from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import HTTPException, status
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.billing import (
    BillingLinkResponse,
    BillingPayerAutopaySetupRequest,
    BillingPayerResponse,
)
from app.services.billing_invoice_projection import _object_get, _stripe_id
from app.services.billing_provider_operations import (
    AUTOPAY_DISABLE_SUBSCRIPTION_ACTIVE_DETAIL,
    AUTOPAY_TERMS_VERSION,
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
    PAYER_SETUP_OPERATION_TYPE,
)
from app.services.platform_billing_helpers import normalize_idempotency_key, stable_hash
from app.services.stripe_mutation_policy import StripeMutationBlocked
from app.services.stripe_service import StripeService


ACTIVE_AUTOPAY_SUBSCRIPTION_STATUSES = ["pending", "trialing", "active", "incomplete", "past_due"]
AUTOPAY_SETUP_OPERATION_LIFETIME = timedelta(minutes=30)
AUTOPAY_SETUP_PROVIDER_LIFETIME = timedelta(minutes=35)
AUTOPAY_SETUP_PROVIDER_MINIMUM_LIFETIME = timedelta(minutes=30)
AUTOPAY_SETUP_IN_PROGRESS_DETAIL = (
    "Autopay setup is still being reconciled. Retry with the same Idempotency-Key."
)
AUTOPAY_SETUP_AMBIGUOUS_DETAIL = (
    "Autopay setup outcome is not yet confirmed. Retry with the same Idempotency-Key after reconciliation."
)
AUTOPAY_EXISTING_CONSENT_UNVERIFIED_DETAIL = (
    "Existing autopay consent could not be verified. Retry before starting a replacement setup."
)


class BillingAutopayManager:
    def __init__(self, billing_service: Any, *, stripe_service_cls: type[StripeService] = StripeService):
        self.billing_service = billing_service
        self.stripe_service_cls = stripe_service_cls

    @property
    def supabase(self):
        return self.billing_service.supabase

    @property
    def settings(self):
        return self.billing_service.settings

    def _get_row_or_404(self, *args, **kwargs):
        return self.billing_service._get_row_or_404(*args, **kwargs)

    def _ensure_connect_ready(self, studio_id: str) -> dict[str, Any]:
        return self.billing_service._ensure_connect_ready(studio_id)

    def _safe_redirect_url(self, value: Optional[str], default: str) -> str:
        return self.billing_service._safe_redirect_url(value, default)

    def _idempotency_key(self, *parts: str) -> str:
        return self.billing_service._idempotency_key(*parts)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.billing_service._audit(studio_id, actor_id, action, entity_id, metadata)

    async def create_autopay_setup_link(
        self,
        payer_id: str,
        data: BillingPayerAutopaySetupRequest,
        studio_id: str,
        actor_id: str,
        request_idempotency_key: str,
    ) -> BillingLinkResponse:
        normalized_key = normalize_idempotency_key(request_idempotency_key)
        if not normalized_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Idempotency-Key is required for autopay setup.",
            )
        payer = self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        account = self._ensure_connect_ready(studio_id)
        account_id = str(account.get("stripe_connected_account_id") or "")
        generation = self._connect_account_generation(account)
        if not account_id or generation is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Stripe account identity is not ready for autopay setup.",
            )
        customer_id = str(payer.get("stripe_customer_id") or "")
        if payer.get("stripe_account_id") != account_id or not customer_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "Sync this payer with Stripe before starting autopay setup, "
                    "then retry with the same Idempotency-Key."
                ),
            )
        frontend_url = self.settings.FRONTEND_URL.rstrip("/")
        return_url = self._safe_redirect_url(data.return_url, f"{frontend_url}/billing?autopay=success")
        success_url = self._safe_redirect_url(
            data.success_url or data.return_url,
            f"{frontend_url}/billing?autopay=success",
        )
        cancel_url = self._safe_redirect_url(
            data.cancel_url or data.return_url,
            f"{frontend_url}/billing?autopay=cancelled",
        )
        request_sha256 = stable_hash({
            "operation_type": PAYER_SETUP_OPERATION_TYPE,
            "studio_id": studio_id,
            "payer_id": payer_id,
            "stripe_customer_id": customer_id,
            "stripe_connected_account_id": account_id,
            "connect_account_generation": generation,
            "terms_version": AUTOPAY_TERMS_VERSION,
            "success_url": success_url,
            "cancel_url": cancel_url,
            "return_url": return_url,
        })
        lease_owner = str(uuid4())
        coordinator = BillingProviderOperationCoordinator(self.supabase)
        claimed = coordinator.claim(
            studio_id=studio_id,
            actor_id=actor_id,
            operation_type=PAYER_SETUP_OPERATION_TYPE,
            caller_request_key=normalized_key,
            request_sha256=request_sha256,
            stripe_connected_account_id=account_id,
            connect_account_generation=generation,
            lease_owner=lease_owner,
        )
        operation = claimed["operation"]
        outcome = str(claimed.get("outcome") or "")
        context = BillingProviderOperationContext(
            operation_id=str(operation["id"]),
            studio_id=studio_id,
            actor_id=actor_id,
            operation_type=PAYER_SETUP_OPERATION_TYPE,
            caller_request_key=normalized_key,
            request_sha256=request_sha256,
            stripe_connected_account_id=account_id,
            connect_account_generation=generation,
            lease_owner=lease_owner,
        )
        if outcome in {"busy", "provider_request_in_flight"}:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=AUTOPAY_SETUP_IN_PROGRESS_DETAIL,
            )
        if outcome == "reconciliation_required" or operation.get("state") == "reconciliation_required":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=AUTOPAY_SETUP_AMBIGUOUS_DETAIL,
            )
        if operation.get("state") in {"definitive_failed", "definitive_rejected"}:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The prior autopay setup request was rejected. Use a new Idempotency-Key.",
            )
        setup_request_id = str(uuid5(NAMESPACE_URL, f"koaryu:payer-setup:{context.operation_id}"))
        operation_deadline = self._operation_setup_deadline(operation)

        if operation.get("state") == "started" and operation_deadline <= datetime.now(timezone.utc):
            coordinator.transition(
                context,
                operation,
                "definitive_rejected",
                error_code="setup_request_expired_before_provider",
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The autopay setup request expired. Start a new setup with a new Idempotency-Key.",
            )

        if operation.get("state") == "projected":
            return self._replay_autopay_setup_link(
                coordinator=coordinator,
                context=context,
                operation=operation,
                payer_id=payer_id,
                setup_request_id=setup_request_id,
                return_urls={return_url, success_url, cancel_url},
            )

        if operation.get("state") in {"provider_succeeded", "completed"} or outcome == "replay":
            return self._replay_autopay_setup_link(
                coordinator=coordinator,
                context=context,
                operation=operation,
                payer_id=payer_id,
                setup_request_id=setup_request_id,
                return_urls={return_url, success_url, cancel_url},
            )

        setup_request = coordinator.find_payer_setup_request(
            setup_request_id=setup_request_id,
            studio_id=studio_id,
            payer_id=payer_id,
            stripe_connected_account_id=account_id,
            connect_account_generation=generation,
        )
        expires_at = (
            self._setup_request_expiry(setup_request)
            if setup_request
            else datetime.now(timezone.utc) + AUTOPAY_SETUP_PROVIDER_LIFETIME
        )
        preserve_existing_autopay = self._preserve_existing_autopay(
            coordinator,
            payer=payer,
            account_id=account_id,
            generation=generation,
        )
        setup_request = coordinator.prepare_payer_setup(
            context,
            operation,
            setup_request_id=setup_request_id,
            payer_id=payer_id,
            terms_version=AUTOPAY_TERMS_VERSION,
            expires_at=expires_at.isoformat(),
        )
        if expires_at < (
            datetime.now(timezone.utc) + AUTOPAY_SETUP_PROVIDER_MINIMUM_LIFETIME
        ):
            coordinator.transition(
                context,
                operation,
                "definitive_rejected",
                error_code="setup_request_lifetime_insufficient",
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "The autopay setup request is too close to expiry. "
                    "Start a new setup with a new Idempotency-Key."
                ),
            )
        operation = coordinator.transition(
            context,
            operation,
            "provider_request_in_flight",
            result_code="payer_setup_requested",
        )
        try:
            link = self.stripe_service_cls().create_setup_checkout_session(
                account_id=account_id,
                studio_id=studio_id,
                customer_id=customer_id,
                success_url=success_url,
                cancel_url=cancel_url,
                metadata={
                    "product": "koaryu_payments_autopay",
                    "studio_id": studio_id,
                    "payer_id": payer_id,
                    "operation_id": context.operation_id,
                    "setup_request_id": setup_request_id,
                    "terms_version": AUTOPAY_TERMS_VERSION,
                    "stripe_account_id": account_id,
                    "connect_account_generation": str(generation),
                },
                idempotency_key=self._idempotency_key(
                    "payer-autopay-setup",
                    context.operation_id,
                ),
                expires_at=int(expires_at.timestamp()),
            )
        except StripeMutationBlocked:
            rejected = coordinator.reject_payer_setup_without_provider(
                context,
                operation=operation,
                setup_request=setup_request,
                payer_id=payer_id,
            )
            if (
                rejected.get("outcome") not in {"rejected", "replay"}
                or (rejected.get("operation") or {}).get("state")
                != "definitive_rejected"
                or not (rejected.get("setup_request") or {}).get("superseded_at")
            ):
                raise RuntimeError("payer_setup_policy_rejection_not_converged")
            raise
        except Exception as exc:
            self._mark_ambiguous_provider_request(
                coordinator,
                context,
                operation,
                exc,
            )

        session_id = _stripe_id(link)
        hosted_url = _object_get(link, "url")
        setup_intent_id = _stripe_id(_object_get(link, "setup_intent"))
        if not session_id or not isinstance(hosted_url, str) or not hosted_url:
            self._mark_ambiguous_provider_request(
                coordinator,
                context,
                operation,
                RuntimeError("provider_setup_response_incomplete"),
            )
        try:
            operation = coordinator.transition(
                context,
                operation,
                "provider_succeeded",
                provider_object_id=session_id,
                provider_secondary_object_id=setup_intent_id,
                result_code="checkout_session_created",
            )
            setup_request = coordinator.bind_payer_setup_session(
                context,
                setup_request=setup_request,
                payer_id=payer_id,
                stripe_checkout_session_id=session_id,
            )
        except Exception as exc:
            try:
                coordinator.mark_payer_setup_reconciliation(
                    setup_request_id=setup_request_id,
                    operation_id=context.operation_id,
                    stripe_checkout_session_id=session_id,
                    stripe_setup_intent_id=setup_intent_id,
                    stripe_connected_account_id=account_id,
                    connect_account_generation=generation,
                    reconciliation_reason_code="setup_session_projection_failed",
                )
            except Exception:
                pass
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=AUTOPAY_SETUP_AMBIGUOUS_DETAIL,
            ) from exc

        if not preserve_existing_autopay:
            pending = self.supabase.table("billing_payers").update({
                "autopay_status": "pending",
                "autopay_authorized_at": None,
                "autopay_terms_accepted_at": None,
            }).eq("id", payer_id).eq("studio_id", studio_id).execute()
            if not pending.data:
                try:
                    coordinator.mark_payer_setup_reconciliation(
                        setup_request_id=setup_request_id,
                        operation_id=context.operation_id,
                        stripe_checkout_session_id=session_id,
                        stripe_setup_intent_id=setup_intent_id,
                        stripe_connected_account_id=account_id,
                        connect_account_generation=generation,
                        reconciliation_reason_code="setup_payer_pending_projection_failed",
                    )
                except Exception:
                    pass
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=AUTOPAY_SETUP_AMBIGUOUS_DETAIL,
                )

        if hosted_url in {return_url, success_url, cancel_url}:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=AUTOPAY_SETUP_AMBIGUOUS_DETAIL,
            )
        self._audit_autopay_setup_started_once(
            context=context,
            payer_id=payer_id,
            setup_request_id=str(setup_request["id"]),
        )
        return BillingLinkResponse(url=hosted_url)

    @staticmethod
    def _preserve_existing_autopay(
        coordinator: BillingProviderOperationCoordinator,
        *,
        payer: dict[str, Any],
        account_id: str,
        generation: int,
    ) -> bool:
        if payer.get("autopay_status") != "enabled":
            return False
        if (
            not payer.get("autopay_terms_accepted_at")
            or not payer.get("default_payment_method_id")
            or payer.get("stripe_account_id") != account_id
            or int(payer.get("connect_account_generation") or 0) != generation
        ):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=AUTOPAY_EXISTING_CONSENT_UNVERIFIED_DETAIL,
            )
        try:
            consent = coordinator.read_active_payer_consent(
                studio_id=str(payer["studio_id"]),
                payer_id=str(payer["id"]),
                terms_version=AUTOPAY_TERMS_VERSION,
                stripe_connected_account_id=account_id,
                connect_account_generation=generation,
            )
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=AUTOPAY_EXISTING_CONSENT_UNVERIFIED_DETAIL,
            ) from exc
        if not (
            consent.get("completed_at")
            and not consent.get("revoked_at")
            and not consent.get("superseded_at")
            and consent.get("accepted_at")
            == payer.get("autopay_terms_accepted_at")
        ):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=AUTOPAY_EXISTING_CONSENT_UNVERIFIED_DETAIL,
            )
        return True

    def _replay_autopay_setup_link(
        self,
        *,
        coordinator: BillingProviderOperationCoordinator,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        payer_id: str,
        setup_request_id: str,
        return_urls: set[str],
    ) -> BillingLinkResponse:
        operation_state = operation.get("state")
        if operation_state == "completed":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "Autopay setup is already complete. "
                    "Start a new setup with a new Idempotency-Key."
                ),
            )
        if operation_state == "projected":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Autopay consent is recorded but local completion is still pending.",
            )
        session_id = str(operation.get("provider_object_id") or "")
        if operation_state == "provider_succeeded":
            self._validate_replay_operation(context, operation, session_id=session_id)
            setup_request = coordinator.read_payer_setup_request(
                setup_request_id=setup_request_id,
                studio_id=context.studio_id,
                payer_id=payer_id,
                stripe_connected_account_id=context.stripe_connected_account_id,
                connect_account_generation=context.connect_account_generation,
            )
            self._validate_replay_setup_request(
                context,
                setup_request,
                payer_id=payer_id,
                setup_request_id=setup_request_id,
                session_id=session_id,
            )
            if not setup_request.get("stripe_checkout_session_id") and session_id:
                try:
                    coordinator.bind_payer_setup_session(
                        context,
                        setup_request=setup_request,
                        payer_id=payer_id,
                        stripe_checkout_session_id=session_id,
                    )
                except Exception as exc:
                    try:
                        coordinator.mark_payer_setup_reconciliation(
                            setup_request_id=setup_request_id,
                            operation_id=context.operation_id,
                            stripe_checkout_session_id=session_id,
                            stripe_setup_intent_id=operation.get(
                                "provider_secondary_object_id"
                            ),
                            stripe_connected_account_id=context.stripe_connected_account_id,
                            connect_account_generation=context.connect_account_generation,
                            reconciliation_reason_code="setup_session_projection_failed",
                        )
                    except Exception:
                        pass
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=AUTOPAY_SETUP_AMBIGUOUS_DETAIL,
                    ) from exc
                setup_request = coordinator.read_payer_setup_request(
                    setup_request_id=setup_request_id,
                    studio_id=context.studio_id,
                    payer_id=payer_id,
                    stripe_connected_account_id=context.stripe_connected_account_id,
                    connect_account_generation=context.connect_account_generation,
                )
                self._validate_replay_setup_request(
                    context,
                    setup_request,
                    payer_id=payer_id,
                    setup_request_id=setup_request_id,
                    session_id=session_id,
                )
        if session_id:
            try:
                session = self.stripe_service_cls().retrieve_connected_checkout_session(
                    account_id=context.stripe_connected_account_id,
                    session_id=session_id,
                )
                retrieved_session_id = _stripe_id(session)
                raw_session_status = _object_get(session, "status")
                session_status = (
                    raw_session_status
                    if isinstance(raw_session_status, str)
                    and 0 < len(raw_session_status) <= 64
                    else None
                )
                raw_expires_at = _object_get(session, "expires_at")
                try:
                    expires_at_epoch = (
                        int(raw_expires_at) if raw_expires_at is not None else None
                    )
                except (TypeError, ValueError):
                    expires_at_epoch = None
                if operation_state == "provider_succeeded":
                    if retrieved_session_id != session_id:
                        raise HTTPException(
                            status_code=status.HTTP_409_CONFLICT,
                            detail=AUTOPAY_SETUP_IN_PROGRESS_DETAIL,
                        )
                    close_reason = None
                    if session_status == "expired" or (
                        expires_at_epoch is not None
                        and expires_at_epoch <= int(datetime.now(timezone.utc).timestamp())
                    ):
                        close_reason = "checkout_session_expired"
                    if close_reason:
                        closed = coordinator.close_payer_setup_request(
                            setup_request_id=setup_request_id,
                            operation_id=context.operation_id,
                            studio_id=context.studio_id,
                            payer_id=payer_id,
                            stripe_checkout_session_id=session_id,
                            stripe_connected_account_id=context.stripe_connected_account_id,
                            connect_account_generation=context.connect_account_generation,
                            close_reason_code=close_reason,
                            provider_read_proof_sha256=stable_hash({
                                "operation_id": context.operation_id,
                                "setup_request_id": setup_request_id,
                                "studio_id": context.studio_id,
                                "payer_id": payer_id,
                                "stripe_checkout_session_id": session_id,
                                "stripe_connected_account_id": context.stripe_connected_account_id,
                                "connect_account_generation": context.connect_account_generation,
                                "checkout_session_status": session_status,
                                "checkout_session_expires_at": expires_at_epoch,
                                "close_reason_code": close_reason,
                            }),
                        )
                        if (
                            closed.get("outcome") not in {"closed", "replay"}
                            or (closed.get("operation") or {}).get("state")
                            != "definitive_rejected"
                            or not (closed.get("setup_request") or {}).get("superseded_at")
                        ):
                            raise RuntimeError("payer_setup_close_not_converged")
                        raise HTTPException(
                            status_code=status.HTTP_409_CONFLICT,
                            detail=(
                                "The Stripe autopay setup session expired. "
                                "Start a new setup with a new Idempotency-Key."
                            ),
                        )
                    if session_status == "complete":
                        raise HTTPException(
                            status_code=status.HTTP_409_CONFLICT,
                            detail=AUTOPAY_SETUP_IN_PROGRESS_DETAIL,
                        )
                    if session_status != "open":
                        raise HTTPException(
                            status_code=status.HTTP_409_CONFLICT,
                            detail=AUTOPAY_SETUP_IN_PROGRESS_DETAIL,
                        )
                hosted_url = _object_get(session, "url")
                if (
                    isinstance(hosted_url, str)
                    and hosted_url
                    and hosted_url not in return_urls
                ):
                    self._audit_autopay_setup_started_once(
                        context=context,
                        payer_id=payer_id,
                        setup_request_id=setup_request_id,
                    )
                    return BillingLinkResponse(url=hosted_url)
            except HTTPException:
                raise
            except Exception:
                if operation_state == "provider_succeeded":
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail=AUTOPAY_SETUP_IN_PROGRESS_DETAIL,
                    ) from None
        if operation_state == "provider_succeeded":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=AUTOPAY_SETUP_IN_PROGRESS_DETAIL,
            )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=AUTOPAY_SETUP_IN_PROGRESS_DETAIL,
        )

    @staticmethod
    def _validate_replay_operation(
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        *,
        session_id: str,
    ) -> None:
        if not session_id or any((
            operation.get("id") != context.operation_id,
            operation.get("studio_id") != context.studio_id,
            operation.get("actor_id") != context.actor_id,
            operation.get("operation_type") != context.operation_type,
            operation.get("caller_request_key") != context.caller_request_key,
            operation.get("request_sha256") != context.request_sha256,
            operation.get("stripe_connected_account_id")
            != context.stripe_connected_account_id,
            operation.get("connect_account_generation")
            != context.connect_account_generation,
        )):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=AUTOPAY_SETUP_IN_PROGRESS_DETAIL,
            )

    @staticmethod
    def _validate_replay_setup_request(
        context: BillingProviderOperationContext,
        setup_request: dict[str, Any],
        *,
        payer_id: str,
        setup_request_id: str,
        session_id: str,
    ) -> None:
        bound_session_id = setup_request.get("stripe_checkout_session_id")
        if any((
            setup_request.get("id") != setup_request_id,
            setup_request.get("operation_id") != context.operation_id,
            setup_request.get("studio_id") != context.studio_id,
            setup_request.get("payer_id") != payer_id,
            setup_request.get("initiated_by") != context.actor_id,
            setup_request.get("terms_version") != AUTOPAY_TERMS_VERSION,
            setup_request.get("stripe_connected_account_id")
            != context.stripe_connected_account_id,
            setup_request.get("connect_account_generation")
            != context.connect_account_generation,
            bound_session_id not in {None, session_id},
            bool(setup_request.get("revoked_at")),
            bool(setup_request.get("superseded_at")),
            bool(setup_request.get("completed_at")),
        )):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=AUTOPAY_SETUP_IN_PROGRESS_DETAIL,
            )

    def _audit_autopay_setup_started_once(
        self,
        *,
        context: BillingProviderOperationContext,
        payer_id: str,
        setup_request_id: str,
    ) -> None:
        action = "billing.autopay_setup_started"
        metadata = {
            "operation_id": context.operation_id,
            "setup_request_id": setup_request_id,
            "terms_version": AUTOPAY_TERMS_VERSION,
        }
        audit_id = str(uuid5(NAMESPACE_URL, f"koaryu:{action}:{context.operation_id}"))
        deterministic = (
            self.supabase.table("audit_logs")
            .select("id, studio_id, actor_id, action, entity_type, entity_id, metadata")
            .eq("id", audit_id)
            .limit(1)
            .execute()
        )
        if deterministic.data:
            self._validate_setup_started_audit(
                deterministic.data,
                audit_id=audit_id,
                context=context,
                payer_id=payer_id,
                metadata=metadata,
            )
            return

        legacy = (
            self.supabase.table("audit_logs")
            .select("id, studio_id, actor_id, action, entity_type, entity_id, metadata")
            .eq("studio_id", context.studio_id)
            .eq("action", action)
            .eq("entity_id", payer_id)
            .eq("metadata->>operation_id", context.operation_id)
            .limit(2)
            .execute()
        )
        if legacy.data:
            self._validate_setup_started_audit(
                legacy.data,
                audit_id=None,
                context=context,
                payer_id=payer_id,
                metadata=metadata,
            )
            return

        payload = {
            "id": audit_id,
            "studio_id": context.studio_id,
            "actor_id": context.actor_id,
            "action": action,
            "entity_type": "billing",
            "entity_id": payer_id,
            "metadata": metadata,
        }
        try:
            self.supabase.table("audit_logs").insert(payload).execute()
        except PostgrestAPIError as exc:
            if getattr(exc, "code", None) != "23505":
                raise
            winner = (
                self.supabase.table("audit_logs")
                .select("id, studio_id, actor_id, action, entity_type, entity_id, metadata")
                .eq("id", audit_id)
                .limit(1)
                .execute()
            )
            self._validate_setup_started_audit(
                winner.data,
                audit_id=audit_id,
                context=context,
                payer_id=payer_id,
                metadata=metadata,
            )

    @staticmethod
    def _validate_setup_started_audit(
        rows: Any,
        *,
        audit_id: Optional[str],
        context: BillingProviderOperationContext,
        payer_id: str,
        metadata: dict[str, Any],
    ) -> None:
        if not isinstance(rows, list) or len(rows) != 1:
            raise RuntimeError("autopay_setup_started_audit_conflict")
        row = rows[0]
        if not isinstance(row, dict) or any((
            audit_id is not None and row.get("id") != audit_id,
            row.get("studio_id") != context.studio_id,
            row.get("actor_id") != context.actor_id,
            row.get("action") != "billing.autopay_setup_started",
            row.get("entity_type") != "billing",
            row.get("entity_id") != payer_id,
            row.get("metadata") != metadata,
        )):
            raise RuntimeError("autopay_setup_started_audit_conflict")

    def _mark_ambiguous_provider_request(
        self,
        coordinator: BillingProviderOperationCoordinator,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        exc: Exception,
    ) -> None:
        try:
            coordinator.transition(
                context,
                operation,
                "reconciliation_required",
                error_code="provider_outcome_ambiguous",
                reconciliation_reason_code="provider_setup_outcome_ambiguous",
            )
        except Exception:
            pass
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=AUTOPAY_SETUP_AMBIGUOUS_DETAIL,
        ) from exc

    @staticmethod
    def _connect_account_generation(account: dict[str, Any]) -> Optional[int]:
        value = (account.get("metadata") or {}).get("connect_account_generation") or 1
        try:
            generation = int(value)
        except (TypeError, ValueError):
            return None
        return generation if generation > 0 else None

    @staticmethod
    def _operation_setup_deadline(operation: dict[str, Any]) -> datetime:
        raw_started_at = operation.get("started_at")
        try:
            started_at = datetime.fromisoformat(str(raw_started_at).replace("Z", "+00:00"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Billing operation start time could not be verified.",
            ) from exc
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=timezone.utc)
        return started_at.astimezone(timezone.utc) + AUTOPAY_SETUP_OPERATION_LIFETIME

    @staticmethod
    def _setup_request_expiry(setup_request: dict[str, Any]) -> datetime:
        raw_expires_at = setup_request.get("setup_request_expires_at")
        try:
            expires_at = datetime.fromisoformat(
                str(raw_expires_at).replace("Z", "+00:00")
            )
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Autopay setup expiry could not be verified.",
            ) from exc
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        return expires_at.astimezone(timezone.utc)

    async def disable_autopay(self, payer_id: str, studio_id: str, actor_id: str) -> BillingPayerResponse:
        self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        active_subscription_ids = self._active_payer_autopay_subscription_ids(
            payer_id, studio_id
        )
        if active_subscription_ids:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=AUTOPAY_DISABLE_SUBSCRIPTION_ACTIVE_DETAIL,
            )
        envelope = BillingProviderOperationCoordinator(self.supabase).disable_payer_autopay(
            studio_id=studio_id,
            payer_id=payer_id,
            actor_id=actor_id,
            disabled_at=datetime.now(timezone.utc).isoformat(),
        )
        self._audit(studio_id, actor_id, "billing.autopay_disabled", payer_id, {
            "rewired_subscription_ids": [],
        })
        return BillingPayerResponse(**envelope["payer"])

    def _active_payer_autopay_subscription_ids(
        self, payer_id: str, studio_id: str
    ) -> list[str]:
        result = (
            self.supabase.table("billing_subscriptions")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("payer_id", payer_id)
            .eq("collection_mode", "autopay")
            .in_("status", ACTIVE_AUTOPAY_SUBSCRIPTION_STATUSES)
            .execute()
        )
        return [str(subscription["id"]) for subscription in (result.data or [])]

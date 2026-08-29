from __future__ import annotations

from typing import Any, Optional
from uuid import uuid4

from fastapi import HTTPException, status

from app.schemas.billing import (
    STRIPE_TEST_CLOCK_ID_PATTERN,
    BillingPayerCreate,
    BillingPayerResponse,
    BillingPayerUpdate,
)
from app.services.billing_invoice_projection import _object_get, _stripe_id
from app.services.billing_provider_operations import (
    AUTOPAY_TERMS_VERSION,
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
    PAYER_SYNC_OPERATION_TYPE,
    provider_operation_disposition,
)
from app.services.platform_billing_helpers import normalize_idempotency_key, stable_hash
from app.services.stripe_mutation_policy import StripeMutationBlocked, configured_stripe_mode
from app.services.stripe_service import StripeService


PAYER_SYNC_AMBIGUOUS_DETAIL = (
    "Payer sync outcome is not confirmed. Retry with the same Idempotency-Key after reconciliation."
)


class BillingPayerManager:
    def __init__(self, billing_service: Any, *, stripe_service_cls: type[StripeService] = StripeService):
        self.billing_service = billing_service
        self.stripe_service_cls = stripe_service_cls

    @property
    def supabase(self):
        return self.billing_service.supabase

    def _connect_accounts(self):
        return self.billing_service._connect_accounts()

    def _ensure_connect_ready(self, studio_id: str) -> dict[str, Any]:
        return self.billing_service._ensure_connect_ready(studio_id)

    def _get_row_or_404(self, *args, **kwargs):
        return self.billing_service._get_row_or_404(*args, **kwargs)

    def _ensure_record_in_studio(self, *args, **kwargs) -> None:
        self.billing_service._ensure_record_in_studio(*args, **kwargs)

    def _idempotency_key(self, *parts: str) -> str:
        return self.billing_service._idempotency_key(*parts)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.billing_service._audit(studio_id, actor_id, action, entity_id, metadata)

    async def list_payers(self, studio_id: str) -> list[BillingPayerResponse]:
        result = (
            self.supabase.table("billing_payers")
            .select("*")
            .eq("studio_id", studio_id)
            .order("display_name")
            .execute()
        )
        return [BillingPayerResponse(**row) for row in (result.data or [])]

    async def create_payer(self, data: BillingPayerCreate, studio_id: str, actor_id: str) -> BillingPayerResponse:
        row = data.model_dump()
        row["studio_id"] = studio_id
        if row.get("guardian_id"):
            self._ensure_record_in_studio("guardians", row["guardian_id"], studio_id, "Guardian not found.")
        result = self.supabase.table("billing_payers").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create payer.")
        payer = result.data[0]
        self._audit(studio_id, actor_id, "billing.payer_created", payer["id"], {"display_name": data.display_name})
        return BillingPayerResponse(**payer)

    async def get_payer(self, payer_id: str, studio_id: str) -> BillingPayerResponse:
        return BillingPayerResponse(**self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found."))

    async def update_payer(
        self,
        payer_id: str,
        data: BillingPayerUpdate,
        studio_id: str,
        actor_id: str,
    ) -> BillingPayerResponse:
        self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        update = data.model_dump(exclude_unset=True)
        if update.get("guardian_id"):
            self._ensure_record_in_studio("guardians", update["guardian_id"], studio_id, "Guardian not found.")
        if not update:
            return await self.get_payer(payer_id, studio_id)
        result = self.supabase.table("billing_payers").update(update).eq("id", payer_id).eq("studio_id", studio_id).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Payer not found.")
        payer = result.data[0]
        self._audit(studio_id, actor_id, "billing.payer_updated", payer_id, {"changes": update})
        return BillingPayerResponse(**payer)

    async def sync_payer(
        self,
        payer_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None = None,
        test_clock_id: str | None = None,
    ) -> BillingPayerResponse:
        normalized_key = normalize_idempotency_key(idempotency_key)
        if not normalized_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Idempotency-Key is required for payer sync.",
            )
        self._validate_test_clock_context(test_clock_id)
        payer = self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        account = self._local_ready_connect_account(studio_id)
        account_id = str(account["stripe_connected_account_id"])
        generation = self._connect_account_generation(account)
        request_sha256 = self._payer_sync_request_hash(
            payer,
            account_id=account_id,
            generation=generation,
            test_clock_id=test_clock_id,
        )
        lease_owner = str(uuid4())
        coordinator = BillingProviderOperationCoordinator(self.supabase)
        claimed = coordinator.claim_resource(
            studio_id=studio_id,
            actor_id=actor_id,
            operation_type=PAYER_SYNC_OPERATION_TYPE,
            resource_type="payer",
            resource_id=payer_id,
            payer_id=payer_id,
            caller_request_key=normalized_key,
            request_sha256=request_sha256,
            stripe_connected_account_id=account_id,
            connect_account_generation=generation,
            lease_owner=lease_owner,
        )
        operation = claimed["operation"]
        disposition = provider_operation_disposition(claimed)
        recovery = disposition in {"recovery_safe_retry", "recovery_reconcile_only"}
        if recovery:
            resource = claimed.get("resource") or {}
            if (
                resource.get("studio_id") != studio_id
                or resource.get("operation_type") != PAYER_SYNC_OPERATION_TYPE
                or resource.get("resource_type") != "payer"
                or str(resource.get("resource_id") or "") != payer_id
                or str(resource.get("payer_id") or "") != payer_id
                or str(resource.get("operation_id") or "") != str(operation["id"])
            ):
                raise HTTPException(
                    status_code=503,
                    detail=PAYER_SYNC_AMBIGUOUS_DETAIL,
                )
        context = BillingProviderOperationContext(
            operation_id=str(operation["id"]),
            studio_id=studio_id,
            actor_id=str(operation["actor_id"]),
            operation_type=PAYER_SYNC_OPERATION_TYPE,
            caller_request_key=str(claimed["canonical_caller_request_key"]),
            request_sha256=str(operation["request_sha256"]),
            stripe_connected_account_id=account_id,
            connect_account_generation=generation,
            lease_owner=str(operation["lease_owner"]) if recovery else lease_owner,
        )
        if disposition == "replay":
            try:
                self._payer_sync_mode(operation)
                payer = self._load_payer_sync_result(
                    payer_id=payer_id,
                    context=context,
                    operation=operation,
                )
            except Exception as exc:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Completed payer sync result could not be verified.",
                ) from exc
            return BillingPayerResponse(**payer)
        if operation.get("state") == "projected":
            try:
                self._payer_sync_mode(operation)
                payer = self._load_payer_sync_result(
                    payer_id=payer_id,
                    context=context,
                    operation=operation,
                )
            except Exception as exc:
                self._mark_payer_sync_reconciliation(
                    coordinator,
                    context,
                    operation,
                    "payer_sync_projection_unverified",
                    exc,
                )
            coordinator.complete(context, operation, result_code="payer_sync_completed")
            return BillingPayerResponse(**payer)
        if operation.get("state") == "provider_succeeded":
            try:
                self._payer_sync_mode(operation)
                payer = self._load_payer_sync_result(
                    payer_id=payer_id,
                    context=context,
                    operation=operation,
                )
            except Exception as exc:
                self._mark_payer_sync_reconciliation(
                    coordinator,
                    context,
                    operation,
                    "payer_sync_projection_unverified",
                    exc,
                )
            operation = coordinator.transition(
                context,
                operation,
                "projected",
                result_code="payer_sync_projected",
            )
            coordinator.complete(context, operation, result_code="payer_sync_completed")
            return BillingPayerResponse(**payer)

        if test_clock_id and not recovery and payer.get("stripe_customer_id"):
            coordinator.transition(
                context,
                operation,
                "definitive_rejected",
                error_code="payer_sync_test_clock_requires_new_customer",
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A Stripe test clock can only be attached when creating a new payer customer.",
            )

        sync_mode = (
            self._payer_sync_mode(operation)
            if recovery
            else (
                "update"
                if payer.get("stripe_customer_id")
                and payer.get("stripe_account_id") == account_id
                else "create"
            )
        )
        target_customer_id = (
            self._payer_sync_evidence(operation)[1]
            if recovery
            else (
                str(payer.get("stripe_customer_id"))
                if sync_mode == "update"
                else None
            )
        )
        if recovery and (
            (sync_mode == "create" and payer.get("stripe_customer_id") is not None)
            or (
                sync_mode == "update"
                and str(payer.get("stripe_customer_id") or "")
                != str(target_customer_id or "")
            )
        ):
            coordinator.reject_recovery_source_drift_v2(
                context, operation,
                error_code="payer_sync_recovery_source_drift",
            )
            raise HTTPException(status_code=409, detail=PAYER_SYNC_AMBIGUOUS_DETAIL)
        saved_summary = self._payer_sync_summary(sync_mode, target_customer_id)
        stripe_key = self._idempotency_key("payer-sync", context.operation_id)
        metadata = {
            "studio_id": payer["studio_id"],
            "payer_id": payer["id"],
            "product": "koaryu_payments",
        }
        address = {
            "line1": payer.get("address_line1"),
            "city": payer.get("address_city"),
            "state": payer.get("address_state"),
            "postal_code": payer.get("address_zip"),
        }
        stripe_service = self.stripe_service_cls()
        if disposition == "recovery_reconcile_only":
            customer_id = str(operation.get("provider_object_id") or "")
            try:
                provider_customer = stripe_service.retrieve_connected_customer(
                    account_id=account_id,
                    customer_id=customer_id,
                    expand=["invoice_settings.default_payment_method"],
                )
                self._verify_recovered_customer(
                    provider_customer,
                    payer=payer,
                    customer_id=customer_id,
                    sync_mode=sync_mode,
                    metadata=metadata,
                    address=address,
                    test_clock_id=test_clock_id,
                )
            except Exception as exc:
                self._mark_payer_sync_reconciliation(
                    coordinator,
                    context,
                    operation,
                    "payer_sync_recovered_customer_mismatch",
                    exc,
                )
            operation = coordinator.transition(
                context,
                operation,
                "provider_succeeded",
                provider_object_id=customer_id,
                result_code=f"payer_sync_{sync_mode}_succeeded",
                result_summary=saved_summary,
            )
        else:
            operation = coordinator.transition(
                context,
                operation,
                "provider_request_in_flight",
                result_code=f"payer_sync_{sync_mode}_started",
                result_summary=saved_summary,
            )
            if disposition == "recovery_safe_retry" and int(
                operation.get("provider_request_attempt_count") or 0
            ) != 2:
                raise HTTPException(status_code=503, detail=PAYER_SYNC_AMBIGUOUS_DETAIL)
            try:
                if sync_mode == "update":
                    provider_customer = stripe_service.update_connected_customer(
                        account_id=account_id,
                        studio_id=studio_id,
                        customer_id=str(payer["stripe_customer_id"]),
                        name=payer.get("display_name") or "Koaryu payer",
                        email=payer.get("email"),
                        phone=payer.get("phone"),
                        address=address,
                        metadata=metadata,
                        expand=["invoice_settings.default_payment_method"],
                        idempotency_key=stripe_key,
                    )
                else:
                    provider_customer = stripe_service.create_connected_customer(
                        account_id=account_id,
                        studio_id=studio_id,
                        name=payer.get("display_name") or "Koaryu payer",
                        email=payer.get("email"),
                        phone=payer.get("phone"),
                        address=address,
                        metadata=metadata,
                        expand=["invoice_settings.default_payment_method"],
                        idempotency_key=stripe_key,
                        test_clock_id=test_clock_id,
                    )
            except StripeMutationBlocked:
                coordinator.transition(
                    context,
                    operation,
                    "definitive_rejected",
                    error_code="provider_mutation_blocked",
                )
                raise
            except Exception as exc:
                self._mark_payer_sync_reconciliation(
                    coordinator,
                    context,
                    operation,
                    "payer_sync_provider_outcome_ambiguous",
                    exc,
                )
            customer_id = _stripe_id(provider_customer)
            if not customer_id or (
                sync_mode == "update" and customer_id != payer.get("stripe_customer_id")
            ):
                self._mark_payer_sync_reconciliation(
                    coordinator,
                    context,
                    operation,
                    "payer_sync_provider_identity_ambiguous",
                    RuntimeError("payer_sync_provider_identity_ambiguous"),
                )
            try:
                operation = coordinator.transition(
                    context,
                    operation,
                    "provider_succeeded",
                    provider_object_id=customer_id,
                    result_code=f"payer_sync_{sync_mode}_succeeded",
                )
            except Exception as exc:
                self._mark_payer_sync_reconciliation(
                    coordinator,
                    context,
                    operation,
                    "payer_sync_provider_result_not_recorded",
                    exc,
                )
        try:
            payer = self._project_payer_sync_result(
                payer=payer,
                provider_customer=provider_customer,
                customer_id=customer_id,
                context=context,
            )
        except Exception as exc:
            self._mark_payer_sync_reconciliation(
                coordinator,
                context,
                operation,
                "payer_sync_local_projection_failed",
                exc,
            )
        operation = coordinator.transition(
            context,
            operation,
            "projected",
            result_code="payer_sync_projected",
        )
        coordinator.complete(context, operation, result_code="payer_sync_completed")
        self._audit(studio_id, actor_id, "billing.payer_synced", payer_id, {
            "operation_id": context.operation_id,
            "sync_mode": sync_mode,
        })
        return BillingPayerResponse(**payer)

    @staticmethod
    def _verify_recovered_customer(
        customer: Any,
        *,
        payer: dict[str, Any],
        customer_id: str,
        sync_mode: str,
        metadata: dict[str, Any],
        address: dict[str, Any],
        test_clock_id: str | None = None,
    ) -> None:
        provider_address = _object_get(customer, "address") or {}
        provider_metadata = _object_get(customer, "metadata") or {}
        provider_test_clock = _stripe_id(_object_get(customer, "test_clock"))
        if (
            _stripe_id(customer) != customer_id
            or (
                sync_mode == "update"
                and customer_id != payer.get("stripe_customer_id")
            )
            or (
                sync_mode == "create"
                and payer.get("stripe_customer_id") not in {None, customer_id}
            )
            or str(_object_get(customer, "name") or "")
            != str(payer.get("display_name") or "Koaryu payer")
            or str(_object_get(customer, "email") or "") != str(payer.get("email") or "")
            or str(_object_get(customer, "phone") or "") != str(payer.get("phone") or "")
            or any(
                str(_object_get(provider_address, key) or "")
                != str(value or "")
                for key, value in address.items()
            )
            or any(
                str(_object_get(provider_metadata, key) or "")
                != str(value)
                for key, value in metadata.items()
            )
            or provider_test_clock != test_clock_id
        ):
            raise RuntimeError("payer_sync_recovered_customer_mismatch")

    def _local_ready_connect_account(self, studio_id: str) -> dict[str, Any]:
        account = self._connect_accounts().ensure_row(studio_id)
        if (
            account.get("studio_id") != studio_id
            or not account.get("stripe_connected_account_id")
            or not account.get("charges_enabled")
            or account.get("status") == "deauthorized"
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Stripe Connect charges are not enabled yet.",
            )
        return account

    @staticmethod
    def _connect_account_generation(account: dict[str, Any]) -> int:
        value = (account.get("metadata") or {}).get("connect_account_generation") or 1
        try:
            generation = int(value)
        except (TypeError, ValueError):
            generation = 0
        if generation <= 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Stripe account generation is not ready for payer sync.",
            )
        return generation

    @staticmethod
    def _payer_sync_mode(operation: dict[str, Any]) -> str:
        return BillingPayerManager._payer_sync_evidence(operation)[0]

    @staticmethod
    def _payer_sync_summary(mode: str, target_customer_id: str | None) -> str:
        if mode == "create" and target_customer_id is None:
            return "sync_mode:create:target_customer_id:none"
        if (
            mode == "update"
            and isinstance(target_customer_id, str)
            and target_customer_id.startswith("cus_")
            and target_customer_id[4:].isalnum()
        ):
            return f"sync_mode:update:target_customer_id:{target_customer_id}"
        raise RuntimeError("payer_sync_saved_target_invalid")

    @staticmethod
    def _payer_sync_evidence(operation: dict[str, Any]) -> tuple[str, str | None]:
        summary = str(operation.get("result_summary") or "")
        create = "sync_mode:create:target_customer_id:none"
        update_prefix = "sync_mode:update:target_customer_id:"
        if summary == create:
            return "create", None
        if summary.startswith(update_prefix):
            target = summary[len(update_prefix):]
            BillingPayerManager._payer_sync_summary("update", target)
            return "update", target
        raise RuntimeError("payer_sync_saved_mode_invalid")

    @staticmethod
    def _payer_sync_request_hash(
        payer: dict[str, Any],
        *,
        account_id: str,
        generation: int,
        test_clock_id: str | None = None,
    ) -> str:
        payload = {
            "operation_type": PAYER_SYNC_OPERATION_TYPE,
            "studio_id": payer["studio_id"],
            "payer_id": payer["id"],
            "stripe_connected_account_id": account_id,
            "connect_account_generation": generation,
            "display_name": payer.get("display_name") or "Koaryu payer",
            "email": payer.get("email"),
            "phone": payer.get("phone"),
            "address": {
                "line1": payer.get("address_line1"),
                "city": payer.get("address_city"),
                "state": payer.get("address_state"),
                "postal_code": payer.get("address_zip"),
            },
        }
        if test_clock_id is not None:
            payload["stripe_test_clock_id"] = test_clock_id
        return stable_hash(payload)

    def _validate_test_clock_context(self, test_clock_id: str | None) -> None:
        if test_clock_id is None:
            return
        if not STRIPE_TEST_CLOCK_ID_PATTERN.fullmatch(test_clock_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Stripe test clock ID is malformed.",
            )
        settings = self.billing_service.settings
        if getattr(settings, "ENVIRONMENT", None) != "staging":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Stripe test clocks are restricted to the staging environment.",
            )
        if configured_stripe_mode(settings) != "test":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Stripe test clocks require Stripe test mode.",
            )

    def _project_payer_sync_result(
        self,
        *,
        payer: dict[str, Any],
        provider_customer: Any,
        customer_id: str,
        context: BillingProviderOperationContext,
    ) -> dict[str, Any]:
        payment_fields = self._payment_method_fields_from_customer(provider_customer)
        active_consent = None
        if not payment_fields.get("default_payment_method_id"):
            try:
                active_consent = BillingProviderOperationCoordinator(
                    self.supabase
                ).read_active_payer_consent(
                    studio_id=context.studio_id,
                    payer_id=str(payer["id"]),
                    terms_version=AUTOPAY_TERMS_VERSION,
                    stripe_connected_account_id=context.stripe_connected_account_id,
                    connect_account_generation=context.connect_account_generation,
                )
            except Exception:
                active_consent = None
        if (
            not payment_fields.get("default_payment_method_id")
            and active_consent is not None
            and payer.get("default_payment_method_id")
            and payer.get("autopay_status") == "enabled"
            and payer.get("autopay_authorized_at") == active_consent.get("completed_at")
            and payer.get("autopay_terms_accepted_at") == active_consent.get("accepted_at")
        ):
            payment_fields = {
                key: payer.get(key)
                for key in (
                    "default_payment_method_id",
                    "default_payment_method_brand",
                    "default_payment_method_last4",
                    "default_payment_method_exp_month",
                    "default_payment_method_exp_year",
                )
            }
        update = {
            "stripe_account_id": context.stripe_connected_account_id,
            "stripe_customer_id": customer_id,
            "connect_account_generation": context.connect_account_generation,
            **payment_fields,
        }
        query = (
            self.supabase.table("billing_payers")
            .update(update)
            .eq("id", payer["id"])
            .eq("studio_id", context.studio_id)
        )
        for field in (
            "display_name", "email", "phone", "address_line1", "address_city",
            "address_state", "address_zip", "stripe_account_id",
            "stripe_customer_id", "connect_account_generation",
        ):
            value = payer.get(field)
            query = query.is_(field, "null") if value is None else query.eq(field, value)
        result = query.execute()
        if not result.data:
            raise RuntimeError("payer_sync_projection_not_persisted")
        return result.data[0]

    def _load_payer_sync_result(
        self,
        *,
        payer_id: str,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
    ) -> dict[str, Any]:
        payer = self._get_row_or_404("billing_payers", payer_id, context.studio_id, "Payer not found.")
        if (
            payer.get("stripe_account_id") != context.stripe_connected_account_id
            or payer.get("connect_account_generation")
            != context.connect_account_generation
            or payer.get("stripe_customer_id") != operation.get("provider_object_id")
        ):
            raise RuntimeError("payer_sync_saved_result_mismatch")
        return payer

    @staticmethod
    def _mark_payer_sync_reconciliation(
        coordinator: BillingProviderOperationCoordinator,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        reason_code: str,
        exc: Exception,
    ) -> None:
        try:
            if operation.get("state") == "recovery_authorized":
                coordinator.mark_recovery_reconciliation_v2(
                    context,
                    operation,
                    reconciliation_reason_code=reason_code,
                )
            else:
                coordinator.transition(
                    context,
                    operation,
                    "reconciliation_required",
                    reconciliation_reason_code=reason_code,
                )
        except Exception:
            pass
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=PAYER_SYNC_AMBIGUOUS_DETAIL,
        ) from exc

    def _payer_id_for_customer(self, studio_id: str, account_id: Optional[str], customer_id: Optional[str]) -> Optional[str]:
        if not customer_id:
            return None
        query = (
            self.supabase.table("billing_payers")
            .select("id")
            .eq("studio_id", studio_id)
            .eq("stripe_customer_id", customer_id)
            .limit(1)
        )
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0]["id"] if result.data else None

    def _payment_method_fields_from_customer(self, customer: Any) -> dict[str, Any]:
        invoice_settings = _object_get(customer, "invoice_settings") or {}
        payment_method = _object_get(invoice_settings, "default_payment_method")
        return self._payment_method_fields_from_payment_method(payment_method)

    def _payment_method_fields_from_payment_method(self, payment_method: Any) -> dict[str, Any]:
        if not payment_method:
            return {
                "default_payment_method_id": None,
                "default_payment_method_brand": None,
                "default_payment_method_last4": None,
                "default_payment_method_exp_month": None,
                "default_payment_method_exp_year": None,
            }
        method_type = _object_get(payment_method, "type")
        card = _object_get(payment_method, "card") or {}
        return {
            "default_payment_method_id": _stripe_id(payment_method),
            "default_payment_method_brand": _object_get(card, "brand") or method_type,
            "default_payment_method_last4": _object_get(card, "last4"),
            "default_payment_method_exp_month": _object_get(card, "exp_month"),
            "default_payment_method_exp_year": _object_get(card, "exp_year"),
        }

    def _recompute_payer_balance(self, studio_id: str, payer_id: Optional[str]) -> None:
        if not payer_id:
            return
        result = (
            self.supabase.table("billing_invoices")
            .select("amount_due_cents, amount_paid_cents, amount_remaining_cents, status, external")
            .eq("studio_id", studio_id)
            .eq("payer_id", payer_id)
            .in_("status", ["draft", "open", "uncollectible", "partially_refunded"])
            .execute()
        )
        balance = 0
        for row in result.data or []:
            remaining = row.get("amount_remaining_cents")
            if remaining is None:
                remaining = max(0, int(row.get("amount_due_cents") or 0) - int(row.get("amount_paid_cents") or 0))
            balance += max(0, int(remaining or 0))
        billing_status = "current" if balance == 0 else "past_due"
        self.supabase.table("billing_payers").update({
            "balance_cents": balance,
            "billing_status": billing_status,
        }).eq("id", payer_id).eq("studio_id", studio_id).execute()

from __future__ import annotations

from typing import Optional

from fastapi import HTTPException, status

from app.schemas.billing import (
    BillingLinkResponse,
    ConnectOnboardingDeliveryAckResponse,
    ConnectOnboardingLinkResponse,
    StudioPaymentAccountResponse,
)
from app.services.billing_connect_accounts import BillingConnectAccountStore
from app.services.platform_billing_helpers import build_idempotency_key, normalize_idempotency_key
from app.services.stripe_connect_gateway import (
    build_connect_account_v2_payload,
    build_connect_onboarding_link_v2_payload,
)
from app.services.stripe_mutation_policy import configured_stripe_mode
from app.services.stripe_service import StripeService
from app.services.studio_live_billing_authorizations import (
    LIVE_CONNECT_BOOTSTRAP_SUPPORT_DETAIL,
    StudioLiveBillingAuthorizationStore,
    new_connect_onboarding_bootstrap_context,
    stripe_payload_sha256,
)


class BillingConnectActions:
    def __init__(
        self,
        billing_service,
        connect_accounts: BillingConnectAccountStore,
        *,
        stripe_service_cls=StripeService,
    ):
        self.billing_service = billing_service
        self.connect_accounts = connect_accounts
        self.stripe_service_cls = stripe_service_cls

    async def get_payment_account(self, studio_id: str) -> StudioPaymentAccountResponse:
        account = self.connect_accounts.ensure_row(studio_id)
        if self.connect_accounts.should_refresh(account):
            account = self.connect_accounts.refresh_status(account, strict=False)
        return self.connect_accounts.response(account)

    async def create_onboarding_link(
        self,
        studio_id: str,
        actor_id: str,
        refresh_url: Optional[str] = None,
        return_url: Optional[str] = None,
        business_entity_type: Optional[str] = None,
        request_idempotency_key: Optional[str] = None,
    ) -> ConnectOnboardingLinkResponse:
        frontend_url = self.billing_service.settings.FRONTEND_URL.rstrip("/")
        safe_refresh_url = self.billing_service._safe_redirect_url(
            refresh_url,
            f"{frontend_url}/billing/connect/refresh",
        )
        safe_return_url = self.billing_service._safe_redirect_url(
            return_url,
            f"{frontend_url}/billing?connect=return",
        )
        account = self.connect_accounts.ensure_row(studio_id)
        stripe_account_id = account.get("stripe_connected_account_id")
        stripe_service = self.stripe_service_cls(supabase=self.billing_service.supabase)
        bootstrap_context = None
        stripe_mode = configured_stripe_mode(stripe_service.settings)
        authorization_store = (
            StudioLiveBillingAuthorizationStore(self.billing_service.supabase)
            if stripe_mode == "live"
            else None
        )

        if authorization_store is not None:
            bootstrap_context = authorization_store.load_connect_onboarding_bootstrap_recovery(
                studio_id=studio_id,
            )
            if bootstrap_context is not None:
                recovery = bootstrap_context.recovery_context or {}
                if (
                    recovery.get("refresh_url") != safe_refresh_url
                    or recovery.get("return_url") != safe_return_url
                    or (
                        business_entity_type is not None
                        and recovery.get("business_entity_type") != business_entity_type
                    )
                ):
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="Stripe onboarding recovery must use the original verified context.",
                    )
                if (
                    stripe_account_id is not None
                    and bootstrap_context.stripe_connected_account_id != stripe_account_id
                ):
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="Stripe onboarding recovery requires support because the account mapping changed.",
                    )
                stripe_account_id = bootstrap_context.stripe_connected_account_id
                business_entity_type = str(recovery.get("business_entity_type") or "")

        if not stripe_account_id:
            if business_entity_type not in {"company", "individual"}:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Choose whether this Stripe account is for a company or a sole proprietor.",
                )
            account_generation = int((account.get("metadata") or {}).get("connect_account_generation") or 1)
            if bootstrap_context is None:
                studio = self.billing_service._get_studio(studio_id)
                recovery_context = {
                    "business_name": studio.get("name") or "Koaryu studio",
                    "contact_email": (
                        self.billing_service._get_user_email(actor_id)
                        or self.billing_service._get_user_email(studio.get("owner_id"))
                    ),
                    "business_entity_type": business_entity_type,
                    "refresh_url": safe_refresh_url,
                    "return_url": safe_return_url,
                }
                bootstrap_context = new_connect_onboarding_bootstrap_context(
                    studio_id=studio_id,
                    account_generation=account_generation,
                    refresh_url=safe_refresh_url,
                    return_url=safe_return_url,
                    recovery_context=recovery_context,
                )
                if authorization_store is not None:
                    account_payload = build_connect_account_v2_payload(
                        studio_id=studio_id,
                        business_name=recovery_context["business_name"],
                        contact_email=recovery_context["contact_email"],
                        business_entity_type=business_entity_type,
                    )
                    bootstrap_context = authorization_store.prepare_connect_onboarding_bootstrap(
                        studio_id=studio_id,
                        recovery_context=recovery_context,
                        account_create_payload_sha256=stripe_payload_sha256(account_payload),
                        bootstrap_context=bootstrap_context,
                    )
            recovery_context = bootstrap_context.recovery_context or {
                "business_name": self.billing_service._get_studio(studio_id).get("name") or "Koaryu studio",
                "contact_email": self.billing_service._get_user_email(actor_id),
                "business_entity_type": business_entity_type,
                "refresh_url": safe_refresh_url,
                "return_url": safe_return_url,
            }
            stripe_account = stripe_service.create_connect_account(
                studio_id=studio_id,
                business_name=str(recovery_context["business_name"]),
                contact_email=recovery_context.get("contact_email"),
                business_entity_type=str(recovery_context["business_entity_type"]),
                account_generation=account_generation,
                bootstrap_context=bootstrap_context,
            )
            stripe_account_id = stripe_account["id"] if isinstance(stripe_account, dict) else stripe_account.id
            if authorization_store is not None:
                account = authorization_store.bind_created_connect_account(
                    studio_id=studio_id,
                    account_id=stripe_account_id,
                    business_entity_type=str(recovery_context["business_entity_type"]),
                    bootstrap_context=bootstrap_context,
                )
            else:
                metadata = dict(account.get("metadata") or {})
                metadata["business_entity_type"] = business_entity_type
                metadata["connect_account_generation"] = account_generation
                account = self.connect_accounts.update(studio_id, {
                    "stripe_connected_account_id": stripe_account_id,
                    "status": "onboarding_incomplete",
                    "metadata": metadata,
                })

        link_payload = build_connect_onboarding_link_v2_payload(
            account_id=stripe_account_id,
            refresh_url=safe_refresh_url,
            return_url=safe_return_url,
        )
        ordinary_idempotency_key = None
        if bootstrap_context is None:
            normalized_request_key = normalize_idempotency_key(request_idempotency_key)
            if not normalized_request_key:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Idempotency-Key is required for a fresh Connect onboarding link.",
                )
            account_generation = int((account.get("metadata") or {}).get("connect_account_generation") or 1)
            ordinary_idempotency_key = build_idempotency_key(
                "connect-onboarding-link",
                studio_id,
                stripe_account_id,
                account_generation,
                normalized_request_key,
                stripe_payload_sha256(link_payload),
            )
        link = stripe_service.create_connect_onboarding_link(
            account_id=stripe_account_id,
            studio_id=studio_id,
            refresh_url=safe_refresh_url,
            return_url=safe_return_url,
            idempotency_key=ordinary_idempotency_key,
            bootstrap_context=bootstrap_context,
        )
        link_url = str(link["url"] if isinstance(link, dict) else link.url)
        delivery_receipt = None
        if authorization_store is not None and bootstrap_context is not None:
            delivery_receipt = authorization_store.record_connect_onboarding_initial_link_response(
                studio_id=studio_id,
                account_id=stripe_account_id,
                link_url=link_url,
                payload_sha256=stripe_payload_sha256(link_payload),
                bootstrap_context=bootstrap_context,
            )
        return ConnectOnboardingLinkResponse(
            pending_url=link_url,
            delivery_receipt=delivery_receipt,
        )

    async def acknowledge_onboarding_link_delivery(
        self,
        studio_id: str,
        delivery_receipt: str,
    ) -> ConnectOnboardingDeliveryAckResponse:
        stripe_service = self.stripe_service_cls(supabase=self.billing_service.supabase)
        if configured_stripe_mode(stripe_service.settings) != "live":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=LIVE_CONNECT_BOOTSTRAP_SUPPORT_DETAIL,
            )
        acknowledged = StudioLiveBillingAuthorizationStore(
            self.billing_service.supabase
        ).acknowledge_connect_onboarding_initial_link_delivery(
            studio_id=studio_id,
            delivery_receipt=delivery_receipt,
        )
        return ConnectOnboardingDeliveryAckResponse(acknowledged=acknowledged)

    async def sync_account(self, studio_id: str) -> StudioPaymentAccountResponse:
        account = self.connect_accounts.ensure_row(studio_id)
        if not account.get("stripe_connected_account_id"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Connect Stripe before syncing the account status.",
            )

        account = self.connect_accounts.refresh_status(account, strict=True)
        return self.connect_accounts.response(account)

    async def reset_account(self, studio_id: str, actor_id: str) -> StudioPaymentAccountResponse:
        account = self.connect_accounts.ensure_row(studio_id)
        stripe_account_id = account.get("stripe_connected_account_id")
        if not stripe_account_id:
            return self.connect_accounts.response(account)
        if self.billing_service._has_stripe_billing_history(studio_id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Reconnect requires support because this studio already has Stripe billing history.",
            )

        metadata = dict(account.get("metadata") or {})
        previous_accounts = list(metadata.get("previous_stripe_connected_account_ids") or [])
        previous_accounts.append(stripe_account_id)
        metadata["previous_stripe_connected_account_ids"] = list(dict.fromkeys(previous_accounts))
        metadata["connect_account_generation"] = int(metadata.get("connect_account_generation") or 1) + 1
        account = self.connect_accounts.update(studio_id, {
            "stripe_connected_account_id": None,
            "status": "not_connected",
            "charges_enabled": False,
            "payouts_enabled": False,
            "details_submitted": False,
            "requirements_due": [],
            "metadata": metadata,
        })
        self.billing_service._audit(studio_id, actor_id, "billing.connect_account_reset", studio_id, {
            "previous_stripe_account_id": stripe_account_id,
        })
        return self.connect_accounts.response(account)

    async def create_dashboard_link(self, studio_id: str, actor_id: str) -> BillingLinkResponse:
        account = self.connect_accounts.ensure_row(studio_id)
        stripe_account_id = account.get("stripe_connected_account_id")
        if not stripe_account_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Connect Stripe before opening the Stripe dashboard.",
            )
        url = self.stripe_service_cls().create_connect_dashboard_url(
            account_id=stripe_account_id,
            studio_id=studio_id,
        )
        return BillingLinkResponse(url=url)

    def audit_onboarding_started(self, studio_id: str, actor_id: str) -> None:
        account = self.connect_accounts.ensure_row(studio_id)
        self.billing_service._audit_best_effort(
            studio_id,
            actor_id,
            "billing.connect_onboarding_started",
            studio_id,
            {"stripe_account_id": account.get("stripe_connected_account_id")},
        )

    def audit_dashboard_opened(self, studio_id: str, actor_id: str) -> None:
        account = self.connect_accounts.ensure_row(studio_id)
        self.billing_service._audit_best_effort(
            studio_id,
            actor_id,
            "billing.connect_dashboard_opened",
            studio_id,
            {"stripe_account_id": account.get("stripe_connected_account_id")},
        )

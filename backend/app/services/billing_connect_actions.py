from __future__ import annotations

from typing import Optional

from fastapi import HTTPException, status

from app.schemas.billing import BillingLinkResponse, StudioPaymentAccountResponse
from app.services.billing_connect_accounts import BillingConnectAccountStore
from app.services.stripe_service import StripeService


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
    ) -> BillingLinkResponse:
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
        stripe_service = self.stripe_service_cls()

        if not stripe_account_id:
            if business_entity_type not in {"company", "individual"}:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Choose whether this Stripe account is for a company or a sole proprietor.",
                )
            studio = self.billing_service._get_studio(studio_id)
            account_generation = int((account.get("metadata") or {}).get("connect_account_generation") or 1)
            stripe_account = stripe_service.create_connect_account(
                studio_id=studio_id,
                business_name=studio.get("name") or "Koaryu studio",
                contact_email=(
                    self.billing_service._get_user_email(actor_id)
                    or self.billing_service._get_user_email(studio.get("owner_id"))
                ),
                business_entity_type=business_entity_type,
                account_generation=account_generation,
            )
            stripe_account_id = stripe_account["id"] if isinstance(stripe_account, dict) else stripe_account.id
            metadata = dict(account.get("metadata") or {})
            metadata["business_entity_type"] = business_entity_type
            account = self.connect_accounts.update(studio_id, {
                "stripe_connected_account_id": stripe_account_id,
                "status": "onboarding_incomplete",
                "metadata": metadata,
            })

        link = stripe_service.create_connect_onboarding_link(
            account_id=stripe_account_id,
            refresh_url=safe_refresh_url,
            return_url=safe_return_url,
        )
        return BillingLinkResponse(url=link["url"] if isinstance(link, dict) else link.url)

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
        url = self.stripe_service_cls().create_connect_dashboard_url(account_id=stripe_account_id)
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

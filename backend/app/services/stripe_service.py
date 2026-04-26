from __future__ import annotations

import importlib
from typing import Any, Optional

from fastapi import HTTPException, status

from app.core.config import get_settings


class StripeService:
    """Thin wrapper around Stripe so the rest of the app stays testable."""

    def __init__(self):
        self.settings = get_settings()

    def _stripe(self):
        if not self.settings.STRIPE_SECRET_KEY:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Stripe is not configured for this environment.",
            )

        try:
            stripe = importlib.import_module("stripe")
        except ModuleNotFoundError as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Stripe SDK is not installed. Install backend requirements before using live billing.",
            ) from exc

        stripe.api_key = self.settings.STRIPE_SECRET_KEY
        return stripe

    def create_customer(self, *, name: str, metadata: dict[str, Any]):
        stripe = self._stripe()
        return stripe.Customer.create(name=name, metadata=metadata)

    def create_core_checkout_session(
        self,
        *,
        customer_id: str,
        studio_id: str,
        success_url: str,
        cancel_url: str,
    ):
        if not self.settings.STRIPE_KOARYU_CORE_PRICE_ID:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Koaryu Core Stripe price is not configured.",
            )
        stripe = self._stripe()
        return stripe.checkout.Session.create(
            customer=customer_id,
            mode="subscription",
            line_items=[{"price": self.settings.STRIPE_KOARYU_CORE_PRICE_ID, "quantity": 1}],
            subscription_data={
                "trial_period_days": 30,
                "metadata": {"studio_id": studio_id, "product": "koaryu_core"},
            },
            metadata={"studio_id": studio_id, "product": "koaryu_core"},
            success_url=success_url,
            cancel_url=cancel_url,
        )

    def create_customer_portal_session(self, *, customer_id: str, return_url: str):
        stripe = self._stripe()
        return stripe.billing_portal.Session.create(customer=customer_id, return_url=return_url)

    def create_connect_account(self, *, studio_id: str, business_name: str):
        stripe = self._stripe()
        try:
            return stripe.Account.create(
                type="express",
                metadata={"studio_id": studio_id},
                business_profile={"name": business_name},
                capabilities={
                    "card_payments": {"requested": True},
                    "transfers": {"requested": True},
                },
            )
        except Exception as exc:
            if exc.__class__.__module__.startswith("stripe"):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        "Stripe Connect is not ready for this Stripe account. "
                        "Enable Connect in the Stripe Dashboard before starting studio payment onboarding."
                    ),
                ) from exc
            raise

    def create_connect_onboarding_link(
        self,
        *,
        account_id: str,
        refresh_url: str,
        return_url: str,
    ):
        stripe = self._stripe()
        return stripe.AccountLink.create(
            account=account_id,
            refresh_url=refresh_url,
            return_url=return_url,
            type="account_onboarding",
        )

    def create_connect_dashboard_link(self, *, account_id: str):
        stripe = self._stripe()
        return stripe.Account.create_login_link(account_id)

    def construct_webhook_event(self, *, payload: bytes, signature: Optional[str], secret: str):
        if not secret:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Stripe webhook secret is not configured.",
            )
        if not signature:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing Stripe signature.")
        stripe = self._stripe()
        try:
            return stripe.Webhook.construct_event(payload, signature, secret)
        except Exception as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Stripe webhook signature.") from exc

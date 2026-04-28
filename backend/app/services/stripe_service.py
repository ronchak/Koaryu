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

    @staticmethod
    def _request_options(*, account_id: Optional[str] = None, idempotency_key: Optional[str] = None) -> dict[str, str]:
        options: dict[str, str] = {}
        if account_id:
            options["stripe_account"] = account_id
        if idempotency_key:
            options["idempotency_key"] = idempotency_key
        return options

    def create_connected_customer(
        self,
        *,
        account_id: str,
        name: str,
        email: Optional[str] = None,
        phone: Optional[str] = None,
        address: Optional[dict[str, Any]] = None,
        metadata: dict[str, Any],
        idempotency_key: str,
    ):
        stripe = self._stripe()
        payload: dict[str, Any] = {"name": name, "metadata": metadata}
        if email:
            payload["email"] = email
        if phone:
            payload["phone"] = phone
        if address:
            payload["address"] = {k: v for k, v in address.items() if v}
        return stripe.Customer.create(
            **payload,
            **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    def update_connected_customer(
        self,
        *,
        account_id: str,
        customer_id: str,
        name: str,
        email: Optional[str] = None,
        phone: Optional[str] = None,
        address: Optional[dict[str, Any]] = None,
        metadata: dict[str, Any],
    ):
        stripe = self._stripe()
        payload: dict[str, Any] = {"name": name, "metadata": metadata}
        payload["email"] = email or ""
        payload["phone"] = phone or ""
        if address is not None:
            payload["address"] = {k: v for k, v in address.items() if v}
        return stripe.Customer.modify(
            customer_id,
            **payload,
            **self._request_options(account_id=account_id),
        )

    def retrieve_connected_customer(self, *, account_id: str, customer_id: str, expand: Optional[list[str]] = None):
        stripe = self._stripe()
        payload: dict[str, Any] = {}
        if expand:
            payload["expand"] = expand
        return stripe.Customer.retrieve(customer_id, **payload, **self._request_options(account_id=account_id))

    def set_connected_customer_default_payment_method(
        self,
        *,
        account_id: str,
        customer_id: str,
        payment_method_id: str,
    ):
        stripe = self._stripe()
        return stripe.Customer.modify(
            customer_id,
            invoice_settings={"default_payment_method": payment_method_id},
            **self._request_options(account_id=account_id),
        )

    def retrieve_connected_setup_intent(self, *, account_id: str, setup_intent_id: str, expand: Optional[list[str]] = None):
        stripe = self._stripe()
        payload: dict[str, Any] = {}
        if expand:
            payload["expand"] = expand
        return stripe.SetupIntent.retrieve(setup_intent_id, **payload, **self._request_options(account_id=account_id))

    def create_connected_product(
        self,
        *,
        account_id: str,
        name: str,
        description: Optional[str],
        metadata: dict[str, Any],
        idempotency_key: str,
    ):
        stripe = self._stripe()
        payload: dict[str, Any] = {"name": name, "metadata": metadata}
        if description:
            payload["description"] = description
        return stripe.Product.create(
            **payload,
            **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    def update_connected_product(
        self,
        *,
        account_id: str,
        product_id: str,
        name: str,
        description: Optional[str],
        metadata: dict[str, Any],
    ):
        stripe = self._stripe()
        return stripe.Product.modify(
            product_id,
            name=name,
            description=description or "",
            metadata=metadata,
            **self._request_options(account_id=account_id),
        )

    def create_connected_price(
        self,
        *,
        account_id: str,
        product_id: str,
        unit_amount: int,
        currency: str,
        recurring: Optional[dict[str, Any]],
        lookup_key: str,
        metadata: dict[str, Any],
        idempotency_key: str,
    ):
        stripe = self._stripe()
        payload: dict[str, Any] = {
            "product": product_id,
            "unit_amount": unit_amount,
            "currency": currency,
            "lookup_key": lookup_key,
            "metadata": metadata,
        }
        if recurring:
            payload["recurring"] = recurring
        return stripe.Price.create(
            **payload,
            **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    def create_setup_checkout_session(
        self,
        *,
        account_id: str,
        customer_id: str,
        success_url: str,
        cancel_url: str,
        metadata: dict[str, Any],
        idempotency_key: str,
    ):
        stripe = self._stripe()
        return stripe.checkout.Session.create(
            customer=customer_id,
            currency="usd",
            mode="setup",
            setup_intent_data={"metadata": metadata},
            metadata=metadata,
            success_url=success_url,
            cancel_url=cancel_url,
            **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    def create_connected_subscription(
        self,
        *,
        account_id: str,
        customer_id: str,
        price_id: str,
        collection_method: str,
        application_fee_percent: float,
        default_payment_method: Optional[str],
        trial_days: int,
        metadata: dict[str, Any],
        item_metadata: dict[str, Any],
        days_until_due: Optional[int],
        idempotency_key: str,
    ):
        stripe = self._stripe()
        payload: dict[str, Any] = {
            "customer": customer_id,
            "items": [{"price": price_id, "quantity": 1, "metadata": item_metadata}],
            "collection_method": collection_method,
            "application_fee_percent": application_fee_percent,
            "metadata": metadata,
            "expand": ["latest_invoice", "items.data"],
        }
        if collection_method == "send_invoice":
            payload["days_until_due"] = days_until_due or 7
        if default_payment_method:
            payload["default_payment_method"] = default_payment_method
        if trial_days > 0:
            payload["trial_period_days"] = trial_days
        return stripe.Subscription.create(
            **payload,
            **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    def create_connected_subscription_item(
        self,
        *,
        account_id: str,
        subscription_id: str,
        price_id: str,
        metadata: dict[str, Any],
        idempotency_key: str,
    ):
        stripe = self._stripe()
        return stripe.SubscriptionItem.create(
            subscription=subscription_id,
            price=price_id,
            quantity=1,
            metadata=metadata,
            proration_behavior="none",
            **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    def update_connected_subscription_item(self, *, account_id: str, subscription_item_id: str, **payload: Any):
        stripe = self._stripe()
        return stripe.SubscriptionItem.modify(
            subscription_item_id,
            **payload,
            **self._request_options(account_id=account_id),
        )

    def delete_connected_subscription_item(self, *, account_id: str, subscription_item_id: str):
        stripe = self._stripe()
        return stripe.SubscriptionItem.delete(subscription_item_id, **self._request_options(account_id=account_id))

    def update_connected_subscription(self, *, account_id: str, subscription_id: str, **payload: Any):
        stripe = self._stripe()
        return stripe.Subscription.modify(subscription_id, **payload, **self._request_options(account_id=account_id))

    def cancel_connected_subscription(self, *, account_id: str, subscription_id: str):
        stripe = self._stripe()
        return stripe.Subscription.cancel(subscription_id, **self._request_options(account_id=account_id))

    def create_connected_invoice_item(
        self,
        *,
        account_id: str,
        customer_id: str,
        amount: int,
        currency: str,
        description: str,
        metadata: dict[str, Any],
        idempotency_key: str,
        invoice_id: Optional[str] = None,
    ):
        stripe = self._stripe()
        payload: dict[str, Any] = {
            "customer": customer_id,
            "amount": amount,
            "currency": currency,
            "description": description,
            "metadata": metadata,
        }
        if invoice_id:
            payload["invoice"] = invoice_id
        return stripe.InvoiceItem.create(
            **payload,
            **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    def create_connected_invoice(
        self,
        *,
        account_id: str,
        customer_id: str,
        collection_method: str,
        application_fee_amount: int,
        metadata: dict[str, Any],
        due_date: Optional[int] = None,
        days_until_due: Optional[int] = None,
        default_payment_method: Optional[str] = None,
        idempotency_key: str,
    ):
        stripe = self._stripe()
        payload: dict[str, Any] = {
            "customer": customer_id,
            "collection_method": collection_method,
            "metadata": metadata,
            "auto_advance": False,
        }
        if application_fee_amount > 0:
            payload["application_fee_amount"] = application_fee_amount
        if collection_method == "send_invoice":
            if due_date:
                payload["due_date"] = due_date
            else:
                payload["days_until_due"] = days_until_due or 7
        if default_payment_method:
            payload["default_payment_method"] = default_payment_method
        return stripe.Invoice.create(
            **payload,
            **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    def finalize_connected_invoice(self, *, account_id: str, invoice_id: str):
        stripe = self._stripe()
        return stripe.Invoice.finalize_invoice(invoice_id, **self._request_options(account_id=account_id))

    def send_connected_invoice(self, *, account_id: str, invoice_id: str):
        stripe = self._stripe()
        return stripe.Invoice.send_invoice(invoice_id, **self._request_options(account_id=account_id))

    def pay_connected_invoice(self, *, account_id: str, invoice_id: str, paid_out_of_band: bool = False):
        stripe = self._stripe()
        payload: dict[str, Any] = {}
        if paid_out_of_band:
            payload["paid_out_of_band"] = True
        return stripe.Invoice.pay(
            invoice_id,
            **payload,
            **self._request_options(account_id=account_id),
        )

    def void_connected_invoice(self, *, account_id: str, invoice_id: str):
        stripe = self._stripe()
        return stripe.Invoice.void_invoice(invoice_id, **self._request_options(account_id=account_id))

    def retrieve_connected_invoice(self, *, account_id: str, invoice_id: str, expand: Optional[list[str]] = None):
        stripe = self._stripe()
        payload: dict[str, Any] = {}
        if expand:
            payload["expand"] = expand
        return stripe.Invoice.retrieve(invoice_id, **payload, **self._request_options(account_id=account_id))

    def retrieve_connected_payment_intent(self, *, account_id: str, payment_intent_id: str, expand: Optional[list[str]] = None):
        stripe = self._stripe()
        payload: dict[str, Any] = {}
        if expand:
            payload["expand"] = expand
        return stripe.PaymentIntent.retrieve(payment_intent_id, **payload, **self._request_options(account_id=account_id))

    def create_connected_refund(
        self,
        *,
        account_id: str,
        charge_id: str,
        amount: Optional[int],
        reason: Optional[str],
        refund_application_fee: bool,
        metadata: dict[str, Any],
        idempotency_key: str,
    ):
        stripe = self._stripe()
        payload: dict[str, Any] = {
            "charge": charge_id,
            "refund_application_fee": refund_application_fee,
            "metadata": metadata,
        }
        if amount:
            payload["amount"] = amount
        if reason:
            payload["reason"] = reason
        return stripe.Refund.create(
            **payload,
            **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

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

    def retrieve_subscription(self, subscription_id: str, *, expand: Optional[list[str]] = None):
        stripe = self._stripe()
        params = {"expand": expand or ["items.data"]}
        return stripe.Subscription.retrieve(subscription_id, **params)

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

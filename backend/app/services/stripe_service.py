from __future__ import annotations

import importlib
from functools import wraps
from typing import Any, Optional
from urllib.parse import quote

from fastapi import HTTPException, status

from app.core.config import get_settings, parse_stripe_webhook_secrets
from app.services.stripe_connect_gateway import (
    STRIPE_ACCOUNTS_V2_VERSION,
    StripeConnectGateway,
    _StripeV2RequestError,
    stripe_v2_request,
)
from app.services.stripe_mutation_policy import (
    StripeMutationBlocked,
    StripeMutationPermit,
    StripeMutationPolicy,
)
from app.services.studio_live_billing_authorizations import (
    ConnectOnboardingBootstrapContext,
    connect_initial_link_context_sha256,
    stripe_payload_sha256,
)


def _exact_keys(value: Any, required: set[str], optional: set[str] | None = None) -> bool:
    return isinstance(value, dict) and set(value) == required | (set(value) & (optional or set()))


def _valid_connect_account_create_payload(payload: dict[str, Any], studio_id: Optional[str]) -> bool:
    if not studio_id or not _exact_keys(
        payload,
        {"display_name", "dashboard", "identity", "configuration", "defaults", "metadata", "include"},
        {"contact_email"},
    ):
        return False
    display_name = payload.get("display_name")
    identity = payload.get("identity")
    configuration = payload.get("configuration")
    defaults = payload.get("defaults")
    metadata = payload.get("metadata")
    entity_type = identity.get("entity_type") if isinstance(identity, dict) else None
    identity_keys = {"country", "entity_type", "business_details"} if entity_type == "company" else {"country", "entity_type"}
    return bool(
        isinstance(display_name, str)
        and display_name
        and payload.get("dashboard") == "full"
        and _exact_keys(identity, identity_keys)
        and identity.get("country") == "us"
        and entity_type in {"company", "individual"}
        and (
            entity_type != "company"
            or identity.get("business_details") == {"registered_name": display_name}
        )
        and configuration == {"merchant": {"capabilities": {"card_payments": {"requested": True}}}}
        and _exact_keys(defaults, {"currency", "responsibilities", "profile", "locales"})
        and defaults.get("currency") == "usd"
        and defaults.get("locales") == ["en-US"]
        and defaults.get("responsibilities") == {
            "fees_collector": "stripe",
            "losses_collector": "stripe",
        }
        and defaults.get("profile") == {
            "doing_business_as": display_name,
            "product_description": "Martial arts tuition and membership payments",
        }
        and metadata == {
            "studio_id": studio_id,
            "product": "koaryu_payments",
            "business_entity_type": entity_type,
        }
        and payload.get("include") == ["configuration.merchant", "identity", "defaults", "requirements"]
        and (
            "contact_email" not in payload
            or isinstance(payload.get("contact_email"), str) and bool(payload.get("contact_email"))
        )
    )


def _valid_connect_onboarding_payload(payload: dict[str, Any], account_id: Optional[str]) -> bool:
    use_case = payload.get("use_case")
    onboarding = use_case.get("account_onboarding") if isinstance(use_case, dict) else None
    return bool(
        account_id
        and _exact_keys(payload, {"account", "use_case"})
        and payload.get("account") == account_id
        and _exact_keys(use_case, {"type", "account_onboarding"})
        and use_case.get("type") == "account_onboarding"
        and _exact_keys(
            onboarding,
            {"configurations", "collection_options", "refresh_url", "return_url"},
        )
        and onboarding.get("configurations") == ["merchant"]
        and onboarding.get("collection_options") == {"fields": "eventually_due"}
        and all(
            isinstance(onboarding.get(key), str) and bool(onboarding.get(key))
            for key in ("refresh_url", "return_url")
        )
    )


def _valid_connect_branding_payload(payload: dict[str, Any]) -> bool:
    configuration = payload.get("configuration")
    merchant = configuration.get("merchant") if isinstance(configuration, dict) else None
    branding = merchant.get("branding") if isinstance(merchant, dict) else None
    return bool(
        _exact_keys(payload, {"configuration", "include"})
        and payload.get("include") == ["configuration.merchant"]
        and _exact_keys(configuration, {"merchant"})
        and _exact_keys(merchant, {"branding"})
        and _exact_keys(branding, {"primary_color", "secondary_color"}, {"icon", "logo"})
        and all(isinstance(value, str) and bool(value) for value in branding.values())
    )


def stripe_mutation(operation: str):
    """Mark and authorize a Stripe mutation before any provider client runs."""

    def decorator(func):
        @wraps(func)
        def wrapped(self, *args, **kwargs):
            self._authorize_stripe_mutation(
                operation,
                studio_id=kwargs.get("studio_id"),
                account_id=kwargs.get("account_id"),
            )
            return func(self, *args, **kwargs)

        wrapped.__stripe_mutation_operation__ = operation
        return wrapped

    return decorator


def stripe_sink_guarded(operation: str):
    """Inventory marker for mutations authorized by the raw provider sink."""

    def decorator(func):
        func.__stripe_mutation_operation__ = operation
        func.__stripe_sink_guarded__ = True
        return func

    return decorator


class StripeService:
    """Thin wrapper around Stripe so the rest of the app stays testable."""

    def __init__(self, *, supabase: Any = None):
        self.settings = get_settings()
        self.supabase = supabase

    def _authorize_stripe_mutation(
        self,
        operation: str,
        *,
        studio_id: Optional[str] = None,
        account_id: Optional[str] = None,
        payload_sha256: Optional[str] = None,
        bootstrap_context: Optional[ConnectOnboardingBootstrapContext] = None,
    ) -> StripeMutationPermit:
        if self.supabase is None:
            return StripeMutationPolicy(self.settings).issue_permit(
                operation,
                studio_id=studio_id,
                account_id=account_id,
                payload_sha256=payload_sha256,
                bootstrap_context=bootstrap_context,
            )
        from app.services.studio_live_billing_authorizations import StudioLiveBillingAuthorizationStore

        return StripeMutationPolicy(
            self.settings,
            authorization_store=StudioLiveBillingAuthorizationStore(self.supabase),
        ).issue_permit(
            operation,
            studio_id=studio_id,
            account_id=account_id,
            payload_sha256=payload_sha256,
            bootstrap_context=bootstrap_context,
        )

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

    @stripe_mutation("customer.create")
    def create_customer(
        self,
        *,
        name: str,
        metadata: dict[str, Any],
        studio_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ):
        stripe = self._stripe()
        return stripe.Customer.create(
            name=name,
            metadata=metadata,
            **self._request_options(idempotency_key=idempotency_key),
        )

    @staticmethod
    def _request_options(*, account_id: Optional[str] = None, idempotency_key: Optional[str] = None) -> dict[str, str]:
        options: dict[str, str] = {}
        if account_id:
            options["stripe_account"] = account_id
        if idempotency_key:
            options["idempotency_key"] = idempotency_key
        return options

    def _connect_gateway(self) -> StripeConnectGateway:
        return StripeConnectGateway(
            settings=self.settings,
            stripe_loader=self._stripe,
            request_options=self._request_options,
            stripe_v2_post=self._stripe_v2_post,
            stripe_v2_patch=self._stripe_v2_patch,
            authorize_mutation=self._authorize_stripe_mutation,
        )

    @stripe_mutation("connected_customer.create")
    def create_connected_customer(
        self,
        *,
        account_id: str,
        studio_id: str,
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

    @stripe_mutation("connected_customer.update")
    def update_connected_customer(
        self,
        *,
        account_id: str,
        studio_id: str,
        customer_id: str,
        name: str,
        email: Optional[str] = None,
        phone: Optional[str] = None,
        address: Optional[dict[str, Any]] = None,
        metadata: dict[str, Any],
        idempotency_key: Optional[str] = None,
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
            **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    def retrieve_connected_customer(self, *, account_id: str, customer_id: str, expand: Optional[list[str]] = None):
        stripe = self._stripe()
        payload: dict[str, Any] = {}
        if expand:
            payload["expand"] = expand
        return stripe.Customer.retrieve(customer_id, **payload, **self._request_options(account_id=account_id))

    @stripe_mutation("connected_customer.default_payment_method.update")
    def set_connected_customer_default_payment_method(
        self,
        *,
        account_id: str,
        studio_id: str,
        customer_id: str,
        payment_method_id: str,
        idempotency_key: Optional[str] = None,
    ):
        stripe = self._stripe()
        return stripe.Customer.modify(
            customer_id,
            invoice_settings={"default_payment_method": payment_method_id},
            **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    def retrieve_connected_setup_intent(self, *, account_id: str, setup_intent_id: str, expand: Optional[list[str]] = None):
        stripe = self._stripe()
        payload: dict[str, Any] = {}
        if expand:
            payload["expand"] = expand
        return stripe.SetupIntent.retrieve(setup_intent_id, **payload, **self._request_options(account_id=account_id))

    @stripe_mutation("connected_product.create")
    def create_connected_product(
        self,
        *,
        account_id: str,
        studio_id: str,
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

    @stripe_mutation("connected_product.update")
    def update_connected_product(
        self,
        *,
        account_id: str,
        studio_id: str,
        product_id: str,
        name: str,
        description: Optional[str],
        metadata: dict[str, Any],
        idempotency_key: Optional[str] = None,
    ):
        stripe = self._stripe()
        return stripe.Product.modify(
            product_id,
            name=name,
            description=description or "",
            metadata=metadata,
            **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    @stripe_mutation("connected_price.create")
    def create_connected_price(
        self,
        *,
        account_id: str,
        studio_id: str,
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

    @stripe_mutation("connected_setup_checkout_session.create")
    def create_setup_checkout_session(
        self,
        *,
        account_id: str,
        studio_id: str,
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

    @stripe_mutation("connected_subscription.create")
    def create_connected_subscription(
        self,
        *,
        account_id: str,
        studio_id: str,
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

    @stripe_mutation("connected_subscription_item.create")
    def create_connected_subscription_item(
        self,
        *,
        account_id: str,
        studio_id: str,
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

    @stripe_mutation("connected_subscription_item.update")
    def update_connected_subscription_item(
        self,
        *,
        account_id: str,
        studio_id: str,
        subscription_item_id: str,
        idempotency_key: Optional[str] = None,
        **payload: Any,
    ):
        stripe = self._stripe()
        return stripe.SubscriptionItem.modify(
            subscription_item_id,
            **payload,
            **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    @stripe_mutation("connected_subscription_item.delete")
    def delete_connected_subscription_item(
        self, *, account_id: str, studio_id: str, subscription_item_id: str, idempotency_key: Optional[str] = None,
    ):
        stripe = self._stripe()
        return stripe.SubscriptionItem.delete(
            subscription_item_id, **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    @stripe_mutation("connected_subscription.update")
    def update_connected_subscription(
        self, *, account_id: str, studio_id: str, subscription_id: str, idempotency_key: Optional[str] = None, **payload: Any,
    ):
        stripe = self._stripe()
        return stripe.Subscription.modify(
            subscription_id, **payload, **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    @stripe_mutation("connected_subscription.cancel")
    def cancel_connected_subscription(
        self, *, account_id: str, studio_id: str, subscription_id: str, idempotency_key: Optional[str] = None,
    ):
        stripe = self._stripe()
        return stripe.Subscription.cancel(
            subscription_id, **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    @stripe_mutation("connected_invoice_item.create")
    def create_connected_invoice_item(
        self,
        *,
        account_id: str,
        studio_id: str,
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

    @stripe_mutation("connected_invoice.create")
    def create_connected_invoice(
        self,
        *,
        account_id: str,
        studio_id: str,
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

    @stripe_mutation("connected_invoice.finalize")
    def finalize_connected_invoice(
        self, *, account_id: str, studio_id: str, invoice_id: str, idempotency_key: Optional[str] = None,
    ):
        stripe = self._stripe()
        return stripe.Invoice.finalize_invoice(
            invoice_id, **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    @stripe_mutation("connected_invoice.send")
    def send_connected_invoice(
        self, *, account_id: str, studio_id: str, invoice_id: str, idempotency_key: Optional[str] = None,
    ):
        stripe = self._stripe()
        return stripe.Invoice.send_invoice(
            invoice_id, **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    @stripe_mutation("connected_invoice.pay")
    def pay_connected_invoice(
        self,
        *,
        account_id: str,
        studio_id: str,
        invoice_id: str,
        paid_out_of_band: bool = False,
        idempotency_key: Optional[str] = None,
    ):
        stripe = self._stripe()
        payload: dict[str, Any] = {}
        if paid_out_of_band:
            payload["paid_out_of_band"] = True
        return stripe.Invoice.pay(
            invoice_id,
            **payload,
            **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

    @stripe_mutation("connected_invoice.void")
    def void_connected_invoice(
        self, *, account_id: str, studio_id: str, invoice_id: str, idempotency_key: Optional[str] = None,
    ):
        stripe = self._stripe()
        return stripe.Invoice.void_invoice(
            invoice_id, **self._request_options(account_id=account_id, idempotency_key=idempotency_key),
        )

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

    def retrieve_connected_subscription(self, *, account_id: str, subscription_id: str, expand: Optional[list[str]] = None):
        stripe = self._stripe()
        payload: dict[str, Any] = {"expand": expand or ["items.data"]}
        return stripe.Subscription.retrieve(subscription_id, **payload, **self._request_options(account_id=account_id))

    @stripe_mutation("connected_refund.create")
    def create_connected_refund(
        self,
        *,
        account_id: str,
        studio_id: str,
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

    @stripe_mutation("core_checkout_session.create")
    def create_core_checkout_session(
        self,
        *,
        customer_id: str,
        studio_id: str,
        success_url: str,
        cancel_url: str,
        reservation_token: str,
        checkout_epoch: int,
        trial_period_days: Optional[int] = None,
        idempotency_key: Optional[str] = None,
    ):
        if not self.settings.STRIPE_KOARYU_CORE_PRICE_ID:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Koaryu Core Stripe price is not configured.",
            )
        stripe = self._stripe()
        subscription_data: dict[str, Any] = {
            "metadata": {
                "studio_id": studio_id,
                "product": "koaryu_core",
                "core_checkout_reservation_token": reservation_token,
                "core_checkout_epoch": str(checkout_epoch),
            },
        }
        if trial_period_days is not None:
            subscription_data["trial_period_days"] = trial_period_days
        return stripe.checkout.Session.create(
            customer=customer_id,
            mode="subscription",
            line_items=[{"price": self.settings.STRIPE_KOARYU_CORE_PRICE_ID, "quantity": 1}],
            subscription_data=subscription_data,
            metadata={
                "studio_id": studio_id,
                "product": "koaryu_core",
                "core_checkout_reservation_token": reservation_token,
                "core_checkout_epoch": str(checkout_epoch),
            },
            success_url=success_url,
            cancel_url=cancel_url,
            **self._request_options(idempotency_key=idempotency_key),
        )

    @stripe_mutation("core_checkout_session.expire")
    def expire_core_checkout_session(
        self,
        *,
        session_id: str,
        studio_id: str,
        idempotency_key: Optional[str] = None,
    ):
        stripe = self._stripe()
        return stripe.checkout.Session.expire(
            session_id,
            **self._request_options(idempotency_key=idempotency_key),
        )

    @stripe_mutation("core_subscription.cancel")
    def cancel_core_subscription(
        self,
        *,
        subscription_id: str,
        studio_id: str,
        idempotency_key: Optional[str] = None,
    ):
        stripe = self._stripe()
        return stripe.Subscription.cancel(
            subscription_id,
            **self._request_options(idempotency_key=idempotency_key),
        )

    @stripe_mutation("customer_portal_session.create")
    def create_customer_portal_session(
        self,
        *,
        customer_id: str,
        return_url: str,
        studio_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ):
        stripe = self._stripe()
        return stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=return_url,
            **self._request_options(idempotency_key=idempotency_key),
        )

    def retrieve_subscription(self, subscription_id: str, *, expand: Optional[list[str]] = None):
        stripe = self._stripe()
        params = {"expand": expand or ["items.data"]}
        return stripe.Subscription.retrieve(subscription_id, **params)

    def list_customer_subscriptions(self, customer_id: str, *, limit: int = 5):
        stripe = self._stripe()
        return stripe.Subscription.list(
            customer=customer_id,
            status="all",
            limit=limit,
            expand=["data.items.data"],
        )

    @stripe_sink_guarded("connect_account.create")
    def create_connect_account(
        self,
        *,
        studio_id: str,
        business_name: str,
        contact_email: Optional[str] = None,
        business_entity_type: str = "company",
        account_generation: int = 1,
        bootstrap_context: Optional[ConnectOnboardingBootstrapContext] = None,
    ):
        return self._connect_gateway().create_account(
            studio_id=studio_id,
            business_name=business_name,
            contact_email=contact_email,
            business_entity_type=business_entity_type,
            account_generation=account_generation,
            bootstrap_context=bootstrap_context,
        )

    @stripe_mutation("connect_branding_file.create")
    def upload_branding_file(
        self,
        *,
        file_path: str,
        purpose: str,
        studio_id: str,
        idempotency_key: Optional[str] = None,
    ) -> str:
        return self._connect_gateway().upload_branding_file(
            file_path=file_path, purpose=purpose, studio_id=studio_id, idempotency_key=idempotency_key,
        )

    @stripe_mutation("connect_account.branding.update")
    def update_connect_account_branding(
        self,
        *,
        account_id: str,
        studio_id: str,
        primary_color: str,
        secondary_color: str,
        icon_file_id: Optional[str] = None,
        logo_file_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        return self._connect_gateway().update_branding(
            account_id=account_id,
            studio_id=studio_id,
            primary_color=primary_color,
            secondary_color=secondary_color,
            icon_file_id=icon_file_id,
            logo_file_id=logo_file_id,
            idempotency_key=idempotency_key,
        )

    @stripe_sink_guarded("connect_onboarding_link.create")
    def create_connect_onboarding_link(
        self,
        *,
        account_id: str,
        studio_id: str,
        refresh_url: str,
        return_url: str,
        idempotency_key: Optional[str] = None,
        bootstrap_context: Optional[ConnectOnboardingBootstrapContext] = None,
    ):
        return self._connect_gateway().create_onboarding_link(
            account_id=account_id,
            studio_id=studio_id,
            refresh_url=refresh_url,
            return_url=return_url,
            idempotency_key=idempotency_key,
            bootstrap_context=bootstrap_context,
        )

    def create_connect_dashboard_link(self, *, account_id: str, studio_id: str):
        return self._connect_gateway().create_dashboard_link(account_id=account_id, studio_id=studio_id)

    def retrieve_account(self, *, account_id: Optional[str] = None):
        return self._connect_gateway().retrieve_account(account_id=account_id)

    def create_connect_dashboard_url(self, *, account_id: str, studio_id: str) -> str:
        return self._connect_gateway().create_dashboard_url(account_id=account_id, studio_id=studio_id)

    def _stripe_v2_post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        operation: str,
        studio_id: Optional[str] = None,
        account_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        bootstrap_context: Optional[ConnectOnboardingBootstrapContext] = None,
    ) -> dict[str, Any]:
        return self._stripe_v2_request(
            "POST", path, payload, operation=operation, studio_id=studio_id, account_id=account_id,
            idempotency_key=idempotency_key,
            bootstrap_context=bootstrap_context,
        )

    def _stripe_v2_patch(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        operation: str,
        studio_id: Optional[str] = None,
        account_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        bootstrap_context: Optional[ConnectOnboardingBootstrapContext] = None,
    ) -> dict[str, Any]:
        return self._stripe_v2_request(
            "PATCH", path, payload, operation=operation, studio_id=studio_id, account_id=account_id,
            idempotency_key=idempotency_key,
            bootstrap_context=bootstrap_context,
        )

    def _stripe_v2_request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any],
        *,
        operation: str,
        studio_id: Optional[str] = None,
        account_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        bootstrap_context: Optional[ConnectOnboardingBootstrapContext] = None,
    ) -> dict[str, Any]:
        request_matches_operation = (
            operation == "connect_account.create"
            and method == "POST"
            and path == "/v2/core/accounts"
            and account_id is None
            and _valid_connect_account_create_payload(payload, studio_id)
        ) or (
            operation == "connect_onboarding_link.create"
            and method == "POST"
            and path == "/v2/core/account_links"
            and _valid_connect_onboarding_payload(payload, account_id)
        ) or (
            operation == "connect_account.branding.update"
            and method == "PATCH"
            and bool(account_id)
            and path == f"/v2/core/accounts/{quote(account_id, safe='')}"
            and _valid_connect_branding_payload(payload)
        )
        if not request_matches_operation:
            raise StripeMutationBlocked(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Stripe Accounts v2 request does not match an authorized operation.",
            )
        if bootstrap_context and (
            (operation == "connect_account.create"
             and idempotency_key != bootstrap_context.account_create_idempotency_key)
            or (operation == "connect_onboarding_link.create"
                and idempotency_key != bootstrap_context.initial_link_idempotency_key)
            or operation not in {"connect_account.create", "connect_onboarding_link.create"}
        ):
            raise StripeMutationBlocked(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Stripe bootstrap request does not match its stored idempotency context.",
            )
        if bootstrap_context and operation == "connect_onboarding_link.create":
            onboarding = payload["use_case"]["account_onboarding"]
            link_context_sha256 = connect_initial_link_context_sha256(
                studio_id=studio_id or "",
                account_generation=bootstrap_context.account_generation,
                refresh_url=onboarding["refresh_url"],
                return_url=onboarding["return_url"],
            )
            if link_context_sha256 != bootstrap_context.initial_link_context_sha256:
                raise StripeMutationBlocked(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Stripe bootstrap request does not match its stored initial-link context.",
                )
        self._authorize_stripe_mutation(
            operation,
            studio_id=studio_id,
            account_id=account_id,
            payload_sha256=stripe_payload_sha256(payload),
            bootstrap_context=bootstrap_context,
        )
        return stripe_v2_request(
            self.settings,
            method,
            path,
            payload,
            idempotency_key=idempotency_key,
        )

    def construct_webhook_event(self, *, payload: bytes, signature: Optional[str], secret: str):
        secrets = self._webhook_secrets(secret)
        if not secrets:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Stripe webhook secret is not configured.",
            )
        if not signature:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing Stripe signature.")
        stripe = self._stripe()
        last_error: Optional[Exception] = None
        for candidate in secrets:
            try:
                return stripe.Webhook.construct_event(payload, signature, candidate)
            except Exception as exc:
                last_error = exc
                continue
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Stripe webhook signature.") from last_error

    @staticmethod
    def _webhook_secrets(secret: str) -> list[str]:
        return parse_stripe_webhook_secrets("Stripe webhook secret", secret)

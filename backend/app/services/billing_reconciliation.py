from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from supabase import Client

from app.schemas.billing import BillingReconcileRequest, BillingReconcileResponse
from app.services.billing_audit import record_billing_audit
from app.services.billing_connect_actions import BillingConnectActions
from app.services.billing_connect_accounts import BillingConnectAccountStore
from app.services.billing_invoice_projection import (
    invoice_subscription_id,
    merge_invoice_identity_from_stored_event,
)
from app.services.billing_payment_projection import BillingPaymentEventProjector
from app.services.billing_subscription_webhook_projection import (
    BillingSubscriptionWebhookProjector,
)
from app.services.billing_webhook_projection import BillingWebhookProjector
from app.services.stripe_service import StripeService


class BillingReconciliationService:
    def __init__(
        self,
        supabase: Client,
        connect_accounts: BillingConnectAccountStore,
        connect_actions: BillingConnectActions,
        *,
        stripe_service_cls: type[StripeService] = StripeService,
    ):
        self.supabase = supabase
        self.connect_accounts = connect_accounts
        self.connect_actions = connect_actions
        self.stripe_service_cls = stripe_service_cls
        self.webhook_projector = BillingWebhookProjector(
            supabase,
            connect_accounts,
            stripe_service_cls=stripe_service_cls,
        )
        self.payment_projector = BillingPaymentEventProjector(
            supabase,
            connect_accounts,
            stripe_service_cls=stripe_service_cls,
        )
        self.subscription_projector = BillingSubscriptionWebhookProjector(
            supabase,
            connect_accounts,
        )

    async def reconcile_stripe_object(
        self,
        data: BillingReconcileRequest,
        studio_id: str,
        actor_id: str,
    ) -> BillingReconcileResponse:
        if data.object_type == "connect_account":
            return await self._reconcile_connect_account(data, studio_id, actor_id)

        if data.object_type == "payer":
            return await self._reconcile_payer(data, studio_id, actor_id)

        if not data.stripe_object_id:
            raise HTTPException(
                status_code=400, detail="stripe_object_id is required for this reconciliation."
            )

        account = self.connect_accounts.ensure_ready(studio_id)
        account_id = account["stripe_connected_account_id"]
        stripe_service = self.stripe_service_cls()

        if data.object_type == "invoice":
            return self._reconcile_invoice(
                data,
                studio_id,
                actor_id,
                account_id,
                stripe_service,
            )

        if data.object_type == "subscription":
            return self._reconcile_subscription(
                data,
                studio_id,
                actor_id,
                account_id,
                stripe_service,
            )

        return self._reconcile_payment_intent(
            data,
            studio_id,
            actor_id,
            account_id,
            stripe_service,
        )

    async def _reconcile_connect_account(
        self,
        data: BillingReconcileRequest,
        studio_id: str,
        actor_id: str,
    ) -> BillingReconcileResponse:
        account = await self.connect_actions.sync_account(studio_id)
        record_billing_audit(
            self.supabase,
            studio_id,
            actor_id,
            "billing.reconcile_connect_account",
            studio_id,
            {"stripe_account_id": account.stripe_connected_account_id},
        )
        return BillingReconcileResponse(
            object_type=data.object_type,
            stripe_object_id=account.stripe_connected_account_id,
            local_object_id=studio_id,
            status=account.status,
            detail="Connect account status was refreshed from Stripe.",
        )

    async def _reconcile_payer(
        self,
        data: BillingReconcileRequest,
        studio_id: str,
        actor_id: str,
    ) -> BillingReconcileResponse:
        if not data.payer_id:
            raise HTTPException(
                status_code=400, detail="payer_id is required to reconcile a payer."
            )
        raise HTTPException(
            status_code=409,
            detail=(
                "Payer reconciliation cannot start a nested provider workflow. "
                "Use the payer sync action with its own Idempotency-Key."
            ),
        )

    def _reconcile_invoice(
        self,
        data: BillingReconcileRequest,
        studio_id: str,
        actor_id: str,
        account_id: str,
        stripe_service: StripeService,
    ) -> BillingReconcileResponse:
        stripe_invoice = stripe_service.retrieve_connected_invoice(
            account_id=account_id,
            invoice_id=data.stripe_object_id,
            expand=["payment_intent"],
        )
        invoice = self._stripe_object_to_dict(stripe_invoice)
        stored_invoice = self.webhook_projector.stored_stripe_event_object(
            account_id,
            data.stripe_object_id,
            ["invoice.paid", "invoice.finalized", "invoice.created"],
        )
        if (
            stored_invoice
            and invoice_subscription_id(stored_invoice)
            and not invoice_subscription_id(invoice)
        ):
            invoice = merge_invoice_identity_from_stored_event(invoice, stored_invoice)

        event_type = "invoice.paid" if invoice.get("status") == "paid" else "invoice.finalized"
        self.webhook_projector.project_invoice_event(
            invoice, account_id, event_type, event_created=None
        )
        local = self.webhook_projector.find_invoice_for_stripe(invoice, account_id)
        record_billing_audit(
            self.supabase,
            studio_id,
            actor_id,
            "billing.reconcile_invoice",
            local.get("id") if local else data.stripe_object_id,
            {"stripe_invoice_id": data.stripe_object_id},
        )
        return BillingReconcileResponse(
            object_type=data.object_type,
            stripe_object_id=data.stripe_object_id,
            local_object_id=(local or {}).get("id"),
            status=(local or {}).get("status") or "reconciled",
            detail="Invoice was refreshed from Stripe.",
        )

    def _reconcile_subscription(
        self,
        data: BillingReconcileRequest,
        studio_id: str,
        actor_id: str,
        account_id: str,
        stripe_service: StripeService,
    ) -> BillingReconcileResponse:
        stripe_subscription = stripe_service.retrieve_connected_subscription(
            account_id=account_id,
            subscription_id=data.stripe_object_id,
            expand=["items.data"],
        )
        subscription = self._stripe_object_to_dict(stripe_subscription)
        local = self.subscription_projector.project_subscription(
            subscription,
            account_id,
            "customer.subscription.updated",
            None,
        )
        record_billing_audit(
            self.supabase,
            studio_id,
            actor_id,
            "billing.reconcile_subscription",
            (local or {}).get("id") or data.stripe_object_id,
            {"stripe_subscription_id": data.stripe_object_id},
        )
        return BillingReconcileResponse(
            object_type=data.object_type,
            stripe_object_id=data.stripe_object_id,
            local_object_id=(local or {}).get("id"),
            status=(local or {}).get("status") or subscription.get("status") or "reconciled",
            detail="Subscription was refreshed from Stripe.",
        )

    def _reconcile_payment_intent(
        self,
        data: BillingReconcileRequest,
        studio_id: str,
        actor_id: str,
        account_id: str,
        stripe_service: StripeService,
    ) -> BillingReconcileResponse:
        stripe_intent = stripe_service.retrieve_connected_payment_intent(
            account_id=account_id,
            payment_intent_id=data.stripe_object_id,
            expand=["latest_charge", "payment_method"],
        )
        intent = self._stripe_object_to_dict(stripe_intent)
        if intent.get("status") == "requires_capture":
            raise HTTPException(
                status_code=409,
                detail="This payment is authorized but has not been captured. Reconciliation cannot record it as collected.",
            )
        event_type = "payment_intent.succeeded"
        if intent.get("status") == "processing":
            event_type = "payment_intent.processing"
        elif intent.get("status") != "succeeded":
            event_type = "payment_intent.payment_failed"

        self.payment_projector.project_payment_intent(intent, account_id, event_type)
        local_payment = self.payment_projector.find_payment_by_intent(
            account_id, data.stripe_object_id
        )
        record_billing_audit(
            self.supabase,
            studio_id,
            actor_id,
            "billing.reconcile_payment_intent",
            (local_payment or {}).get("id") or data.stripe_object_id,
            {"stripe_payment_intent_id": data.stripe_object_id},
        )
        return BillingReconcileResponse(
            object_type=data.object_type,
            stripe_object_id=data.stripe_object_id,
            local_object_id=(local_payment or {}).get("id"),
            status=(local_payment or {}).get("status") or intent.get("status") or "reconciled",
            detail="PaymentIntent was refreshed from Stripe.",
        )

    @staticmethod
    def _stripe_object_to_dict(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        if hasattr(value, "to_dict_recursive"):
            return value.to_dict_recursive()
        if hasattr(value, "to_dict"):
            return value.to_dict()
        return dict(value)

from __future__ import annotations

from fastapi import HTTPException

from app.schemas.billing import BillingReconcileRequest, BillingReconcileResponse
from app.services.billing_invoice_projection import (
    invoice_subscription_id,
    merge_invoice_identity_from_stored_event,
)
from app.services.stripe_service import StripeService


class BillingReconciliationService:
    def __init__(self, billing_service, *, stripe_service_cls=StripeService):
        self.billing_service = billing_service
        self.stripe_service_cls = stripe_service_cls

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
            raise HTTPException(status_code=400, detail="stripe_object_id is required for this reconciliation.")

        account = self.billing_service._ensure_connect_ready(studio_id)
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
        account = await self.billing_service.sync_connect_account(studio_id)
        self.billing_service._audit(
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
            raise HTTPException(status_code=400, detail="payer_id is required to reconcile a payer.")
        payer = await self.billing_service.sync_payer(data.payer_id, studio_id, actor_id)
        return BillingReconcileResponse(
            object_type=data.object_type,
            stripe_object_id=payer.stripe_customer_id,
            local_object_id=payer.id,
            status=payer.billing_status,
            detail="Payer customer and default payment method were refreshed from Stripe.",
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
        invoice = self.billing_service._stripe_object_to_dict(stripe_invoice)
        stored_invoice = self.billing_service._stored_stripe_event_object(
            account_id,
            data.stripe_object_id,
            ["invoice.paid", "invoice.finalized", "invoice.created"],
        )
        if stored_invoice and invoice_subscription_id(stored_invoice) and not invoice_subscription_id(invoice):
            invoice = merge_invoice_identity_from_stored_event(invoice, stored_invoice)

        event_type = "invoice.paid" if invoice.get("status") == "paid" else "invoice.finalized"
        self.billing_service._project_invoice_event(invoice, account_id, event_type, event_created=None)
        local = self.billing_service._find_invoice_for_stripe(invoice, account_id)
        self.billing_service._audit(
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
        subscription = self.billing_service._stripe_object_to_dict(stripe_subscription)
        local = self.billing_service._project_subscription(
            subscription,
            account_id,
            "customer.subscription.updated",
            None,
        )
        self.billing_service._audit(
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
        intent = self.billing_service._stripe_object_to_dict(stripe_intent)
        event_type = "payment_intent.succeeded"
        if intent.get("status") == "processing":
            event_type = "payment_intent.processing"
        elif intent.get("status") not in {"succeeded", "requires_capture"}:
            event_type = "payment_intent.payment_failed"

        self.billing_service._project_payment_intent(intent, account_id, event_type)
        local_payment = self.billing_service._find_payment_by_intent(account_id, data.stripe_object_id)
        self.billing_service._audit(
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

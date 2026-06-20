from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException

from app.schemas.billing import BillingPayerCreate, BillingPayerResponse, BillingPayerUpdate
from app.services.billing_invoice_projection import _object_get, _stripe_id
from app.services.stripe_service import StripeService


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

    def _validate_connect_account_access(self, account: dict[str, Any]) -> None:
        self.billing_service._validate_connect_account_access(account)

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
        account = self._connect_accounts().ensure_row(studio_id)
        if account.get("charges_enabled"):
            self._validate_connect_account_access(account)
        result = self.supabase.table("billing_payers").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create payer.")
        payer = result.data[0]
        if account.get("charges_enabled"):
            payer = self._sync_payer_customer(payer, account)
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
        account = self._connect_accounts().ensure_row(studio_id)
        if account.get("charges_enabled"):
            self._validate_connect_account_access(account)
        result = self.supabase.table("billing_payers").update(update).eq("id", payer_id).eq("studio_id", studio_id).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Payer not found.")
        payer = result.data[0]
        if account.get("charges_enabled"):
            payer = self._sync_payer_customer(payer, account)
        self._audit(studio_id, actor_id, "billing.payer_updated", payer_id, {"changes": update})
        return BillingPayerResponse(**payer)

    async def sync_payer(self, payer_id: str, studio_id: str, actor_id: str) -> BillingPayerResponse:
        payer = self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        account = self._ensure_connect_ready(studio_id)
        payer = self._sync_payer_customer(payer, account)
        self._audit(studio_id, actor_id, "billing.payer_synced", payer_id, {
            "stripe_account_id": account.get("stripe_connected_account_id"),
            "stripe_customer_id": payer.get("stripe_customer_id"),
        })
        return BillingPayerResponse(**payer)

    def _sync_payer_customer(self, payer: dict[str, Any], account: dict[str, Any]) -> dict[str, Any]:
        account_id = account.get("stripe_connected_account_id")
        if not account_id:
            return payer
        stripe_service = self.stripe_service_cls()
        metadata = {"studio_id": payer["studio_id"], "payer_id": payer["id"], "product": "koaryu_payments"}
        address = {
            "line1": payer.get("address_line1"),
            "city": payer.get("address_city"),
            "state": payer.get("address_state"),
            "postal_code": payer.get("address_zip"),
        }
        customer_id = payer.get("stripe_customer_id")
        if customer_id:
            stripe_service.update_connected_customer(
                account_id=account_id,
                customer_id=customer_id,
                name=payer.get("display_name") or "Koaryu payer",
                email=payer.get("email"),
                phone=payer.get("phone"),
                address=address,
                metadata=metadata,
            )
        else:
            customer = stripe_service.create_connected_customer(
                account_id=account_id,
                name=payer.get("display_name") or "Koaryu payer",
                email=payer.get("email"),
                phone=payer.get("phone"),
                address=address,
                metadata=metadata,
                idempotency_key=self._idempotency_key("payer-customer", payer["id"]),
            )
            customer_id = _stripe_id(customer)
        customer = stripe_service.retrieve_connected_customer(
            account_id=account_id,
            customer_id=customer_id,
            expand=["invoice_settings.default_payment_method"],
        )
        payment_fields = self._payment_method_fields_from_customer(customer)
        update = {
            "stripe_account_id": account_id,
            "stripe_customer_id": customer_id,
            **payment_fields,
        }
        if payment_fields.get("default_payment_method_id") and payer.get("autopay_status") in {"not_configured", "pending"}:
            update["billing_status"] = "current"
        result = (
            self.supabase.table("billing_payers")
            .update(update)
            .eq("id", payer["id"])
            .eq("studio_id", payer["studio_id"])
            .execute()
        )
        return result.data[0] if result.data else {**payer, **update}

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

    def _store_invoice_payment_method(
        self,
        studio_id: str,
        payer_id: str,
        account_id: Optional[str],
        customer_id: Optional[str],
        payment_method: Any,
    ) -> None:
        payment_method_id = _stripe_id(payment_method)
        if not account_id or not customer_id or not payment_method_id:
            return
        try:
            stripe_service = self.stripe_service_cls()
            stripe_service.set_connected_customer_default_payment_method(
                account_id=account_id,
                customer_id=customer_id,
                payment_method_id=payment_method_id,
            )
            customer = stripe_service.retrieve_connected_customer(
                account_id=account_id,
                customer_id=customer_id,
                expand=["invoice_settings.default_payment_method"],
            )
            payment_fields = self._payment_method_fields_from_customer(customer)
        except Exception:
            payment_fields = self._payment_method_fields_from_payment_method(payment_method)
        payment_fields = {key: value for key, value in payment_fields.items() if value is not None}
        if not payment_fields:
            return
        self.supabase.table("billing_payers").update({
            "stripe_account_id": account_id,
            "stripe_customer_id": customer_id,
            **payment_fields,
        }).eq("id", payer_id).eq("studio_id", studio_id).execute()

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

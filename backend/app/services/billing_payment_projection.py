from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from app.services.billing_invoice_projection import _object_get, _stripe_id
from app.services.billing_webhook_event_state import (
    PAYMENT_STATUS_ORDER,
    add_stripe_event_created_guard,
    is_same_second_status_regression,
    is_stale_stripe_event,
)
from app.services.stripe_service import StripeService


PAYMENT_PROJECTION_PRESERVED_INVOICE_STATUSES = {"partially_refunded", "refunded", "void"}


class BillingPaymentEventProjector:
    def __init__(self, billing_service: Any, *, stripe_service_cls: type[StripeService] = StripeService):
        self.billing_service = billing_service
        self.stripe_service_cls = stripe_service_cls

    @property
    def supabase(self):
        return self.billing_service.supabase

    def _resolve_stripe_event_studio_id(
        self,
        account_id: Optional[str],
        *,
        metadata_studio_id: Optional[str] = None,
        local_studio_id: Optional[str] = None,
    ) -> Optional[str]:
        return self.billing_service._resolve_stripe_event_studio_id(
            account_id,
            metadata_studio_id=metadata_studio_id,
            local_studio_id=local_studio_id,
        )

    def _payer_id_for_customer(
        self,
        studio_id: str,
        account_id: Optional[str],
        customer_id: Optional[str],
    ) -> Optional[str]:
        return self.billing_service._payer_id_for_customer(studio_id, account_id, customer_id)

    def _latest_charge(self, intent: dict[str, Any]) -> Any:
        return self.billing_service._latest_charge(intent)

    def _payment_method_type(self, intent: dict[str, Any], charge: Any) -> Optional[str]:
        return self.billing_service._payment_method_type(intent, charge)

    def _store_invoice_payment_method(
        self,
        studio_id: str,
        payer_id: str,
        account_id: Optional[str],
        customer_id: Optional[str],
        payment_method: Any,
    ) -> None:
        self.billing_service._store_invoice_payment_method(
            studio_id,
            payer_id,
            account_id,
            customer_id,
            payment_method,
        )

    def _recompute_payer_balance(self, studio_id: str, payer_id: Optional[str]) -> None:
        self.billing_service._recompute_payer_balance(studio_id, payer_id)

    def _project_payment_intent(
        self,
        intent: dict[str, Any],
        account_id: Optional[str],
        event_type: str,
        event_created: Optional[int] = None,
    ) -> None:
        metadata = intent.get("metadata") or {}
        customer_id = _stripe_id(intent.get("customer"))
        invoice_id = _stripe_id(intent.get("invoice")) or metadata.get("invoice_id")
        local_invoice = self._find_invoice_by_payment_intent_or_invoice(
            account_id,
            _stripe_id(intent),
            invoice_id,
        )
        studio_id = self._resolve_stripe_event_studio_id(
            account_id,
            metadata_studio_id=metadata.get("studio_id"),
            local_studio_id=(local_invoice or {}).get("studio_id"),
        )
        if not studio_id:
            return
        if local_invoice and is_stale_stripe_event(local_invoice, event_created):
            return
        payer_id = metadata.get("payer_id") or (local_invoice or {}).get("payer_id") or self._payer_id_for_customer(studio_id, account_id, customer_id)
        if not payer_id and not local_invoice and metadata.get("product") != "koaryu_payments":
            return
        status_value = "processing" if event_type == "payment_intent.processing" else ("succeeded" if event_type == "payment_intent.succeeded" else "failed")
        charge = self._latest_charge(intent)
        charge_id = _stripe_id(charge)
        row = {
            "studio_id": studio_id,
            "payer_id": payer_id,
            "invoice_id": (local_invoice or {}).get("id"),
            "stripe_customer_id": customer_id,
            "stripe_invoice_id": invoice_id,
            "stripe_payment_intent_id": _stripe_id(intent),
            "stripe_charge_id": charge_id,
            "stripe_account_id": account_id,
            "stripe_payment_method_id": _stripe_id(intent.get("payment_method")),
            "status": status_value,
            "amount_cents": int(intent.get("amount_received") or intent.get("amount") or 0),
            "currency": intent.get("currency") or "usd",
            "payment_method_type": self._payment_method_type(intent, charge),
            "receipt_url": _object_get(charge, "receipt_url"),
            "failure_code": _object_get(_object_get(intent, "last_payment_error"), "code"),
            "failure_message": _object_get(_object_get(intent, "last_payment_error"), "message"),
            "application_fee_amount_cents": int(
                intent.get("application_fee_amount")
                if intent.get("application_fee_amount") is not None
                else (local_invoice or {}).get("application_fee_amount_cents") or 0
            ),
            "processed_at": datetime.now(timezone.utc).isoformat() if status_value == "succeeded" else None,
        }
        if event_created is not None:
            row["last_stripe_event_created"] = event_created
        existing = (
            self.supabase.table("billing_payments")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("stripe_account_id", account_id)
            .eq("stripe_payment_intent_id", _stripe_id(intent))
            .limit(1)
            .execute()
        )
        if existing.data:
            existing_payment = existing.data[0]
            if is_stale_stripe_event(existing_payment, event_created):
                return
            if is_same_second_status_regression(
                existing_payment.get("last_stripe_event_created"),
                event_created,
                current_status=existing_payment.get("status"),
                incoming_status=status_value,
                status_order=PAYMENT_STATUS_ORDER,
            ):
                return
            if existing_payment.get("status") in {"disputed", "refunded"}:
                row["status"] = existing_payment["status"]
                row["processed_at"] = existing_payment.get("processed_at") or row.get("processed_at")
            elif existing_payment.get("status") == "succeeded" and status_value in {"processing", "failed"}:
                row["status"] = "succeeded"
                row["processed_at"] = existing_payment.get("processed_at") or row.get("processed_at")
                row["failure_code"] = existing_payment.get("failure_code")
                row["failure_message"] = existing_payment.get("failure_message")
            query = self.supabase.table("billing_payments").update(row).eq("id", existing_payment["id"])
            query = add_stripe_event_created_guard(query, event_created)
            result = query.execute()
            if not result.data:
                return
        else:
            result = self.supabase.table("billing_payments").insert(row).execute()
        payment = result.data[0] if result.data else row
        payment = self._link_disputes_to_payment(payment, account_id)
        payment_status = payment.get("status")
        invoice_recomputed = False
        if local_invoice and payment_status in {"succeeded", "failed"}:
            if not self._record_payment_projection_invoice_metadata(
                local_invoice,
                row,
                payment_status=payment_status,
                event_created=event_created,
                studio_id=studio_id,
                stripe_payment_intent_id=_stripe_id(intent),
            ):
                return
            if local_invoice.get("status") not in PAYMENT_PROJECTION_PRESERVED_INVOICE_STATUSES:
                self._refresh_invoice_and_payer_from_payment_events(payment)
                invoice_recomputed = True
        if payment_status == "succeeded" and row.get("payer_id"):
            self._store_invoice_payment_method(
                studio_id,
                row["payer_id"],
                account_id,
                _stripe_id(intent.get("customer")),
                intent.get("payment_method"),
            )
        if payment.get("payer_id") and not invoice_recomputed:
            self._recompute_payer_balance(studio_id, payment.get("payer_id"))

    def _record_payment_projection_invoice_metadata(
        self,
        local_invoice: dict[str, Any],
        row: dict[str, Any],
        *,
        payment_status: str,
        event_created: Optional[int],
        studio_id: str,
        stripe_payment_intent_id: Optional[str],
    ) -> bool:
        update: dict[str, Any] = {
            "last_payment_error": row.get("failure_message") if payment_status == "failed" else None,
        }
        if (
            payment_status == "succeeded"
            and local_invoice.get("status") not in PAYMENT_PROJECTION_PRESERVED_INVOICE_STATUSES
        ):
            update.update({
                "stripe_payment_intent_id": stripe_payment_intent_id,
                "application_fee_amount_cents": row["application_fee_amount_cents"],
                "paid_at": datetime.now(timezone.utc).isoformat(),
            })
        if event_created is not None:
            update["last_stripe_event_created"] = event_created
        invoice_query = (
            self.supabase.table("billing_invoices")
            .update(update)
            .eq("id", local_invoice["id"])
            .eq("studio_id", studio_id)
        )
        invoice_query = add_stripe_event_created_guard(invoice_query, event_created)
        invoice_result = invoice_query.execute()
        return event_created is None or bool(invoice_result.data)

    def _link_disputes_to_payment(self, payment: dict[str, Any], account_id: Optional[str]) -> dict[str, Any]:
        charge_id = payment.get("stripe_charge_id")
        payment_id = payment.get("id")
        studio_id = payment.get("studio_id")
        if not charge_id or not payment_id or not studio_id:
            return payment
        query = (
            self.supabase.table("billing_disputes")
            .select("id, status")
            .eq("studio_id", studio_id)
            .eq("stripe_charge_id", charge_id)
        )
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        disputes = query.execute()
        if not disputes.data:
            return payment

        dispute_ids = [row["id"] for row in disputes.data if row.get("id")]
        dispute_update = {"payment_id": payment_id}
        if payment.get("stripe_payment_intent_id"):
            dispute_update["stripe_payment_intent_id"] = payment["stripe_payment_intent_id"]
        if dispute_ids:
            self.supabase.table("billing_disputes").update(dispute_update).in_("id", dispute_ids).execute()

        if payment.get("status") == "disputed":
            self._refresh_invoice_and_payer_from_payment_events(payment)
            return payment
        result = self.supabase.table("billing_payments").update({"status": "disputed"}).eq("id", payment_id).execute()
        updated_payment = result.data[0] if result.data else {**payment, "status": "disputed"}
        self._refresh_invoice_and_payer_from_payment_events(updated_payment)
        return updated_payment

    def _project_charge_refund(self, charge: dict[str, Any], account_id: Optional[str]) -> None:
        refunds = ((charge.get("refunds") or {}).get("data") or [])
        for refund in refunds:
            self._project_refund(refund, account_id, charge=charge)

    def _project_refund(self, refund: Any, account_id: Optional[str], *, charge: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        refund_dict = refund if isinstance(refund, dict) else refund.to_dict_recursive() if hasattr(refund, "to_dict_recursive") else dict(refund)
        charge_id = _stripe_id(refund_dict.get("charge")) or _stripe_id(charge)
        payment = self._find_payment_by_charge(account_id, charge_id)
        studio_id = self._resolve_stripe_event_studio_id(
            account_id,
            metadata_studio_id=(refund_dict.get("metadata") or {}).get("studio_id"),
            local_studio_id=(payment or {}).get("studio_id"),
        )
        if not studio_id:
            return {}
        row = {
            "studio_id": studio_id,
            "payment_id": (payment or {}).get("id"),
            "stripe_refund_id": _stripe_id(refund_dict),
            "stripe_charge_id": charge_id,
            "stripe_payment_intent_id": _stripe_id(refund_dict.get("payment_intent")) or (payment or {}).get("stripe_payment_intent_id"),
            "stripe_account_id": account_id,
            "amount_cents": int(refund_dict.get("amount") or 0),
            "status": refund_dict.get("status") or "succeeded",
            "reason": refund_dict.get("reason"),
            "metadata": refund_dict.get("metadata") or {},
        }
        existing = (
            self.supabase.table("billing_refunds")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("stripe_account_id", account_id)
            .eq("stripe_refund_id", row["stripe_refund_id"])
            .limit(1)
            .execute()
        )
        if existing.data:
            delta = row["amount_cents"] - int(existing.data[0].get("amount_cents") or 0)
            result = self.supabase.table("billing_refunds").update(row).eq("id", existing.data[0]["id"]).execute()
        else:
            delta = row["amount_cents"]
            result = self.supabase.table("billing_refunds").insert(row).execute()
        if payment and delta:
            refunded = max(0, int(payment.get("refunded_amount_cents") or 0) + delta)
            payment_update = {
                "status": "refunded" if refunded >= int(payment.get("amount_cents") or 0) else payment.get("status"),
                "refunded_amount_cents": refunded,
            }
            payment_result = self.supabase.table("billing_payments").update(payment_update).eq("id", payment["id"]).execute()
            updated_payment = payment_result.data[0] if payment_result.data else {**payment, **payment_update}
            self._refresh_invoice_and_payer_from_payment_events(updated_payment)
        return result.data[0] if result.data else row

    def _project_dispute(self, dispute: dict[str, Any], account_id: Optional[str]) -> None:
        charge_id = _stripe_id(dispute.get("charge"))
        payment = self._find_payment_by_charge(account_id, charge_id)
        studio_id = self._resolve_stripe_event_studio_id(
            account_id,
            metadata_studio_id=(dispute.get("metadata") or {}).get("studio_id"),
            local_studio_id=(payment or {}).get("studio_id"),
        )
        if not studio_id:
            return
        row = {
            "studio_id": studio_id,
            "payment_id": (payment or {}).get("id"),
            "stripe_dispute_id": _stripe_id(dispute),
            "stripe_charge_id": charge_id,
            "stripe_payment_intent_id": (payment or {}).get("stripe_payment_intent_id"),
            "stripe_account_id": account_id,
            "amount_cents": int(dispute.get("amount") or 0),
            "status": dispute.get("status") or "needs_response",
            "reason": dispute.get("reason"),
            "liability_owner": "studio",
            "metadata": dispute.get("metadata") or {},
        }
        existing = (
            self.supabase.table("billing_disputes")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("stripe_account_id", account_id)
            .eq("stripe_dispute_id", row["stripe_dispute_id"])
            .limit(1)
            .execute()
        )
        if existing.data:
            self.supabase.table("billing_disputes").update(row).eq("id", existing.data[0]["id"]).execute()
        else:
            self.supabase.table("billing_disputes").insert(row).execute()
        if payment:
            payment_result = self.supabase.table("billing_payments").update({"status": "disputed"}).eq("id", payment["id"]).execute()
            updated_payment = payment_result.data[0] if payment_result.data else {**payment, "status": "disputed"}
            self._refresh_invoice_and_payer_from_payment_events(updated_payment)

    def _refresh_invoice_and_payer_from_payment_events(self, payment: dict[str, Any]) -> None:
        studio_id = payment.get("studio_id")
        invoice_id = payment.get("invoice_id")
        payer_id = payment.get("payer_id")
        if not studio_id:
            return
        if not invoice_id:
            self._recompute_payer_balance(studio_id, payer_id)
            return

        invoice_result = (
            self.supabase.table("billing_invoices")
            .select("*")
            .eq("id", invoice_id)
            .eq("studio_id", studio_id)
            .limit(1)
            .execute()
        )
        if not invoice_result.data:
            self._recompute_payer_balance(studio_id, payer_id)
            return
        invoice = invoice_result.data[0]
        if invoice.get("status") == "void":
            self._recompute_payer_balance(studio_id, payer_id or invoice.get("payer_id"))
            return

        payment_rows = (
            self.supabase.table("billing_payments")
            .select("amount_cents, refunded_amount_cents, status")
            .eq("studio_id", studio_id)
            .eq("invoice_id", invoice_id)
            .execute()
        )
        amount_due = int(invoice.get("amount_due_cents") or 0)
        net_paid = 0
        refunded_total = 0
        disputed_total = 0
        for row in payment_rows.data or []:
            amount = max(0, int(row.get("amount_cents") or 0))
            refunded = min(amount, max(0, int(row.get("refunded_amount_cents") or 0)))
            refunded_total += refunded
            if row.get("status") == "disputed":
                disputed_total += max(0, amount - refunded)
                continue
            if row.get("status") in {"succeeded", "refunded", "externally_recorded"}:
                net_paid += max(0, amount - refunded)

        amount_paid = min(amount_due, net_paid)
        amount_remaining = max(0, amount_due - amount_paid)
        if disputed_total and amount_remaining:
            status_value = "open"
        elif refunded_total >= amount_due and amount_due > 0 and amount_paid == 0:
            status_value = "refunded"
            amount_remaining = 0
        elif refunded_total:
            status_value = "partially_refunded"
        elif amount_due > 0 and amount_paid >= amount_due:
            status_value = "paid"
        else:
            status_value = "open"

        invoice_update: dict[str, Any] = {
            "status": status_value,
            "amount_paid_cents": amount_paid,
            "amount_remaining_cents": amount_remaining,
        }
        if status_value != "paid":
            invoice_update["paid_at"] = None
        self.supabase.table("billing_invoices").update(invoice_update).eq("id", invoice_id).eq("studio_id", studio_id).execute()
        self._recompute_payer_balance(studio_id, payer_id or invoice.get("payer_id"))

    def _project_payment_from_invoice(
        self,
        invoice: dict[str, Any],
        account_id: Optional[str],
        local_invoice: dict[str, Any],
        *,
        event_created: Optional[int] = None,
    ) -> None:
        payment_intent_id = _stripe_id(invoice.get("payment_intent"))
        if not payment_intent_id:
            return
        try:
            intent = self.stripe_service_cls().retrieve_connected_payment_intent(
                account_id=account_id or local_invoice["stripe_account_id"],
                payment_intent_id=payment_intent_id,
                expand=["latest_charge", "payment_method"],
            )
        except Exception:
            intent = {
                "id": payment_intent_id,
                "amount_received": invoice.get("amount_paid"),
                "currency": invoice.get("currency"),
                "customer": invoice.get("customer"),
                "invoice": invoice.get("id"),
                "status": "succeeded",
                "metadata": invoice.get("metadata") or {},
            }
        self._project_payment_intent(
            intent if isinstance(intent, dict) else intent.to_dict_recursive(),
            account_id,
            "payment_intent.succeeded",
            event_created,
        )

    def _find_invoice_by_payment_intent_or_invoice(
        self,
        account_id: Optional[str],
        payment_intent_id: Optional[str],
        stripe_invoice_id: Optional[str],
    ) -> Optional[dict[str, Any]]:
        if payment_intent_id:
            query = self.supabase.table("billing_invoices").select("*").eq("stripe_payment_intent_id", payment_intent_id).limit(1)
            query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
            result = query.execute()
            if result.data:
                return result.data[0]
        if stripe_invoice_id:
            query = self.supabase.table("billing_invoices").select("*").eq("stripe_invoice_id", stripe_invoice_id).limit(1)
            query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
            result = query.execute()
            if result.data:
                return result.data[0]
        return None

    def _find_invoice_by_customer_amount(
        self,
        account_id: Optional[str],
        customer_id: Optional[str],
        amount_cents: int,
        currency: str,
    ) -> Optional[dict[str, Any]]:
        if not customer_id or amount_cents <= 0:
            return None
        query = (
            self.supabase.table("billing_invoices")
            .select("*")
            .eq("stripe_customer_id", customer_id)
            .eq("amount_due_cents", amount_cents)
            .eq("amount_remaining_cents", amount_cents)
            .eq("currency", currency)
            .eq("status", "open")
            .is_("stripe_payment_intent_id", "null")
            .limit(2)
        )
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        rows = query.execute().data or []
        return rows[0] if len(rows) == 1 else None

    def _find_unlinked_payment_by_customer_amount(
        self,
        account_id: Optional[str],
        customer_id: Optional[str],
        amount_cents: int,
        currency: str,
    ) -> Optional[dict[str, Any]]:
        if not customer_id or amount_cents <= 0:
            return None
        query = (
            self.supabase.table("billing_payments")
            .select("*")
            .eq("stripe_customer_id", customer_id)
            .eq("amount_cents", amount_cents)
            .eq("currency", currency)
            .in_("status", ["processing", "succeeded"])
            .order("processed_at", desc=True)
            .limit(5)
        )
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        candidates = []
        for row in result.data or []:
            if row.get("invoice_id") or row.get("stripe_invoice_id"):
                continue
            candidates.append(row)
        return candidates[0] if len(candidates) == 1 else None

    def _find_payment_by_charge(self, account_id: Optional[str], charge_id: Optional[str]) -> Optional[dict[str, Any]]:
        if not charge_id:
            return None
        query = self.supabase.table("billing_payments").select("*").eq("stripe_charge_id", charge_id).limit(1)
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0] if result.data else None

    def _find_payment_by_intent(self, account_id: Optional[str], payment_intent_id: Optional[str]) -> Optional[dict[str, Any]]:
        if not payment_intent_id:
            return None
        query = self.supabase.table("billing_payments").select("*").eq("stripe_payment_intent_id", payment_intent_id).limit(1)
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0] if result.data else None

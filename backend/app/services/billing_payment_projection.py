from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from postgrest.exceptions import APIError as PostgrestAPIError

from app.services.billing_invoice_projection import _object_get, _stripe_id
from app.services.billing_webhook_event_state import (
    PAYMENT_STATUS_ORDER,
    add_stripe_event_created_guard,
    is_same_second_status_regression,
    is_stale_stripe_event,
)
from app.services.stripe_service import StripeService


PAYMENT_PROJECTION_PRESERVED_INVOICE_STATUSES = {"void"}
REFUND_EFFECTIVE_STATUSES = {"succeeded"}
REFUND_STATUS_ORDER = {
    "unknown": -1,
    "pending": 0,
    "requires_action": 0,
    "failed": 1,
    "canceled": 1,
    "succeeded": 2,
}
DISPUTE_TERMINAL_STATUSES = {"lost", "prevented", "warning_closed", "won"}
DISPUTE_STATUS_ORDER = {
    "warning_needs_response": 0,
    "warning_under_review": 1,
    "warning_closed": 2,
    "prevented": 3,
    "needs_response": 10,
    "under_review": 11,
    "lost": 20,
    "won": 21,
}
DISPUTE_BALANCE_REVERSING_CATEGORIES = {"active", "lost", "unknown"}
ADJUSTMENT_IDENTITY_MISMATCH = "payment_identity_mismatch"
ADJUSTMENT_OVER_REFUND = "succeeded_refunds_exceed_payment"
ADJUSTMENT_UNKNOWN_DISPUTE = "unknown_dispute_status"
ADJUSTMENT_HISTORICAL_GENERATION_UNKNOWN = "historical_connect_generation_unknown"
DURABLE_ADJUSTMENT_RECONCILIATION_REASONS = {
    ADJUSTMENT_IDENTITY_MISMATCH,
    ADJUSTMENT_HISTORICAL_GENERATION_UNKNOWN,
}

PAYMENT_ESTABLISHED_IDENTITY_FIELDS = (
    "studio_id",
    "payer_id",
    "invoice_id",
    "stripe_customer_id",
    "stripe_invoice_id",
    "stripe_payment_intent_id",
    "stripe_charge_id",
    "stripe_account_id",
    "connect_account_generation",
    "stripe_payment_method_id",
)
REFUND_ESTABLISHED_IDENTITY_FIELDS = (
    "studio_id",
    "payment_id",
    "stripe_refund_id",
    "stripe_charge_id",
    "stripe_payment_intent_id",
    "stripe_account_id",
    "connect_account_generation",
)
DISPUTE_ESTABLISHED_IDENTITY_FIELDS = (
    "studio_id",
    "payment_id",
    "stripe_dispute_id",
    "stripe_charge_id",
    "stripe_payment_intent_id",
    "stripe_account_id",
    "connect_account_generation",
)


def dispute_state_category(status: Any) -> str:
    normalized = str(status or "").strip().lower()
    if normalized in {"warning_needs_response", "warning_under_review", "warning_closed", "prevented"}:
        return "warning"
    if normalized in {"needs_response", "under_review"}:
        return "active"
    if normalized == "won":
        return "won"
    if normalized == "lost":
        return "lost"
    return "unknown"


class BillingPaymentEventProjector:
    def __init__(self, billing_service: Any, *, stripe_service_cls: type[StripeService] = StripeService):
        self.billing_service = billing_service
        self.stripe_service_cls = stripe_service_cls

    @property
    def supabase(self):
        return self.billing_service.supabase

    @staticmethod
    def _preserve_established_identity(
        row: dict[str, Any],
        existing: dict[str, Any],
        fields: tuple[str, ...],
    ) -> None:
        for field in fields:
            if existing.get(field) is not None:
                row[field] = existing[field]

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
        connect_account_generation = self._connect_account_generation(account_id, studio_id)
        amount_cents = int(intent.get("amount_received") or intent.get("amount") or 0)
        collected_amount_cents = amount_cents if status_value == "succeeded" else 0
        row = {
            "studio_id": studio_id,
            "payer_id": payer_id,
            "invoice_id": (local_invoice or {}).get("id"),
            "stripe_customer_id": customer_id,
            "stripe_invoice_id": invoice_id,
            "stripe_payment_intent_id": _stripe_id(intent),
            "stripe_charge_id": charge_id,
            "stripe_account_id": account_id,
            "connect_account_generation": connect_account_generation,
            "stripe_payment_method_id": _stripe_id(intent.get("payment_method")),
            "status": status_value,
            "amount_cents": amount_cents,
            "refunded_amount_cents": 0,
            "disputed_amount_cents": 0,
            "net_collected_amount_cents": collected_amount_cents,
            "refundable_amount_cents": collected_amount_cents if charge_id else 0,
            "adjustment_reconciliation_required": False,
            "adjustment_reconciliation_reason_code": None,
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
            self._preserve_established_identity(
                row,
                existing_payment,
                PAYMENT_ESTABLISHED_IDENTITY_FIELDS,
            )
            for field in (
                "adjustment_reconciliation_required",
                "adjustment_reconciliation_reason_code",
            ):
                if existing_payment.get(field) is not None:
                    row[field] = existing_payment[field]
            gross_amount = (
                max(0, int(row.get("amount_cents") or 0))
                if row.get("status") in {
                    "succeeded",
                    "refunded",
                    "disputed",
                    "externally_recorded",
                }
                else 0
            )
            refunded_amount = min(
                gross_amount,
                max(0, int(existing_payment.get("refunded_amount_cents") or 0)),
            )
            disputed_amount = min(
                max(0, gross_amount - refunded_amount),
                max(0, int(existing_payment.get("disputed_amount_cents") or 0)),
            )
            net_collected_amount = gross_amount - refunded_amount - disputed_amount
            row["refunded_amount_cents"] = refunded_amount
            row["disputed_amount_cents"] = disputed_amount
            row["net_collected_amount_cents"] = net_collected_amount
            row["refundable_amount_cents"] = (
                net_collected_amount if row.get("stripe_charge_id") else 0
            )
            query = self.supabase.table("billing_payments").update(row).eq("id", existing_payment["id"])
            query = add_stripe_event_created_guard(query, event_created)
            result = query.execute()
            if not result.data:
                return
        else:
            result = self.supabase.table("billing_payments").insert(row).execute()
        payment = result.data[0] if result.data else row
        payment = self._link_adjustments_to_payment(payment, account_id)
        payment_status = payment.get("status")
        invoice_recomputed = False
        if local_invoice and status_value in {"succeeded", "failed"}:
            if not self._record_payment_projection_invoice_metadata(
                local_invoice,
                row,
                payment_status=status_value,
                event_created=event_created,
                studio_id=studio_id,
                stripe_payment_intent_id=_stripe_id(intent),
            ):
                return
            if local_invoice.get("status") not in PAYMENT_PROJECTION_PRESERVED_INVOICE_STATUSES:
                self._refresh_invoice_and_payer_from_payment_events(payment)
                invoice_recomputed = True
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

    def _connect_account_generation(
        self,
        account_id: Optional[str],
        studio_id: Optional[str],
    ) -> Optional[int]:
        if not account_id or not studio_id:
            return None
        account = self.billing_service._connect_accounts().by_stripe_account(account_id)
        if not account or account.get("studio_id") != studio_id:
            return None
        raw_generation = (account.get("metadata") or {}).get("connect_account_generation") or 1
        try:
            generation = int(raw_generation)
        except (TypeError, ValueError):
            return None
        return generation if generation > 0 else None

    @staticmethod
    def _generation_matches(row: dict[str, Any], generation: Optional[int]) -> bool:
        row_generation = row.get("connect_account_generation")
        if row_generation is None or generation is None:
            return row_generation is None and generation is None
        try:
            return int(row_generation) == int(generation)
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _sanitized_adjustment_metadata(metadata: Any) -> dict[str, str]:
        if not isinstance(metadata, dict):
            return {}
        sanitized: dict[str, str] = {}
        for key in ("studio_id", "payment_id", "product"):
            value = metadata.get(key)
            if value is None:
                continue
            sanitized[key] = str(value)[:160]
        return sanitized

    def _link_adjustments_to_payment(self, payment: dict[str, Any], account_id: Optional[str]) -> dict[str, Any]:
        charge_id = payment.get("stripe_charge_id")
        payment_id = payment.get("id")
        studio_id = payment.get("studio_id")
        if not charge_id or not payment_id or not studio_id:
            return payment
        generation = payment.get("connect_account_generation")
        refund_query = (
            self.supabase.table("billing_refunds")
            .select("id, connect_account_generation")
            .eq("studio_id", studio_id)
            .eq("stripe_charge_id", charge_id)
        )
        refund_query = (
            refund_query.eq("stripe_account_id", account_id)
            if account_id
            else refund_query.is_("stripe_account_id", "null")
        )
        refunds = refund_query.execute()
        refund_ids = [
            row["id"]
            for row in refunds.data or []
            if row.get("id") and self._generation_matches(row, generation)
        ]
        mismatched_refund_ids = [
            row["id"]
            for row in refunds.data or []
            if row.get("id") and not self._generation_matches(row, generation)
        ]

        dispute_query = (
            self.supabase.table("billing_disputes")
            .select("id, status, connect_account_generation")
            .eq("studio_id", studio_id)
            .eq("stripe_charge_id", charge_id)
        )
        dispute_query = (
            dispute_query.eq("stripe_account_id", account_id)
            if account_id
            else dispute_query.is_("stripe_account_id", "null")
        )
        disputes = dispute_query.execute()
        dispute_ids = [
            row["id"]
            for row in disputes.data or []
            if row.get("id") and self._generation_matches(row, generation)
        ]
        mismatched_dispute_ids = [
            row["id"]
            for row in disputes.data or []
            if row.get("id") and not self._generation_matches(row, generation)
        ]
        mismatch_update = {
            "reconciliation_required": True,
            "reconciliation_reason_code": ADJUSTMENT_IDENTITY_MISMATCH,
        }
        if mismatched_refund_ids:
            self.supabase.table("billing_refunds").update(mismatch_update).in_(
                "id",
                mismatched_refund_ids,
            ).execute()
        if mismatched_dispute_ids:
            self.supabase.table("billing_disputes").update(mismatch_update).in_(
                "id",
                mismatched_dispute_ids,
            ).execute()
        if not refund_ids and not dispute_ids:
            return self._reconcile_payment_adjustments(payment, account_id)

        adjustment_update = {
            "payment_id": payment_id,
            "reconciliation_required": False,
            "reconciliation_reason_code": None,
        }
        if payment.get("stripe_payment_intent_id"):
            adjustment_update["stripe_payment_intent_id"] = payment["stripe_payment_intent_id"]
        if refund_ids:
            self.supabase.table("billing_refunds").update(adjustment_update).in_("id", refund_ids).execute()
        if dispute_ids:
            self.supabase.table("billing_disputes").update(adjustment_update).in_("id", dispute_ids).execute()

        current_payment = (
            self.supabase.table("billing_payments")
            .select("*")
            .eq("id", payment_id)
            .eq("studio_id", studio_id)
            .limit(1)
            .execute()
        )
        return self._reconcile_payment_adjustments(
            current_payment.data[0] if current_payment.data else payment,
            account_id,
        )

    def _project_charge_refund(
        self,
        charge: dict[str, Any],
        account_id: Optional[str],
        event_created: Optional[int] = None,
    ) -> None:
        refunds = ((charge.get("refunds") or {}).get("data") or [])
        for refund in refunds:
            self._project_refund(refund, account_id, charge=charge, event_created=event_created)

    def _project_refund(
        self,
        refund: Any,
        account_id: Optional[str],
        *,
        charge: Optional[dict[str, Any]] = None,
        event_created: Optional[int] = None,
    ) -> dict[str, Any]:
        refund_dict = refund if isinstance(refund, dict) else refund.to_dict_recursive() if hasattr(refund, "to_dict_recursive") else dict(refund)
        charge_id = _stripe_id(refund_dict.get("charge")) or _stripe_id(charge)
        metadata = refund_dict.get("metadata") or {}
        metadata_studio_id = metadata.get("studio_id")
        payment = self._find_payment_by_charge(
            account_id,
            charge_id,
            studio_id=metadata_studio_id,
        )
        studio_id = self._resolve_stripe_event_studio_id(
            account_id,
            metadata_studio_id=metadata_studio_id,
            local_studio_id=(payment or {}).get("studio_id"),
        )
        if not studio_id:
            return {}
        if payment and payment.get("studio_id") != studio_id:
            payment = None
        connect_account_generation = self._connect_account_generation(account_id, studio_id)
        identity_mismatch = bool(
            payment and not self._generation_matches(payment, connect_account_generation)
        )
        if identity_mismatch:
            payment = None
        row = {
            "studio_id": studio_id,
            "payment_id": (payment or {}).get("id"),
            "stripe_refund_id": _stripe_id(refund_dict),
            "stripe_charge_id": charge_id,
            "stripe_payment_intent_id": _stripe_id(refund_dict.get("payment_intent")) or (payment or {}).get("stripe_payment_intent_id"),
            "stripe_account_id": account_id,
            "connect_account_generation": connect_account_generation,
            "amount_cents": int(refund_dict.get("amount") or 0),
            "status": refund_dict.get("status") or "unknown",
            "reason": refund_dict.get("reason"),
            "metadata": self._sanitized_adjustment_metadata(metadata),
            "reconciliation_required": identity_mismatch,
            "reconciliation_reason_code": ADJUSTMENT_IDENTITY_MISMATCH if identity_mismatch else None,
        }
        if event_created is not None:
            row["last_stripe_event_created"] = event_created
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
            current_refund = existing.data[0]
            if is_stale_stripe_event(current_refund, event_created):
                if payment:
                    self._reconcile_payment_adjustments(payment, account_id)
                return current_refund
            current_status = str(current_refund.get("status") or "")
            incoming_status = str(row.get("status") or "")
            if (
                REFUND_STATUS_ORDER.get(current_status, -1)
                > REFUND_STATUS_ORDER.get(incoming_status, -1)
                or is_same_second_status_regression(
                    current_refund.get("last_stripe_event_created"),
                    event_created,
                    current_status=current_status,
                    incoming_status=incoming_status,
                    status_order=REFUND_STATUS_ORDER,
                )
            ):
                row["status"] = current_status
            self._preserve_established_identity(
                row,
                current_refund,
                REFUND_ESTABLISHED_IDENTITY_FIELDS,
            )
            row["reconciliation_required"] = bool(
                current_refund.get("reconciliation_required")
            )
            row["reconciliation_reason_code"] = current_refund.get(
                "reconciliation_reason_code"
            )
            established_payment = self._find_payment_by_charge(
                row.get("stripe_account_id"),
                row.get("stripe_charge_id"),
                studio_id=row.get("studio_id"),
            )
            if (
                established_payment
                and row.get("payment_id") == established_payment.get("id")
                and self._row_matches_adjustment_identity(
                    row,
                    established_payment,
                    row.get("stripe_account_id"),
                )
            ):
                payment = established_payment
            query = self.supabase.table("billing_refunds").update(row).eq(
                "id",
                current_refund["id"],
            ).eq("studio_id", studio_id)
            query = add_stripe_event_created_guard(query, event_created)
            result = query.execute()
        else:
            try:
                result = self.supabase.table("billing_refunds").insert(row).execute()
            except PostgrestAPIError as exc:
                if getattr(exc, "code", None) != "23505":
                    raise
                concurrent = (
                    self.supabase.table("billing_refunds")
                    .select("*")
                    .eq("studio_id", studio_id)
                    .eq("stripe_account_id", account_id)
                    .eq("stripe_refund_id", row["stripe_refund_id"])
                    .limit(1)
                    .execute()
                )
                if not concurrent.data:
                    raise
                return self._project_refund(
                    refund_dict,
                    account_id,
                    charge=charge,
                    event_created=event_created,
                )
        if payment:
            self._reconcile_payment_adjustments(payment, account_id)
        return result.data[0] if result.data else row

    def _project_dispute(
        self,
        dispute: dict[str, Any],
        account_id: Optional[str],
        event_created: Optional[int] = None,
    ) -> None:
        charge_id = _stripe_id(dispute.get("charge"))
        metadata = dispute.get("metadata") or {}
        metadata_studio_id = metadata.get("studio_id")
        payment = self._find_payment_by_charge(
            account_id,
            charge_id,
            studio_id=metadata_studio_id,
        )
        studio_id = self._resolve_stripe_event_studio_id(
            account_id,
            metadata_studio_id=metadata_studio_id,
            local_studio_id=(payment or {}).get("studio_id"),
        )
        if not studio_id:
            return
        if payment and payment.get("studio_id") != studio_id:
            payment = None
        connect_account_generation = self._connect_account_generation(account_id, studio_id)
        identity_mismatch = bool(
            payment and not self._generation_matches(payment, connect_account_generation)
        )
        if identity_mismatch:
            payment = None
        status_value = str(dispute.get("status") or "unknown")
        state_category = dispute_state_category(status_value)
        row = {
            "studio_id": studio_id,
            "payment_id": (payment or {}).get("id"),
            "stripe_dispute_id": _stripe_id(dispute),
            "stripe_charge_id": charge_id,
            "stripe_payment_intent_id": (payment or {}).get("stripe_payment_intent_id"),
            "stripe_account_id": account_id,
            "connect_account_generation": connect_account_generation,
            "amount_cents": int(dispute.get("amount") or 0),
            "status": status_value,
            "state_category": state_category,
            "reason": dispute.get("reason"),
            "liability_owner": "studio",
            "metadata": self._sanitized_adjustment_metadata(metadata),
            "reconciliation_required": identity_mismatch or state_category == "unknown",
            "reconciliation_reason_code": (
                ADJUSTMENT_IDENTITY_MISMATCH
                if identity_mismatch
                else ADJUSTMENT_UNKNOWN_DISPUTE if state_category == "unknown" else None
            ),
        }
        if event_created is not None:
            row["last_stripe_event_created"] = event_created
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
            current_dispute = existing.data[0]
            if is_stale_stripe_event(current_dispute, event_created):
                if payment:
                    self._reconcile_payment_adjustments(payment, account_id)
                return
            current_status = str(current_dispute.get("status") or "")
            incoming_status = str(row.get("status") or "")
            if (
                current_status in DISPUTE_TERMINAL_STATUSES
                and incoming_status not in DISPUTE_TERMINAL_STATUSES
            ) or is_same_second_status_regression(
                current_dispute.get("last_stripe_event_created"),
                event_created,
                current_status=current_status,
                incoming_status=incoming_status,
                status_order=DISPUTE_STATUS_ORDER,
            ):
                row["status"] = current_status
                row["state_category"] = current_dispute.get("state_category") or dispute_state_category(current_status)
                row["reconciliation_required"] = bool(current_dispute.get("reconciliation_required"))
                row["reconciliation_reason_code"] = current_dispute.get("reconciliation_reason_code")
            self._preserve_established_identity(
                row,
                current_dispute,
                DISPUTE_ESTABLISHED_IDENTITY_FIELDS,
            )
            established_payment = self._find_payment_by_charge(
                row.get("stripe_account_id"),
                row.get("stripe_charge_id"),
                studio_id=row.get("studio_id"),
            )
            if (
                established_payment
                and row.get("payment_id") == established_payment.get("id")
                and self._row_matches_adjustment_identity(
                    row,
                    established_payment,
                    row.get("stripe_account_id"),
                )
            ):
                payment = established_payment
                if row.get("state_category") != "unknown":
                    current_reason = current_dispute.get(
                        "reconciliation_reason_code"
                    )
                    if current_reason in DURABLE_ADJUSTMENT_RECONCILIATION_REASONS:
                        row["reconciliation_required"] = True
                        row["reconciliation_reason_code"] = current_reason
                    else:
                        row["reconciliation_required"] = False
                        row["reconciliation_reason_code"] = None
            query = self.supabase.table("billing_disputes").update(row).eq("id", current_dispute["id"]).eq(
                "studio_id",
                studio_id,
            )
            query = add_stripe_event_created_guard(query, event_created)
            query.execute()
        else:
            try:
                self.supabase.table("billing_disputes").insert(row).execute()
            except PostgrestAPIError as exc:
                if getattr(exc, "code", None) != "23505":
                    raise
                concurrent = (
                    self.supabase.table("billing_disputes")
                    .select("id")
                    .eq("studio_id", studio_id)
                    .eq("stripe_account_id", account_id)
                    .eq("stripe_dispute_id", row["stripe_dispute_id"])
                    .limit(1)
                    .execute()
                )
                if not concurrent.data:
                    raise
                self._project_dispute(dispute, account_id, event_created)
        if payment:
            self._reconcile_payment_adjustments(payment, account_id)

    def _reconcile_payment_adjustments(
        self,
        payment: dict[str, Any],
        account_id: Optional[str],
    ) -> dict[str, Any]:
        payment_id = payment.get("id")
        studio_id = payment.get("studio_id")
        if not payment_id or not studio_id:
            return payment

        refunds = (
            self.supabase.table("billing_refunds")
            .select("amount_cents, status, stripe_account_id, connect_account_generation")
            .eq("studio_id", studio_id)
            .eq("payment_id", payment_id)
            .execute()
        )
        matching_refunds = [
            row
            for row in refunds.data or []
            if self._row_matches_adjustment_identity(row, payment, account_id)
        ]
        raw_refunded_amount = sum(
            max(0, int(row.get("amount_cents") or 0))
            for row in matching_refunds
            if row.get("status") in REFUND_EFFECTIVE_STATUSES
        )
        payment_amount = (
            max(0, int(payment.get("amount_cents") or 0))
            if payment.get("status") in {"succeeded", "refunded", "disputed", "externally_recorded"}
            else 0
        )
        refunded_amount = min(payment_amount, raw_refunded_amount)

        dispute_query = (
            self.supabase.table("billing_disputes")
            .select("amount_cents, status, state_category, stripe_account_id, connect_account_generation, reconciliation_required")
            .eq("studio_id", studio_id)
            .eq("payment_id", payment_id)
        )
        dispute_query = (
            dispute_query.eq("stripe_account_id", account_id)
            if account_id
            else dispute_query.is_("stripe_account_id", "null")
        )
        disputes = dispute_query.execute()
        matching_disputes = [
            row
            for row in disputes.data or []
            if self._row_matches_adjustment_identity(row, payment, account_id)
        ]
        reversing_dispute_amount = sum(
            max(0, int(row.get("amount_cents") or 0))
            for row in matching_disputes
            if (row.get("state_category") or dispute_state_category(row.get("status")))
            in DISPUTE_BALANCE_REVERSING_CATEGORIES
        )
        disputed_amount = min(max(0, payment_amount - refunded_amount), reversing_dispute_amount)
        net_collected_amount = max(0, payment_amount - refunded_amount - disputed_amount)
        reconciliation_reason = None
        if (
            payment.get("adjustment_reconciliation_reason_code")
            == ADJUSTMENT_HISTORICAL_GENERATION_UNKNOWN
        ):
            reconciliation_reason = ADJUSTMENT_HISTORICAL_GENERATION_UNKNOWN
        elif raw_refunded_amount > payment_amount:
            reconciliation_reason = ADJUSTMENT_OVER_REFUND
        elif any(
            (row.get("state_category") or dispute_state_category(row.get("status"))) == "unknown"
            or row.get("reconciliation_required")
            for row in matching_disputes
        ):
            reconciliation_reason = ADJUSTMENT_UNKNOWN_DISPUTE

        if disputed_amount > 0:
            payment_status = "disputed"
        elif payment_amount > 0 and refunded_amount >= payment_amount:
            payment_status = "refunded"
        elif payment.get("status") in {"disputed", "refunded", "succeeded"}:
            payment_status = "succeeded"
        else:
            payment_status = payment.get("status")

        payment_update = {
            "status": payment_status,
            "refunded_amount_cents": refunded_amount,
            "disputed_amount_cents": disputed_amount,
            "net_collected_amount_cents": net_collected_amount,
            "refundable_amount_cents": net_collected_amount if payment.get("stripe_charge_id") else 0,
            "adjustment_reconciliation_required": reconciliation_reason is not None,
            "adjustment_reconciliation_reason_code": reconciliation_reason,
        }
        payment_result = (
            self.supabase.table("billing_payments")
            .update(payment_update)
            .eq("id", payment_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        updated_payment = payment_result.data[0] if payment_result.data else {**payment, **payment_update}
        return updated_payment

    def _row_matches_adjustment_identity(
        self,
        adjustment: dict[str, Any],
        payment: dict[str, Any],
        account_id: Optional[str],
    ) -> bool:
        if adjustment.get("studio_id") and adjustment.get("studio_id") != payment.get("studio_id"):
            return False
        if not self.billing_service._row_matches_stripe_account(adjustment, account_id):
            return False
        return self._generation_matches(adjustment, payment.get("connect_account_generation"))

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
            .select("amount_cents, status")
            .eq("studio_id", studio_id)
            .eq("invoice_id", invoice_id)
            .execute()
        )
        amount_due = int(invoice.get("amount_due_cents") or 0)
        gross_paid = 0
        for row in payment_rows.data or []:
            amount = max(0, int(row.get("amount_cents") or 0))
            if row.get("status") in {"succeeded", "refunded", "externally_recorded"}:
                gross_paid += amount
            elif row.get("status") == "disputed":
                gross_paid += amount

        amount_paid = min(amount_due, gross_paid)
        amount_remaining = max(0, amount_due - amount_paid)
        if amount_due > 0 and amount_paid >= amount_due:
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

    def _find_payment_by_charge(
        self,
        account_id: Optional[str],
        charge_id: Optional[str],
        *,
        studio_id: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        if not charge_id:
            return None
        query = self.supabase.table("billing_payments").select("*").eq("stripe_charge_id", charge_id)
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        if studio_id:
            query = query.eq("studio_id", studio_id)
        rows = query.limit(2).execute().data or []
        return rows[0] if len(rows) == 1 else None

    def _find_payment_by_intent(self, account_id: Optional[str], payment_intent_id: Optional[str]) -> Optional[dict[str, Any]]:
        if not payment_intent_id:
            return None
        query = self.supabase.table("billing_payments").select("*").eq("stripe_payment_intent_id", payment_intent_id).limit(1)
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0] if result.data else None

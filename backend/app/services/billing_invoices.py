from __future__ import annotations

import hashlib
import json
import logging
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Optional
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError
from stripe import (
    AuthenticationError as StripeAuthenticationError,
    CardError as StripeCardError,
    InvalidRequestError as StripeInvalidRequestError,
    PermissionError as StripePermissionError,
    RateLimitError as StripeRateLimitError,
)

from app.schemas.billing import BillingInvoiceCreate, BillingInvoiceResponse
from app.services.billing_invoice_projection import _object_get, _stripe_id
from app.services.stripe_service import StripeService


logger = logging.getLogger(__name__)

INVOICE_RETRY_LEASE_DURATION = timedelta(seconds=30)
INVOICE_RETRY_STRIPE_KEY_MAX_AGE = timedelta(hours=23)
INVOICE_RETRY_AMBIGUOUS_DETAIL = (
    "Invoice payment outcome is not yet confirmed. Retry with the same operation after reconciliation."
)
INVOICE_RETRY_EXPIRED_DETAIL = (
    "The prior payment attempt could not be confirmed before its Stripe retry window expired. "
    "Review the invoice in Stripe, then start a new retry operation."
)


class BillingInvoiceManager:
    def __init__(self, billing_service: Any, *, stripe_service_cls: type[StripeService] = StripeService):
        self.billing_service = billing_service
        self.stripe_service_cls = stripe_service_cls

    @property
    def supabase(self):
        return self.billing_service.supabase

    def _get_row_or_404(self, *args, **kwargs):
        return self.billing_service._get_row_or_404(*args, **kwargs)

    def _ensure_record_in_studio(self, *args, **kwargs) -> None:
        self.billing_service._ensure_record_in_studio(*args, **kwargs)

    def _ensure_connect_ready(self, studio_id: str) -> dict[str, Any]:
        return self.billing_service._ensure_connect_ready(studio_id)

    def _sync_payer_customer(self, payer: dict[str, Any], account: dict[str, Any]) -> dict[str, Any]:
        return self.billing_service._sync_payer_customer(payer, account)

    def _payer_autopay_authorized(self, payer: dict[str, Any]) -> bool:
        return self.billing_service._payer_autopay_authorized(payer)

    def _application_fee_amount(self, amount_cents: int, account: dict[str, Any]) -> int:
        return self.billing_service._application_fee_amount(amount_cents, account)

    def _idempotency_key(self, *parts: str) -> str:
        return self.billing_service._idempotency_key(*parts)

    def _update_invoice_from_stripe(
        self,
        invoice_id: str,
        studio_id: str,
        stripe_invoice: Any,
        account_id: str,
    ) -> dict[str, Any]:
        return self.billing_service._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, account_id)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.billing_service._audit(studio_id, actor_id, action, entity_id, metadata)

    def _recompute_payer_balance(self, studio_id: str, payer_id: Optional[str]) -> None:
        self.billing_service._recompute_payer_balance(studio_id, payer_id)

    async def list_invoices(self, studio_id: str) -> list[BillingInvoiceResponse]:
        result = (
            self.supabase.table("billing_invoices")
            .select("*")
            .eq("studio_id", studio_id)
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
        return [BillingInvoiceResponse(**row) for row in (result.data or [])]

    async def create_invoice(
        self,
        data: BillingInvoiceCreate,
        studio_id: str,
        actor_id: str,
        idempotency_key: Optional[str] = None,
    ) -> BillingInvoiceResponse:
        local_invoice = self._create_invoice_without_hosted_send(data, studio_id, idempotency_key)
        if data.send_hosted_invoice:
            local_invoice = (await self.finalize_invoice(local_invoice["id"], studio_id, actor_id)).model_dump()
        self._audit(studio_id, actor_id, "billing.invoice_created", local_invoice["id"], {
            "amount_due_cents": local_invoice.get("amount_due_cents"),
            "stripe_invoice_id": local_invoice.get("stripe_invoice_id"),
        })
        self._recompute_payer_balance(studio_id, data.payer_id)
        return BillingInvoiceResponse(**local_invoice)

    def create_invoice_sync(
        self,
        data: BillingInvoiceCreate,
        studio_id: str,
        actor_id: str,
        idempotency_key: Optional[str] = None,
    ) -> BillingInvoiceResponse:
        if data.send_hosted_invoice:
            raise HTTPException(status_code=400, detail="Hosted invoice sending requires the async invoice path.")
        local_invoice = self._create_invoice_without_hosted_send(data, studio_id, idempotency_key)
        self._audit(studio_id, actor_id, "billing.invoice_created", local_invoice["id"], {
            "amount_due_cents": local_invoice.get("amount_due_cents"),
            "stripe_invoice_id": local_invoice.get("stripe_invoice_id"),
        })
        self._recompute_payer_balance(studio_id, data.payer_id)
        return BillingInvoiceResponse(**local_invoice)

    def _create_invoice_without_hosted_send(
        self,
        data: BillingInvoiceCreate,
        studio_id: str,
        idempotency_key: Optional[str],
    ) -> dict[str, Any]:
        payer = self._get_row_or_404("billing_payers", data.payer_id, studio_id, "Payer not found.")
        if data.student_id:
            self._ensure_record_in_studio("students", data.student_id, studio_id, "Student not found.")
        if data.enrollment_id:
            self._ensure_record_in_studio("student_billing_enrollments", data.enrollment_id, studio_id, "Billing enrollment not found.")

        if not data.items and not data.amount_cents:
            raise HTTPException(status_code=400, detail="Invoice needs at least one line item or amount.")
        items = [item.model_dump() for item in data.items] if data.items else [
            {
                "description": data.description or "Tuition invoice",
                "amount_cents": data.amount_cents or 0,
                "quantity": 1,
                "student_id": data.student_id,
                "enrollment_id": data.enrollment_id,
            }
        ]
        for item in items:
            self._validate_invoice_item_refs(item, studio_id)

        account = self._ensure_connect_ready(studio_id)
        payer = self._sync_payer_customer(payer, account)
        if data.collection_mode == "autopay" and not payer.get("default_payment_method_id"):
            raise HTTPException(status_code=409, detail="Autopay requires a saved payer payment method.")
        if data.collection_mode == "autopay" and not self._payer_autopay_authorized(payer):
            raise HTTPException(status_code=409, detail="Autopay requires accepted autopay terms before charging this payer.")

        amount_due = sum(int(item["amount_cents"]) * int(item.get("quantity") or 1) for item in items)
        application_fee = self._application_fee_amount(amount_due, account)
        normalized_idempotency_key = self._normalize_idempotency_key(idempotency_key)
        request_hash = self._invoice_request_hash(data)
        invoice_row = {
            "studio_id": studio_id,
            "payer_id": data.payer_id,
            "student_id": data.student_id,
            "enrollment_id": data.enrollment_id,
            "invoice_type": data.invoice_type,
            "status": "draft",
            "amount_due_cents": amount_due,
            "amount_paid_cents": 0,
            "amount_remaining_cents": amount_due,
            "currency": data.currency,
            "due_date": data.due_date,
            "stripe_account_id": account["stripe_connected_account_id"],
            "stripe_customer_id": payer.get("stripe_customer_id"),
            "collection_method": "charge_automatically" if data.collection_mode == "autopay" else "send_invoice",
            "application_fee_amount_cents": application_fee,
            "external": False,
            "idempotency_key": normalized_idempotency_key,
            "request_hash": request_hash if normalized_idempotency_key else None,
        }
        local_invoice = self._claim_invoice_create_request(
            studio_id,
            normalized_idempotency_key,
            request_hash,
            invoice_row,
        )
        if local_invoice.get("stripe_invoice_id"):
            return local_invoice

        stripe_service = self.stripe_service_cls()
        stripe_invoice = stripe_service.create_connected_invoice(
            account_id=account["stripe_connected_account_id"],
            customer_id=payer["stripe_customer_id"],
            collection_method=invoice_row["collection_method"],
            application_fee_amount=application_fee,
            default_payment_method=payer.get("default_payment_method_id") if data.collection_mode == "autopay" else None,
            due_date=self._date_to_epoch(data.due_date) if data.due_date else None,
            days_until_due=7,
            metadata={
                "studio_id": studio_id,
                "payer_id": data.payer_id,
                "invoice_id": local_invoice["id"],
                "product": "koaryu_payments",
            },
            idempotency_key=self._idempotency_key("invoice", local_invoice["id"]),
        )
        stripe_invoice_id = _stripe_id(stripe_invoice)
        for index, item in enumerate(items):
            amount = int(item["amount_cents"]) * int(item.get("quantity") or 1)
            metadata = {
                "studio_id": studio_id,
                "invoice_id": local_invoice["id"],
                "student_id": item.get("student_id") or "",
                "enrollment_id": item.get("enrollment_id") or "",
                "billing_plan_id": item.get("billing_plan_id") or "",
            }
            stripe_item = stripe_service.create_connected_invoice_item(
                account_id=account["stripe_connected_account_id"],
                customer_id=payer["stripe_customer_id"],
                amount=amount,
                currency=data.currency,
                description=item["description"],
                metadata=metadata,
                idempotency_key=self._idempotency_key("invoice-item", local_invoice["id"], str(index)),
                invoice_id=stripe_invoice_id,
            )
            self._insert_invoice_item_once({
                "studio_id": studio_id,
                "invoice_id": local_invoice["id"],
                "student_id": item.get("student_id"),
                "enrollment_id": item.get("enrollment_id"),
                "billing_plan_id": item.get("billing_plan_id"),
                "description": item["description"],
                "quantity": item.get("quantity") or 1,
                "unit_amount_cents": item["amount_cents"],
                "amount_cents": amount,
                "stripe_invoice_item_id": _stripe_id(stripe_item),
                "metadata": metadata,
            })

        stripe_invoice = stripe_service.retrieve_connected_invoice(
            account_id=account["stripe_connected_account_id"],
            invoice_id=stripe_invoice_id,
        )
        local_invoice = self._update_invoice_from_stripe(local_invoice["id"], studio_id, stripe_invoice, account["stripe_connected_account_id"])
        return local_invoice

    async def finalize_invoice(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        invoice = self._get_row_or_404("billing_invoices", invoice_id, studio_id, "Invoice not found.")
        if not invoice.get("stripe_invoice_id") or not invoice.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Invoice is not linked to Stripe.")
        stripe_service = self.stripe_service_cls()
        stripe_invoice = stripe_service.finalize_connected_invoice(
            account_id=invoice["stripe_account_id"],
            invoice_id=invoice["stripe_invoice_id"],
        )
        send_error = None
        if _object_get(stripe_invoice, "collection_method") == "send_invoice":
            try:
                stripe_invoice = stripe_service.send_connected_invoice(
                    account_id=invoice["stripe_account_id"],
                    invoice_id=invoice["stripe_invoice_id"],
                )
            except Exception as exc:
                error_id = uuid4().hex
                logger.error(
                    "Stripe hosted invoice email send failed; reference=%s; error_type=%s",
                    error_id,
                    type(exc).__name__,
                )
                send_error = (
                    "Stripe finalized the hosted invoice, but Koaryu could not send the email. "
                    f"Reference: {error_id}"
                )
        invoice = self._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, invoice["stripe_account_id"])
        if send_error:
            result = (
                self.supabase.table("billing_invoices")
                .update({"last_payment_error": send_error})
                .eq("id", invoice_id)
                .eq("studio_id", studio_id)
                .execute()
            )
            if result.data:
                invoice = result.data[0]
        self._audit(studio_id, actor_id, "billing.invoice_finalized", invoice_id, {})
        return BillingInvoiceResponse(**invoice)

    async def retry_invoice_payment(
        self,
        invoice_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: Optional[str] = None,
    ) -> BillingInvoiceResponse:
        invoice = self._get_row_or_404("billing_invoices", invoice_id, studio_id, "Invoice not found.")
        if not invoice.get("stripe_invoice_id") or not invoice.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Invoice is not linked to Stripe.")
        normalized_idempotency_key = self._normalize_idempotency_key(idempotency_key)
        if not normalized_idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required for invoice payment retries.")
        requested_idempotency_key = normalized_idempotency_key
        stripe_idempotency_key = self._idempotency_key(
            "invoice-retry",
            studio_id,
            invoice_id,
            normalized_idempotency_key,
        )
        operation = self._find_invoice_retry_operation(
            studio_id,
            invoice_id,
            normalized_idempotency_key,
        )
        if not operation:
            operation = self._find_active_invoice_retry_operation(studio_id, invoice_id)
        created = False
        if operation:
            normalized_idempotency_key = operation["client_idempotency_key"]
            stripe_idempotency_key = operation["stripe_idempotency_key"]
        else:
            operation, created = self._claim_invoice_retry_operation(
                studio_id,
                invoice_id,
                normalized_idempotency_key,
                stripe_idempotency_key,
            )
        if operation["client_idempotency_key"] != requested_idempotency_key:
            self._ensure_invoice_retry_operation_alias(
                operation,
                requested_idempotency_key,
            )
            normalized_idempotency_key = operation["client_idempotency_key"]
            stripe_idempotency_key = operation["stripe_idempotency_key"]
        if not created:
            if operation.get("status") in {"processing", "reconciliation_required"}:
                operation = self._acquire_invoice_retry_operation_lease(operation)
            replay = self._resolve_invoice_retry_replay(invoice, operation, studio_id, actor_id)
            if replay is not None:
                return replay

        try:
            stripe_invoice = self.stripe_service_cls().pay_connected_invoice(
                account_id=invoice["stripe_account_id"],
                invoice_id=invoice["stripe_invoice_id"],
                idempotency_key=stripe_idempotency_key,
            )
        except Exception as exc:
            definitive = self._definitive_invoice_retry_error(exc)
            if definitive is not None:
                status_code, detail, error_code = definitive
                self._finish_invoice_retry_operation(
                    operation["id"],
                    operation["lease_token"],
                    "failed_definitive",
                    error_code,
                )
                raise HTTPException(status_code=status_code, detail=detail) from None
            self._finish_invoice_retry_operation(
                operation["id"],
                operation["lease_token"],
                "reconciliation_required",
                "ambiguous_stripe_error",
            )
            raise HTTPException(status_code=503, detail=INVOICE_RETRY_AMBIGUOUS_DETAIL) from None

        try:
            invoice = self._update_invoice_from_stripe(
                invoice_id,
                studio_id,
                stripe_invoice,
                invoice["stripe_account_id"],
            )
            if invoice.get("status") != "paid":
                self._finish_invoice_retry_operation(
                    operation["id"],
                    operation["lease_token"],
                    "reconciliation_required",
                    "stripe_payment_nonterminal",
                )
                raise HTTPException(status_code=503, detail=INVOICE_RETRY_AMBIGUOUS_DETAIL)
            self._audit_invoice_retry_once(
                studio_id,
                actor_id,
                invoice_id,
                normalized_idempotency_key,
            )
            self._finish_invoice_retry_operation(operation["id"], operation["lease_token"], "succeeded")
        except HTTPException:
            raise
        except Exception:
            self._finish_invoice_retry_operation(
                operation["id"],
                operation["lease_token"],
                "reconciliation_required",
                "local_projection_error",
            )
            raise HTTPException(status_code=503, detail=INVOICE_RETRY_AMBIGUOUS_DETAIL) from None
        return BillingInvoiceResponse(**invoice)

    def _claim_invoice_retry_operation(
        self,
        studio_id: str,
        invoice_id: str,
        client_key: str,
        stripe_key: str,
    ) -> tuple[dict[str, Any], bool]:
        existing = self._find_invoice_retry_operation(studio_id, invoice_id, client_key)
        if existing:
            return existing, False
        now_value = datetime.now(timezone.utc)
        now = now_value.isoformat()
        lease_token = uuid4().hex
        try:
            result = self.supabase.table("billing_invoice_retry_operations").insert({
                "studio_id": studio_id,
                "invoice_id": invoice_id,
                "client_idempotency_key": client_key,
                "stripe_idempotency_key": stripe_key,
                "status": "processing",
                "lease_token": lease_token,
                "lease_expires_at": (now_value + INVOICE_RETRY_LEASE_DURATION).isoformat(),
                "processing_started_at": now,
                "created_at": now,
                "updated_at": now,
            }).execute()
        except PostgrestAPIError as exc:
            if getattr(exc, "code", None) != "23505":
                raise
            existing = self._find_invoice_retry_operation(studio_id, invoice_id, client_key)
            if existing:
                return existing, False
            active = self._find_active_invoice_retry_operation(studio_id, invoice_id)
            if active:
                return active, False
            raise
        if not result.data:
            raise HTTPException(status_code=503, detail="Invoice retry operation could not be claimed.")
        return result.data[0], True

    def _acquire_invoice_retry_operation_lease(
        self,
        operation: dict[str, Any],
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        lease_token = uuid4().hex
        result = (
            self.supabase.table("billing_invoice_retry_operations")
            .update({
                "lease_token": lease_token,
                "lease_expires_at": (now + INVOICE_RETRY_LEASE_DURATION).isoformat(),
                "processing_started_at": now.isoformat(),
            })
            .eq("id", operation["id"])
            .in_("status", ["processing", "reconciliation_required"])
            .lte("lease_expires_at", now.isoformat())
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=503, detail=INVOICE_RETRY_AMBIGUOUS_DETAIL)
        return result.data[0]

    def _find_active_invoice_retry_operation(
        self,
        studio_id: str,
        invoice_id: str,
    ) -> Optional[dict[str, Any]]:
        result = (
            self.supabase.table("billing_invoice_retry_operations")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("invoice_id", invoice_id)
            .in_("status", ["processing", "reconciliation_required"])
            .order("created_at")
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def _find_invoice_retry_operation(
        self,
        studio_id: str,
        invoice_id: str,
        client_key: str,
    ) -> Optional[dict[str, Any]]:
        result = (
            self.supabase.table("billing_invoice_retry_operations")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("invoice_id", invoice_id)
            .eq("client_idempotency_key", client_key)
            .limit(1)
            .execute()
        )
        if result.data:
            return result.data[0]
        alias = (
            self.supabase.table("billing_invoice_retry_operation_aliases")
            .select("operation_id")
            .eq("studio_id", studio_id)
            .eq("invoice_id", invoice_id)
            .eq("client_idempotency_key", client_key)
            .limit(1)
            .execute()
        )
        if not alias.data:
            return None
        operation = (
            self.supabase.table("billing_invoice_retry_operations")
            .select("*")
            .eq("id", alias.data[0]["operation_id"])
            .eq("studio_id", studio_id)
            .eq("invoice_id", invoice_id)
            .limit(1)
            .execute()
        )
        return operation.data[0] if operation.data else None

    def _ensure_invoice_retry_operation_alias(
        self,
        operation: dict[str, Any],
        client_key: str,
    ) -> None:
        existing = (
            self.supabase.table("billing_invoice_retry_operation_aliases")
            .select("operation_id")
            .eq("studio_id", operation["studio_id"])
            .eq("invoice_id", operation["invoice_id"])
            .eq("client_idempotency_key", client_key)
            .limit(1)
            .execute()
        )
        if existing.data:
            if existing.data[0]["operation_id"] != operation["id"]:
                raise HTTPException(status_code=409, detail="This idempotency key belongs to another invoice retry operation.")
            return
        try:
            self.supabase.table("billing_invoice_retry_operation_aliases").insert({
                "operation_id": operation["id"],
                "studio_id": operation["studio_id"],
                "invoice_id": operation["invoice_id"],
                "client_idempotency_key": client_key,
            }).execute()
        except PostgrestAPIError as exc:
            if getattr(exc, "code", None) != "23505":
                raise
            existing = (
                self.supabase.table("billing_invoice_retry_operation_aliases")
                .select("operation_id")
                .eq("studio_id", operation["studio_id"])
                .eq("invoice_id", operation["invoice_id"])
                .eq("client_idempotency_key", client_key)
                .limit(1)
                .execute()
            )
            if not existing.data or existing.data[0]["operation_id"] != operation["id"]:
                raise HTTPException(status_code=409, detail="This idempotency key belongs to another invoice retry operation.")

    def _resolve_invoice_retry_replay(
        self,
        invoice: dict[str, Any],
        operation: dict[str, Any],
        studio_id: str,
        actor_id: str,
    ) -> Optional[BillingInvoiceResponse]:
        status = operation.get("status")
        if status == "succeeded":
            return BillingInvoiceResponse(**invoice)
        if status == "failed_definitive":
            raise HTTPException(status_code=409, detail="The prior invoice payment attempt failed definitively. Start a new retry operation.")

        created_at = self._parse_retry_operation_time(operation.get("created_at"))
        age = datetime.now(timezone.utc) - created_at

        try:
            stripe_invoice = self.stripe_service_cls().retrieve_connected_invoice(
                account_id=invoice["stripe_account_id"],
                invoice_id=invoice["stripe_invoice_id"],
                expand=["payment_intent"],
            )
            invoice = self._update_invoice_from_stripe(
                invoice["id"],
                studio_id,
                stripe_invoice,
                invoice["stripe_account_id"],
            )
        except Exception:
            self._finish_invoice_retry_operation(
                operation["id"],
                operation["lease_token"],
                "reconciliation_required",
                "reconciliation_error",
            )
            raise HTTPException(status_code=503, detail=INVOICE_RETRY_AMBIGUOUS_DETAIL) from None

        if invoice.get("status") == "paid":
            self._audit_invoice_retry_once(
                studio_id,
                actor_id,
                invoice["id"],
                operation["client_idempotency_key"],
            )
            self._finish_invoice_retry_operation(operation["id"], operation["lease_token"], "succeeded")
            return BillingInvoiceResponse(**invoice)
        if age >= INVOICE_RETRY_STRIPE_KEY_MAX_AGE:
            self._finish_invoice_retry_operation(
                operation["id"],
                operation["lease_token"],
                "failed_definitive",
                "stripe_key_window_expired",
            )
            raise HTTPException(status_code=409, detail=INVOICE_RETRY_EXPIRED_DETAIL)

        self._restart_invoice_retry_operation(operation["id"], operation["lease_token"])
        return None

    def _restart_invoice_retry_operation(self, operation_id: str, lease_token: str) -> None:
        result = (
            self.supabase.table("billing_invoice_retry_operations")
            .update({
                "status": "processing",
                "processing_started_at": datetime.now(timezone.utc).isoformat(),
                "error_code": None,
            })
            .eq("id", operation_id)
            .eq("lease_token", lease_token)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=503, detail=INVOICE_RETRY_AMBIGUOUS_DETAIL)

    def _finish_invoice_retry_operation(
        self,
        operation_id: str,
        lease_token: str,
        status: str,
        error_code: Optional[str] = None,
    ) -> None:
        update: dict[str, Any] = {
            "status": status,
            "error_code": error_code,
            "lease_token": None,
            "lease_expires_at": datetime.now(timezone.utc).isoformat(),
        }
        if status in {"succeeded", "failed_definitive"}:
            update["completed_at"] = datetime.now(timezone.utc).isoformat()
        result = (
            self.supabase.table("billing_invoice_retry_operations")
            .update(update)
            .eq("id", operation_id)
            .eq("lease_token", lease_token)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=503, detail=INVOICE_RETRY_AMBIGUOUS_DETAIL)

    @staticmethod
    def _parse_retry_operation_time(value: Any) -> datetime:
        if isinstance(value, datetime):
            parsed = value
        elif isinstance(value, str):
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                return datetime.min.replace(tzinfo=timezone.utc)
        else:
            return datetime.min.replace(tzinfo=timezone.utc)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed

    @staticmethod
    def _definitive_invoice_retry_error(exc: Exception) -> Optional[tuple[int, str, str]]:
        if isinstance(exc, StripeCardError):
            return 402, "Stripe declined the invoice payment. Review the payer payment method and retry.", "card_declined"
        if isinstance(exc, StripeInvalidRequestError):
            return 409, "Stripe rejected the invoice payment request. Review the invoice before retrying.", "stripe_request_rejected"
        if isinstance(exc, (StripeAuthenticationError, StripePermissionError)):
            return 409, "Stripe billing configuration rejected the invoice payment request.", "stripe_configuration_rejected"
        if isinstance(exc, StripeRateLimitError):
            return 429, "Stripe rate-limited the invoice payment request. Retry later.", "stripe_rate_limited"
        if isinstance(exc, HTTPException):
            if 400 <= exc.status_code < 500:
                return exc.status_code, str(exc.detail), "local_request_rejected"
            return 409, "Stripe billing is unavailable before the payment request can be sent.", "local_execution_unavailable"
        return None

    def _audit_invoice_retry_once(
        self,
        studio_id: str,
        actor_id: str,
        invoice_id: str,
        idempotency_key: str,
    ) -> None:
        audit_id = str(uuid5(
            NAMESPACE_URL,
            f"koaryu:billing:invoice-retry:{studio_id}:{invoice_id}:{idempotency_key}",
        ))
        existing = (
            self.supabase.table("audit_logs")
            .select("id")
            .eq("id", audit_id)
            .eq("studio_id", studio_id)
            .limit(1)
            .execute()
        )
        if existing.data:
            return
        try:
            self.supabase.table("audit_logs").insert({
                "id": audit_id,
                "studio_id": studio_id,
                "actor_id": actor_id,
                "action": "billing.invoice_retry_requested",
                "entity_type": "billing",
                "entity_id": invoice_id,
                "metadata": {"idempotency_key": idempotency_key},
            }).execute()
        except PostgrestAPIError as exc:
            if getattr(exc, "code", None) != "23505":
                raise

    async def void_invoice(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        invoice = self._get_row_or_404("billing_invoices", invoice_id, studio_id, "Invoice not found.")
        if invoice.get("stripe_invoice_id") and invoice.get("stripe_account_id"):
            stripe_invoice = self.stripe_service_cls().void_connected_invoice(
                account_id=invoice["stripe_account_id"],
                invoice_id=invoice["stripe_invoice_id"],
            )
            invoice = self._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, invoice["stripe_account_id"])
        else:
            result = (
                self.supabase.table("billing_invoices")
                .update({"status": "void", "voided_at": datetime.now(timezone.utc).isoformat()})
                .eq("id", invoice_id)
                .eq("studio_id", studio_id)
                .execute()
            )
            invoice = result.data[0]
        self._audit(studio_id, actor_id, "billing.invoice_voided", invoice_id, {})
        self._recompute_payer_balance(studio_id, invoice.get("payer_id"))
        return BillingInvoiceResponse(**invoice)

    async def reconcile_invoice(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        invoice = self._get_row_or_404("billing_invoices", invoice_id, studio_id, "Invoice not found.")
        if not invoice.get("stripe_invoice_id") or not invoice.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Invoice is not linked to Stripe.")
        stripe_invoice = self.stripe_service_cls().retrieve_connected_invoice(
            account_id=invoice["stripe_account_id"],
            invoice_id=invoice["stripe_invoice_id"],
            expand=["payment_intent"],
        )
        invoice = self._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, invoice["stripe_account_id"])
        self._audit(studio_id, actor_id, "billing.invoice_reconciled", invoice_id, {})
        self._recompute_payer_balance(studio_id, invoice.get("payer_id"))
        return BillingInvoiceResponse(**invoice)

    def _normalize_idempotency_key(self, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            return None
        if len(normalized) > 255:
            raise HTTPException(status_code=400, detail="Idempotency-Key must be 255 characters or fewer.")
        return normalized

    def _invoice_request_hash(self, data: BillingInvoiceCreate) -> str:
        payload = data.model_dump(mode="json", exclude_none=True)
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _claim_invoice_create_request(
        self,
        studio_id: str,
        idempotency_key: Optional[str],
        request_hash: str,
        invoice_row: dict[str, Any],
    ) -> dict[str, Any]:
        if idempotency_key:
            existing = self._find_invoice_by_idempotency_key(studio_id, idempotency_key)
            if existing:
                if existing.get("request_hash") != request_hash:
                    raise HTTPException(
                        status_code=409,
                        detail="This idempotency key is already in use for a different invoice request.",
                    )
                return existing
        try:
            inserted = self.supabase.table("billing_invoices").insert(invoice_row).execute()
        except PostgrestAPIError as exc:
            if exc.code != "23505" or not idempotency_key:
                raise
            existing = self._find_invoice_by_idempotency_key(studio_id, idempotency_key)
            if not existing:
                raise
            if existing.get("request_hash") != request_hash:
                raise HTTPException(
                    status_code=409,
                    detail="This idempotency key is already in use for a different invoice request.",
                ) from exc
            return existing
        if not inserted.data:
            raise HTTPException(status_code=500, detail="Failed to create invoice.")
        return inserted.data[0]

    def _validate_invoice_item_refs(self, item: dict[str, Any], studio_id: str) -> None:
        student_id = item.get("student_id")
        enrollment_id = item.get("enrollment_id")
        billing_plan_id = item.get("billing_plan_id")

        if student_id:
            self._ensure_record_in_studio(
                "students",
                student_id,
                studio_id,
                "Invoice item student not found.",
            )

        enrollment = None
        if enrollment_id:
            enrollment = self._get_row_or_404(
                "student_billing_enrollments",
                enrollment_id,
                studio_id,
                "Invoice item enrollment not found.",
            )

        if billing_plan_id:
            self._ensure_record_in_studio(
                "billing_plans",
                billing_plan_id,
                studio_id,
                "Invoice item billing plan not found.",
            )

        if enrollment and student_id and enrollment.get("student_id") != student_id:
            raise HTTPException(
                status_code=409,
                detail="Invoice item enrollment belongs to a different student.",
            )

        if enrollment and billing_plan_id and enrollment.get("billing_plan_id") != billing_plan_id:
            raise HTTPException(
                status_code=409,
                detail="Invoice item enrollment belongs to a different billing plan.",
            )

    def _find_invoice_by_idempotency_key(self, studio_id: str, idempotency_key: str) -> Optional[dict[str, Any]]:
        result = (
            self.supabase.table("billing_invoices")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("idempotency_key", idempotency_key)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def _insert_invoice_item_once(self, row: dict[str, Any]) -> None:
        try:
            self.supabase.table("billing_invoice_items").insert(row).execute()
        except PostgrestAPIError as exc:
            if exc.code != "23505":
                raise

    def _date_to_epoch(self, value: str) -> int:
        parsed = date.fromisoformat(value)
        return int(datetime.combine(parsed, time.min, tzinfo=timezone.utc).timestamp())

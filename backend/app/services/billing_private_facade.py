from __future__ import annotations

import importlib
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import HTTPException, status

from app.schemas.billing import BillingInvoiceCreate, BillingPlanProgramResponse, BillingPlanResponse
from app.services.billing_autopay import BillingAutopayManager
from app.services.billing_enrollments import BillingEnrollmentManager
from app.services.billing_invoice_projection import _object_get
from app.services.billing_invoices import BillingInvoiceManager
from app.services.billing_payers import BillingPayerManager
from app.services.billing_plans import BillingPlanManager
from app.services.billing_system_status import BillingSystemStatusReporter
from app.services.billing_webhook_event_state import (
    date_from_epoch,
    epoch_seconds,
    is_same_second_status_regression,
    is_stale_stripe_event,
    preserve_invoice_terminal_state,
    timestamp,
)


class BillingPrivateFacadeMixin:
    @staticmethod
    def _billing_stripe_service_cls():
        return importlib.import_module("app.services.billing_service").StripeService

    def project_connect_event(self, event: dict[str, Any]) -> None:
        self._webhook_projector().project_connect_event(event)
    def _ensure_connect_ready(self, studio_id: str) -> dict[str, Any]:
        account = self._connect_accounts().ensure_row(studio_id)
        if not account.get("stripe_connected_account_id"):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Connect Stripe before using hosted payments.")
        account = self._connect_accounts().refresh_status(account, strict=True)
        if not account.get("charges_enabled"):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Stripe Connect charges are not enabled yet.")
        return account

    def _validate_connect_account_access(self, account: dict[str, Any]) -> None:
        account_id = account.get("stripe_connected_account_id")
        if account_id:
            self._billing_stripe_service_cls()().retrieve_account(account_id=account_id)

    def _sync_plan_price(self, plan: dict[str, Any], account: dict[str, Any], *, force: bool = False) -> dict[str, Any]:
        return BillingPlanManager(self, stripe_service_cls=self._billing_stripe_service_cls())._sync_plan_price(plan, account, force=force)

    def _sync_payer_customer(self, payer: dict[str, Any], account: dict[str, Any]) -> dict[str, Any]:
        return BillingPayerManager(self, stripe_service_cls=self._billing_stripe_service_cls())._sync_payer_customer(payer, account)

    def _activate_stripe_enrollment(self, enrollment: dict[str, Any], plan: dict[str, Any], studio_id: str) -> dict[str, Any]:
        return BillingEnrollmentManager(self, stripe_service_cls=self._billing_stripe_service_cls())._activate_stripe_enrollment(
            enrollment,
            plan,
            studio_id,
        )

    def _find_or_create_billing_subscription(
        self,
        enrollment: dict[str, Any],
        plan: dict[str, Any],
        payer: dict[str, Any],
        account: dict[str, Any],
    ) -> dict[str, Any]:
        return BillingEnrollmentManager(self, stripe_service_cls=self._billing_stripe_service_cls())._find_or_create_billing_subscription(
            enrollment,
            plan,
            payer,
            account,
        )

    def _enrollment_has_stripe_link(self, enrollment: dict[str, Any]) -> bool:
        return BillingEnrollmentManager(self, stripe_service_cls=self._billing_stripe_service_cls())._enrollment_has_stripe_link(enrollment)

    def _mark_enrollment_stripe_attach_pending(
        self,
        enrollment: dict[str, Any],
        reason: str,
    ) -> dict[str, Any]:
        return BillingEnrollmentManager(self, stripe_service_cls=self._billing_stripe_service_cls())._mark_enrollment_stripe_attach_pending(
            enrollment,
            reason,
        )

    def _attached_enrollment_fields(self, enrollment: dict[str, Any], update: dict[str, Any]) -> dict[str, Any]:
        return BillingEnrollmentManager(self, stripe_service_cls=self._billing_stripe_service_cls())._attached_enrollment_fields(enrollment, update)

    def _mark_enrollment_stripe_detach_pending(
        self,
        enrollment: dict[str, Any],
        reason: str,
    ) -> dict[str, Any]:
        return BillingEnrollmentManager(self, stripe_service_cls=self._billing_stripe_service_cls())._mark_enrollment_stripe_detach_pending(
            enrollment,
            reason,
        )

    def _detached_enrollment_fields(self, enrollment: dict[str, Any]) -> dict[str, Any]:
        return BillingEnrollmentManager(self, stripe_service_cls=self._billing_stripe_service_cls())._detached_enrollment_fields(enrollment)

    def _detach_enrollment_from_subscription(self, enrollment: dict[str, Any]) -> None:
        BillingEnrollmentManager(self, stripe_service_cls=self._billing_stripe_service_cls())._detach_enrollment_from_subscription(enrollment)

    def _create_paid_in_full_invoice(self, enrollment: dict[str, Any], plan: dict[str, Any], payer: dict[str, Any], account: dict[str, Any]) -> None:
        BillingEnrollmentManager(self, stripe_service_cls=self._billing_stripe_service_cls())._create_paid_in_full_invoice(
            enrollment,
            plan,
            payer,
            account,
        )

    def _project_checkout_session(self, session: dict[str, Any], account_id: Optional[str]) -> None:
        self._webhook_projector()._project_checkout_session(session, account_id)
    def _project_invoice_event(
        self,
        invoice: dict[str, Any],
        account_id: Optional[str],
        event_type: str,
        event_created: Optional[int] = None,
    ) -> None:
        self._webhook_projector()._project_invoice_event(invoice, account_id, event_type, event_created)
    def _project_payment_intent(
        self,
        intent: dict[str, Any],
        account_id: Optional[str],
        event_type: str,
        event_created: Optional[int] = None,
    ) -> None:
        self._webhook_projector()._project_payment_intent(intent, account_id, event_type, event_created)
    def _link_disputes_to_payment(self, payment: dict[str, Any], account_id: Optional[str]) -> dict[str, Any]:
        return self._webhook_projector()._link_disputes_to_payment(payment, account_id)
    def _project_charge_refund(self, charge: dict[str, Any], account_id: Optional[str]) -> None:
        self._webhook_projector()._project_charge_refund(charge, account_id)
    def _project_refund(self, refund: Any, account_id: Optional[str], *, charge: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        return self._webhook_projector()._project_refund(refund, account_id, charge=charge)
    def _project_dispute(self, dispute: dict[str, Any], account_id: Optional[str]) -> None:
        self._webhook_projector()._project_dispute(dispute, account_id)
    def _refresh_invoice_and_payer_from_payment_events(self, payment: dict[str, Any]) -> None:
        self._webhook_projector()._refresh_invoice_and_payer_from_payment_events(payment)
    def _project_subscription(
        self,
        subscription: dict[str, Any],
        account_id: Optional[str],
        event_type: str = "",
        event_created: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        return self._webhook_projector()._project_subscription(subscription, account_id, event_type, event_created)
    def _update_invoice_from_stripe(
        self,
        invoice_id: str,
        studio_id: str,
        invoice: Any,
        account_id: Optional[str],
        *,
        event_created: Optional[int] = None,
    ) -> dict[str, Any]:
        return self._webhook_projector()._update_invoice_from_stripe(
            invoice_id,
            studio_id,
            invoice,
            account_id,
            event_created=event_created,
        )
    def _insert_invoice_from_stripe(
        self,
        studio_id: str,
        invoice: dict[str, Any],
        account_id: Optional[str],
        event_created: Optional[int] = None,
    ) -> dict[str, Any]:
        return self._webhook_projector()._insert_invoice_from_stripe(studio_id, invoice, account_id, event_created)
    def _invoice_projection(self, invoice: Any, account_id: Optional[str]) -> dict[str, Any]:
        return self._webhook_projector()._invoice_projection(invoice, account_id)
    def _project_payment_from_invoice(
        self,
        invoice: dict[str, Any],
        account_id: Optional[str],
        local_invoice: dict[str, Any],
        *,
        event_created: Optional[int] = None,
    ) -> None:
        self._webhook_projector()._project_payment_from_invoice(
            invoice,
            account_id,
            local_invoice,
            event_created=event_created,
        )
    def _invoice_identity_projection(
        self,
        studio_id: str,
        invoice: Any,
        account_id: Optional[str],
        *,
        current: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        return self._webhook_projector()._invoice_identity_projection(
            studio_id,
            invoice,
            account_id,
            current=current,
        )
    def _invoice_enrollment(self, studio_id: str, invoice: Any) -> Optional[dict[str, Any]]:
        return self._webhook_projector()._invoice_enrollment(studio_id, invoice)
    def _update_subscription_period_from_invoice(self, studio_id: str, invoice: Any, account_id: Optional[str]) -> None:
        self._webhook_projector()._update_subscription_period_from_invoice(studio_id, invoice, account_id)
    def _link_orphan_payment_to_invoice(self, invoice: dict[str, Any], account_id: Optional[str], local_invoice: dict[str, Any]) -> None:
        self._webhook_projector()._link_orphan_payment_to_invoice(invoice, account_id, local_invoice)
    def _find_invoice_for_stripe(self, invoice: dict[str, Any], account_id: Optional[str]) -> Optional[dict[str, Any]]:
        return self._webhook_projector()._find_invoice_for_stripe(invoice, account_id)
    def _find_invoice_by_payment_intent_or_invoice(
        self,
        account_id: Optional[str],
        payment_intent_id: Optional[str],
        stripe_invoice_id: Optional[str],
    ) -> Optional[dict[str, Any]]:
        return self._webhook_projector()._find_invoice_by_payment_intent_or_invoice(
            account_id,
            payment_intent_id,
            stripe_invoice_id,
        )
    def _find_invoice_by_customer_amount(
        self,
        account_id: Optional[str],
        customer_id: Optional[str],
        amount_cents: int,
        currency: str,
    ) -> Optional[dict[str, Any]]:
        return self._webhook_projector()._find_invoice_by_customer_amount(
            account_id,
            customer_id,
            amount_cents,
            currency,
        )
    def _find_unlinked_payment_by_customer_amount(
        self,
        account_id: Optional[str],
        customer_id: Optional[str],
        amount_cents: int,
        currency: str,
    ) -> Optional[dict[str, Any]]:
        return self._webhook_projector()._find_unlinked_payment_by_customer_amount(
            account_id,
            customer_id,
            amount_cents,
            currency,
        )
    def _find_payment_by_charge(self, account_id: Optional[str], charge_id: Optional[str]) -> Optional[dict[str, Any]]:
        return self._webhook_projector()._find_payment_by_charge(account_id, charge_id)
    def _find_payment_by_intent(self, account_id: Optional[str], payment_intent_id: Optional[str]) -> Optional[dict[str, Any]]:
        return self._webhook_projector()._find_payment_by_intent(account_id, payment_intent_id)
    def _webhook_health(self, account_id: Optional[str]):
        return BillingSystemStatusReporter(
            self.supabase,
            settings=self.settings,
            connect_accounts=self._connect_accounts(),
            payment_account_loader=self.get_payment_account,
        ).webhook_health(account_id)

    @staticmethod
    def _is_stale_webhook_processing(row: dict[str, Any]) -> bool:
        return BillingSystemStatusReporter.is_stale_webhook_processing(row)

    @staticmethod
    def _stripe_object_to_dict(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        if hasattr(value, "to_dict_recursive"):
            return value.to_dict_recursive()
        if hasattr(value, "to_dict"):
            return value.to_dict()
        return dict(value)

    def _stored_stripe_event_object(
        self,
        account_id: Optional[str],
        object_id: str,
        event_types: list[str],
    ) -> Optional[dict[str, Any]]:
        return self._webhook_projector()._stored_stripe_event_object(account_id, object_id, event_types)
    def _find_subscription_for_stripe(self, subscription: dict[str, Any], account_id: Optional[str]) -> Optional[dict[str, Any]]:
        return self._webhook_projector()._find_subscription_for_stripe(subscription, account_id)
    def _project_subscription_items(self, subscription: dict[str, Any], group: dict[str, Any]) -> None:
        self._webhook_projector()._project_subscription_items(subscription, group)
    def _subscription_item_id_for_group_plan(self, studio_id: str, group_id: str, plan_id: str) -> Optional[str]:
        return BillingEnrollmentManager(self, stripe_service_cls=self._billing_stripe_service_cls())._subscription_item_id_for_group_plan(
            studio_id,
            group_id,
            plan_id,
        )

    def _active_enrollment_count_for_subscription_item(
        self,
        studio_id: str,
        group_id: Optional[str],
        item_id: str,
        *,
        exclude_enrollment_id: Optional[str] = None,
    ) -> int:
        return BillingEnrollmentManager(self, stripe_service_cls=self._billing_stripe_service_cls())._active_enrollment_count_for_subscription_item(
            studio_id,
            group_id,
            item_id,
            exclude_enrollment_id=exclude_enrollment_id,
        )

    def _find_plan_price(
        self,
        studio_id: str,
        plan_id: str,
        account_id: str,
        amount: int,
        currency: str,
        billing_interval: str,
        recurring: bool,
    ) -> Optional[dict[str, Any]]:
        return BillingPlanManager(self, stripe_service_cls=self._billing_stripe_service_cls())._find_plan_price(
            studio_id,
            plan_id,
            account_id,
            amount,
            currency,
            billing_interval,
            recurring,
        )

    def _update_enrollment(self, enrollment_id: str, studio_id: str, update: dict[str, Any]) -> dict[str, Any]:
        return BillingEnrollmentManager(self, stripe_service_cls=self._billing_stripe_service_cls())._update_enrollment(
            enrollment_id,
            studio_id,
            update,
        )

    def _payer_id_for_customer(self, studio_id: str, account_id: Optional[str], customer_id: Optional[str]) -> Optional[str]:
        return BillingPayerManager(self, stripe_service_cls=self._billing_stripe_service_cls())._payer_id_for_customer(
            studio_id,
            account_id,
            customer_id,
        )

    def _stripe_account_for_studio(self, studio_id: str) -> Optional[str]:
        account = self._connect_accounts().ensure_row(studio_id)
        return account.get("stripe_connected_account_id")

    def _stripe_account_for_enrollment_subscription(self, enrollment: dict[str, Any]) -> Optional[str]:
        subscription_row_id = enrollment.get("billing_subscription_id")
        if subscription_row_id:
            result = (
                self.supabase.table("billing_subscriptions")
                .select("stripe_account_id")
                .eq("id", subscription_row_id)
                .eq("studio_id", enrollment["studio_id"])
                .limit(1)
                .execute()
            )
            if result.data and result.data[0].get("stripe_account_id"):
                return result.data[0]["stripe_account_id"]

        return self._stripe_account_for_studio(enrollment["studio_id"])

    def _has_stripe_billing_history(self, studio_id: str) -> bool:
        checks = (
            ("billing_plans", "stripe_price_id"),
            ("billing_payers", "stripe_customer_id"),
            ("billing_subscriptions", "stripe_subscription_id"),
            ("billing_invoices", "stripe_invoice_id"),
            ("billing_payments", "stripe_payment_intent_id"),
            ("billing_refunds", "stripe_refund_id"),
            ("billing_disputes", "stripe_dispute_id"),
        )
        for table, column in checks:
            result = (
                self.supabase.table(table)
                .select("id")
                .eq("studio_id", studio_id)
                .not_.is_(column, "null")
                .limit(1)
                .execute()
            )
            if result.data:
                return True
        return False

    def _payment_method_fields_from_customer(self, customer: Any) -> dict[str, Any]:
        return BillingPayerManager(self, stripe_service_cls=self._billing_stripe_service_cls())._payment_method_fields_from_customer(customer)

    def _payment_method_fields_from_payment_method(self, payment_method: Any) -> dict[str, Any]:
        return BillingPayerManager(self, stripe_service_cls=self._billing_stripe_service_cls())._payment_method_fields_from_payment_method(
            payment_method,
        )

    def _store_invoice_payment_method(
        self,
        studio_id: str,
        payer_id: str,
        account_id: Optional[str],
        customer_id: Optional[str],
        payment_method: Any,
    ) -> None:
        BillingPayerManager(self, stripe_service_cls=self._billing_stripe_service_cls())._store_invoice_payment_method(
            studio_id,
            payer_id,
            account_id,
            customer_id,
            payment_method,
        )

    def _subscription_item_id_for_enrollment(self, subscription: Any, enrollment_id: str) -> Optional[str]:
        return BillingEnrollmentManager(self, stripe_service_cls=self._billing_stripe_service_cls())._subscription_item_id_for_enrollment(
            subscription,
            enrollment_id,
        )

    def _latest_charge(self, intent: dict[str, Any]) -> Any:
        latest = intent.get("latest_charge")
        if latest:
            return latest
        charges = (intent.get("charges") or {}).get("data") or []
        return charges[0] if charges else None

    def _payment_method_type(self, intent: dict[str, Any], charge: Any) -> Optional[str]:
        payment_method_types = intent.get("payment_method_types") or []
        if payment_method_types:
            return payment_method_types[0]
        payment_method_details = _object_get(charge, "payment_method_details") or {}
        return _object_get(payment_method_details, "type")

    def _stripe_recurring_for_interval(self, billing_interval: str) -> tuple[Optional[dict[str, Any]], int]:
        return BillingPlanManager(self, stripe_service_cls=self._billing_stripe_service_cls())._stripe_recurring_for_interval(billing_interval)

    def _application_fee_percent(self, account: dict[str, Any]) -> float:
        return round((account.get("platform_fee_bps") or self.settings.BILLING_PLATFORM_FEE_BPS) / 100, 3)

    def _application_fee_amount(self, amount_cents: int, account: dict[str, Any]) -> int:
        bps = account.get("platform_fee_bps") or self.settings.BILLING_PLATFORM_FEE_BPS
        return int(round(amount_cents * bps / 10000))

    def _payer_autopay_authorized(self, payer: dict[str, Any]) -> bool:
        return payer.get("autopay_status") == "enabled" and bool(payer.get("autopay_terms_accepted_at"))

    def _idempotency_key(self, *parts: str) -> str:
        return "koaryu:" + ":".join(str(part).replace(":", "_") for part in parts if part is not None)

    def _safe_redirect_url(self, value: Optional[str], default: str) -> str:
        url = (value or default).strip()
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(status_code=400, detail="Billing redirect URL must be absolute.")
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if origin not in self._allowed_redirect_origins():
            raise HTTPException(status_code=400, detail="Billing redirect URL is not allowed.")
        return url

    def _allowed_redirect_origins(self) -> set[str]:
        parsed = urlparse(self.settings.FRONTEND_URL.rstrip("/"))
        if not parsed.scheme or not parsed.netloc:
            return set()
        origins = {f"{parsed.scheme}://{parsed.netloc}"}
        if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"} and parsed.port:
            alternate_host = "127.0.0.1" if parsed.hostname == "localhost" else "localhost"
            origins.add(f"http://{alternate_host}:{parsed.port}")
        return origins

    def _normalize_idempotency_key(self, value: Optional[str]) -> Optional[str]:
        return BillingInvoiceManager(self, stripe_service_cls=self._billing_stripe_service_cls())._normalize_idempotency_key(value)

    def _invoice_request_hash(self, data: BillingInvoiceCreate) -> str:
        return BillingInvoiceManager(self, stripe_service_cls=self._billing_stripe_service_cls())._invoice_request_hash(data)

    def _is_stale_stripe_event(self, row: dict[str, Any], event_created: Optional[int]) -> bool:
        return is_stale_stripe_event(row, event_created)
    def _update_invoice_last_event(self, invoice: dict[str, Any], studio_id: str, event_created: int) -> dict[str, Any]:
        return self._webhook_projector()._update_invoice_last_event(invoice, studio_id, event_created)
    def _resolve_stripe_event_studio_id(
        self,
        account_id: Optional[str],
        *,
        metadata_studio_id: Optional[str] = None,
        local_studio_id: Optional[str] = None,
    ) -> Optional[str]:
        account = self._connect_accounts().by_stripe_account(account_id) if account_id else None
        account_studio_id = (account or {}).get("studio_id")

        if account_id:
            trusted_studio_id = account_studio_id or local_studio_id
        else:
            trusted_studio_id = local_studio_id or metadata_studio_id

        if not trusted_studio_id:
            return None
        for candidate in (account_studio_id, local_studio_id, metadata_studio_id):
            if candidate and candidate != trusted_studio_id:
                return None
        return trusted_studio_id

    @staticmethod
    def _row_matches_stripe_account(row: dict[str, Any], account_id: Optional[str]) -> bool:
        row_account_id = row.get("stripe_account_id")
        if account_id:
            return row_account_id == account_id
        return row_account_id is None

    def _is_same_second_status_regression(
        self,
        last_event_created: Any,
        event_created: Optional[int],
        *,
        current_status: Optional[str],
        incoming_status: Optional[str],
        status_order: dict[str, int],
    ) -> bool:
        return is_same_second_status_regression(
            last_event_created,
            event_created,
            current_status=current_status,
            incoming_status=incoming_status,
            status_order=status_order,
        )
    def _preserve_invoice_terminal_state(self, update: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
        return preserve_invoice_terminal_state(update, current)
    def _claim_invoice_create_request(
        self,
        studio_id: str,
        idempotency_key: Optional[str],
        request_hash: str,
        invoice_row: dict[str, Any],
    ) -> dict[str, Any]:
        return BillingInvoiceManager(self, stripe_service_cls=self._billing_stripe_service_cls())._claim_invoice_create_request(
            studio_id,
            idempotency_key,
            request_hash,
            invoice_row,
        )

    def _find_invoice_by_idempotency_key(self, studio_id: str, idempotency_key: str) -> Optional[dict[str, Any]]:
        return BillingInvoiceManager(self, stripe_service_cls=self._billing_stripe_service_cls())._find_invoice_by_idempotency_key(
            studio_id,
            idempotency_key,
        )

    def _insert_invoice_item_once(self, row: dict[str, Any]) -> None:
        BillingInvoiceManager(self, stripe_service_cls=self._billing_stripe_service_cls())._insert_invoice_item_once(row)

    def _timestamp(self, value: Any) -> Optional[str]:
        return timestamp(value)
    def _epoch_seconds(self, value: Any) -> Optional[float]:
        return epoch_seconds(value)
    def _date_from_epoch(self, value: Any) -> Optional[str]:
        return date_from_epoch(value)
    def _date_to_epoch(self, value: str) -> int:
        return BillingInvoiceManager(self, stripe_service_cls=self._billing_stripe_service_cls())._date_to_epoch(value)

    def _recompute_payer_balance(self, studio_id: str, payer_id: Optional[str]) -> None:
        BillingPayerManager(self, stripe_service_cls=self._billing_stripe_service_cls())._recompute_payer_balance(studio_id, payer_id)

    def _plan_response(self, row: dict[str, Any], account: dict[str, Any]) -> BillingPlanResponse:
        return BillingPlanManager(self, stripe_service_cls=self._billing_stripe_service_cls())._plan_response(row, account)

    def _programs_for_plan(self, studio_id: str, plan_id: str) -> list[BillingPlanProgramResponse]:
        return BillingPlanManager(self, stripe_service_cls=self._billing_stripe_service_cls())._programs_for_plan(studio_id, plan_id)

    def _replace_plan_programs(self, studio_id: str, plan_id: str, program_ids: list[str]) -> None:
        BillingPlanManager(self, stripe_service_cls=self._billing_stripe_service_cls())._replace_plan_programs(studio_id, plan_id, program_ids)

    def _ensure_programs_in_studio(self, studio_id: str, program_ids: list[str]) -> None:
        BillingPlanManager(self, stripe_service_cls=self._billing_stripe_service_cls())._ensure_programs_in_studio(studio_id, program_ids)

    def _ensure_record_in_studio(self, table: str, record_id: str, studio_id: str, detail: str) -> None:
        result = self.supabase.table(table).select("id").eq("id", record_id).eq("studio_id", studio_id).limit(1).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail=detail)

    def _get_row_or_404(self, table: str, record_id: str, studio_id: str, detail: str) -> dict[str, Any]:
        result = self.supabase.table(table).select("*").eq("id", record_id).eq("studio_id", studio_id).maybe_single().execute()
        if not result.data:
            raise HTTPException(status_code=404, detail=detail)
        return result.data

    def _get_studio(self, studio_id: str) -> dict[str, Any]:
        result = self.supabase.table("studios").select("id, name, owner_id").eq("id", studio_id).single().execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Studio not found.")
        return result.data

    def _get_user_email(self, user_id: Optional[str]) -> Optional[str]:
        if not user_id:
            return None
        try:
            result = self.supabase.auth.admin.get_user_by_id(user_id)
        except Exception:
            return None
        user = getattr(result, "user", None)
        return getattr(user, "email", None)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": "billing",
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()

    def _audit_best_effort(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        try:
            self._audit(studio_id, actor_id, action, entity_id, metadata)
        except Exception:
            return

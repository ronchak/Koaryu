from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from app.services.billing_payment_projection import BillingPaymentEventProjector
from app.services.billing_invoice_projection import (
    _object_get,
    _stripe_id,
    invoice_line_period_bounds,
    invoice_metadata,
    invoice_subscription_id,
    invoice_subscription_item_id,
    local_invoice_status,
)
from app.services.stripe_service import StripeService
from app.services.stripe_mutation_policy import StripeMutationBlocked
from app.services.billing_subscription_webhook_projection import BillingSubscriptionWebhookProjector
from app.services.billing_webhook_event_state import (
    INVOICE_STATUS_ORDER,
    add_stripe_event_created_guard,
    date_from_epoch,
    epoch_seconds,
    is_same_second_status_regression,
    is_stale_stripe_event,
    preserve_invoice_terminal_state,
    timestamp,
)


class BillingWebhookProjector:
    def __init__(self, billing_service: Any, *, stripe_service_cls: type[StripeService] = StripeService):
        self.billing_service = billing_service
        self.stripe_service_cls = stripe_service_cls

    @property
    def supabase(self):
        return self.billing_service.supabase

    def _connect_accounts(self):
        return self.billing_service._connect_accounts()

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

    def _get_row_or_404(
        self,
        table: str,
        record_id: str,
        studio_id: str,
        detail: str,
    ) -> dict[str, Any]:
        return self.billing_service._get_row_or_404(table, record_id, studio_id, detail)

    def _payment_method_fields_from_customer(self, customer: Any) -> dict[str, Any]:
        return self.billing_service._payment_method_fields_from_customer(customer)

    def _payment_method_fields_from_payment_method(self, payment_method: Any) -> dict[str, Any]:
        return self.billing_service._payment_method_fields_from_payment_method(payment_method)

    def _payer_id_for_customer(
        self,
        studio_id: str,
        account_id: Optional[str],
        customer_id: Optional[str],
    ) -> Optional[str]:
        return self.billing_service._payer_id_for_customer(studio_id, account_id, customer_id)

    def _row_matches_stripe_account(self, row: dict[str, Any], account_id: Optional[str]) -> bool:
        return self.billing_service._row_matches_stripe_account(row, account_id)

    def _recompute_payer_balance(self, studio_id: str, payer_id: Optional[str]) -> None:
        self.billing_service._recompute_payer_balance(studio_id, payer_id)

    def _payment_events(self) -> BillingPaymentEventProjector:
        return BillingPaymentEventProjector(
            self.billing_service,
            stripe_service_cls=self.stripe_service_cls,
        )

    def _subscription_events(self) -> BillingSubscriptionWebhookProjector:
        return BillingSubscriptionWebhookProjector(self.billing_service)

    def project_connect_event(self, event: dict[str, Any]) -> None:
        event_type = event.get("type") or ""
        account_id = event.get("account")
        event_created = event.get("created")
        data_object = ((event.get("data") or {}).get("object") or {})
        if event_type == "account.application.deauthorized":
            account_id = account_id or data_object.get("id")
            self._connect_accounts().update_by_stripe_account(account_id, {
                "status": "deauthorized",
                "charges_enabled": False,
                "payouts_enabled": False,
            }, event_created=event_created)
            return
        if event_type == "account.updated":
            account_id = account_id or data_object.get("id")
            self._connect_accounts().update_by_stripe_account(
                account_id,
                self._connect_accounts().update_from_stripe(data_object),
                event_created=event_created,
            )
            return
        if self._requires_connected_account(event_type) and not account_id:
            return
        if event_type == "checkout.session.completed":
            self._project_checkout_session(data_object, account_id)
            return
        if event_type in {
            "invoice.created",
            "invoice.finalized",
            "invoice.paid",
            "invoice.payment_failed",
            "invoice.voided",
            "invoice.marked_uncollectible",
        }:
            self._project_invoice_event(data_object, account_id, event_type, event_created)
            return
        if event_type in {
            "payment_intent.processing",
            "payment_intent.succeeded",
            "payment_intent.payment_failed",
        }:
            self._project_payment_intent(data_object, account_id, event_type, event_created)
            return
        if event_type == "charge.refunded":
            self._project_charge_refund(data_object, account_id)
            return
        if event_type.startswith("charge.dispute."):
            self._project_dispute(data_object, account_id)
            return
        if event_type.startswith("customer.subscription."):
            self._project_subscription(data_object, account_id, event_type, event_created)
            return

    @staticmethod
    def _requires_connected_account(event_type: str) -> bool:
        return (
            event_type == "checkout.session.completed"
            or event_type.startswith("invoice.")
            or event_type.startswith("payment_intent.")
            or event_type.startswith("charge.")
            or event_type.startswith("customer.subscription.")
        )

    def _project_checkout_session(self, session: dict[str, Any], account_id: Optional[str]) -> None:
        metadata = session.get("metadata") or {}
        if metadata.get("product") != "koaryu_payments_autopay":
            return
        studio_id = self._resolve_stripe_event_studio_id(
            account_id,
            metadata_studio_id=metadata.get("studio_id"),
        )
        payer_id = metadata.get("payer_id")
        if not studio_id or not payer_id:
            return
        setup_intent_id = _stripe_id(session.get("setup_intent"))
        customer_id = _stripe_id(session.get("customer"))
        payer = self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        payment_fields: dict[str, Any] = {}
        if setup_intent_id and account_id:
            try:
                setup_intent = self.stripe_service_cls().retrieve_connected_setup_intent(
                    account_id=account_id,
                    setup_intent_id=setup_intent_id,
                    expand=["payment_method"],
                )
                payment_method_id = _stripe_id(_object_get(setup_intent, "payment_method"))
                if payment_method_id and customer_id:
                    customer = self.stripe_service_cls().set_connected_customer_default_payment_method(
                        account_id=account_id,
                        customer_id=customer_id,
                        payment_method_id=payment_method_id,
                    )
                    payment_fields = self._payment_method_fields_from_customer(customer)
                else:
                    payment_fields = self._payment_method_fields_from_payment_method(_object_get(setup_intent, "payment_method"))
            except StripeMutationBlocked:
                # Preserve Stripe retry semantics when this projection would need
                # an outbound mutation that the live interlock intentionally blocks.
                raise
            except Exception as exc:
                metadata = dict(payer.get("metadata") or {})
                metadata["autopay_projection_error"] = {
                    "type": exc.__class__.__name__,
                    "occurred_at": datetime.now(timezone.utc).isoformat(),
                }
                self.supabase.table("billing_payers").update({
                    "stripe_account_id": account_id,
                    "stripe_customer_id": customer_id,
                    "autopay_status": "pending",
                    "metadata": metadata,
                }).eq("id", payer_id).eq("studio_id", studio_id).execute()
                return
        metadata_update: dict[str, Any] | None = None
        if payer.get("metadata"):
            metadata_update = dict(payer.get("metadata") or {})
            metadata_update.pop("autopay_projection_error", None)

        update = {
            "stripe_account_id": account_id,
            "stripe_customer_id": customer_id,
            **{k: v for k, v in payment_fields.items() if v is not None},
        }
        if metadata_update is not None:
            update["metadata"] = metadata_update
        if payer.get("autopay_terms_accepted_at") and payment_fields.get("default_payment_method_id"):
            update["autopay_status"] = "enabled"
            update["autopay_authorized_at"] = datetime.now(timezone.utc).isoformat()
            update["billing_status"] = "current"
        else:
            update["autopay_status"] = "pending"
        self.supabase.table("billing_payers").update(update).eq("id", payer_id).eq("studio_id", studio_id).execute()

    def _project_invoice_event(
        self,
        invoice: dict[str, Any],
        account_id: Optional[str],
        event_type: str,
        event_created: Optional[int] = None,
    ) -> None:
        local = self._find_invoice_for_stripe(invoice, account_id)
        metadata = invoice_metadata(invoice)
        studio_id = self._resolve_stripe_event_studio_id(
            account_id,
            metadata_studio_id=metadata.get("studio_id"),
            local_studio_id=(local or {}).get("studio_id"),
        )
        if not studio_id:
            return
        if local and is_stale_stripe_event(local, event_created):
            return
        if local:
            local = self._update_invoice_from_stripe(local["id"], studio_id, invoice, account_id, event_created=event_created)
        else:
            local = self._insert_invoice_from_stripe(studio_id, invoice, account_id, event_created)
        if local and is_stale_stripe_event(local, event_created):
            return
        self._update_subscription_period_from_invoice(studio_id, invoice, account_id)
        if event_type == "invoice.paid":
            self._project_payment_from_invoice(invoice, account_id, local, event_created=event_created)
            self._link_orphan_payment_to_invoice(invoice, account_id, local)
        if local.get("payer_id"):
            self._recompute_payer_balance(studio_id, local.get("payer_id"))

    def _project_payment_intent(
        self,
        intent: dict[str, Any],
        account_id: Optional[str],
        event_type: str,
        event_created: Optional[int] = None,
    ) -> None:
        self._payment_events()._project_payment_intent(intent, account_id, event_type, event_created)

    def _link_disputes_to_payment(self, payment: dict[str, Any], account_id: Optional[str]) -> dict[str, Any]:
        return self._payment_events()._link_disputes_to_payment(payment, account_id)

    def _project_charge_refund(self, charge: dict[str, Any], account_id: Optional[str]) -> None:
        self._payment_events()._project_charge_refund(charge, account_id)

    def _project_refund(self, refund: Any, account_id: Optional[str], *, charge: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        return self._payment_events()._project_refund(refund, account_id, charge=charge)

    def _project_dispute(self, dispute: dict[str, Any], account_id: Optional[str]) -> None:
        self._payment_events()._project_dispute(dispute, account_id)

    def _refresh_invoice_and_payer_from_payment_events(self, payment: dict[str, Any]) -> None:
        self._payment_events()._refresh_invoice_and_payer_from_payment_events(payment)

    def _project_subscription(
        self,
        subscription: dict[str, Any],
        account_id: Optional[str],
        event_type: str = "",
        event_created: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        return self._subscription_events().project_subscription(
            subscription,
            account_id,
            event_type=event_type,
            event_created=event_created,
        )

    def _update_invoice_from_stripe(
        self,
        invoice_id: str,
        studio_id: str,
        invoice: Any,
        account_id: Optional[str],
        *,
        event_created: Optional[int] = None,
    ) -> dict[str, Any]:
        update = self._invoice_projection(invoice, account_id)
        current_rows = self.supabase.table("billing_invoices").select("*").eq("id", invoice_id).eq("studio_id", studio_id).limit(1).execute()
        current = current_rows.data[0] if current_rows.data else {}
        if is_same_second_status_regression(
            current.get("last_stripe_event_created"),
            event_created,
            current_status=current.get("status"),
            incoming_status=update.get("status"),
            status_order=INVOICE_STATUS_ORDER,
        ):
            update = preserve_invoice_terminal_state(update, current)
        for stable_field in ("stripe_payment_intent_id", "stripe_subscription_id"):
            if update.get(stable_field) is None and current.get(stable_field):
                update[stable_field] = current[stable_field]
        if event_created is not None:
            update["last_stripe_event_created"] = event_created
        update.update(self._invoice_identity_projection(studio_id, invoice, account_id, current=current))
        query = (
            self.supabase.table("billing_invoices")
            .update(update)
            .eq("id", invoice_id)
            .eq("studio_id", studio_id)
        )
        query = add_stripe_event_created_guard(query, event_created)
        result = query.execute()
        if result.data:
            return result.data[0]
        if event_created is not None:
            latest_rows = (
                self.supabase.table("billing_invoices")
                .select("*")
                .eq("id", invoice_id)
                .eq("studio_id", studio_id)
                .limit(1)
                .execute()
            )
            return latest_rows.data[0] if latest_rows.data else current
        return {**current, **update}

    def _insert_invoice_from_stripe(
        self,
        studio_id: str,
        invoice: dict[str, Any],
        account_id: Optional[str],
        event_created: Optional[int] = None,
    ) -> dict[str, Any]:
        metadata = invoice_metadata(invoice)
        row = {
            "studio_id": studio_id,
            "payer_id": None,
            "student_id": None,
            "enrollment_id": None,
            "invoice_type": metadata.get("invoice_type") or "manual",
            "external": False,
            "last_stripe_event_created": event_created,
            **self._invoice_projection(invoice, account_id),
        }
        row.update(self._invoice_identity_projection(studio_id, invoice, account_id))
        result = self.supabase.table("billing_invoices").insert(row).execute()
        return result.data[0] if result.data else row

    def _invoice_projection(self, invoice: Any, account_id: Optional[str]) -> dict[str, Any]:
        invoice_id = _stripe_id(invoice)
        status_value = _object_get(invoice, "status") or "draft"
        if status_value == "void":
            status_value = "void"
        payment_intent = _object_get(invoice, "payment_intent")
        last_error = _object_get(_object_get(payment_intent, "last_payment_error"), "message")
        amount_due = int(_object_get(invoice, "amount_due") or 0)
        amount_paid = int(_object_get(invoice, "amount_paid") or 0)
        amount_remaining = int(_object_get(invoice, "amount_remaining") or 0)
        application_fee_amount = _object_get(invoice, "application_fee_amount")
        if _object_get(invoice, "paid_out_of_band"):
            amount_paid = amount_due
            amount_remaining = 0
        projection = {
            "stripe_invoice_id": invoice_id,
            "stripe_account_id": account_id,
            "stripe_customer_id": _stripe_id(_object_get(invoice, "customer")),
            "stripe_subscription_id": invoice_subscription_id(invoice),
            "stripe_payment_intent_id": _stripe_id(payment_intent),
            "invoice_number": _object_get(invoice, "number"),
            "status": local_invoice_status(status_value),
            "amount_due_cents": amount_due,
            "amount_paid_cents": amount_paid,
            "amount_remaining_cents": amount_remaining,
            "currency": _object_get(invoice, "currency") or "usd",
            "hosted_invoice_url": _object_get(invoice, "hosted_invoice_url"),
            "invoice_pdf": _object_get(invoice, "invoice_pdf"),
            "due_date": date_from_epoch(_object_get(invoice, "due_date")),
            "paid_at": timestamp(_object_get(_object_get(invoice, "status_transitions") or {}, "paid_at")),
            "finalized_at": timestamp(_object_get(_object_get(invoice, "status_transitions") or {}, "finalized_at")),
            "voided_at": timestamp(_object_get(_object_get(invoice, "status_transitions") or {}, "voided_at")),
            "collection_method": _object_get(invoice, "collection_method"),
            "last_payment_error": last_error,
        }
        if _object_get(invoice, "paid_out_of_band"):
            projection["application_fee_amount_cents"] = 0
        elif application_fee_amount is not None:
            projection["application_fee_amount_cents"] = int(application_fee_amount)
        return projection

    def _project_payment_from_invoice(
        self,
        invoice: dict[str, Any],
        account_id: Optional[str],
        local_invoice: dict[str, Any],
        *,
        event_created: Optional[int] = None,
    ) -> None:
        self._payment_events()._project_payment_from_invoice(
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
        current = current or {}
        metadata = invoice_metadata(invoice)
        enrollment = self._invoice_enrollment(studio_id, invoice)
        subscription_id = invoice_subscription_id(invoice)
        projection: dict[str, Any] = {}
        payer_id = metadata.get("payer_id") or current.get("payer_id") or self._payer_id_for_customer(studio_id, account_id, _stripe_id(_object_get(invoice, "customer")))
        enrollment_id = metadata.get("enrollment_id") or (enrollment or {}).get("id")
        student_id = metadata.get("student_id") or (enrollment or {}).get("student_id")
        invoice_type = metadata.get("invoice_type") or ("tuition" if subscription_id else None)
        if payer_id and not current.get("payer_id"):
            projection["payer_id"] = payer_id
        if enrollment_id and not current.get("enrollment_id"):
            projection["enrollment_id"] = enrollment_id
        if student_id and not current.get("student_id"):
            projection["student_id"] = student_id
        if invoice_type and (not current.get("invoice_type") or current.get("invoice_type") == "manual"):
            projection["invoice_type"] = invoice_type
        return projection

    def _invoice_enrollment(self, studio_id: str, invoice: Any) -> Optional[dict[str, Any]]:
        item_id = invoice_subscription_item_id(invoice)
        if not item_id:
            return None
        result = (
            self.supabase.table("student_billing_enrollments")
            .select("id, student_id")
            .eq("studio_id", studio_id)
            .eq("stripe_subscription_item_id", item_id)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def _update_subscription_period_from_invoice(self, studio_id: str, invoice: Any, account_id: Optional[str]) -> None:
        subscription_id = invoice_subscription_id(invoice)
        if not subscription_id:
            return
        period_start, period_end = invoice_line_period_bounds(invoice)
        if not period_start and not period_end:
            return
        query = (
            self.supabase.table("billing_subscriptions")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("stripe_subscription_id", subscription_id)
            .limit(1)
        )
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        if not result.data:
            return
        current = result.data[0]
        update: dict[str, Any] = {}
        current_end = epoch_seconds(current.get("current_period_end"))
        incoming_end = epoch_seconds(period_end)
        should_update = not current.get("current_period_end") or (
            incoming_end is not None and (current_end is None or incoming_end >= current_end)
        )
        if period_start and should_update:
            update["current_period_start"] = timestamp(period_start)
        if period_end and should_update:
            update["current_period_end"] = timestamp(period_end)
        if update:
            self.supabase.table("billing_subscriptions").update(update).eq("id", current["id"]).execute()

    def _link_orphan_payment_to_invoice(self, invoice: dict[str, Any], account_id: Optional[str], local_invoice: dict[str, Any]) -> None:
        if not local_invoice or not local_invoice.get("id"):
            return
        payment_intent_id = _stripe_id(invoice.get("payment_intent"))
        payment = self._find_payment_by_intent(account_id, payment_intent_id) if payment_intent_id else None
        if not payment:
            payment = self._find_unlinked_payment_by_customer_amount(
                account_id,
                _stripe_id(invoice.get("customer")),
                int(invoice.get("amount_paid") or invoice.get("amount_due") or 0),
                invoice.get("currency") or "usd",
            )
        if not payment:
            return
        payment_update = {
            "invoice_id": local_invoice["id"],
            "stripe_invoice_id": local_invoice.get("stripe_invoice_id") or _stripe_id(invoice),
        }
        if local_invoice.get("payer_id") and not payment.get("payer_id"):
            payment_update["payer_id"] = local_invoice["payer_id"]
        self.supabase.table("billing_payments").update(payment_update).eq("id", payment["id"]).execute()
        invoice_update: dict[str, Any] = {}
        if payment.get("stripe_payment_intent_id") and not local_invoice.get("stripe_payment_intent_id"):
            invoice_update["stripe_payment_intent_id"] = payment["stripe_payment_intent_id"]
        existing_fee = local_invoice.get("application_fee_amount_cents")
        payment_fee = payment.get("application_fee_amount_cents")
        if payment_fee is not None and (int(payment_fee or 0) > 0 or existing_fee is None):
            invoice_update["application_fee_amount_cents"] = int(payment.get("application_fee_amount_cents") or 0)
        if invoice_update:
            self.supabase.table("billing_invoices").update(invoice_update).eq("id", local_invoice["id"]).execute()
            local_invoice.update(invoice_update)

    def _find_invoice_for_stripe(self, invoice: dict[str, Any], account_id: Optional[str]) -> Optional[dict[str, Any]]:
        metadata = invoice_metadata(invoice)
        local_id = metadata.get("invoice_id")
        studio_id = metadata.get("studio_id")
        if local_id and studio_id:
            result = self.supabase.table("billing_invoices").select("*").eq("id", local_id).eq("studio_id", studio_id).limit(1).execute()
            if result.data and self._row_matches_stripe_account(result.data[0], account_id):
                return result.data[0]
        stripe_invoice_id = _stripe_id(invoice)
        if not stripe_invoice_id:
            return None
        query = self.supabase.table("billing_invoices").select("*").eq("stripe_invoice_id", stripe_invoice_id).limit(1)
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0] if result.data else None

    def _find_invoice_by_payment_intent_or_invoice(
        self,
        account_id: Optional[str],
        payment_intent_id: Optional[str],
        stripe_invoice_id: Optional[str],
    ) -> Optional[dict[str, Any]]:
        return self._payment_events()._find_invoice_by_payment_intent_or_invoice(
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
        return self._payment_events()._find_invoice_by_customer_amount(
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
        return self._payment_events()._find_unlinked_payment_by_customer_amount(
            account_id,
            customer_id,
            amount_cents,
            currency,
        )

    def _find_payment_by_charge(self, account_id: Optional[str], charge_id: Optional[str]) -> Optional[dict[str, Any]]:
        return self._payment_events()._find_payment_by_charge(account_id, charge_id)

    def _find_payment_by_intent(self, account_id: Optional[str], payment_intent_id: Optional[str]) -> Optional[dict[str, Any]]:
        return self._payment_events()._find_payment_by_intent(account_id, payment_intent_id)

    def _stored_stripe_event_object(
        self,
        account_id: Optional[str],
        object_id: str,
        event_types: list[str],
    ) -> Optional[dict[str, Any]]:
        try:
            query = (
                self.supabase.table("stripe_events")
                .select("payload, type, created_at")
                .eq("payload->data->object->>id", object_id)
                .in_("type", event_types)
                .order("created_at", desc=True)
                .limit(10)
            )
            query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
            result = query.execute()
        except Exception:
            return None
        for row in result.data or []:
            payload = row.get("payload") or {}
            data_object = ((payload.get("data") or {}).get("object") or {})
            if _stripe_id(data_object) == object_id:
                return data_object
        return None

    def _find_subscription_for_stripe(self, subscription: dict[str, Any], account_id: Optional[str]) -> Optional[dict[str, Any]]:
        return self._subscription_events().find_subscription_for_stripe(subscription, account_id)

    def _project_subscription_items(self, subscription: dict[str, Any], group: dict[str, Any]) -> None:
        self._subscription_events().project_subscription_items(subscription, group)

    def _update_invoice_last_event(self, invoice: dict[str, Any], studio_id: str, event_created: int) -> dict[str, Any]:
        query = (
            self.supabase.table("billing_invoices")
            .update({"last_stripe_event_created": event_created})
            .eq("id", invoice["id"])
            .eq("studio_id", studio_id)
        )
        query = add_stripe_event_created_guard(query, event_created)
        result = query.execute()
        if result.data:
            return result.data[0]
        latest_rows = (
            self.supabase.table("billing_invoices")
            .select("*")
            .eq("id", invoice["id"])
            .eq("studio_id", studio_id)
            .limit(1)
            .execute()
        )
        return latest_rows.data[0] if latest_rows.data else invoice

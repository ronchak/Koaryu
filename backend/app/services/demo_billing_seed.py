from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.services.demo_seed_common import (
    DEMO_CONNECT_ACCOUNT_ID,
    OPTIONAL_SCHEMA_ERROR_CODES,
    demo_seed_id,
)


class DemoBillingSeeder:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    def _id(self, studio_id: str, key: str) -> str:
        return demo_seed_id(studio_id, key)

    def _today(self) -> date:
        return date.today()

    def _date(self, days_from_today: int) -> str:
        return (self._today() + timedelta(days=days_from_today)).isoformat()

    def _timestamp(self, days_from_today: int = 0, hour: int = 9, minute: int = 0) -> str:
        value = datetime.combine(
            self._today() + timedelta(days=days_from_today),
            time(hour=hour, minute=minute),
            tzinfo=timezone.utc,
        )
        return value.isoformat()

    def _insert(self, table: str, rows: list[dict[str, Any]]) -> None:
        if rows:
            self.supabase.table(table).insert(rows).execute()

    def _insert_optional(self, table: str, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        try:
            self._insert(table, rows)
        except PostgrestAPIError as exc:
            if exc.code not in OPTIONAL_SCHEMA_ERROR_CODES:
                raise

    def seed(
        self,
        studio_id: str,
        program_ids: dict[str, str],
        student_ids: dict[str, str],
    ) -> None:
        now = self._timestamp()
        period_start = self._today().replace(day=1).isoformat()
        if self._today().month == 12:
            period_end = date(self._today().year + 1, 1, 1).isoformat()
        else:
            period_end = date(self._today().year, self._today().month + 1, 1).isoformat()

        self._insert_optional(
            "email_usage_events",
            [
                {
                    "id": self._id(studio_id, f"email-usage:{category}"),
                    "studio_id": studio_id,
                    "category": category,
                    "quantity": quantity,
                    "sent_at": self._timestamp(offset, 10),
                    "metadata": {"demo": True},
                }
                for category, quantity, offset in [
                    ("trial_reminders", 88, -18),
                    ("attendance_followups", 104, -12),
                    ("promotion_notices", 42, -7),
                    ("billing_receipts", 96, -3),
                    ("staff_invites", 18, -1),
                ]
            ],
        )

        plan_specs = [
            ("kids-unlimited", "Kids Unlimited", "Unlimited youth classes with belt testing billed separately.", 12900, "monthly", [program_ids["bjj_core"]]),
            ("adult-unlimited", "Adult Unlimited", "Unlimited adult BJJ classes, no-gi, and open mat access.", 14900, "monthly", [program_ids["bjj_core"]]),
            ("tkd-fundamentals", "Tae Kwon Do Fundamentals", "Monthly Tae Kwon Do tuition for youth and adult fundamentals.", 11900, "monthly", [program_ids["tae_kwon_do"]]),
            ("family-unlimited", "Family Unlimited", "Family tuition for multiple students across programs.", 17900, "monthly", [program_ids["bjj_core"], program_ids["tae_kwon_do"]]),
            ("belt-test", "Belt Testing Fee", "One-time exam charge collected when a promotion is approved.", 3500, "paid_in_full", [program_ids["bjj_core"], program_ids["tae_kwon_do"]]),
        ]
        plan_rows = []
        plan_program_rows = []
        plan_ids: dict[str, str] = {}
        for index, (key, name, description, amount, interval, attached_programs) in enumerate(plan_specs):
            plan_id = self._id(studio_id, f"billing-plan:{key}")
            plan_ids[key] = plan_id
            plan_rows.append(
                {
                    "id": plan_id,
                    "studio_id": studio_id,
                    "name": name,
                    "description": description,
                    "amount_cents": amount,
                    "currency": "usd",
                    "billing_interval": interval,
                    "status": "active",
                    "signup_fee_cents": 4900 if key == "kids-unlimited" else 0,
                    "trial_days": 14 if key == "kids-unlimited" else 0,
                    "proration_behavior": "next_cycle",
                    "stripe_account_id": DEMO_CONNECT_ACCOUNT_ID,
                    "stripe_product_id": f"prod_demo_{key}",
                    "stripe_price_id": f"price_demo_{key}",
                    "stripe_price_lookup_key": f"koaryu_demo_{key}",
                    "stripe_one_time_price_id": f"price_demo_{key}_one_time" if interval == "paid_in_full" else None,
                    "metadata": {"demo": True},
                    "created_at": self._timestamp(-36 + index, 9),
                    "updated_at": now,
                }
            )
            for program_id in attached_programs:
                plan_program_rows.append(
                    {
                        "id": self._id(studio_id, f"billing-plan-program:{key}:{program_id}"),
                        "studio_id": studio_id,
                        "billing_plan_id": plan_id,
                        "program_id": program_id,
                        "created_at": now,
                    }
                )
        self._insert_optional("billing_plans", plan_rows)
        self._insert_optional("billing_plan_programs", plan_program_rows)
        self._insert_optional(
            "billing_plan_prices",
            [
                {
                    "id": self._id(studio_id, f"billing-plan-price:{key}"),
                    "studio_id": studio_id,
                    "billing_plan_id": plan_ids[key],
                    "stripe_account_id": DEMO_CONNECT_ACCOUNT_ID,
                    "stripe_product_id": f"prod_demo_{key}",
                    "stripe_price_id": f"price_demo_{key}",
                    "amount_cents": amount,
                    "currency": "usd",
                    "billing_interval": interval,
                    "interval_count": 1,
                    "recurring": interval != "paid_in_full",
                    "active": True,
                    "version": 1,
                    "metadata": {"demo": True},
                    "created_at": self._timestamp(-34 + index, 9),
                }
                for index, (key, _name, _description, amount, interval, _programs) in enumerate(plan_specs)
            ],
        )

        payer_specs = [
            ("tanaka", "Kenji Tanaka", "kenji.tanaka@example.test", "(555) 234-5678", "guardian:aiko", "current", "enabled", 0),
            ("park", "Jin Park", "jin.park@example.test", "(555) 241-0117", "guardian:chloe", "past_due", "enabled", 11900),
            ("haddad", "Omar Haddad", "omar.haddad@example.test", "(555) 241-0116", None, "externally_paid", "not_configured", 0),
            ("webb", "Marcus Webb", "marcus.webb@example.test", "(555) 876-5432", None, "current", "enabled", 0),
            ("thompson", "Andre Thompson", "andre.thompson@example.test", "(555) 241-0113", "guardian:kai", "failed", "enabled", 12900),
            ("mori", "Yumi Mori", "yumi.mori@example.test", "(555) 241-0101", "guardian:hana", "upcoming", "pending", 0),
            ("grant", "Lucas Grant", "lucas.grant@example.test", "(555) 241-0107", None, "no_payment_method", "not_configured", 0),
            ("johnson", "Megan Johnson", "megan.johnson@example.test", "(555) 241-0102", "guardian:liam", "current", "enabled", 0),
            ("bennett", "Claire Bennett", "claire.bennett@example.test", "(555) 241-0104", "guardian:noah_b", "unpaid", "disabled", 3500),
            ("rossi", "Gianna Rossi", "gianna.rossi@example.test", "(555) 241-0112", "guardian:isabella", "current", "enabled", 0),
        ]
        payer_ids: dict[str, str] = {}
        payer_rows = []
        for key, name, email, phone, guardian_key, billing_status, autopay_status, balance in payer_specs:
            payer_id = self._id(studio_id, f"billing-payer:{key}")
            payer_ids[key] = payer_id
            payer_rows.append(
                {
                    "id": payer_id,
                    "studio_id": studio_id,
                    "guardian_id": self._id(studio_id, guardian_key) if guardian_key else None,
                    "display_name": name,
                    "email": email,
                    "phone": phone,
                    "stripe_account_id": None if billing_status == "externally_paid" else DEMO_CONNECT_ACCOUNT_ID,
                    "stripe_customer_id": None if billing_status == "externally_paid" else f"cus_demo_{key}",
                    "autopay_status": autopay_status,
                    "billing_status": billing_status,
                    "balance_cents": balance,
                    "metadata": {"demo": True},
                    "created_at": self._timestamp(-32, 9),
                    "updated_at": now,
                }
            )
        self._insert_optional("billing_payers", payer_rows)

        enrollment_specs = [
            ("aiko", "tanaka", "kids-unlimited", "current", self._date(7), "autopay"),
            ("chloe", "park", "tkd-fundamentals", "past_due", self._date(-3), "invoice_link"),
            ("omar", "haddad", "tkd-fundamentals", "externally_paid", self._date(5), "external"),
            ("marcus", "webb", "family-unlimited", "current", self._date(10), "autopay"),
            ("kai", "thompson", "kids-unlimited", "failed", self._date(-1), "autopay"),
            ("hana", "mori", "kids-unlimited", "upcoming", self._date(12), "invoice_link"),
            ("lucas", "grant", "adult-unlimited", "no_payment_method", self._date(4), "invoice_link"),
            ("liam", "johnson", "family-unlimited", "current", self._date(9), "autopay"),
            ("mia_j", "johnson", "family-unlimited", "current", self._date(9), "autopay"),
            ("julian", "bennett", "belt-test", "unpaid", self._date(2), "invoice_link"),
            ("isabella", "rossi", "kids-unlimited", "current", self._date(14), "autopay"),
        ]
        subscription_specs = [
            ("tanaka", "autopay", "monthly", "active", self._date(7), "sub_demo_tanaka"),
            ("park", "invoice_link", "monthly", "past_due", self._date(-3), "sub_demo_park"),
            ("webb", "autopay", "monthly", "active", self._date(10), "sub_demo_webb"),
            ("thompson", "autopay", "monthly", "past_due", self._date(-1), "sub_demo_thompson"),
            ("mori", "invoice_link", "monthly", "trialing", self._date(12), "sub_demo_mori"),
            ("grant", "invoice_link", "monthly", "incomplete", self._date(4), "sub_demo_grant"),
            ("johnson", "autopay", "monthly", "active", self._date(9), "sub_demo_johnson"),
            ("bennett", "invoice_link", "paid_in_full", "past_due", self._date(2), "sub_demo_bennett"),
            ("rossi", "autopay", "monthly", "active", self._date(14), "sub_demo_rossi"),
        ]
        subscription_ids: dict[str, str] = {}
        subscription_rows = []
        for payer_key, collection_mode, billing_interval, status_value, next_bill_on, stripe_subscription in subscription_specs:
            subscription_id = self._id(studio_id, f"billing-subscription:{payer_key}:{collection_mode}:{billing_interval}")
            subscription_ids[payer_key] = subscription_id
            external = collection_mode == "external"
            subscription_rows.append(
                {
                    "id": subscription_id,
                    "studio_id": studio_id,
                    "payer_id": payer_ids[payer_key],
                    "stripe_account_id": None if external else DEMO_CONNECT_ACCOUNT_ID,
                    "stripe_customer_id": None if external else f"cus_demo_{payer_key}",
                    "stripe_subscription_id": None if external else stripe_subscription,
                    "collection_mode": collection_mode,
                    "billing_interval": billing_interval,
                    "currency": "usd",
                    "status": status_value,
                    "current_period_start": self._timestamp(-24, 0),
                    "current_period_end": self._timestamp(7, 0) if billing_interval != "paid_in_full" else self._timestamp(2, 0),
                    "cancel_at_period_end": False,
                    "default_payment_method_id": None if collection_mode != "autopay" else f"pm_demo_{payer_key}",
                    "application_fee_percent": 0.5,
                    "metadata": {"demo": True, "next_bill_on": next_bill_on},
                    "created_at": self._timestamp(-30, 9),
                    "updated_at": now,
                }
            )
        self._insert_optional("billing_subscriptions", subscription_rows)

        enrollment_ids: dict[str, str] = {}
        enrollment_plan_ids: dict[str, str] = {}
        enrollment_rows = []
        for student_key, payer_key, plan_key, billing_status, next_bill_on, collection_mode in enrollment_specs:
            enrollment_id = self._id(studio_id, f"billing-enrollment:{student_key}:{plan_key}")
            enrollment_ids[student_key] = enrollment_id
            enrollment_plan_ids[student_key] = plan_ids[plan_key]
            external = collection_mode == "external"
            enrollment_rows.append(
                {
                    "id": enrollment_id,
                    "studio_id": studio_id,
                    "student_id": student_ids[student_key],
                    "payer_id": payer_ids[payer_key],
                    "billing_plan_id": plan_ids[plan_key],
                    "billing_subscription_id": subscription_ids.get(payer_key),
                    "collection_mode": collection_mode,
                    "status": "active",
                    "billing_status": billing_status,
                    "start_date": self._date(-90),
                    "next_bill_on": next_bill_on,
                    "stripe_subscription_id": None if external else f"sub_demo_{payer_key}",
                    "stripe_subscription_item_id": None if external else f"si_demo_{payer_key}_{plan_key}",
                    "metadata": {"demo": True},
                    "created_at": self._timestamp(-30, 9),
                    "updated_at": now,
                }
            )
        self._insert_optional("student_billing_enrollments", enrollment_rows)

        invoice_specs = [
            ("paid-aiko", "tanaka", "aiko", "tuition", "paid", 12900, 12900, self._date(-24), False, "in_demo_aiko"),
            ("open-chloe", "park", "chloe", "tuition", "open", 11900, 0, self._date(-3), False, "in_demo_chloe"),
            ("external-omar", "haddad", "omar", "tuition", "paid", 11900, 11900, self._date(-2), True, None),
            ("paid-marcus", "webb", "marcus", "tuition", "paid", 17900, 17900, self._date(-12), False, "in_demo_marcus"),
            ("failed-kai", "thompson", "kai", "tuition", "open", 12900, 0, self._date(-1), False, "in_demo_kai"),
            ("partial-hana", "mori", "hana", "tuition", "open", 12900, 4900, self._date(1), False, "in_demo_hana"),
            ("setup-lucas", "grant", "lucas", "tuition", "draft", 14900, 0, self._date(4), False, "in_demo_lucas"),
            ("paid-johnson-liam", "johnson", "liam", "tuition", "paid", 8950, 8950, self._date(-8), False, "in_demo_johnson_liam"),
            ("paid-johnson-mia", "johnson", "mia_j", "tuition", "paid", 8950, 8950, self._date(-8), False, "in_demo_johnson_mia"),
            ("unpaid-julian-test", "bennett", "julian", "belt_test", "open", 3500, 0, self._date(-4), False, "in_demo_julian_test"),
            ("paid-isabella", "rossi", "isabella", "tuition", "paid", 12900, 12900, self._date(-6), False, "in_demo_isabella"),
        ]
        invoice_ids: dict[str, str] = {}
        invoice_stripe_ids: dict[str, str | None] = {}
        invoice_rows = []
        invoice_item_rows = []
        for key, payer_key, student_key, invoice_type, invoice_status, due, paid, due_date, external, stripe_invoice in invoice_specs:
            invoice_id = self._id(studio_id, f"billing-invoice:{key}")
            invoice_ids[key] = invoice_id
            invoice_stripe_ids[key] = stripe_invoice
            invoice_rows.append(
                {
                    "id": invoice_id,
                    "studio_id": studio_id,
                    "payer_id": payer_ids[payer_key],
                    "student_id": student_ids[student_key],
                    "enrollment_id": enrollment_ids[student_key],
                    "stripe_invoice_id": stripe_invoice,
                    "stripe_account_id": None if external else DEMO_CONNECT_ACCOUNT_ID,
                    "stripe_customer_id": None if external else f"cus_demo_{payer_key}",
                    "stripe_subscription_id": None if external else f"sub_demo_{payer_key}",
                    "stripe_payment_intent_id": None if external or invoice_status != "paid" else f"pi_demo_{key}",
                    "invoice_number": f"KOA-DEMO-{len(invoice_rows) + 101}",
                    "invoice_type": invoice_type,
                    "status": invoice_status,
                    "amount_due_cents": due,
                    "amount_paid_cents": paid,
                    "amount_remaining_cents": max(0, due - paid),
                    "currency": "usd",
                    "hosted_invoice_url": f"https://dashboard.stripe.com/test/invoices/{stripe_invoice}" if stripe_invoice else None,
                    "due_date": due_date,
                    "paid_at": self._timestamp(-1, 14) if invoice_status == "paid" else None,
                    "collection_method": "send_invoice" if not external else "external",
                    "application_fee_amount_cents": 0 if external else round(due * 0.005),
                    "finalized_at": self._timestamp(-25, 8, 15) if invoice_status != "draft" else None,
                    "external": external,
                    "metadata": {"demo": True},
                    "created_at": self._timestamp(-25, 8),
                    "updated_at": now,
                }
            )
            invoice_item_rows.append(
                {
                    "id": self._id(studio_id, f"billing-invoice-item:{key}"),
                    "studio_id": studio_id,
                    "invoice_id": invoice_id,
                    "student_id": student_ids[student_key],
                    "description": "Belt testing fee" if invoice_type == "belt_test" else "Monthly tuition",
                    "quantity": 1,
                    "unit_amount_cents": due,
                    "amount_cents": due,
                    "enrollment_id": enrollment_ids[student_key],
                    "billing_plan_id": enrollment_plan_ids[student_key],
                    "stripe_invoice_item_id": f"ii_demo_{key}" if stripe_invoice else None,
                    "metadata": {"demo": True},
                    "created_at": self._timestamp(-25, 8),
                }
            )
        self._insert_optional("billing_invoices", invoice_rows)
        self._insert_optional("billing_invoice_items", invoice_item_rows)

        payment_specs = [
            ("card-aiko", "tanaka", "paid-aiko", "succeeded", 12900, "card", None, None, -24),
            ("external-omar", "haddad", "external-omar", "externally_recorded", 11900, "external", "Zelle", "Recorded by front desk.", -2),
            ("card-marcus", "webb", "paid-marcus", "succeeded", 17900, "card", None, None, -12),
            ("card-hana-partial", "mori", "partial-hana", "succeeded", 4900, "card", None, "Signup fee collected before monthly invoice balance.", -1),
            ("card-johnson-liam", "johnson", "paid-johnson-liam", "succeeded", 8950, "card", None, None, -8),
            ("card-johnson-mia", "johnson", "paid-johnson-mia", "succeeded", 8950, "card", None, None, -8),
            ("card-isabella", "rossi", "paid-isabella", "succeeded", 12900, "card", None, None, -6),
        ]
        payment_rows = []
        for key, payer_key, invoice_key, payment_status, amount, method, external_method, note, offset in payment_specs:
            payment_rows.append(
                {
                    "id": self._id(studio_id, f"billing-payment:{key}"),
                    "studio_id": studio_id,
                    "payer_id": payer_ids[payer_key],
                    "invoice_id": invoice_ids[invoice_key],
                    "stripe_payment_intent_id": None if external_method else f"pi_demo_{key}",
                    "stripe_charge_id": None if external_method else f"ch_demo_{key}",
                    "stripe_account_id": None if external_method else DEMO_CONNECT_ACCOUNT_ID,
                    "stripe_customer_id": None if external_method else f"cus_demo_{payer_key}",
                    "stripe_invoice_id": invoice_stripe_ids[invoice_key],
                    "stripe_payment_method_id": None if external_method else f"pm_demo_{payer_key}",
                    "receipt_url": None if external_method else f"https://dashboard.stripe.com/test/payments/pi_demo_{key}",
                    "application_fee_amount_cents": 0 if external_method else round(amount * 0.005),
                    "status": payment_status,
                    "amount_cents": amount,
                    "currency": "usd",
                    "payment_method_type": method,
                    "external_method": external_method,
                    "note": note,
                    "processed_at": self._timestamp(offset, 14),
                    "metadata": {"demo": True},
                    "created_at": self._timestamp(offset, 14),
                    "updated_at": now,
                }
            )
        self._insert_optional("billing_payments", payment_rows)

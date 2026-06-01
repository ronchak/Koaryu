from __future__ import annotations

from datetime import date

from app.services.demo_billing_seed import DemoBillingSeeder
from app.services.demo_seed_common import DEMO_CONNECT_ACCOUNT_ID, demo_seed_id
from tests.fakes.supabase import TableBackedSupabase


class FixedDateDemoBillingSeeder(DemoBillingSeeder):
    def _today(self) -> date:
        return date(2026, 5, 24)


def _student_ids(studio_id: str) -> dict[str, str]:
    keys = [
        "aiko",
        "chloe",
        "omar",
        "marcus",
        "kai",
        "hana",
        "lucas",
        "liam",
        "mia_j",
        "julian",
        "isabella",
    ]
    return {key: demo_seed_id(studio_id, f"student:{key}") for key in keys}


def test_demo_billing_seed_writes_coherent_fixture_rows():
    studio_id = "studio_demo"
    supabase = TableBackedSupabase()
    program_ids = {
        "bjj_core": demo_seed_id(studio_id, "program:bjj-core"),
        "tae_kwon_do": demo_seed_id(studio_id, "program:tae-kwon-do"),
    }

    FixedDateDemoBillingSeeder(supabase).seed(studio_id, program_ids, _student_ids(studio_id))

    assert len(supabase.tables["email_usage_events"]) == 5
    assert len(supabase.tables["billing_plans"]) == 5
    assert len(supabase.tables["billing_plan_programs"]) == 7
    assert len(supabase.tables["billing_plan_prices"]) == 5
    assert len(supabase.tables["billing_payers"]) == 10
    assert len(supabase.tables["billing_subscriptions"]) == 9
    assert len(supabase.tables["student_billing_enrollments"]) == 11
    assert len(supabase.tables["billing_invoices"]) == 11
    assert len(supabase.tables["billing_invoice_items"]) == 11
    assert len(supabase.tables["billing_payments"]) == 7

    kids_plan = next(row for row in supabase.tables["billing_plans"] if row["name"] == "Kids Unlimited")
    assert kids_plan["id"] == demo_seed_id(studio_id, "billing-plan:kids-unlimited")
    assert kids_plan["stripe_account_id"] == DEMO_CONNECT_ACCOUNT_ID

    external_payer = next(row for row in supabase.tables["billing_payers"] if row["display_name"] == "Omar Haddad")
    assert external_payer["stripe_account_id"] is None
    assert external_payer["billing_status"] == "externally_paid"

    paid_invoice = next(row for row in supabase.tables["billing_invoices"] if row["invoice_number"] == "KOA-DEMO-101")
    assert paid_invoice["amount_remaining_cents"] == 0
    assert paid_invoice["paid_at"] is not None

    external_payment = next(row for row in supabase.tables["billing_payments"] if row["external_method"] == "Zelle")
    assert external_payment["stripe_account_id"] is None
    assert external_payment["status"] == "externally_recorded"

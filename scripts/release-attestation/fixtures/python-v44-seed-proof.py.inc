        require(seed == "seeded" and len(before["public.billing_plans"]) == 2
                and len(before["public.billing_plan_programs"]) == 1
                and len(before["public.billing_plan_prices"]) == 1
                and len(before["public.studio_payment_accounts"]) == 1
                and not before["public.audit_logs"], "Local-plan restore fixture is incomplete")
        require(next(row for row in before["public.billing_plans"] if row["id"] == LEGACY_PLAN)["currency"] == "EUR",
                "Restore must retain a confirmed non-USD definition")

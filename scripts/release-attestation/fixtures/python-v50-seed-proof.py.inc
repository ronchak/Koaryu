        require(seed == "seeded" and len(before["public.billing_invoices"]) == 2
                and all(row["billing_status"] == "past_due" for row in before["public.billing_payers"]),
                "Legacy cached-status fixture is incomplete")

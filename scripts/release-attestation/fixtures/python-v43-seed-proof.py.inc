        require(seed == "seeded" and len(before["public.billing_payments"]) == 1
                and before["public.billing_payments"][0]["currency"] == "eur"
                and before["public.billing_payers"][0]["balance_cents"] == 777
                and len(before["public.billing_invoices"]) == 1 and not before["public.audit_logs"],
                "External-payment restore fixture is incomplete")

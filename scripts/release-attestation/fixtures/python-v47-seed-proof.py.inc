        require(seed == "seeded" and len(before["public.billing_payments"]) == 1
                and before["public.billing_payments"][0]["refunded_amount_cents"] == 500
                and before["public.billing_provider_operations"][0]["state"] == "projected"
                and len(before["public.billing_refunds"]) == 1, "Refund restore seed is incomplete")

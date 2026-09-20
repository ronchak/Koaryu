        require(seed == "seeded" and len(before["public.billing_subscriptions"]) == 1
                and before["public.billing_subscriptions"][0]["currency"] == "cad"
                and before["public.billing_subscriptions"][0]["billing_interval"] == "annual",
                "Known non-USD subscription fixture is incomplete")

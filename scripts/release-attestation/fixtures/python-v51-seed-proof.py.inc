        require(seed == "seeded"
                and sorted(row["state"] for row in before["public.billing_provider_operations"]) == ["completed", "started"]
                and len(before["public.billing_provider_operation_resource_aliases"]) == 2
                and len(before["public.billing_invoice_mutation_owners"]) == 2,
                "Terminal and nonterminal closeout claim fixture is incomplete")

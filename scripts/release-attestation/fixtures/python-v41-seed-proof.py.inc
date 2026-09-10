        seed = json.loads(local.sql(source, SEED_SQL))
        UUID(seed["operation_id"])
        require(re.fullmatch(r"[0-9a-f]{64}", seed["request_hash"]) is not None, "Invalid retained receipt hash")
        audit_id = str(uuid5(NAMESPACE_URL, "koaryu:billing.invoice_retry_requested:" + seed["operation_id"]))
        local.sql(source, f"INSERT INTO public.audit_logs(id,studio_id,actor_id,action,entity_type,entity_id,metadata)"
                  f"VALUES('{audit_id}','{STUDIO}','{ACTOR}','billing.invoice_retry_requested','billing','{INVOICE}',"
                  f"jsonb_build_object('operation_id','{seed['operation_id']}','stripe_invoice_id','in_balancerestore','status','paid'));")
        before = snapshot(source)
        require(len(before["public.billing_payers"]) == 2 and len(before["public.billing_invoices"]) == 2
                and len(before["public.billing_provider_operations"]) == 1
                and len(before["private.billing_invoice_retry_hash_ledger_v33"]) == 1,
                "Balance restore fixture is incomplete")

    def snapshot(database):
        fields = []
        for table in TABLES:
            value = "to_jsonb(t)-'receipts_enabled'" if table == "public.student_import_runs" else "to_jsonb(t)"
            fields.append(f"'{table}',(SELECT COALESCE(jsonb_agg({value} ORDER BY to_jsonb(t)->>'id',"
                          f"to_jsonb(t)::TEXT COLLATE \"C\"),'[]'::JSONB) FROM {table} t)")
        return json.loads(local.sql(database, "SET TIME ZONE 'UTC'; SELECT jsonb_build_object(" + ",".join(fields) + ");"))
    contract_sources = {
        name: (root / "supabase" / "verification" / name).read_bytes()
        for name in ("student_import_row_atomic_contract.sql", "worker_claim_rpc_contract.sql")
    }

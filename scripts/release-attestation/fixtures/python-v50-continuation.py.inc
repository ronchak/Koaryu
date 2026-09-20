            studio = before["public.studios"][0]["id"]
            rows = json.loads(local.sql(database,
                f"SELECT jsonb_agg(p ORDER BY p->>'display_name') FROM public.list_billing_payers_v1('{studio}',NULL,'2040-06-15') p;"))
            require([(row["billing_status"], row["balance_cents"], row["overdue_balance_cents"], row["uncollectible_balance_cents"])
                     for row in rows] == [("outstanding",100,0,0),("uncollectible",200,0,200)],
                    "Current reads reused legacy delinquency or conflated uncollectible invoices")
            require(snapshot(database) == before, "Read projection rewrote retained financial rows")
            local.sql(database, contract_bytes.decode("utf8"))
            require(contract_path.read_bytes() == contract_bytes, "Payer contract changed during verification")
            require(snapshot(database) == before, "Payer contract did not roll back its fixture changes")
            outcomes["payer_contract_sha256"] = hashlib.sha256(contract_bytes).hexdigest()

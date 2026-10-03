            def record(actor, key, amount, currency, note, request_hash):
                note = note.replace("'", "''")
                return json.loads(local.sql(database, f"""
                    BEGIN; SET LOCAL ROLE service_role;
                    SELECT public.record_external_payment_v1('{STUDIO}','{actor}','{PAYER}',{amount},'{currency}',
                        'cash','{note}','{key}','{request_hash}');
                    COMMIT;
                """))
            legacy = record(RETRY_ACTOR, "legacy-external", 500, "eur", "Legacy note", LEGACY_REQUEST_HASH)
            require(legacy["id"] == LEGACY and snapshot(database) == before,
                    "Legacy replay changed confirmed facts or fabricated a historical audit")
            payment = record(ACTOR, "restored-external-command", 750, "usd", "Original note", NEW_REQUEST_HASH)
            after = snapshot(database)
            require(record(RETRY_ACTOR, "restored-external-command", 750, "usd", "Original note", NEW_REQUEST_HASH) == payment
                    and snapshot(database) == after, "New payment replay changed its record or audit")
            require(len(after["public.billing_payments"]) == 2 and len(after["public.audit_logs"]) == 1,
                    "Expected exactly one new payment and audit")
            require(next(row for row in after["public.billing_payments"] if row["id"] == LEGACY)
                    == before["public.billing_payments"][0], "New recording changed a legacy payment")
            audit = after["public.audit_logs"][0]
            require(audit["actor_id"] == ACTOR and audit["studio_id"] == STUDIO and audit["entity_id"] == payment["id"]
                    and audit["action"] == "billing.external_payment_recorded" and audit["entity_type"] == "billing"
                    and audit["metadata"] == {"amount_cents": 750, "external_method": "cash"}, "Original audit identity changed")
            for table in TABLES:
                if table not in ("public.billing_payments", "public.audit_logs"):
                    require(after[table] == before[table], f"Payment recording changed unrelated {table}")
            local.sql(database, f"SET ROLE service_role; SELECT public.recompute_billing_payer_balance_v1('{STUDIO}','{PAYER}');")
            repaired = snapshot(database)
            require(repaired["public.billing_payers"][0]["balance_cents"] == 1000,
                    "Payer balance completion changed the existing invoice-based formula")
            require(record(RETRY_ACTOR, "restored-external-command", 750, "usd", "Original note", NEW_REQUEST_HASH) == payment
                    and snapshot(database) == repaired, "Completed replay rewrote payment, audit or balance")

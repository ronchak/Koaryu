            def write_plan(studio, plan_id, patch, program_ids=None, actor=ACTOR):
                values = json.dumps(patch).replace("'", "''")
                plan_arg = "NULL" if plan_id is None else f"'{plan_id}'::UUID"
                programs_arg = "NULL" if program_ids is None else "ARRAY[" + ",".join(f"'{item}'::UUID" for item in program_ids) + "]::UUID[]"
                return json.loads(local.sql(database, f"SET TIME ZONE 'UTC'; SET ROLE service_role; SELECT public.write_billing_plan_v1('{studio}','{actor}',{plan_arg},'{values}'::JSONB,{programs_arg});"))
            current = next(row for row in before["public.billing_plans"] if row["id"] == PLAN)
            legacy = next(row for row in before["public.billing_plans"] if row["id"] == LEGACY_PLAN)
            require(write_plan(STUDIO, PLAN, {"name": "Active USD", "currency": "USD"}, [PROGRAM, PROGRAM])["plan"] == current
                    and write_plan(STUDIO, LEGACY_PLAN, {"currency": "eur"})["plan"] == legacy
                    and snapshot(database) == before, "No-op changed original plan, links, audit or historical currency")
            created = write_plan(STUDIO, None, {"name": "New USD", "amount_cents": 750}, [PROGRAM, PROGRAM])
            require(created["plan"]["currency"] == "usd" and created["plan"]["status"] == "pending"
                    and created["programs"] == [{"program_id": PROGRAM, "program_name": "Karate", "program_color_hex": "#123456"}],
                    "New plan/defaults/committed program snapshot mismatch")
            changed = write_plan(STUDIO, PLAN, {"amount_cents": 1250, "description": None}, [])
            require(changed["plan"]["status"] == "pending" and changed["plan"]["description"] is None
                    and changed["plan"]["stripe_price_id"] == "price_restore" and changed["programs"] == [],
                    "Real plan patch did not preserve provider identity or explicit clearing")
            after = snapshot(database)
            require(write_plan(STUDIO, PLAN, {"amount_cents": 1250, "description": None}, [])["plan"] == changed["plan"]
                    and snapshot(database) == after, "Repeated patch wrote another audit or changed the committed result")
            require(next(row for row in after["public.billing_plans"] if row["id"] == LEGACY_PLAN) == legacy
                    and after["public.billing_plan_prices"] == before["public.billing_plan_prices"],
                    "Local plan writes changed historical financial/provider facts")
            audits = after["public.audit_logs"]
            require(len(audits) == 2 and all(row["actor_id"] == ACTOR and row["studio_id"] == STUDIO
                    and row["entity_type"] == "billing" for row in audits)
                    and {row["action"] for row in audits} == {"billing.plan_created", "billing.plan_updated"},
                    "Expected one original-actor audit per actual local command")
            for table in TABLES:
                if table not in ("public.billing_plans", "public.billing_plan_programs", "public.audit_logs"):
                    require(after[table] == before[table], f"Local plan command changed unrelated {table}")
            # Database-first compatibility permits the old caller's direct writes.
            # Each local.sql call is a distinct request; this does not claim old callers became atomic.
            local.sql(database, f"SET ROLE service_role; UPDATE public.billing_plans SET description='Legacy caller note',status='pending' WHERE id='{PLAN}' AND studio_id='{STUDIO}';")
            local.sql(database, f"SET ROLE service_role; INSERT INTO public.billing_plan_programs(studio_id,billing_plan_id,program_id) VALUES('{STUDIO}','{PLAN}','{PROGRAM}');")
            old_result = write_plan(STUDIO, PLAN, {"description": "Legacy caller note"}, [PROGRAM])
            require(old_result["plan"]["description"] == "Legacy caller note" and len(old_result["programs"]) == 1
                    and len(snapshot(database)["public.audit_logs"]) == 2, "Old caller compatibility or new no-op continuation failed")
            before_clear = snapshot(database)
            demo_plan = write_plan(CLEAR_STUDIO, None, {"name": "Clear me", "amount_cents": 0}, [CLEAR_PROGRAM], actor=CLEAR_ACTOR)
            # Do not upgrade the shared advisory lock inside the same transaction.
            local.sql(database, f"SET ROLE service_role; SELECT public.clear_studio_operational_data_atomic('{CLEAR_STUDIO}',FALSE);")
            cleared = snapshot(database)
            require(not any(row["studio_id"] == CLEAR_STUDIO for row in cleared["public.billing_plans"])
                    and not any(row["studio_id"] == CLEAR_STUDIO for row in cleared["public.billing_plan_programs"])
                    and not any(row["studio_id"] == CLEAR_STUDIO for row in cleared["public.programs"])
                    and cleared["public.studio_payment_accounts"] == before_clear["public.studio_payment_accounts"],
                    "Clear companion changed target selection or platform-row preservation")
            require([row for row in cleared["public.billing_plans"] if row["studio_id"] == STUDIO]
                    == before_clear["public.billing_plans"]
                    and any(row["entity_id"] == demo_plan["plan"]["id"] and row["actor_id"] == CLEAR_ACTOR and row["studio_id"] == CLEAR_STUDIO for row in cleared["public.audit_logs"]),
                    "Clear changed another studio or removed the existing audit-retention behavior")

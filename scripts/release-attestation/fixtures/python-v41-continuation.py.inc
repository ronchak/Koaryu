            local.sql(database, f"BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL ROLE service_role; "
                      f"SELECT public.recompute_billing_payer_balance_v1('{STUDIO}','{PAYER}'); COMMIT;")
            after = snapshot(database)
            expected = json.loads(json.dumps(before))
            changed = next(row for row in after["public.billing_payers"] if row["id"] == PAYER)
            intended = next(row for row in expected["public.billing_payers"] if row["id"] == PAYER)
            intended.update(balance_cents=300, billing_status="past_due", updated_at=changed["updated_at"])
            require(after == expected, "Explicit repair changed unintended retained fields")
            replay = json.loads(local.sql(database, f"BEGIN; SET LOCAL ROLE service_role; "
                f"SELECT public.claim_billing_provider_operation_resource_v1('{STUDIO}','{ACTOR}','invoice.retry','invoice',"
                f"'{INVOICE}','{PAYER}','balance-restore-retry','{seed['request_hash']}','acct_balancerestore',1,gen_random_uuid(),30); COMMIT;"))
            require(replay["operation"]["id"] == seed["operation_id"] and replay["operation"]["state"] == "completed",
                    "Retained completed receipt did not replay")
            require(snapshot(database) == after, "Completed replay changed persisted facts")

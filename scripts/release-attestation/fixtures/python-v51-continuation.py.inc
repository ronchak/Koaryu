            # Retained terminal and in-flight closeout claims keep replaying their original operation.
            studio = before["public.studios"][0]["id"]
            actor = before["public.staff_roles"][0]["user_id"]
            payer = before["public.billing_payers"][0]["id"]
            operations = {row["operation_type"]: row for row in before["public.billing_provider_operations"]}
            for kind, resource_type, key, digest in [("invoice.finalize", "invoice_finalize", "restore-finalize", "e" * 64),
                                                     ("invoice.void", "invoice_void", "restore-void", "f" * 64)]:
                operation = operations[kind]
                invoice = next(row["resource_id"] for row in before["public.billing_provider_operation_resources"]
                               if row["operation_id"] == operation["id"])
                replay = json.loads(local.sql(database,
                    "BEGIN; SELECT public.claim_billing_invoice_closeout_operation_v1("
                    f"'{studio}','{actor}','{kind}','{resource_type}','{invoice}','{payer}','{key}','{digest}',"
                    "'acct_v51restore',1,gen_random_uuid(),30); ROLLBACK;"))
                require(replay["outcome"] == "replay" and replay["operation"]["id"] == operation["id"],
                        f"Retained {kind} closeout claim did not replay after the upgrade")
                outcomes[("restored_" if is_restored else "canonical_") + kind] = replay["outcome"]
            require(snapshot(database) == before, "Closeout replay rewrote retained claims")

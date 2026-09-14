            operation = before["public.billing_provider_operations"][0]
            payment = before["public.billing_payments"][0]
            claim = json.loads(local.sql(database, f"SET ROLE service_role; SELECT public.claim_billing_provider_operation_resource_v1('{operation['studio_id']}','{operation['actor_id']}','payment.refund','payment','{payment['id']}','{payment['payer_id']}','refund-proof','{operation['request_sha256']}','acct_refundproof',1,'{operation['lease_owner']}',30);"))
            require(claim["operation"]["id"] == operation["id"] and claim["operation"]["state"] == "projected",
                    "Restored receipt did not retain its recovery identity")
            completed = json.loads(local.sql(database, f"SET ROLE service_role; SELECT public.complete_billing_provider_operation_v1('{operation['id']}','{operation['studio_id']}','{operation['actor_id']}','payment.refund','refund-proof','{operation['request_sha256']}','acct_refundproof',1,'{operation['lease_owner']}',{claim['operation']['revision']},'payment_refund_completed');"))
            require(completed["operation"]["state"] == "completed"
                    and completed["operation"]["provider_request_attempt_count"] == 1,
                    "Refund continuation did not complete the original single attempt")
            after = snapshot(database)
            require(all(after[table] == before[table] for table in TABLES
                        if table != "public.billing_provider_operations"),
                    "Refund completion changed payment, refund, claim or unrelated rows")
            for name, content in contract_sources.items():
                local.sql(database, content.decode("utf8"))
                require((root / "supabase" / "verification" / name).read_bytes() == content,
                        "Refund continuation contract changed during verification")
            require(snapshot(database) == after, "Rollback-scoped proof changed retained rows")
            outcomes["contract_inputs"] = {name: hashlib.sha256(content).hexdigest() for name, content in contract_sources.items()}

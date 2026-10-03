            operation = before["public.billing_provider_operations"][0]
            claimed = json.loads(local.sql(database, f"SET ROLE service_role; SELECT public.claim_billing_provider_operation_resource_v1('{F['studio']}','{F['actor']}','enrollment.activate.invoice','enrollment','{F['enrollment']}','{F['payer']}','activation-restore','{INTENT['desired_sha256']}','acct_ActivationRestore48',1,'{F['lease']}',300);"))
            local.sql(database, f"SET ROLE service_role; SELECT public.claim_billing_subscription_quantity_sync('{F['studio']}','{F['group']}','{F['lease']}',120);")
            result = json.loads(local.sql(database, f"SET ROLE service_role; SELECT public.begin_billing_enrollment_activation_v1('{operation['id']}','{F['studio']}','{F['actor']}','enrollment.activate.invoice','activation-restore','{INTENT['desired_sha256']}','acct_ActivationRestore48',1,'{F['lease']}',{claimed['operation']['revision']},'{F['enrollment']}','{F['lease']}','sub_activation48');"))
            require(result["operation"]["id"] == operation["id"] and result["operation"]["provider_request_attempt_count"] == 1
                    and result["execution"]["expected_quantity"] == 3,
                    "Restored zero-attempt receipt did not use three current seats")
            after = snapshot(database)
            pending = next(row for row in after["public.student_billing_enrollments"] if row["id"] == F["enrollment"])
            intent = pending["metadata"]["provider_activation_intent"]
            require({key:value for key,value in intent.items() if key != "executions"} == INTENT
                    and intent["executions"] == {operation["id"]: result["execution"]},
                    "Execution overwrote the legacy request or used its stale quantity")
            mutable = {"public.student_billing_enrollments", "public.billing_subscriptions", "public.billing_provider_operations"}
            require(all(after[table] == before[table] for table in TABLES if table not in mutable),
                    "Beginning activation changed unrelated rows")
            require([row for row in after["public.student_billing_enrollments"] if row["id"] != F["enrollment"]]
                    == [row for row in before["public.student_billing_enrollments"] if row["id"] != F["enrollment"]],
                    "Beginning activation changed another seat")

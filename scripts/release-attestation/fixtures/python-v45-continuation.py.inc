            require(local.sql(database, "SELECT count(*)=0 FROM private.student_import_receipts;") == "t"
                    and local.sql(database, "SELECT bool_and(NOT receipts_enabled) FROM public.student_import_runs;") == "t",
                    "Migration invented completion receipts for legacy imports")
            for function in ("claim_student_import_run", "claim_student_import_run_v2"):
                complete = json.loads(local.sql(database, f"SET ROLE service_role; SELECT to_jsonb(r) FROM public.{function}('{STUDIO}','{ACTOR}','students_csv_execute','legacy-complete','completed-hash','cache-token',45) r;"))
                require(complete["claim_status"] == "completed" and complete["run_row"]["result_json"] == LEGACY_RESULT,
                        "Completed pre-migration cache changed or stopped replaying")
                failed = json.loads(local.sql(database, f"SET ROLE service_role; SELECT to_jsonb(r) FROM public.{function}('{STUDIO}','{ACTOR}','students_csv_execute','legacy-failed','failed-hash','retry-token',45) r;"))
                require(failed["claim_status"] == "unsupported_run", "Untracked pre-migration partial import was resumed")
            require(snapshot(database) == before, "Legacy cache/refusal changed retained customer or financial data")
            # Reuse the maintained behavioral contracts on both restored and canonical
            # schemas instead of copying their row/setup/claim algorithms into this runner.
            for name, content in contract_sources.items():
                local.sql(database, content.decode("utf8"))
                require((root / "supabase" / "verification" / name).read_bytes() == content,
                        "Continuation contract changed during verification")
            outcomes["contract_inputs"] = {name: hashlib.sha256(content).hexdigest() for name, content in contract_sources.items()}
            require(snapshot(database) == before, "Rollback-scoped continuation checks changed retained data")

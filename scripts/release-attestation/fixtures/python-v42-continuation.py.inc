            protected = ("id", "program_id", "status", "started_at", "ended_at", "current_belt_rank_id")
            original_memberships = [{key: row[key] for key in protected} for row in before["memberships"]]
            for function, date in [("write_student_profile_v2_atomic", "2026-09-01"),
                                   ("write_student_profile_atomic", "2026-08-01")]:
                payload = json.dumps({"membership_start_date": date, "phone": "updated"})
                result = json.loads(local.sql(database, f"""
                    BEGIN; SET LOCAL ROLE service_role;
                    SELECT to_jsonb(r) FROM public.{function}('{STUDENT}','{STUDIO}','{OWNER}',
                        '{payload}',ARRAY['{PROGRAMS[0]}','{PROGRAMS[1]}']::UUID[],'[]',true,'student.updated') r;
                    COMMIT;
                """))
                after = snapshot(database)
                saved = result.get("result_student", result)
                require(saved["membership_start_date"] == date and after["student"]["membership_start_date"] == date
                        and after["student"]["phone"] == "updated", "Overall joining-date edit did not persist")
                require([{key: row[key] for key in protected} for row in after["memberships"]] == original_memberships,
                        "Profile edit changed a retained program date, status or rank")
            require(len(after["audit"]) == len(before["audit"]) + 2, "Profile edits did not each record their audit")

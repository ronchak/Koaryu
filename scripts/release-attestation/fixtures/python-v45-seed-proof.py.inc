        require(seed == "seeded" and len(before["public.student_import_runs"]) == 2
                and len(before["public.students"]) == 1 and len(before["public.student_guardians"]) == 1
                and before["public.student_program_memberships"][0]["status"] == "paused"
                and before["public.student_program_memberships"][0]["started_at"] == "2014-03-04"
                and before["public.billing_plans"][0]["currency"] == "eur", "Import restore seed is incomplete")

        require(seed == "seeded" and len(before["public.students"]) == 4
                and len(before["public.attendance"]) == 3,
                "Retained student and attendance fixture is incomplete")
        studio = next(row["id"] for row in before["public.studios"] if row["name"] == "Inactivity restore")
        old_dashboard = json.loads(local.sql(source, f"SELECT public.dashboard_summary_facts('{studio}', 'billing_hidden', 'UTC', DATE '2026-05-20', 'dashboard-summary-v1');"))
        old_roster = json.loads(local.sql(source, f"SELECT public.list_student_roster('{studio}', NULL, NULL, NULL, 14, NULL, DATE '2026-05-20', 'name', 'asc', 200, NULL, NULL, NULL);"))
        require(old_dashboard["inactivity"]["watch_14"] != old_roster["total"],
                "V52 source no longer reproduces the delayed-entry dashboard mismatch")

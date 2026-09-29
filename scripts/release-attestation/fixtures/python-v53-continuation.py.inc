            studio = next(row["id"] for row in before["public.studios"] if row["name"] == "Inactivity restore")
            other = next(row["id"] for row in before["public.studios"] if row["name"] == "Other inactivity restore")
            for target, expected in [(studio, {14: 2, 30: 1, 90: 1}), (other, {14: 1, 30: 1, 90: 1})]:
                dashboard = json.loads(local.sql(database, f"SELECT public.dashboard_summary_facts('{target}', 'billing_hidden', 'UTC', DATE '2026-05-20', 'dashboard-summary-v1');"))
                for window, count in expected.items():
                    roster = json.loads(local.sql(database, f"SELECT public.list_student_roster('{target}', NULL, NULL, NULL, {window}, NULL, DATE '2026-05-20', 'name', 'asc', 200, NULL, NULL, NULL);"))
                    ids = {item["id"] for item in roster["items"]}
                    require(len(ids) == count and roster["total"] == count and roster["has_next"] is False
                            and dashboard["inactivity"][f"watch_{window}"] == count,
                            f"V53 dashboard/roster inactivity {window} mismatch after restore")
                if target == studio:
                    expected_names = {row["legal_first_name"] for row in before["public.students"]
                                      if row["studio_id"] == studio and row["legal_first_name"] in {"Delayed", "Future"}}
                    roster = json.loads(local.sql(database, f"SELECT public.list_student_roster('{studio}', NULL, NULL, NULL, 14, NULL, DATE '2026-05-20', 'name', 'asc', 200, NULL, NULL, NULL);"))
                    actual_names = {row["legal_first_name"] for row in before["public.students"] if row["id"] in {item["id"] for item in roster["items"]}}
                    require(actual_names == expected_names, "V53 14-day roster identities changed")
            require(snapshot(database) == before, "V53 read continuation changed retained rows")
            outcomes[("restored_" if is_restored else "canonical_") + "dashboard_roster"] = "exact 14/30/90 parity"

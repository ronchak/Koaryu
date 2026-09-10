        require(before["student"]["phone"] == "original" and len(before["memberships"]) == 2
                and {m["status"] for m in before["memberships"]} == {"paused", "active"}
                and {m["started_at"] for m in before["memberships"]} == {"2026-03-05", None}
                and len(before["ranks"]) == 1 and len(before["audit"]) >= 1, "Restore fixture is incomplete")

        result = json.loads(sql(restored, EDIT_SQL))
        after = json.loads(sql(restored, SNAPSHOT_SQL))
        require(result["result_student"]["phone"] == "updated" and after["student"]["phone"] == "updated",
                "Restored writer did not save the requested edit")
        protected = ("id", "program_id", "status", "started_at", "ended_at", "current_belt_rank_id")
        facts = lambda rows: [{k: row[k] for k in protected} for row in rows]
        require(facts(after["memberships"]) == facts(before["memberships"]), "Restored writer mutated retained membership facts")
        require(len(after["audit"]) == len(before["audit"]) + 1, "Restored writer audit insert did not continue")

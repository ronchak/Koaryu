            studio = before["public.studios"][0]["id"]
            actor = before["public.staff_roles"][0]["user_id"]
            lead = before["public.leads"][0]["id"]
            # Roll back the proof so every retained source row can be compared exactly.
            proof = local.sql(database, f"""
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.update_lead_atomic('{studio}','{actor}','{lead}', '{{"stage":"trial_scheduled"}}');
DO $proof$
DECLARE operation UUID := gen_random_uuid(); first_result public.leads; replay public.leads;
BEGIN
    SELECT * INTO first_result FROM public.follow_up_lead_atomic(
        '{studio}','{actor}','{lead}',operation,'{{"next_stage":"trial_completed"}}');
    SELECT * INTO replay FROM public.follow_up_lead_atomic(
        '{studio}','{actor}','{lead}',operation,'{{"next_stage":"trial_completed"}}');
    IF to_jsonb(first_result) IS DISTINCT FROM to_jsonb(replay)
       OR replay.stage <> 'trial_completed' OR replay.follow_up_date IS NOT NULL
       OR (SELECT count(*) FROM public.lead_follow_up_operations WHERE operation_id=operation) <> 1
       OR (SELECT count(*) FROM public.lead_activities WHERE lead_id='{lead}' AND activity_type='stage_change') <> 2
       OR (SELECT count(*) FROM public.lead_activities WHERE lead_id='{lead}' AND activity_type='follow_up') <> 1 THEN
        RAISE EXCEPTION 'Restored V52 command result, history or replay mismatch';
    END IF;
END;
$proof$;
ROLLBACK;
SELECT 'continued';
""")
            require(proof.splitlines()[-1] == "continued", "Lead command continuation failed")
            require(snapshot(database) == before, "Lead command rollback changed retained rows")
            require(local.sql(database, "SELECT count(*) FROM public.lead_follow_up_operations;") == "0",
                    "Rolled-back follow-up receipt survived")
            outcomes[("restored_" if is_restored else "canonical_") + "lead_command"] = "replayed and rolled back"

            lead = before["public.leads"][0]
            studio, actor = lead["studio_id"], before["public.staff_roles"][0]["user_id"]
            lead_id, student_id, program = lead["id"], lead["converted_student_id"], lead["program_id"]
            proof = local.sql(database, f"""
BEGIN;
UPDATE public.programs SET archived_at=now() WHERE id='{program}';
SET LOCAL ROLE service_role;
DO $proof$
DECLARE operation UUID := gen_random_uuid(); result public.leads; replay public.leads;
    prior JSONB; after_restore JSONB; activities INTEGER;
BEGIN
    SELECT jsonb_build_array(
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.students t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.student_program_memberships t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.guardians t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.student_guardians t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.audit_logs t)
    ) INTO prior;
    IF (SELECT is_minor IS TRUE AND date_of_birth IS NULL FROM public.students WHERE id='{student_id}') IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'V55 restored converted minor lost explicit minor knowledge';
    END IF;
    SELECT count(*) INTO activities FROM public.lead_activities WHERE lead_id='{lead_id}';
    SELECT * INTO result FROM public.follow_up_lead_atomic('{studio}','{actor}','{lead_id}',operation,'{{"next_stage":"enrolled"}}');
    SELECT * INTO replay FROM public.follow_up_lead_atomic('{studio}','{actor}','{lead_id}',operation,'{{"next_stage":"enrolled"}}');
    IF result.stage IS DISTINCT FROM 'enrolled' OR result.follow_up_date IS NOT NULL
       OR result.converted_student_id IS DISTINCT FROM '{student_id}'::uuid
       OR to_jsonb(result) IS DISTINCT FROM to_jsonb(replay)
       OR (SELECT count(*) FROM public.lead_activities WHERE lead_id='{lead_id}') <> activities+2 THEN
        RAISE EXCEPTION 'V55 restored archived-program enrollment or keyed retry mismatch';
    END IF;
    PERFORM public.update_lead_atomic('{studio}','{actor}','{lead_id}','{{"stage":"offer_sent","program_id":null}}');
    SELECT * INTO result FROM public.convert_lead_to_student_atomic('{studio}','{actor}','{lead_id}',NULL,NULL,NULL,NULL,NULL,NULL);
    SELECT * INTO replay FROM public.convert_lead_to_student_atomic('{studio}','{actor}','{lead_id}',NULL,NULL,NULL,NULL,NULL,NULL);
    IF result.stage IS DISTINCT FROM 'enrolled' OR result.program_id IS NOT NULL
       OR result.converted_student_id IS DISTINCT FROM '{student_id}'::uuid
       OR to_jsonb(result) IS DISTINCT FROM to_jsonb(replay)
       OR (SELECT count(*) FROM public.lead_activities WHERE lead_id='{lead_id}') <> activities+4 THEN
        RAISE EXCEPTION 'V55 restored null-program enrollment or exact retry mismatch';
    END IF;
    SELECT jsonb_build_array(
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.students t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.student_program_memberships t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.guardians t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.student_guardians t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.audit_logs t)
    ) INTO after_restore;
    IF prior IS DISTINCT FROM after_restore THEN RAISE EXCEPTION 'V55 restoration changed conversion facts'; END IF;
END;
$proof$;
ROLLBACK;
SELECT 'continued';
""")
            require(proof.splitlines()[-1] == "continued", "Converted lead restoration continuation failed")
            require(snapshot(database) == before, "Converted lead restoration rollback changed retained rows")
            outcomes[("restored_" if is_restored else "canonical_") + "lead_restoration"] = "same student and idempotent retry"

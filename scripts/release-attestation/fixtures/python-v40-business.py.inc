STUDIO = "00000000-0000-4000-8000-000000094003"
SEED_SQL = r"""
INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('00000000-0000-4000-8000-000000094001','authenticated','authenticated','rank-owner@example.invalid','{}','{}',now(),now()),
       ('00000000-0000-4000-8000-000000094002','authenticated','authenticated','rank-actor@example.invalid','{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id) VALUES ('00000000-0000-4000-8000-000000094003','Rank restore fixture','rank-restore-fixture','00000000-0000-4000-8000-000000094001');
INSERT INTO public.programs(id,studio_id,name,is_system) VALUES ('00000000-0000-4000-8000-000000094004','00000000-0000-4000-8000-000000094003','Rank program',FALSE),('00000000-0000-4000-8000-000000094008','00000000-0000-4000-8000-000000094003','Unassigned',TRUE);
INSERT INTO public.belt_ladders(id,studio_id,name,program_id)
VALUES ('00000000-0000-4000-8000-000000094005','00000000-0000-4000-8000-000000094003','Rank ladder','00000000-0000-4000-8000-000000094004'),('00000000-0000-4000-8000-000000094020','00000000-0000-4000-8000-000000094003','Unscoped ladder',NULL);
INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,color_hex,display_order)
VALUES ('00000000-0000-4000-8000-000000094010','00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094005','White','#FFFFFF',0),
       ('00000000-0000-4000-8000-000000094011','00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094005','Yellow','#FFFF00',1),
       ('00000000-0000-4000-8000-000000094012','00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094005','Orange','#FF8000',2),
       ('00000000-0000-4000-8000-000000094022','00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094020','Global White','#FFFFFF',0),
       ('00000000-0000-4000-8000-000000094023','00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094020','Global Yellow','#FFFF00',1);
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id,current_belt_rank_id)
VALUES ('00000000-0000-4000-8000-000000094006','00000000-0000-4000-8000-000000094003','Rank','Student','active','00000000-0000-4000-8000-000000094004','00000000-0000-4000-8000-000000094010'),
       ('00000000-0000-4000-8000-000000094021','00000000-0000-4000-8000-000000094003','Global','Student','active',NULL,NULL);
INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status,current_belt_rank_id)
VALUES ('00000000-0000-4000-8000-000000094007','00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094006','00000000-0000-4000-8000-000000094004','active','00000000-0000-4000-8000-000000094010');
SET LOCAL ROLE service_role;
SELECT id FROM public.record_student_promotion_v2('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094006','00000000-0000-4000-8000-000000094007','00000000-0000-4000-8000-000000094004',
 '00000000-0000-4000-8000-000000094010','00000000-0000-4000-8000-000000094011','00000000-0000-4000-8000-000000094002','Original','00000000-0000-4000-8000-000000094030');
SELECT id FROM public.record_student_promotion_v2('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094021',NULL,NULL,
 NULL,'00000000-0000-4000-8000-000000094022','00000000-0000-4000-8000-000000094002',NULL,'00000000-0000-4000-8000-000000094031');
RESET ROLE;
"""

CONTINUATION_SQL = r"""
DO $$
DECLARE legacy public.promotions%ROWTYPE; empty_context public.promotions%ROWTYPE;
        recorded public.promotions%ROWTYPE; replay public.promotions%ROWTYPE;
        result UUID; rejected BOOLEAN; detail TEXT; saved_audit JSONB; field_name TEXT; before_replay JSONB; after_replay JSONB;
BEGIN
 SELECT * INTO legacy FROM public.promotions WHERE studio_id='00000000-0000-4000-8000-000000094003' AND operation_id='00000000-0000-4000-8000-000000094030';
 SELECT * INTO empty_context FROM public.promotions WHERE studio_id='00000000-0000-4000-8000-000000094003' AND operation_id='00000000-0000-4000-8000-000000094031';
 IF legacy.id IS NULL OR empty_context.id IS NULL OR legacy.command_fingerprint IS NOT NULL
    OR empty_context.command_fingerprint IS NOT NULL OR legacy.command_program_id IS NOT NULL
    OR legacy.command_membership_id IS NOT NULL OR legacy.command_from_rank_id IS NOT NULL THEN
   RAISE EXCEPTION 'The pre-upgrade receipts are not genuine legacy rows'; END IF;
 SELECT jsonb_build_object(
   'students',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.students s WHERE studio_id='00000000-0000-4000-8000-000000094003'),
   'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.student_program_memberships m WHERE studio_id='00000000-0000-4000-8000-000000094003'),
   'history',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.promotions p WHERE id IN (legacy.id,empty_context.id)),
   'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.audit_logs a WHERE studio_id='00000000-0000-4000-8000-000000094003' AND entity_id IN (legacy.id,empty_context.id))
 ) INTO before_replay;
 SET LOCAL ROLE service_role;
 SELECT id INTO result FROM public.record_student_rank_transition_v3('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094006',NULL,NULL,
    '00000000-0000-4000-8000-000000094011','00000000-0000-4000-8000-000000094002','Original','promotion','00000000-0000-4000-8000-000000094030');
 IF result IS DISTINCT FROM legacy.id THEN RAISE EXCEPTION 'Legacy API replay did not preserve the original action'; END IF;
 SELECT id INTO result FROM public.record_student_rank_transition_v3('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094021',NULL,NULL,
    '00000000-0000-4000-8000-000000094022','00000000-0000-4000-8000-000000094002',NULL,'promotion','00000000-0000-4000-8000-000000094031');
 IF result IS DISTINCT FROM empty_context.id THEN RAISE EXCEPTION 'Legacy API null context/from replay failed'; END IF;
 SELECT id INTO result FROM public.record_student_promotion_v2('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094021',NULL,NULL,
    NULL,'00000000-0000-4000-8000-000000094022','00000000-0000-4000-8000-000000094002',NULL,'00000000-0000-4000-8000-000000094031');
 IF result IS DISTINCT FROM empty_context.id THEN RAISE EXCEPTION 'Legacy V2 exact null audit proof failed'; END IF;
 SELECT jsonb_build_object(
   'students',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.students s WHERE studio_id='00000000-0000-4000-8000-000000094003'),
   'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.student_program_memberships m WHERE studio_id='00000000-0000-4000-8000-000000094003'),
   'history',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.promotions p WHERE id IN (legacy.id,empty_context.id)),
   'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.audit_logs a WHERE studio_id='00000000-0000-4000-8000-000000094003' AND entity_id IN (legacy.id,empty_context.id))
 ) INTO after_replay;
 IF after_replay IS DISTINCT FROM before_replay THEN RAISE EXCEPTION 'Legacy replay changed rank, history or audit state'; END IF;

 rejected:=FALSE;
 BEGIN
   PERFORM public.record_student_rank_transition_v3('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094006',NULL,NULL,
     '00000000-0000-4000-8000-000000094011','00000000-0000-4000-8000-000000094001','Original','promotion','00000000-0000-4000-8000-000000094030');
 EXCEPTION WHEN invalid_parameter_value THEN
   GET STACKED DIAGNOSTICS detail=PG_EXCEPTION_DETAIL;
   IF detail IS DISTINCT FROM 'rank_transition_conflict' THEN RAISE; END IF;
   rejected:=TRUE;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'Legacy action transferred to a different actor'; END IF;
 RESET ROLE;

 -- A genuine legacy row may have lost only its optional references.
 UPDATE public.promotions SET program_id=NULL,student_program_membership_id=NULL WHERE id=legacy.id;
 SELECT id INTO result FROM public.record_student_rank_transition_v3('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094006',NULL,NULL,
    '00000000-0000-4000-8000-000000094011','00000000-0000-4000-8000-000000094002','Original','promotion','00000000-0000-4000-8000-000000094030');
 IF result IS DISTINCT FROM legacy.id THEN RAISE EXCEPTION 'Legacy omission required invented original context'; END IF;
 rejected:=FALSE;
 BEGIN
   PERFORM public.record_student_rank_transition_v3('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094006','00000000-0000-4000-8000-000000094007','00000000-0000-4000-8000-000000094004',
     '00000000-0000-4000-8000-000000094011','00000000-0000-4000-8000-000000094002','Original','promotion','00000000-0000-4000-8000-000000094030');
 EXCEPTION WHEN invalid_parameter_value THEN
   GET STACKED DIAGNOSTICS detail=PG_EXCEPTION_DETAIL;
   IF detail IS DISTINCT FROM 'rank_transition_conflict' THEN RAISE; END IF;
   rejected:=TRUE;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'Legacy explicit lost context was guessed'; END IF;

 SELECT metadata INTO saved_audit FROM public.audit_logs WHERE studio_id='00000000-0000-4000-8000-000000094003' AND entity_id=empty_context.id;
 UPDATE public.audit_logs SET metadata=metadata-'from_rank_id' WHERE studio_id='00000000-0000-4000-8000-000000094003' AND entity_id=empty_context.id;
 rejected:=FALSE;
 BEGIN
   PERFORM public.record_student_promotion_v2('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094021',NULL,NULL,
     NULL,'00000000-0000-4000-8000-000000094022','00000000-0000-4000-8000-000000094002',NULL,'00000000-0000-4000-8000-000000094031');
 EXCEPTION WHEN invalid_parameter_value THEN
   GET STACKED DIAGNOSTICS detail=PG_EXCEPTION_DETAIL;
   IF detail IS DISTINCT FROM 'rank_transition_conflict' THEN RAISE; END IF;
   rejected:=TRUE;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'Missing legacy audit key was mistaken for an original null'; END IF;
 UPDATE public.audit_logs SET metadata=saved_audit WHERE studio_id='00000000-0000-4000-8000-000000094003' AND entity_id=empty_context.id;

 SET LOCAL ROLE service_role;
 SELECT * INTO recorded FROM public.record_student_rank_transition_v3('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094006',NULL,NULL,
    '00000000-0000-4000-8000-000000094012','00000000-0000-4000-8000-000000094002','Next','promotion','00000000-0000-4000-8000-000000094040');
 SELECT id INTO result FROM public.record_student_rank_transition_v3('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094006',NULL,NULL,
    '00000000-0000-4000-8000-000000094011','00000000-0000-4000-8000-000000094002','Original','promotion','00000000-0000-4000-8000-000000094030');
 IF result IS DISTINCT FROM legacy.id
    OR (SELECT current_belt_rank_id FROM public.students WHERE id='00000000-0000-4000-8000-000000094006') IS DISTINCT FROM '00000000-0000-4000-8000-000000094012'::UUID
    OR (SELECT current_belt_rank_id FROM public.student_program_memberships WHERE id='00000000-0000-4000-8000-000000094007') IS DISTINCT FROM '00000000-0000-4000-8000-000000094012'::UUID
    OR (SELECT count(*) FROM public.audit_logs WHERE studio_id='00000000-0000-4000-8000-000000094003' AND entity_id=legacy.id) IS DISTINCT FROM 1 THEN
   RAISE EXCEPTION 'An older legacy replay rewound a later rank or duplicated audit'; END IF;
 PERFORM public.record_student_promotion_v2('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094021',NULL,NULL,
    '00000000-0000-4000-8000-000000094022','00000000-0000-4000-8000-000000094023','00000000-0000-4000-8000-000000094001','Compatibility continuation','00000000-0000-4000-8000-000000094041');
 IF recorded.command_fingerprint IS NULL OR recorded.command_program_id IS DISTINCT FROM '00000000-0000-4000-8000-000000094004'::UUID
    OR recorded.command_membership_id IS DISTINCT FROM '00000000-0000-4000-8000-000000094007'::UUID
    OR recorded.command_from_rank_id IS DISTINCT FROM '00000000-0000-4000-8000-000000094011'::UUID THEN
   RAISE EXCEPTION 'New command did not capture immutable original context'; END IF;
 SELECT id INTO result FROM public.record_student_rank_transition_v3('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094021',NULL,NULL,
    '00000000-0000-4000-8000-000000094023','00000000-0000-4000-8000-000000094001','Compatibility continuation','promotion','00000000-0000-4000-8000-000000094041');
 IF result IS DISTINCT FROM (SELECT id FROM public.promotions WHERE studio_id='00000000-0000-4000-8000-000000094003' AND operation_id='00000000-0000-4000-8000-000000094041') THEN
   RAISE EXCEPTION 'New compatibility write cannot replay through the API owner'; END IF;
 RESET ROLE;

 UPDATE public.promotions SET command_fingerprint='v1:'||repeat('0',64),command_program_id=NULL,
     command_membership_id=NULL,command_from_rank_id=NULL WHERE id=recorded.id;
 SELECT * INTO replay FROM public.promotions WHERE id=recorded.id;
 IF (replay.command_fingerprint,replay.command_program_id,replay.command_membership_id,replay.command_from_rank_id)
    IS DISTINCT FROM (recorded.command_fingerprint,recorded.command_program_id,recorded.command_membership_id,recorded.command_from_rank_id) THEN
   RAISE EXCEPTION 'An UPDATE replaced immutable command evidence'; END IF;
 FOREACH field_name IN ARRAY ARRAY['studio_id','student_id','operation_id','transition_kind'] LOOP
   rejected:=FALSE;
   BEGIN
     EXECUTE format('UPDATE public.promotions SET %I=%L WHERE id=%L',field_name,
       CASE WHEN field_name='transition_kind' THEN 'demotion' ELSE gen_random_uuid()::TEXT END,recorded.id);
   EXCEPTION WHEN invalid_parameter_value THEN rejected:=TRUE; END;
   IF NOT rejected THEN RAISE EXCEPTION 'Recorded command association was mutable: %',field_name; END IF;
 END LOOP;

 UPDATE public.belt_ranks SET name='Renamed '||name,color_hex='#123456' WHERE id IN ('00000000-0000-4000-8000-000000094011','00000000-0000-4000-8000-000000094012');
 PERFORM public.record_student_rank_transition_v3('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094006',NULL,NULL,
    '00000000-0000-4000-8000-000000094011','00000000-0000-4000-8000-000000094002','Correction','demotion',gen_random_uuid());
 DELETE FROM public.belt_ranks WHERE id='00000000-0000-4000-8000-000000094012';
 PERFORM public.record_student_rank_transition_v3('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094006',NULL,NULL,
    '00000000-0000-4000-8000-000000094010','00000000-0000-4000-8000-000000094002','Correction','demotion',gen_random_uuid());
 DELETE FROM public.belt_ranks WHERE id='00000000-0000-4000-8000-000000094011';
 -- Remove the enrollment through its owner so program/rank remain coherent.
 PERFORM public.mutate_student_program_membership_atomic('00000000-0000-4000-8000-000000094006','00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094002',
    'remove','00000000-0000-4000-8000-000000094007','{}'::JSONB);
 DELETE FROM public.student_program_memberships WHERE id='00000000-0000-4000-8000-000000094007';
 DELETE FROM public.programs WHERE id='00000000-0000-4000-8000-000000094004';
 DELETE FROM auth.users WHERE id='00000000-0000-4000-8000-000000094002';
 SET LOCAL ROLE service_role;
 SELECT * INTO replay FROM public.record_student_rank_transition_v3('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094006','00000000-0000-4000-8000-000000094007','00000000-0000-4000-8000-000000094004',
    '00000000-0000-4000-8000-000000094012','00000000-0000-4000-8000-000000094002','Next','promotion','00000000-0000-4000-8000-000000094040');
 IF replay.id IS DISTINCT FROM recorded.id OR replay.from_rank_id IS NOT NULL OR replay.to_rank_id IS NOT NULL
    OR replay.program_id IS NOT NULL OR replay.student_program_membership_id IS NOT NULL OR replay.promoted_by IS NOT NULL
    OR (replay.command_fingerprint,replay.command_program_id,replay.command_membership_id,replay.command_from_rank_id,
        replay.from_rank_name_snapshot,replay.to_rank_name_snapshot,replay.from_rank_color_snapshot,replay.to_rank_color_snapshot)
       IS DISTINCT FROM (recorded.command_fingerprint,recorded.command_program_id,recorded.command_membership_id,recorded.command_from_rank_id,
        recorded.from_rank_name_snapshot,recorded.to_rank_name_snapshot,recorded.from_rank_color_snapshot,recorded.to_rank_color_snapshot) THEN
   RAISE EXCEPTION 'Retained replay or original display facts broke after FK cleanup'; END IF;
 SELECT id INTO result FROM public.record_student_promotion_v2('00000000-0000-4000-8000-000000094003','00000000-0000-4000-8000-000000094006','00000000-0000-4000-8000-000000094007','00000000-0000-4000-8000-000000094004',
    '00000000-0000-4000-8000-000000094011','00000000-0000-4000-8000-000000094012','00000000-0000-4000-8000-000000094002','Next','00000000-0000-4000-8000-000000094040');
 IF result IS DISTINCT FROM recorded.id THEN RAISE EXCEPTION 'Compatibility exact replay lost original from-rank identity'; END IF;
 IF (SELECT count(*) FROM public.promotions WHERE studio_id='00000000-0000-4000-8000-000000094003' AND operation_id='00000000-0000-4000-8000-000000094040') IS DISTINCT FROM 1
    OR (SELECT count(*) FROM public.audit_logs WHERE studio_id='00000000-0000-4000-8000-000000094003' AND entity_id=recorded.id) IS DISTINCT FROM 1 THEN
   RAISE EXCEPTION 'Retained replay duplicated history or audit'; END IF;

 RESET ROLE;
 DELETE FROM public.students WHERE id='00000000-0000-4000-8000-000000094006';
 IF EXISTS (SELECT 1 FROM public.promotions WHERE id=recorded.id) THEN RAISE EXCEPTION 'Hard student deletion retained its receipt'; END IF;
 PERFORM public.clear_studio_operational_data_atomic('00000000-0000-4000-8000-000000094003',FALSE);
 IF EXISTS (SELECT 1 FROM public.promotions WHERE studio_id='00000000-0000-4000-8000-000000094003') THEN
   RAISE EXCEPTION 'Operational clear retained promotion receipts'; END IF;
 RAISE NOTICE 'Genuine legacy and prospective rank receipt upgrade checks passed';
END $$;
"""

# Remove exactly the added evidence keys when comparing pre-existing row facts.
# Separate post-upgrade checks require all four new fields to remain null on legacy rows.
SNAPSHOT_SQL = "SELECT jsonb_build_object(" + ",".join(
    "'%s',(SELECT jsonb_agg(%s ORDER BY id) FROM public.%s r WHERE studio_id='%s')" % (
        key,
        "to_jsonb(r)-ARRAY['command_fingerprint','command_program_id','command_membership_id','command_from_rank_id']"
        if key == "promotions" else "to_jsonb(r)", table, STUDIO,
    )
    for key, table in [("students", "students"), ("memberships", "student_program_memberships"),
                       ("programs", "programs"), ("ranks", "belt_ranks"),
                       ("promotions", "promotions"), ("audit", "audit_logs")]
) + ");"

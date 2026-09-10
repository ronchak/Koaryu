#!/usr/bin/env python3
"""Prove a real V39 logical restore continues safely through the V40 rank upgrade."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20260908133504_rank_history_command_ownership_v40.sql"
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


def main(arguments):
    require(len(arguments) == 8, "Expected pg_dump pg_restore createdb psql socket port temp-dir repository-root")
    pg_dump, pg_restore, createdb, psql, socket, port, temporary_arg, root_arg = arguments
    root, temporary = Path(root_arg).resolve(), Path(temporary_arg)
    local = LocalPostgres(psql, socket, port, temporary)
    run, sql, connection = local.run, local.sql, local.connection
    versions = local.require_pg17(pg_dump, pg_restore, createdb, psql)
    exports = ["CATALOG_STATE_SQL", "EXPECTED_V39_CATALOG_STATE", "EXPECTED_V39_RESTORED_CATALOG_STATE",
        "V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS",
        "V39_RELEASE_MANIFEST_SQL", "EXPECTED_V39_RELEASE_MANIFEST",
        "V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS",
        "V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS",
        "V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS",
        "V40_CATALOG_STATE_SQL", "EXPECTED_V40_RESTORED_CATALOG_STATE",
        "V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE",
        "V40_RELEASE_MANIFEST_SQL", "EXPECTED_V40_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V40_EXPECTATION_STATE"]
    module = (root / "scripts/studio-comp-migration-rollout.mjs").as_uri()
    pinned = json.loads(run(["node", "--input-type=module", "--eval",
        f"import * as m from {json.dumps(module)}; console.log(JSON.stringify(Object.fromEntries("
        f"{json.dumps(exports)}.map(k=>[k,m[k]]))));"]))
    require(set(pinned) == set(exports) and all(isinstance(value, str) and value for value in pinned.values()),
            "Incomplete version-bound restore expectations")

    def check(database, query, expected):
        value = sql(database, pinned[query])
        require(value == pinned[expected], f"{database}: {query} did not match {expected}")
        return value

    def predecessor(database, restored=False):
        check(database, "CATALOG_STATE_SQL", "EXPECTED_V39_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V39_CATALOG_STATE")
        check(database, "V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS")
        check(database, "V39_RELEASE_MANIFEST_SQL", "EXPECTED_V39_RELEASE_MANIFEST")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 140 and list(hashes)[-7:] == [
        "20260908080420_student_membership_preservation_v39.sql", MIGRATION,
        "20260908183744_serialize_billing_payer_balance_v41.sql",
        "20260910084231_independent_program_joining_dates_v42.sql",
        "20260910093958_external_payment_command_ownership_v43.sql",
        "20260910135133_local_plan_write_ownership_v44.sql",
        "20260910185031_student_import_retry_ownership_v45.sql"], "Unexpected migration inventory")
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source, restored = f"koaryu_v40_source_{os.getpid()}", f"koaryu_v40_restore_{os.getpid()}"
    owned = []
    dump = temporary / f"v39-before-v40-{os.getpid()}.dump"
    migration = root / "supabase/migrations" / MIGRATION
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            run([createdb, *connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            sql(database, f'ALTER DATABASE {database} SET search_path TO "$user", public, extensions;')
        sql(source, "BEGIN;\n" + SEED_SQL + "\nCOMMIT;")
        before = json.loads(sql(source, SNAPSHOT_SQL))
        require(len(before["promotions"]) == 2 and len(before["students"]) == 2
                and len(before["memberships"]) == 1 and len(before["ranks"]) == 5,
                "Rank restore fixture is incomplete")
        constraints, acls = json.loads(sql(source, CONSTRAINT_SQL)), json.loads(sql(source, ACL_SQL))
        run([pg_dump, *connection, f"--dbname={source}", "--format=custom", f"--file={dump}"])
        dump_hash = hashlib.sha256(dump.read_bytes()).hexdigest()
        run([pg_restore, *connection, f"--dbname={restored}", "--exit-on-error", str(dump)])
        require(hashlib.sha256(dump.read_bytes()).hexdigest() == dump_hash, "Backup changed during restore")
        statements, expected_constraints = normalization_plan(constraints, json.loads(sql(restored, CONSTRAINT_SQL)),
                                                               acls, json.loads(sql(restored, ACL_SQL)), pairs)
        sql(restored, "BEGIN;\n" + "\n".join(statements) + "\nCOMMIT;")
        require(json.loads(sql(restored, CONSTRAINT_SQL)) == expected_constraints, "CHECK repair changed an unexpected definition")
        require(json.loads(sql(restored, ACL_SQL)) == acls, "Default ACL representation repair differed")
        require(json.loads(sql(restored, SNAPSHOT_SQL)) == before, "Logical restore changed business rows")
        predecessor(restored, restored=True)
        require(hashlib.sha256(migration.read_bytes()).hexdigest() == hashes[MIGRATION], "Migration changed during restore")
        version, name = MIGRATION[:-4].split("_", 1)
        run([psql, *connection, f"--dbname={restored}", "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--quiet",
             "--single-transaction", f"--file={migration}",
             f"--command=INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('{version}','{name}');"])
        require(json.loads(sql(restored, SNAPSHOT_SQL)) == before, "V40 changed pre-existing business facts")
        require(sql(restored, f"SELECT count(*)=2 AND bool_and(command_fingerprint IS NULL AND command_program_id IS NULL "
            f"AND command_membership_id IS NULL AND command_from_rank_id IS NULL) FROM public.promotions WHERE studio_id='{STUDIO}';") == "t",
            "V40 fabricated evidence for legacy receipts")
        checks = [
            ("V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS"),
            ("V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS"),
            ("V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS"),
            ("V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS"),
            ("V40_CATALOG_STATE_SQL", "EXPECTED_V40_RESTORED_CATALOG_STATE"),
            ("V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE"),
            ("V40_RELEASE_MANIFEST_SQL", "EXPECTED_V40_RELEASE_MANIFEST"),
            ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V40_EXPECTATION_STATE"),
        ]
        outcomes = {query: check(restored, query, expected) for query, expected in checks}
        # Real commands and FK cleanup run with the tested roles; rollback keeps
        # this restored fixture available for exact state/cleanup verification.
        sql(restored, "BEGIN;\n" + CONTINUATION_SQL + "\nROLLBACK;")
        require({query: check(restored, query, expected) for query, expected in checks} == outcomes,
                "Rank proof changed the attested state")
        require(json.loads(sql(restored, SNAPSHOT_SQL)) == before, "Rank proof did not roll back its fixture changes")
        for database in ("postgres", source):
            predecessor(database)
            require(sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v21()') IS NULL;") == "t",
                    "Restore proof upgraded its source database")
        require(json.loads(sql(source, SNAPSHOT_SQL)) == before, "Restore proof edited its source rows")
        require(all(hashlib.sha256((root / "supabase/migrations" / name).read_bytes()).hexdigest() == digest
                    for name, digest in hashes.items()), "Migration inputs changed during verification")
        evidence = {"migrations": hashes, "dump_sha256": dump_hash,
                    "helper_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                    "local_tools_sha256": hashlib.sha256(Path(__file__).with_name("local_postgres_verification.py").read_bytes()).hexdigest(),
                    "mapping_sha256": hashlib.sha256(mapping_bytes).hexdigest(), "tools": versions,
                    "queries": pinned, "outcomes": outcomes,
                    "business_before_sha256": hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
                    "constraint_pairs": len(pairs), "billing_replays": 6, "acl_representations": len(statements)-6}
        (temporary / "v39-v40-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V40] PASS V39 backup/restore, exact normalization, immutable legacy/history preservation, "
              "new/old rank commands, FK cleanup and V20/V19/V18 compatibility", flush=True)
    finally:
        errors = []
        for database in reversed(owned):
            try:
                sql("postgres", f"DROP DATABASE {database} WITH (FORCE);")
            except Exception as error:
                errors.append(str(error))
        if errors:
            raise RuntimeError("Owned restore database cleanup failed: " + "; ".join(errors))
        dump.unlink(missing_ok=True)


if __name__ == "__main__":
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    main(sys.argv[1:])

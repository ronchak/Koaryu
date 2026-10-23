SEED_SQL = r"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('00000000-0000-4000-8000-000000006101','authenticated','authenticated',
       'v61-restore@example.invalid','{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id,timezone)
VALUES('00000000-0000-4000-8000-000000006102','V61 retained import','v61-retained-import',
       '00000000-0000-4000-8000-000000006101','UTC');
INSERT INTO public.programs(id,studio_id,name) VALUES
 ('00000000-0000-4000-8000-000000006103','00000000-0000-4000-8000-000000006102','V61 program');
SET LOCAL ROLE service_role;
SELECT * FROM public.claim_student_import_run_v2(
 '00000000-0000-4000-8000-000000006102','00000000-0000-4000-8000-000000006101',
 'students_csv_execute','v61-retained','v61-hash','v61-token',45);
DO $seed$
DECLARE runid UUID;
BEGIN
 SELECT id INTO STRICT runid FROM public.student_import_runs WHERE idempotency_key='v61-retained';
 PERFORM public.import_student_row_atomic(
 jsonb_build_object('id','00000000-0000-4000-8000-000000006104','studio_id','00000000-0000-4000-8000-000000006102',
 'legal_first_name','Retained','legal_last_name','Student','_import_outcome',jsonb_build_object(
 'row_number',2,'is_valid',true,'issues','[]'::jsonb,'data','{}'::jsonb,'imported_without_belt',false)),
 '00000000-0000-4000-8000-000000006102',runid,'v61-token',2,'Retained Guardian','retained@example.invalid',NULL,'Parent',
 ARRAY['00000000-0000-4000-8000-000000006103'::uuid]);
END;
$seed$;
COMMIT;
SELECT 'seeded';
"""

CONTINUATION_SQL = r"""
BEGIN;
SET LOCAL ROLE service_role;
DO $continue$
DECLARE runid UUID; payload JSONB; first_result JSONB; replay_result JSONB; before_replay JSONB; after_replay JSONB;
 rejected BOOLEAN; reused_gid UUID; original_contact JSONB; skip JSONB; skipped_receipt JSONB; original_run JSONB;
BEGIN
 SELECT id INTO STRICT runid FROM public.student_import_runs WHERE idempotency_key='v61-retained';
 payload := jsonb_build_object('id','00000000-0000-4000-8000-000000006105','studio_id','00000000-0000-4000-8000-000000006102',
 'legal_first_name','Continued','legal_last_name','Student','_import_outcome',jsonb_build_object(
 'row_number',3,'is_valid',true,'issues','[]'::jsonb,'data','{}'::jsonb,'imported_without_belt',false));
 SELECT to_jsonb(r) INTO first_result FROM public.import_student_row_atomic(payload,
 '00000000-0000-4000-8000-000000006102',runid,'v61-token',3,'Continued Guardian','continued@example.invalid',NULL,'Parent',
 ARRAY['00000000-0000-4000-8000-000000006103'::uuid]) r;
 IF first_result IS DISTINCT FROM jsonb_build_object('student_id','00000000-0000-4000-8000-000000006105','guardian_imported',true)
 OR NOT EXISTS(SELECT 1 FROM public.students WHERE id='00000000-0000-4000-8000-000000006105' AND import_run_id=runid AND source_system IS NULL AND source_id IS NULL)
 OR NOT EXISTS(SELECT 1 FROM public.guardians WHERE id=private.deterministic_import_uuid(runid,'guardian-row:3') AND import_run_id=runid)
 OR NOT EXISTS(SELECT 1 FROM private.student_import_receipts WHERE import_run_id=runid AND kind='student' AND key='3') THEN
  RAISE EXCEPTION 'V61 continuation did not stamp provenance and receipt';
 END IF;
 SELECT jsonb_build_object('students',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.students t),'guardians',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.guardians t),'student_guardians',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.student_guardians t),'student_program_memberships',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.student_program_memberships t),'student_import_runs',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.student_import_runs t),'receipts',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.import_run_id,t.kind,t.key) FROM private.student_import_receipts t)) INTO before_replay;
 SELECT to_jsonb(r) INTO replay_result FROM public.import_student_row_atomic(payload,
 '00000000-0000-4000-8000-000000006102',runid,'v61-token',3,'Continued Guardian','continued@example.invalid',NULL,'Parent',
 ARRAY['00000000-0000-4000-8000-000000006103'::uuid]) r;
 SELECT jsonb_build_object('students',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.students t),'guardians',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.guardians t),'student_guardians',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.student_guardians t),'student_program_memberships',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.student_program_memberships t),'student_import_runs',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.student_import_runs t),'receipts',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.import_run_id,t.kind,t.key) FROM private.student_import_receipts t)) INTO after_replay;
 IF replay_result IS DISTINCT FROM first_result OR before_replay IS DISTINCT FROM after_replay THEN
  RAISE EXCEPTION 'V61 replay changed rows or physical tuples';
 END IF;
 -- The guarded call and reused guardian also continue on logical restores.
 payload:=payload||jsonb_build_object('id','00000000-0000-4000-8000-000000006106',
   'legal_first_name','Guarded','date_of_birth','2014-06-03',
   '_import_outcome',jsonb_set(payload->'_import_outcome','{row_number}','4'));
 PERFORM public.import_student_row_atomic(payload,'00000000-0000-4000-8000-000000006102',runid,'v61-token',4,
   NULL,NULL,NULL,NULL,ARRAY['00000000-0000-4000-8000-000000006103'::UUID],ARRAY[]::UUID[]);
 payload:=payload||jsonb_build_object('id','00000000-0000-4000-8000-000000006107',
   '_import_outcome',jsonb_set(payload->'_import_outcome','{row_number}','5'));
 rejected:=false;
 BEGIN
   PERFORM public.import_student_row_atomic(payload,'00000000-0000-4000-8000-000000006102',runid,'v61-token',5,
     NULL,NULL,NULL,NULL,ARRAY['00000000-0000-4000-8000-000000006103'::UUID],ARRAY[]::UUID[]);
 EXCEPTION WHEN SQLSTATE 'P0409' THEN
   IF SQLERRM IS DISTINCT FROM 'student_import_duplicate_review_required' THEN RAISE; END IF;
   rejected:=true;
 END;
 IF NOT rejected OR EXISTS(SELECT 1 FROM public.students WHERE id='00000000-0000-4000-8000-000000006107')
 OR EXISTS(SELECT 1 FROM private.student_import_receipts WHERE import_run_id=runid AND key='5') THEN
   RAISE EXCEPTION 'Restored identity guard did not refuse the duplicate atomically';
 END IF;
 reused_gid:=private.deterministic_import_uuid(runid,'guardian-row:3');
 SELECT jsonb_build_array(to_jsonb(g),g.ctid::TEXT) INTO original_contact FROM public.guardians g WHERE id=reused_gid;
 payload:=payload||jsonb_build_object('legal_first_name','Sibling');
 PERFORM public.import_student_row_atomic(payload,'00000000-0000-4000-8000-000000006102',runid,'v61-token',5,
   'Ignored Contact',NULL,NULL,NULL,ARRAY['00000000-0000-4000-8000-000000006103'::UUID],ARRAY[]::UUID[],reused_gid);
 IF original_contact IS DISTINCT FROM (SELECT jsonb_build_array(to_jsonb(g),g.ctid::TEXT) FROM public.guardians g WHERE id=reused_gid)
 OR NOT EXISTS(SELECT 1 FROM public.student_guardians WHERE student_id='00000000-0000-4000-8000-000000006107' AND guardian_id=reused_gid)
 OR EXISTS(SELECT 1 FROM public.guardians WHERE id=private.deterministic_import_uuid(runid,'guardian-row:5')) THEN
   RAISE EXCEPTION 'Restored guardian reuse altered or copied the contact';
 END IF;
 skip:=jsonb_build_object('action','skip','retained_kind','row','retained_id_or_row',5,
  'outcome',jsonb_build_object('row_number',6,'is_valid',true,'issues','[]'::JSONB,'data','{}'::JSONB));
 PERFORM public.record_student_import_skip_v1('00000000-0000-4000-8000-000000006102',runid,'v61-token',6,skip);
 SELECT jsonb_build_array(to_jsonb(r),r.ctid::TEXT) INTO skipped_receipt FROM private.student_import_receipts r
 WHERE r.import_run_id=runid AND r.kind='skipped' AND r.key='6';
 SELECT jsonb_build_array(to_jsonb(r),r.ctid::TEXT) INTO original_run FROM public.student_import_runs r WHERE id=runid;
 IF public.record_student_import_skip_v1('00000000-0000-4000-8000-000000006102',runid,'v61-token',6,'{}') IS DISTINCT FROM skip
 OR skipped_receipt IS DISTINCT FROM (SELECT jsonb_build_array(to_jsonb(r),r.ctid::TEXT) FROM private.student_import_receipts r WHERE r.import_run_id=runid AND r.kind='skipped' AND r.key='6')
 OR original_run IS DISTINCT FROM (SELECT jsonb_build_array(to_jsonb(r),r.ctid::TEXT) FROM public.student_import_runs r WHERE id=runid) THEN
   RAISE EXCEPTION 'Restored skipped receipt replay changed the row or run';
 END IF;
END;
$continue$;
COMMIT;
SELECT 'continued and replayed';
"""


def require_v61_snapshot(before, after):
    import copy
    normalized = copy.deepcopy(after)
    for table, columns in {'public.students': ['import_run_id', 'source_system', 'source_id'],
                           'public.guardians': ['import_run_id']}.items():
        for row in normalized[table]:
            require(all(column in row and row[column] is None for column in columns),
                    'V61 backfilled retained provenance or source identity')
            for column in columns:
                del row[column]
    rows = normalized['private.koaryu_release_v31_expectations']
    prior = before['private.koaryu_release_v31_expectations']
    require(len(rows) == len(prior) == 1
            and prior[0]['expectation_key'] == rows[0]['expectation_key'] == 'operational_contract_v31'
            and prior[0]['expected_sha256'] == '1513ff10defced0c619f85c7927259165f6c9eb7ef1400be076f567fd39c85b3'
            and rows[0]['expected_sha256'] == '07b11682181bce027a3434161a54cd9426d45ee1ecd0a9f663d15601ad8b0880', 'V61 expectation correction differs')
    rows[0]['expected_sha256'] = prior[0]['expected_sha256']
    return normalized == before

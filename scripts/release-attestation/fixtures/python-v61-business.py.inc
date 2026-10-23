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
            and rows[0]['expected_sha256'] == 'd3a761bf90deab756233941b2cbcd99e687b055202365413893714cb6865298a', 'V61 expectation correction differs')
    rows[0]['expected_sha256'] = prior[0]['expected_sha256']
    return normalized == before

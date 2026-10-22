SEED_SQL = r"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('00000000-0000-4000-8000-000000006001','authenticated','authenticated',
       'v60-restore@example.invalid','{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id,timezone)
VALUES('00000000-0000-4000-8000-000000006002','V60 retained gaps','v60-retained-gaps',
       '00000000-0000-4000-8000-000000006001','UTC');
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email) VALUES
    ('00000000-0000-4000-8000-000000006003','00000000-0000-4000-8000-000000006002','Closure','Student','closure@example.invalid'),
    ('00000000-0000-4000-8000-000000006004','00000000-0000-4000-8000-000000006002','Capped','Student','capped@example.invalid'),
    ('00000000-0000-4000-8000-000000006005','00000000-0000-4000-8000-000000006002','Peer','Student','peer@example.invalid');
INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time) VALUES
    ('00000000-0000-4000-8000-000000006011','00000000-0000-4000-8000-000000006002','Capped visit','2019-12-01','10:00','11:00'),
    ('00000000-0000-4000-8000-000000006012','00000000-0000-4000-8000-000000006002','Peer class','2020-02-20','10:00','11:00'),
    ('00000000-0000-4000-8000-000000006013','00000000-0000-4000-8000-000000006002','Closure visit','2020-03-01','10:00','11:00'),
    ('00000000-0000-4000-8000-000000006014','00000000-0000-4000-8000-000000006002','Reopening class','2020-03-20','10:00','11:00');
INSERT INTO public.attendance(studio_id,session_id,student_id,checked_in_at) VALUES
    ('00000000-0000-4000-8000-000000006002','00000000-0000-4000-8000-000000006011','00000000-0000-4000-8000-000000006004','2019-12-01 10:05+00'),
    ('00000000-0000-4000-8000-000000006002','00000000-0000-4000-8000-000000006012','00000000-0000-4000-8000-000000006005','2020-02-20 10:05+00'),
    ('00000000-0000-4000-8000-000000006002','00000000-0000-4000-8000-000000006013','00000000-0000-4000-8000-000000006003','2020-03-01 10:05+00'),
    ('00000000-0000-4000-8000-000000006002','00000000-0000-4000-8000-000000006014','00000000-0000-4000-8000-000000006005','2020-03-20 10:05+00');
COMMIT;
SELECT 'seeded';
"""

# Retained rows decide V60's gaps at explicit references, without the wall clock.
V60_GAP_PROBES_SQL = r"""
SELECT jsonb_build_object(
 'closure_before_reopening',(SELECT jsonb_build_array(skip_reason,days_absent) FROM private.missed_class_automation_candidates(
     '00000000-0000-4000-8000-000000006002',14,'00000000-0000-4000-8000-000000006003',NULL,'2020-03-19 12:00+00')),
 'closure_after_missed_classes',(SELECT jsonb_build_array(skip_reason,days_absent) FROM private.missed_class_automation_candidates(
     '00000000-0000-4000-8000-000000006002',14,'00000000-0000-4000-8000-000000006003',NULL,'2020-04-03 12:00+00')),
 'beyond_lookback',(SELECT jsonb_build_array(skip_reason,days_absent) FROM private.missed_class_automation_candidates(
     '00000000-0000-4000-8000-000000006002',14,'00000000-0000-4000-8000-000000006004',NULL,'2020-04-03 12:00+00')));
"""
V60_EXPECTED_GAP_PROBES = {
    'closure_before_reopening': ['recent_attendance', 18],
    'closure_after_missed_classes': [None, 33],
    'beyond_lookback': ['inactive', 124],
}
V60_COMPATIBILITY_DRIFT_SQL = """
BEGIN;
GRANT EXECUTE ON FUNCTION private.missed_class_automation_candidates(UUID,INTEGER,UUID,UUID,TIMESTAMPTZ) TO anon;
DO $compatibility$
DECLARE old RECORD; current RECORD;
BEGIN
    SELECT * INTO old FROM public.koaryu_release_schema_preflight_v40();
    SELECT * INTO current FROM public.koaryu_release_schema_preflight_v41();
    IF old.ready IS DISTINCT FROM FALSE OR current.ready IS DISTINCT FROM FALSE
       OR old.security_failures IS DISTINCT FROM ARRAY['automation_functions_v56','missed_class_functions_v60']::TEXT[]
       OR old.security_failures IS DISTINCT FROM current.security_failures
       OR old.migration_count IS DISTINCT FROM 155 OR old.migration_head IS DISTINCT FROM '20261021093000'
       OR old.pending_versions IS DISTINCT FROM current.pending_versions
       OR old.manifest_version IS DISTINCT FROM 'release-db-attestation-v59' THEN
        RAISE EXCEPTION 'V40 compatibility did not refuse V60 drift: %',row_to_json(old);
    END IF;
END;
$compatibility$;
ROLLBACK;
SELECT 'compatibility drift refused';
"""

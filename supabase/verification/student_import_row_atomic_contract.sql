BEGIN;
-- Preserve the historical guardian ID mapping; this vector does not establish general UUIDv5 parity.
DO $$
BEGIN
    IF private.deterministic_import_uuid('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org')
       IS DISTINCT FROM '886313e1-3b8a-5372-9b90-0c9aee199e5d'::UUID THEN
        RAISE EXCEPTION 'Retained guardian-ID reference vector changed';
    END IF;
    IF has_function_privilege('anon','public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])','EXECUTE')
       OR has_function_privilege('authenticated','public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])','EXECUTE') THEN
        RAISE EXCEPTION 'Browser roles can execute the import writer';
    END IF;
END;
$$;
CREATE TEMP TABLE observed_student_updates (seen boolean);
GRANT SELECT, INSERT, DELETE ON observed_student_updates TO service_role;
CREATE FUNCTION pg_temp.observe_student_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO pg_temp.observed_student_updates VALUES(true); RETURN NULL; END;
$$;
CREATE TRIGGER probe_observe_student_update AFTER UPDATE ON public.students
FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.observe_student_update();
CREATE FUNCTION pg_temp.reject_receipt_after_writes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid := (NEW.result_json->>'student_id')::uuid;
BEGIN
 IF NEW.kind='student' AND NEW.key='6' THEN
   IF NOT EXISTS(SELECT 1 FROM public.students WHERE id=sid)
      OR NOT EXISTS(SELECT 1 FROM public.student_program_memberships WHERE student_id=sid)
      OR NOT EXISTS(SELECT 1 FROM public.student_guardians WHERE student_id=sid) THEN
     RAISE EXCEPTION 'probe did not reach receipt after all domain writes';
   END IF;
   RAISE EXCEPTION 'probe receipt rejected after domain writes' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER probe_reject_receipt BEFORE INSERT ON private.student_import_receipts
FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_receipt_after_writes();

INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
('51000000-0000-4000-8000-000000000001','authenticated','authenticated','row-owner@example.invalid',now(),'{}','{}',now(),now()),
('51000000-0000-4000-8000-000000000002','authenticated','authenticated','foreign-owner@example.invalid',now(),'{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id) VALUES
('52000000-0000-4000-8000-000000000001','Owned row studio','row-owner-proof','51000000-0000-4000-8000-000000000001'),
('52000000-0000-4000-8000-000000000002','Existing foreign studio','row-foreign-proof','51000000-0000-4000-8000-000000000002');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES
('52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','admin'),
('52000000-0000-4000-8000-000000000002','51000000-0000-4000-8000-000000000002','admin');
INSERT INTO public.programs(id,studio_id,name) VALUES
('53000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','Edited program'),
('53000000-0000-4000-8000-000000000002','52000000-0000-4000-8000-000000000001','Still active program'),
('53000000-0000-4000-8000-000000000003','52000000-0000-4000-8000-000000000002','Foreign program');
INSERT INTO public.belt_ladders(id,studio_id,program_id,name) VALUES
('55000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','53000000-0000-4000-8000-000000000001','Requested ladder');
INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,is_tip) VALUES
('56000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','55000000-0000-4000-8000-000000000001','White',0,false),
('56000000-0000-4000-8000-000000000002','52000000-0000-4000-8000-000000000001','55000000-0000-4000-8000-000000000001','Green',1,false);

INSERT INTO public.student_import_runs(id,studio_id,actor_id,idempotency_key,request_hash,status,processing_token,processing_started_at) VALUES('54000000-0000-4000-8000-000000000099','52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','legacy-row-fixture','legacy-hash','processing','legacy-token',now());
SET LOCAL ROLE service_role;
DO $$
DECLARE
 studio uuid := '52000000-0000-4000-8000-000000000001';
 foreign_studio uuid := '52000000-0000-4000-8000-000000000002';
 actor uuid := '51000000-0000-4000-8000-000000000001';
 program uuid := '53000000-0000-4000-8000-000000000001';
 active_program uuid := '53000000-0000-4000-8000-000000000002';
 foreign_program uuid := '53000000-0000-4000-8000-000000000003';
 white uuid := '56000000-0000-4000-8000-000000000001';
 green uuid := '56000000-0000-4000-8000-000000000002';
 sid uuid := '57000000-0000-4000-8000-000000000002';
 unfinished uuid := '57000000-0000-4000-8000-000000000003';
 conflicting uuid := '57000000-0000-4000-8000-000000000005';
 failed_sid uuid := '57000000-0000-4000-8000-000000000006';
 runid uuid; legacy_run uuid; gid uuid; failed_gid uuid;
 payload jsonb; attempt jsonb; outcome jsonb; receipt jsonb; before_state jsonb; after_state jsonb;
 c record; r record; first_result jsonb; replay_result jsonb; rejected boolean; conflict_constraint text;
BEGIN
 SELECT * INTO c FROM public.claim_student_import_run_v2(studio,actor,'students_csv_execute','row-key','row-hash','row-token',45);
 IF c.claim_status IS DISTINCT FROM 'claimed' THEN RAISE EXCEPTION 'new run claim failed'; END IF;
 runid := (c.run_row->>'id')::uuid;
 outcome := jsonb_build_object('row_number',2,'is_valid',true,'issues','[]'::jsonb,'data',jsonb_build_object('legal_first_name','Synthetic','legal_last_name','Row'),'imported_without_belt',false);
 payload := jsonb_build_object('id',sid,'studio_id',studio,'legal_first_name','Synthetic','legal_last_name','Row','phone','original','membership_start_date','2020-01-02','current_belt_rank_id',white,'tags','[]'::jsonb,'_import_outcome',outcome);
 SELECT to_jsonb(x) INTO first_result FROM public.import_student_row_atomic(payload,studio,runid,'row-token',2,'Synthetic Guardian','original@example.invalid','original-guardian','Parent',ARRAY[program]) x;
 SELECT result_json INTO receipt FROM private.student_import_receipts WHERE import_run_id=runid AND kind='student' AND key='2';
 IF first_result IS DISTINCT FROM jsonb_build_object('student_id',sid,'guardian_imported',true)
    OR receipt->'outcome' IS DISTINCT FROM outcome THEN RAISE EXCEPTION 'first success or metadata receipt incorrect'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.student_program_memberships WHERE student_id=sid AND current_belt_rank_id=white)
    OR NOT EXISTS(SELECT 1 FROM public.students WHERE id=sid AND current_belt_rank_id=white) THEN RAISE EXCEPTION 'first rank state incorrect'; END IF;
 gid := private.deterministic_import_uuid(runid,'guardian-row:2');
 UPDATE public.students SET phone='staff-phone',membership_start_date='2021-02-03' WHERE id=sid;
 UPDATE public.guardians SET phone='staff-guardian',email='staff@example.invalid' WHERE id=gid;
 UPDATE public.student_program_memberships SET started_at='2023-04-05',status='paused',current_belt_rank_id=green WHERE student_id=sid;
 SELECT jsonb_build_object('student',to_jsonb(s),'student_tid',s.ctid::text,'membership',to_jsonb(m),'membership_tid',m.ctid::text,'guardian',to_jsonb(g),'guardian_tid',g.ctid::text) INTO before_state
 FROM public.students s JOIN public.student_program_memberships m ON m.student_id=s.id JOIN public.guardians g ON g.id=gid WHERE s.id=sid;
 DELETE FROM pg_temp.observed_student_updates;
 SELECT to_jsonb(x) INTO replay_result FROM public.import_student_row_atomic(payload,studio,runid,'row-token',2,'Synthetic Guardian','original@example.invalid','original-guardian','Parent',ARRAY[program]) x;
 SELECT jsonb_build_object('student',to_jsonb(s),'student_tid',s.ctid::text,'membership',to_jsonb(m),'membership_tid',m.ctid::text,'guardian',to_jsonb(g),'guardian_tid',g.ctid::text) INTO after_state
 FROM public.students s JOIN public.student_program_memberships m ON m.student_id=s.id JOIN public.guardians g ON g.id=gid WHERE s.id=sid;
 IF replay_result IS DISTINCT FROM first_result OR before_state IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'receipt replay changed staff state or returned pair'; END IF;
 IF EXISTS(SELECT 1 FROM pg_temp.observed_student_updates) THEN RAISE EXCEPTION 'public wrapper issued a student UPDATE on replay'; END IF;
 RAISE NOTICE 'first success and edited replay passed, zero UPDATE statements';

 UPDATE public.programs SET archived_at=now() WHERE id=program;
 DELETE FROM public.students WHERE id=sid;
 DELETE FROM pg_temp.observed_student_updates;
 SELECT to_jsonb(x) INTO replay_result FROM public.import_student_row_atomic(payload,studio,runid,'row-token',2,'Synthetic Guardian','original@example.invalid','original-guardian','Parent',ARRAY[program]) x;
 IF replay_result IS DISTINCT FROM first_result OR EXISTS(SELECT 1 FROM public.students WHERE id=sid)
    OR EXISTS(SELECT 1 FROM public.student_program_memberships WHERE student_id=sid)
    OR EXISTS(SELECT 1 FROM public.student_guardians WHERE student_id=sid)
    OR EXISTS(SELECT 1 FROM pg_temp.observed_student_updates) THEN RAISE EXCEPTION 'deleted student/archived program replay wrote effects'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.guardians WHERE id=gid AND phone='staff-guardian' AND email='staff@example.invalid') THEN RAISE EXCEPTION 'deleted replay changed guardian'; END IF;

 attempt := jsonb_set(jsonb_set(payload,'{id}',to_jsonb(unfinished)),'{_import_outcome,row_number}','3');
 rejected:=false;
 BEGIN PERFORM public.import_student_row_atomic(attempt,studio,runid,'row-token',3,NULL,NULL,NULL,NULL,ARRAY[program]);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM <> 'Import program does not belong to this studio or is archived.' THEN RAISE; END IF; rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'unfinished archived program was accepted'; END IF;
 rejected:=false;
 BEGIN PERFORM public.import_student_row_atomic(attempt,studio,runid,'row-token',3,NULL,NULL,NULL,NULL,ARRAY[foreign_program]);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM <> 'Import program does not belong to this studio or is archived.' THEN RAISE; END IF; rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'unfinished foreign program was accepted'; END IF;
 rejected:=false;
 BEGIN PERFORM public.import_student_row_atomic(jsonb_set(payload,'{studio_id}',to_jsonb(foreign_studio)),foreign_studio,runid,'row-token',2,NULL,NULL,NULL,NULL,ARRAY[foreign_program]);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM <> 'Student import worker claim is no longer active.' THEN RAISE; END IF; rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'existing foreign studio accepted owned run'; END IF;
 rejected:=false;
 BEGIN PERFORM public.import_student_row_atomic(payload,studio,runid,'stale-token',2,NULL,NULL,NULL,NULL,ARRAY[program]);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM <> 'Student import worker claim is no longer active.' THEN RAISE; END IF; rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'stale token replay accepted'; END IF;
 IF EXISTS(SELECT 1 FROM public.students WHERE id=unfinished) THEN RAISE EXCEPTION 'rejected unfinished row left student'; END IF;
 RAISE NOTICE 'deleted replay, archived and existing foreign tenant, and stale-token checks passed';

 INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,program_id,phone) VALUES(conflicting,studio,'Existing','Staff record',active_program,'retain-me');
 attempt := jsonb_set(jsonb_set(payload,'{id}',to_jsonb(conflicting)),'{_import_outcome,row_number}','5') - 'current_belt_rank_id';
 rejected:=false;
 BEGIN PERFORM public.import_student_row_atomic(attempt,studio,runid,'row-token',5,NULL,NULL,NULL,NULL,ARRAY[active_program]);
 EXCEPTION WHEN unique_violation THEN GET STACKED DIAGNOSTICS conflict_constraint = CONSTRAINT_NAME; IF conflict_constraint IS DISTINCT FROM 'students_pkey' THEN RAISE; END IF; rejected:=true; END;
 IF NOT rejected OR NOT EXISTS(SELECT 1 FROM public.students WHERE id=conflicting AND phone='retain-me') THEN RAISE EXCEPTION 'same studio unreceipted conflict changed existing row'; END IF;

 -- Retain both original cross-tenant ID collision boundaries under the actual service role.
 INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,program_id,phone)
 VALUES('57000000-0000-4000-8000-000000000099',foreign_studio,'Existing','Foreign student',foreign_program,'foreign-keep');
 attempt := jsonb_set(jsonb_set(payload,'{id}','"57000000-0000-4000-8000-000000000099"'),'{_import_outcome,row_number}','7') - 'current_belt_rank_id';
 rejected := FALSE;
 BEGIN PERFORM public.import_student_row_atomic(attempt,studio,runid,'row-token',7,NULL,NULL,NULL,NULL,ARRAY[active_program]);
 EXCEPTION WHEN unique_violation THEN
   GET STACKED DIAGNOSTICS conflict_constraint = CONSTRAINT_NAME;
   IF conflict_constraint IS DISTINCT FROM 'students_pkey' THEN RAISE; END IF;
   rejected := TRUE;
 END;
 IF NOT rejected OR NOT EXISTS(SELECT 1 FROM public.students
    WHERE id='57000000-0000-4000-8000-000000000099' AND studio_id=foreign_studio AND phone='foreign-keep') THEN
   RAISE EXCEPTION 'Cross-tenant student collision changed the foreign record';
 END IF;
 failed_gid := private.deterministic_import_uuid(runid,'guardian-row:8');
 INSERT INTO public.guardians(id,studio_id,first_name,last_name,phone) VALUES(failed_gid,foreign_studio,'Existing','Foreign guardian','foreign-keep');
 attempt := jsonb_set(jsonb_set(payload,'{id}',to_jsonb(unfinished)),'{_import_outcome,row_number}','8') - 'current_belt_rank_id';
 rejected := FALSE;
 BEGIN PERFORM public.import_student_row_atomic(attempt,studio,runid,'row-token',8,'New Guardian',NULL,NULL,'Parent',ARRAY[active_program]);
 EXCEPTION WHEN unique_violation THEN
   GET STACKED DIAGNOSTICS conflict_constraint = CONSTRAINT_NAME;
   IF conflict_constraint IS DISTINCT FROM 'guardians_pkey' THEN RAISE; END IF;
   rejected := TRUE;
 END;
 IF NOT rejected OR EXISTS(SELECT 1 FROM public.students WHERE id=unfinished)
    OR EXISTS(SELECT 1 FROM public.student_program_memberships WHERE student_id=unfinished)
    OR EXISTS(SELECT 1 FROM private.student_import_receipts WHERE import_run_id=runid AND key='8')
    OR NOT EXISTS(SELECT 1 FROM public.guardians WHERE id=failed_gid AND studio_id=foreign_studio AND phone='foreign-keep') THEN
   RAISE EXCEPTION 'Cross-tenant guardian collision changed data or left a partial student';
 END IF;

 attempt := jsonb_set(jsonb_set(payload,'{id}',to_jsonb(failed_sid)),'{_import_outcome,row_number}','6') - 'current_belt_rank_id';
 failed_gid := private.deterministic_import_uuid(runid,'guardian-row:6');
 rejected:=false;
 BEGIN PERFORM public.import_student_row_atomic(attempt,studio,runid,'row-token',6,'Rollback Guardian','rollback@example.invalid','rollback-phone','Parent',ARRAY[active_program]);
 EXCEPTION WHEN SQLSTATE '23514' THEN IF SQLERRM <> 'probe receipt rejected after domain writes' THEN RAISE; END IF; rejected:=true; END;
 IF NOT rejected OR EXISTS(SELECT 1 FROM public.students WHERE id=failed_sid)
    OR EXISTS(SELECT 1 FROM public.student_program_memberships WHERE student_id=failed_sid)
    OR EXISTS(SELECT 1 FROM public.guardians WHERE id=failed_gid)
    OR EXISTS(SELECT 1 FROM public.student_guardians WHERE student_id=failed_sid)
    OR EXISTS(SELECT 1 FROM private.student_import_receipts WHERE import_run_id=runid AND key='6') THEN RAISE EXCEPTION 'receipt failure did not roll back all effects'; END IF;
 RAISE NOTICE 'unreceipted conflict and receipt insertion rollback passed';

 legacy_run := '54000000-0000-4000-8000-000000000099';
 attempt := (payload - '_import_outcome' - 'current_belt_rank_id') || jsonb_build_object('id',unfinished,'phone','must-not-save');
 rejected:=false;
 BEGIN PERFORM public.import_student_row_atomic(attempt,studio,legacy_run,'legacy-token',1,NULL,NULL,NULL,NULL,ARRAY[active_program]);
 EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM <> 'This unfinished import has no safe retry receipts.' THEN RAISE; END IF; rejected:=true; END;
 IF NOT rejected OR EXISTS(SELECT 1 FROM public.students WHERE id=unfinished) OR EXISTS(SELECT 1 FROM private.student_import_receipts WHERE import_run_id=legacy_run) THEN RAISE EXCEPTION 'legacy refusal left effects'; END IF;
 RAISE NOTICE 'modern guardian/replay/rollback and legacy row refusal passed';
END;
$$;
ROLLBACK;

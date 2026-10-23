BEGIN;
-- Preserve the historical guardian ID mapping; this vector does not establish general UUIDv5 parity.
DO $$
DECLARE writer REGPROCEDURE := COALESCE(
    to_regprocedure('public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[],uuid[],uuid,text,text)'),
    to_regprocedure('public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])'));
BEGIN
    IF writer IS NULL THEN RAISE EXCEPTION 'Import writer is missing'; END IF;
    IF private.deterministic_import_uuid('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org')
       IS DISTINCT FROM '886313e1-3b8a-5372-9b90-0c9aee199e5d'::UUID THEN
        RAISE EXCEPTION 'Retained guardian-ID reference vector changed';
    END IF;
    IF has_function_privilege('anon',writer,'EXECUTE')
       OR has_function_privilege('authenticated',writer,'EXECUTE') THEN
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
 IF to_regprocedure('public.koaryu_release_schema_preflight_v42()') IS NOT NULL THEN
 IF NOT EXISTS(SELECT 1 FROM public.students WHERE id=sid AND import_run_id=runid AND source_system IS NULL AND source_id IS NULL)
    OR NOT EXISTS(SELECT 1 FROM public.guardians WHERE id=gid AND import_run_id=runid) THEN
   RAISE EXCEPTION 'Old-shape import did not stamp student and guardian provenance';
 END IF;

 -- V61 accepts the skipped kind. The service RPC proof below checks its lifecycle.
 INSERT INTO private.student_import_receipts(import_run_id,kind,key,result_json)
 VALUES(runid,'skipped','schema-proof','{}');
 rejected := false;
 BEGIN
   INSERT INTO private.student_import_receipts(import_run_id,kind,key,result_json)
   VALUES(runid,'unknown','schema-proof','{}');
 EXCEPTION WHEN check_violation THEN
   GET STACKED DIAGNOSTICS conflict_constraint = CONSTRAINT_NAME;
   IF conflict_constraint IS DISTINCT FROM 'student_import_receipts_kind_check' THEN RAISE; END IF;
   rejected := true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'Unknown receipt kind was accepted'; END IF;

 FOR r IN SELECT * FROM (VALUES
   ('system'::text,NULL::text,'students_source_pair_check'),
   (NULL::text,'id'::text,'students_source_pair_check'),
   ('   '::text,'id'::text,'students_source_system_length_check'),
   ('system'::text,''::text,'students_source_id_length_check'),
   ('system'::text,'   '::text,'students_source_id_length_check'),
   (repeat('x',121),'id'::text,'students_source_system_length_check'),
   ('system'::text,repeat('x',121),'students_source_id_length_check')
 ) cases(system,id,expected_constraint) LOOP
   rejected := false;
   BEGIN
     UPDATE public.students SET source_system=r.system,source_id=r.id WHERE id=sid;
   EXCEPTION WHEN check_violation THEN
     GET STACKED DIAGNOSTICS conflict_constraint = CONSTRAINT_NAME;
     IF conflict_constraint IS DISTINCT FROM r.expected_constraint THEN RAISE; END IF;
     rejected := true;
   END;
   IF NOT rejected THEN RAISE EXCEPTION 'Invalid source identity accepted: %',row_to_json(r); END IF;
 END LOOP;
 UPDATE public.students SET source_system='legacy',source_id='shared',deleted_at=now() WHERE id=sid;
 rejected := false;
 BEGIN
   INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,source_system,source_id)
   VALUES('57000000-0000-4000-8000-000000000061',studio,'Duplicate','Identity','legacy','shared');
 EXCEPTION WHEN unique_violation THEN
   GET STACKED DIAGNOSTICS conflict_constraint = CONSTRAINT_NAME;
   IF conflict_constraint IS DISTINCT FROM 'students_studio_source_identity_unique' THEN RAISE; END IF;
   rejected := true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'Duplicate source identity accepted, including archived student'; END IF;
 INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,source_system,source_id)
 VALUES('57000000-0000-4000-8000-000000000062',foreign_studio,'Other','Studio','legacy','shared');
 -- Both nulls stay valid and multiple unkeyed students remain possible.
 UPDATE public.students SET source_system=NULL,source_id=NULL,deleted_at=NULL WHERE id=sid;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname='public'
   AND indexname='students_studio_normalized_legal_name_idx'
   AND indexdef='CREATE INDEX students_studio_normalized_legal_name_idx ON public.students USING btree (studio_id, lower(btrim(legal_last_name)), lower(btrim(legal_first_name)))') THEN
   RAISE EXCEPTION 'Normalized name index must cover archived students';
 END IF;
 END IF; -- V61 schema proof; this shared fixture also runs on historical V45/V57.
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
-- The shared contract also runs against historical V45/V57 installations.
CREATE FUNCTION pg_temp.import_domain_snapshot() RETURNS JSONB LANGUAGE SQL AS $$
 SELECT jsonb_object_agg(t.name,t.rows) FROM (VALUES
 ('students',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(x),x.ctid::text) ORDER BY x.id) FROM public.students x)),
 ('memberships',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(x),x.ctid::text) ORDER BY x.id) FROM public.student_program_memberships x)),
 ('guardians',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(x),x.ctid::text) ORDER BY x.id) FROM public.guardians x)),
 ('links',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(x),x.ctid::text) ORDER BY x.id) FROM public.student_guardians x)),
 ('receipts',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(x),x.ctid::text) ORDER BY x.import_run_id,x.kind,x.key) FROM private.student_import_receipts x)),
 ('runs',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(x),x.ctid::text) ORDER BY x.id) FROM public.student_import_runs x))
 ) t(name,rows);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.import_domain_snapshot() TO service_role;
DO $identity_proof$
DECLARE
 studio UUID := '52000000-0000-4000-8000-000000000001';
 foreign_studio UUID := '52000000-0000-4000-8000-000000000002';
 actor UUID := '51000000-0000-4000-8000-000000000001';
 program UUID := '53000000-0000-4000-8000-000000000002';
 runid UUID; reference_id UUID; incoming_id UUID; reused_gid UUID; foreign_gid UUID;
 c RECORD; r RECORD; payload JSONB; ack UUID[]; before_state JSONB; original_guardian JSONB;
 result JSONB; replay JSONB; skip JSONB; rejected BOOLEAN; original_link JSONB; retained_link_id UUID;
BEGIN
 IF to_regprocedure('public.koaryu_release_schema_preflight_v42()') IS NULL THEN RETURN; END IF;
 IF has_function_privilege('anon','public.record_student_import_skip_v1(uuid,uuid,text,integer,jsonb)','EXECUTE')
 OR has_function_privilege('authenticated','public.record_student_import_skip_v1(uuid,uuid,text,integer,jsonb)','EXECUTE')
 OR has_function_privilege('anon','private.record_student_import_skip_v1(uuid,uuid,text,integer,jsonb)','EXECUTE')
 OR has_function_privilege('authenticated','private.record_student_import_skip_v1(uuid,uuid,text,integer,jsonb)','EXECUTE') THEN
   RAISE EXCEPTION 'Browser role can record skipped import rows';
 END IF;
 SELECT * INTO c FROM public.claim_student_import_run_v2(studio,actor,'students_csv_execute','v61-identity','v61-hash','v61-token',45);
 runid := (c.run_row->>'id')::UUID;
 FOR r IN SELECT * FROM (VALUES
   (20,false,false,false,false,'2014-06-03'::date,'2014-06-03'::date,NULL::text,NULL::text,true),
   (21,true,false,false,false,'2014-06-03'::date,'2014-06-03'::date,NULL::text,NULL::text,false),
   (22,false,true,false,false,'2014-06-03'::date,'2014-06-03'::date,NULL::text,NULL::text,true),
   (23,true,true,false,false,'2014-06-03'::date,'2014-06-03'::date,NULL::text,NULL::text,false),
   (24,false,false,false,false,NULL::date,'2014-06-03'::date,' SAME@example.invalid ','same@EXAMPLE.invalid',true),
   (25,false,false,false,false,'2014-06-03'::date,NULL::date,'same@example.invalid',' SAME@example.invalid ',true),
   (26,false,false,false,false,'2014-06-03'::date,'2015-06-03'::date,NULL::text,NULL::text,false),
   (27,false,false,true,false,'2014-06-03'::date,'2014-06-03'::date,NULL::text,NULL::text,false),
   (28,false,false,false,true,'2014-06-03'::date,'2014-06-03'::date,NULL::text,NULL::text,false),
   (29,false,false,false,false,'2014-06-03'::date,'2015-06-03'::date,'same@example.invalid','same@example.invalid',false),
   (30,false,false,false,false,NULL::date,NULL::date,'   '::text,'   '::text,false)
 ) cases(n,acknowledge,archived,foreign_match,legacy,incoming_dob,existing_dob,incoming_email,existing_email,refuse) LOOP
   reference_id:=gen_random_uuid(); incoming_id:=gen_random_uuid();
   INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,date_of_birth,email,deleted_at)
   VALUES(reference_id,CASE WHEN r.foreign_match THEN foreign_studio ELSE studio END,
     'Identity'||r.n,'Guard',r.existing_dob,r.existing_email,CASE WHEN r.archived THEN now() ELSE NULL END);
   payload:=jsonb_build_object('id',incoming_id,'studio_id',studio,'legal_first_name',' identity'||r.n||' ',
     'legal_last_name',' GUARD ','date_of_birth',r.incoming_dob,'email',r.incoming_email,
     '_import_outcome',jsonb_build_object('row_number',r.n,'is_valid',true,'issues','[]'::jsonb,'data','{}'::jsonb,'imported_without_belt',false));
   ack:=CASE WHEN r.legacy THEN NULL WHEN r.acknowledge THEN ARRAY[reference_id] ELSE ARRAY[]::UUID[] END;
   before_state:=pg_temp.import_domain_snapshot(); rejected:=false;
   BEGIN
     PERFORM public.import_student_row_atomic(payload,studio,runid,'v61-token',r.n,'Must Roll Back',NULL,NULL,NULL,ARRAY[program],ack);
   EXCEPTION WHEN SQLSTATE 'P0409' THEN
     IF SQLERRM IS DISTINCT FROM 'student_import_duplicate_review_required' THEN RAISE; END IF;
     rejected:=true;
   END;
   IF rejected IS DISTINCT FROM r.refuse THEN RAISE EXCEPTION 'V61 identity case % refusal differs',r.n; END IF;
   IF r.refuse AND pg_temp.import_domain_snapshot() IS DISTINCT FROM before_state THEN
     RAISE EXCEPTION 'V61 identity refusal % wrote domain rows',r.n;
   END IF;
   IF NOT r.refuse AND NOT EXISTS(SELECT 1 FROM public.students WHERE id=incoming_id AND import_run_id=runid) THEN
     RAISE EXCEPTION 'V61 permitted identity case % did not import',r.n;
   END IF;
 END LOOP;
 -- Source identity is accepted and stored when provided, but is not an app matcher signal yet.
 incoming_id:=gen_random_uuid();
 payload:=jsonb_build_object('id',incoming_id,'studio_id',studio,'legal_first_name','Source','legal_last_name','First',
   '_import_outcome',jsonb_build_object('row_number',40,'is_valid',true,'issues','[]'::jsonb,'data','{}'::jsonb,'imported_without_belt',false));
 PERFORM public.import_student_row_atomic(payload,studio,runid,'v61-token',40,NULL,NULL,NULL,NULL,ARRAY[program],ARRAY[]::UUID[],NULL,'legacy','id-40');
 IF NOT EXISTS(SELECT 1 FROM public.students WHERE id=incoming_id AND source_system='legacy' AND source_id='id-40') THEN RAISE EXCEPTION 'Source parameters not stored'; END IF;
 payload:=payload||jsonb_build_object('id',gen_random_uuid(),'legal_last_name','Second','_import_outcome',jsonb_set(payload->'_import_outcome','{row_number}','41'));
 before_state:=pg_temp.import_domain_snapshot(); rejected:=false;
 BEGIN
   PERFORM public.import_student_row_atomic(payload,studio,runid,'v61-token',41,NULL,NULL,NULL,NULL,ARRAY[program],ARRAY[]::UUID[],NULL,'legacy','id-40');
 EXCEPTION WHEN SQLSTATE 'P0409' THEN
   IF SQLERRM IS DISTINCT FROM 'student_import_duplicate_review_required' THEN RAISE; END IF; rejected:=true;
 END;
 IF NOT rejected OR pg_temp.import_domain_snapshot() IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'Source collision did not refuse atomically'; END IF;
 reused_gid:=gen_random_uuid(); foreign_gid:=gen_random_uuid();
 INSERT INTO public.guardians(id,studio_id,first_name,last_name,email,is_primary_contact) VALUES
 (reused_gid,studio,'Jordan','Smith','preserved@example.invalid',false),
 (foreign_gid,foreign_studio,'Foreign','Guardian',NULL,true);
 payload:=payload||jsonb_build_object('id',gen_random_uuid(),'legal_first_name','Linked','_import_outcome',jsonb_set(payload->'_import_outcome','{row_number}','42'));
 before_state:=pg_temp.import_domain_snapshot(); rejected:=false;
 BEGIN
   PERFORM public.import_student_row_atomic(payload,studio,runid,'v61-token',42,'Ignored Contact','ignored@example.invalid','ignored','Ignored',ARRAY[program],ARRAY[]::UUID[],foreign_gid);
 EXCEPTION WHEN SQLSTATE '22023' THEN
   IF SQLERRM IS DISTINCT FROM 'student_import_guardian_not_in_studio' THEN RAISE; END IF; rejected:=true;
 END;
 IF NOT rejected OR pg_temp.import_domain_snapshot() IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'Foreign guardian was accepted or wrote rows'; END IF;
 retained_link_id:=gen_random_uuid();
 INSERT INTO public.student_guardians(id,student_id,guardian_id) VALUES(retained_link_id,reference_id,reused_gid);
 SELECT jsonb_build_array(to_jsonb(l),l.ctid::TEXT) INTO original_link FROM public.student_guardians l WHERE id=retained_link_id;
 SELECT jsonb_build_array(to_jsonb(g),g.ctid::TEXT) INTO original_guardian FROM public.guardians g WHERE id=reused_gid;
 PERFORM public.import_student_row_atomic(payload,studio,runid,'v61-token',42,'Ignored Contact','ignored@example.invalid','ignored','Ignored',ARRAY[program],ARRAY[]::UUID[],reused_gid);
 IF original_guardian IS DISTINCT FROM (SELECT jsonb_build_array(to_jsonb(g),g.ctid::TEXT) FROM public.guardians g WHERE id=reused_gid)
 OR NOT EXISTS(SELECT 1 FROM public.student_guardians WHERE student_id=(payload->>'id')::UUID AND student_guardians.guardian_id=reused_gid)
 OR EXISTS(SELECT 1 FROM public.guardians WHERE id=private.deterministic_import_uuid(runid,'guardian-row:42'))
 OR original_link IS DISTINCT FROM (SELECT jsonb_build_array(to_jsonb(l),l.ctid::TEXT) FROM public.student_guardians l WHERE id=retained_link_id) THEN
   RAISE EXCEPTION 'Guardian reuse changed the contact or inserted a copy';
 END IF;
 -- Row replay wins over new guard/guardian validation, preserving the original pair and all tuples.
 before_state:=pg_temp.import_domain_snapshot();
 PERFORM public.import_student_row_atomic(payload,studio,runid,'v61-token',42,NULL,NULL,NULL,NULL,ARRAY[program],ARRAY[]::UUID[],foreign_gid);
 IF pg_temp.import_domain_snapshot() IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'Linked row replay wrote effects'; END IF;
 skip:=jsonb_build_object('action','skip','retained_kind','existing','retained_id_or_row',reference_id,
  'outcome',jsonb_build_object('row_number',43,'is_valid',true,'data','{}'::JSONB,'issues',jsonb_build_array(jsonb_build_object('code','duplicate_skipped','message','Skipped: already in Koaryu.','severity','warning'))));
 result:=public.record_student_import_skip_v1(studio,runid,'v61-token',43,skip);
 before_state:=pg_temp.import_domain_snapshot();
 replay:=public.record_student_import_skip_v1(studio,runid,'v61-token',43,'{}');
 IF result IS DISTINCT FROM skip OR replay IS DISTINCT FROM result OR pg_temp.import_domain_snapshot() IS DISTINCT FROM before_state
 OR (SELECT count(*) FROM private.student_import_receipts WHERE import_run_id=runid AND kind='skipped' AND key='43')<>1 THEN
   RAISE EXCEPTION 'Skip receipt replay changed rows or tuple identities';
 END IF;
 rejected:=false;
 BEGIN PERFORM public.record_student_import_skip_v1(studio,runid,'wrong-token',44,skip);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM IS DISTINCT FROM 'Student import worker claim is no longer active.' THEN RAISE; END IF; rejected:=true; END;
 IF NOT rejected OR pg_temp.import_domain_snapshot() IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'Skip writer accepted a stale worker'; END IF;
 UPDATE public.student_import_runs SET status='failed' WHERE id=runid;
 SELECT * INTO c FROM public.claim_student_import_run_v2(studio,actor,'students_csv_execute','v61-identity','v61-hash','new-token',45);
 IF c.claim_status IS DISTINCT FROM 'claimed' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.run_row->'receipts') claimed_receipt WHERE claimed_receipt->>'kind'='skipped' AND claimed_receipt->>'key'='43' AND claimed_receipt->'result'=skip) THEN
   RAISE EXCEPTION 'Claim did not return the skipped receipt unchanged';
 END IF;
 RAISE NOTICE 'V61 identity, source collision, guardian reuse, skipped receipts and ownership passed';
END;
$identity_proof$;

ROLLBACK;

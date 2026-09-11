STUDIO = "95000000-0000-4000-8000-000000000001"
ACTOR = "95000000-0000-4000-8000-000000000002"
PROGRAM = "95000000-0000-4000-8000-000000000003"
STUDENT = "95000000-0000-4000-8000-000000000004"
GUARDIAN = "95000000-0000-4000-8000-000000000005"
COMPLETE_RUN = "95000000-0000-4000-8000-000000000006"
FAILED_RUN = "95000000-0000-4000-8000-000000000007"
TABLES = ("auth.users", "public.staff_profiles", "public.studios", "public.staff_roles",
          "public.programs", "public.students", "public.student_program_memberships", "public.guardians",
          "public.student_guardians", "public.student_import_runs", "public.audit_logs",
          "public.billing_plans", "public.billing_invoices", "public.billing_payments")
LEGACY_RESULT = {"total_rows": 1, "valid_rows": 1, "error_rows": 0, "imported_count": 1,
                 "non_critical_errors": ["Historical import warning"]}
SEED_SQL = f"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('{ACTOR}','authenticated','authenticated','import-restore@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id) VALUES('{STUDIO}','Import restore','import-restore','{ACTOR}');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{STUDIO}','{ACTOR}','admin');
INSERT INTO public.programs(id,studio_id,name) VALUES('{PROGRAM}','{STUDIO}','Legacy program');
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,phone,program_id,membership_start_date)
VALUES('{STUDENT}','{STUDIO}','Retained','Student','staff-edited-phone','{PROGRAM}','2015-01-02');
INSERT INTO public.student_program_memberships(studio_id,student_id,program_id,status,started_at)
SELECT '{STUDIO}','{STUDENT}','{PROGRAM}','paused','2014-03-04'
WHERE NOT EXISTS(SELECT 1 FROM public.student_program_memberships WHERE student_id='{STUDENT}' AND program_id='{PROGRAM}' AND ended_at IS NULL);
UPDATE public.student_program_memberships SET status='paused',started_at='2014-03-04' WHERE student_id='{STUDENT}';
INSERT INTO public.guardians(id,studio_id,first_name,last_name,phone)
VALUES('{GUARDIAN}','{STUDIO}','Retained','Guardian','staff-edited-guardian');
INSERT INTO public.student_guardians(student_id,guardian_id) VALUES('{STUDENT}','{GUARDIAN}');
INSERT INTO public.student_import_runs(id,studio_id,actor_id,idempotency_key,request_hash,status,result_json,processing_token,completed_at)
VALUES('{COMPLETE_RUN}','{STUDIO}','{ACTOR}','legacy-complete','completed-hash','completed','{json.dumps(LEGACY_RESULT)}',NULL,'2020-01-01'),
      ('{FAILED_RUN}','{STUDIO}','{ACTOR}','legacy-failed','failed-hash','failed',NULL,NULL,NULL);
INSERT INTO public.billing_plans(studio_id,name,amount_cents,currency,status)
VALUES('{STUDIO}','Historical EUR plan',1200,'eur','active');
SELECT 'seeded';
COMMIT;
"""

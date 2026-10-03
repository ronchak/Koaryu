STUDENT = "42000000-0000-4000-8000-000000000003"
STUDIO = "42000000-0000-4000-8000-000000000002"
OWNER = "42000000-0000-4000-8000-000000000001"
PROGRAMS = ["42000000-0000-4000-8000-000000000004", "42000000-0000-4000-8000-000000000005"]
SEED_SQL = f"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('{OWNER}','authenticated','authenticated','v42-restore@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES ('{STUDIO}','V42 restore fixture','v42-restore-fixture','{OWNER}');
INSERT INTO public.programs(id,studio_id,name) VALUES
 ('{PROGRAMS[0]}','{STUDIO}','First'),('{PROGRAMS[1]}','{STUDIO}','Second');
INSERT INTO public.belt_ladders(id,studio_id,name,program_id)
VALUES ('42000000-0000-4000-8000-000000000006','{STUDIO}','First ladder','{PROGRAMS[0]}');
INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order)
VALUES ('42000000-0000-4000-8000-000000000007','{STUDIO}',
 '42000000-0000-4000-8000-000000000006','White',0);
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,membership_start_date,phone)
VALUES ('{STUDENT}','{STUDIO}','Restore','Student','active','2026-01-10','original');
DO $seed$ BEGIN PERFORM public.write_student_profile_v2_atomic('{STUDENT}','{STUDIO}','{OWNER}',
 '{{}}',ARRAY['{PROGRAMS[0]}','{PROGRAMS[1]}']::uuid[],'[]',true,'student.updated'); END $seed$;
UPDATE public.student_program_memberships SET status='paused',started_at='2026-03-05'
WHERE student_id='{STUDENT}' AND program_id='{PROGRAMS[0]}';
UPDATE public.student_program_memberships SET started_at=NULL
WHERE student_id='{STUDENT}' AND program_id='{PROGRAMS[1]}';
SELECT 'seeded';
COMMIT;
"""
SNAPSHOT_SQL = f"""
SELECT jsonb_build_object(
 'student',(SELECT to_jsonb(s) FROM public.students s WHERE id='{STUDENT}'),
 'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.student_program_memberships m WHERE student_id='{STUDENT}'),
 'ranks',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.belt_ranks r WHERE studio_id='{STUDIO}'),
 'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.audit_logs a WHERE entity_id='{STUDENT}'));
"""

TABLES = ("auth.users", "public.studios", "public.staff_roles", "public.programs", "public.leads",
          "public.lead_activities", "public.lead_follow_up_operations", "public.students",
          "public.student_program_memberships", "public.guardians", "public.student_guardians", "public.audit_logs")
SEED_SQL = """
BEGIN;
DO $seed$
DECLARE actor UUID := gen_random_uuid(); studio UUID := gen_random_uuid(); lead UUID := gen_random_uuid();
    program UUID := gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(actor,'authenticated','authenticated',actor||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Converted lead restore',studio::TEXT,actor);
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    INSERT INTO public.programs(id,studio_id,name) VALUES(program,studio,'Retained program');
    INSERT INTO public.leads(id,studio_id,first_name,last_name,source,stage,program_id,is_minor,guardian_name)
    VALUES(lead,studio,'Converted','Lead','walk_in','offer_sent',program,TRUE,'Retained Guardian');
    PERFORM public.follow_up_lead_atomic(studio,actor,lead,gen_random_uuid(),'{"next_stage":"enrolled"}');
    PERFORM public.update_lead_atomic(studio,actor,lead,'{"stage":"offer_sent","follow_up_date":"2030-01-01"}');
END;
$seed$;
SELECT 'seeded';
COMMIT;
"""

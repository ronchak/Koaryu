TABLES = ("auth.users", "public.studios", "public.staff_roles", "public.programs", "public.leads", "public.lead_activities")
SEED_SQL = """
BEGIN;
DO $seed$
DECLARE actor UUID := gen_random_uuid(); studio UUID := gen_random_uuid(); lead UUID := gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(actor,'authenticated','authenticated',actor||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Lead restore',studio::TEXT,actor);
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    INSERT INTO public.leads(id,studio_id,first_name,last_name,source,stage,follow_up_date,notes)
    VALUES(lead,studio,'Lead','Restore','walk_in','inquiry',CURRENT_DATE,'Retained lead');
    INSERT INTO public.lead_activities(studio_id,lead_id,activity_type,description,created_by)
    VALUES(studio,lead,'note','Retained contact history',actor);
END;
$seed$;
SELECT 'seeded';
COMMIT;
"""

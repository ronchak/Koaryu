TABLES = ("auth.users", "public.studios", "public.students", "public.class_sessions", "public.attendance")
SEED_SQL = """
BEGIN;
DO $seed$
DECLARE owner UUID := gen_random_uuid(); studio UUID := gen_random_uuid(); other UUID := gen_random_uuid();
    delayed UUID := gen_random_uuid(); recent UUID := gen_random_uuid(); future_student UUID := gen_random_uuid();
    quiet_other UUID := gen_random_uuid(); delayed_class UUID := gen_random_uuid(); recent_class UUID := gen_random_uuid();
    future_class UUID := gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(owner,'authenticated','authenticated',owner||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES
        (studio,'Inactivity restore',studio::TEXT,owner,'UTC'),
        (other,'Other inactivity restore',other::TEXT,owner,'UTC');
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,membership_start_date,created_at) VALUES
        (delayed,studio,'Delayed','Entry','active','2026-01-01','2026-01-01 12:00+00'),
        (recent,studio,'Recent','Class','active','2026-01-01','2026-01-01 12:00+00'),
        (future_student,studio,'Future','Only','active','2026-01-01','2026-01-01 12:00+00'),
        (quiet_other,other,'Other','Quiet','active','2026-01-01','2026-01-01 12:00+00');
    INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time,status,capacity) VALUES
        (delayed_class,studio,'Delayed entry','2026-04-30','10:00','11:00','scheduled',10),
        (recent_class,studio,'Recent class','2026-05-19','10:00','11:00','scheduled',10),
        (future_class,studio,'Future class','2026-05-23','10:00','11:00','scheduled',10);
    INSERT INTO public.attendance(studio_id,session_id,student_id,status,checked_in_at) VALUES
        (studio,delayed_class,delayed,'present','2026-05-20 12:00+00'),
        (studio,recent_class,recent,'present','2026-01-10 12:00+00'),
        (studio,future_class,future_student,'present','2026-05-20 12:00+00');
END;
$seed$;
SELECT 'seeded';
COMMIT;
"""

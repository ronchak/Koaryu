TABLES = ("auth.users", "public.studios", "public.staff_roles", "public.students", "public.leads",
          "public.guardians", "public.student_guardians", "public.student_program_memberships", "public.audit_logs")
SEED_SQL = """
BEGIN;
DO $seed$
DECLARE owner UUID := gen_random_uuid(); studio UUID := gen_random_uuid(); other UUID := gen_random_uuid();
    converted UUID := gen_random_uuid(); adult UUID := gen_random_uuid(); nonminor UUID := gen_random_uuid();
    unknown UUID := gen_random_uuid(); future_student UUID := gen_random_uuid(); guardian UUID := gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(owner,'authenticated','authenticated',owner||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES
        (studio,'Student profile restore',studio::TEXT,owner,'UTC'),
        (other,'Other profile restore',other::TEXT,owner,'America/Los_Angeles');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,owner,'admin');
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,date_of_birth,created_at,updated_at) VALUES
        (converted,studio,'Converted','Minor','active',NULL,'2026-01-01 12:00+00','2026-01-01 12:00+00'),
        (adult,studio,'Known','Adult','active','2000-01-01','2026-01-01 12:00+00','2026-01-01 12:00+00'),
        (nonminor,studio,'Nonminor','Lead','active',NULL,'2026-01-01 12:00+00','2026-01-01 12:00+00'),
        (unknown,other,'Unknown','Age','active',NULL,'2026-01-01 12:00+00','2026-01-01 12:00+00'),
        (future_student,studio,'Legacy','Future','active',CURRENT_DATE+30,'2026-01-01 12:00+00','2026-01-01 12:00+00');
    INSERT INTO public.leads(studio_id,first_name,last_name,is_minor,converted_student_id,stage) VALUES
        (studio,'Converted','Minor',TRUE,converted,'enrolled'),
        (studio,'Known','Adult',TRUE,adult,'enrolled'),
        (studio,'Nonminor','Lead',FALSE,nonminor,'enrolled'),
        (studio,'Legacy','Future',TRUE,future_student,'enrolled');
    INSERT INTO public.guardians(id,studio_id,first_name,last_name,email,is_primary_contact)
    VALUES(guardian,studio,'Original','Guardian','original@example.invalid',TRUE);
    INSERT INTO public.student_guardians(student_id,guardian_id) VALUES (converted,guardian),(adult,guardian);
END;
$seed$;
SELECT 'seeded';
COMMIT;
"""


def verify_upgrade_snapshot(before, after):
    # The reviewed repair permits only the same-studio explicit source lead's
    # missing-DOB student flag and its ordinary update timestamp to change.
    expected = json.loads(json.dumps(before))
    repaired = {student["id"] for student in before["public.students"]
                if student["date_of_birth"] is None and student["is_minor"] is not True
                and any(lead["converted_student_id"] == student["id"]
                        and lead["studio_id"] == student["studio_id"] and lead["is_minor"] is True
                        for lead in before["public.leads"])}
    require(len(repaired) == 1, "Backfill fixture does not isolate one explicit minor source")
    normalized = json.loads(json.dumps(after))
    for rows in (expected["public.students"], normalized["public.students"]):
        for student in rows:
            if student["id"] in repaired:
                if rows is expected["public.students"]:
                    student["is_minor"] = True
                student.pop("updated_at")
    for student in after["public.students"]:
        original = next(row for row in before["public.students"] if row["id"] == student["id"])
        if student["id"] in repaired:
            require(student["updated_at"] >= original["updated_at"], "Backfill timestamp moved backwards")
    return normalized == expected

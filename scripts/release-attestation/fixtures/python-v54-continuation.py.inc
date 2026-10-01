            after = snapshot(database)
            studio = next(row["id"] for row in after["public.studios"] if row["name"] == "Student profile restore")
            actor = next(row["user_id"] for row in after["public.staff_roles"] if row["studio_id"] == studio)
            student = next(row["id"] for row in after["public.students"] if row["legal_first_name"] == "Converted")
            guardian = after["public.guardians"][0]["id"]
            future_student = next(row["id"] for row in after["public.students"] if row["legal_first_name"] == "Legacy")
            proof = local.sql(database, f"""
BEGIN;
SET LOCAL ROLE service_role;
DO $proof$
DECLARE result RECORD; rejected BOOLEAN := FALSE;
BEGIN
    SELECT * INTO result FROM public.write_student_profile_v2_atomic(
        '{student}','{studio}','{actor}','{{"notes":"Retained minor edit","date_of_birth":null}}',
        NULL,'[{{"id":"{guardian}","phone":"555-0101"}}]',FALSE,'student.updated');
    IF (result.result_student->>'is_minor')::BOOLEAN IS DISTINCT FROM TRUE
       OR result.result_student->>'date_of_birth' IS NOT NULL
       OR jsonb_array_length(result.result_guardians) IS DISTINCT FROM 1
       OR result.result_guardians->0->>'email' IS DISTINCT FROM 'original@example.invalid'
       OR result.result_guardians->0->>'phone' IS DISTINCT FROM '555-0101' THEN
        RAISE EXCEPTION 'Restored minor edit lost age or omitted guardian facts';
    END IF;
    SELECT * INTO result FROM public.write_student_profile_v2_atomic(
        '{student}','{studio}','{actor}','{{"notes":"Guardian addition"}}',NULL,
        '[{{"first_name":"Added","last_name":"Guardian","is_primary_contact":false}}]',FALSE,'student.updated');
    IF jsonb_array_length(result.result_guardians) IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'Restored profile did not add a guardian';
    END IF;
    BEGIN
        PERFORM public.write_student_profile_v2_atomic(
            '{student}','{studio}','{actor}',jsonb_build_object('date_of_birth',public.student_business_date('{studio}')+1),
            NULL,'[]',FALSE,'student.updated');
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM IS DISTINCT FROM 'Date of birth cannot be in the future.' THEN RAISE; END IF;
        rejected := TRUE;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'Restored profile accepted a future birth date'; END IF;
    PERFORM public.write_student_profile_v2_atomic(
        '{future_student}','{studio}','{actor}','{{"notes":"Legacy unrelated edit"}}',
        NULL,'[]',FALSE,'student.updated');
    IF (SELECT date_of_birth FROM public.students WHERE id='{future_student}') IS DISTINCT FROM CURRENT_DATE+30
       OR (SELECT is_minor FROM public.students WHERE id='{future_student}') IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'Legacy future date continuation changed DOB or derived a minor age';
    END IF;
END;
$proof$;
ROLLBACK;
SELECT 'continued';
""")
            require(proof.splitlines()[-1] == "continued", "V54 profile continuation failed")
            require(snapshot(database) == after, "V54 continuation rollback changed retained rows")
            outcomes[("restored_" if is_restored else "canonical_") + "student_profile"] = "minor and guardian edits retained, future DOB rejected"
            if not is_restored:
                require(local.sql(database, MINOR_TRIGGER_SQL) == local.sql(source, MINOR_TRIGGER_SQL),
                        "V54 replaced or altered the existing correct trigger")
                outcomes["legacy_trigger_shapes"] = verify_legacy_trigger_shapes(
                    local, root, temporary, source, owned, before, snapshot, predecessor,
                    checks, pinned, hashes, pg_dump, pg_restore, createdb, psql)

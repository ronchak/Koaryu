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


MINOR_TRIGGER_SQL = """
SELECT COALESCE(jsonb_agg(to_jsonb(t) || jsonb_build_object(
    'definition',pg_catalog.pg_get_triggerdef(t.oid)) ORDER BY t.oid),'[]'::JSONB)
FROM pg_catalog.pg_trigger t
WHERE t.tgrelid=pg_catalog.to_regclass('public.students') AND t.tgname='set_students_is_minor';
"""


def legacy_trigger_prestate(local, database, snapshot):
    catalog = json.loads(local.sql(database, """
SELECT jsonb_build_object(
    'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid)
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('public','private')),
    'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid)
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private')),
    'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY h.version) FROM supabase_migrations.schema_migrations h),
    'default_acls',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.oid) FROM pg_catalog.pg_default_acl a),
    'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.rolname) FROM pg_catalog.pg_roles r));
"""))
    return {"catalog": catalog, "constraints": json.loads(local.sql(database, CONSTRAINT_SQL)),
            "acls": json.loads(local.sql(database, ACL_SQL)), "rows": snapshot(database)}


def verify_legacy_trigger_shapes(local, root, temporary, source, owned, before,
                                 snapshot, predecessor, checks, pinned, hashes,
                                 pg_dump, pg_restore, createdb, psql):
    """Only synthetic V53 clones. Missing objects converge; existing drift rolls back."""
    import subprocess

    result = {}
    migration = root / "supabase/migrations" / MIGRATION

    def clone(label, template):
        database = f"koaryu_v54_{label}_{os.getpid()}"
        local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
        owned.append(database)
        local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        return database

    def apply(database, path):
        require(hashlib.sha256(path.read_bytes()).hexdigest() == hashes[path.name], "Migration changed before shape proof")
        version, name = path.stem.split("_", 1)
        return subprocess.run([psql, *local.connection, f"--dbname={database}", "--no-psqlrc",
            "--set=ON_ERROR_STOP=1", "--quiet", "--single-transaction", f"--file={path}",
            f"--command=INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES('{version}','{name}');"],
            text=True, capture_output=True, env=local.env, timeout=120)

    for label, mutation in [
        ("disabled", "ALTER TABLE public.students DISABLE TRIGGER set_students_is_minor;"),
        ("wrong_binding", "DROP TRIGGER set_students_is_minor ON public.students; "
         "CREATE TRIGGER set_students_is_minor BEFORE INSERT OR UPDATE ON public.students "
         "FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();"),
    ]:
        database = clone(label, source)
        local.sql(database, mutation)
        predecessor(database)
        require(snapshot(database) == before, "Trigger drift fixture changed source rows")
        prestate = legacy_trigger_prestate(local, database, snapshot)
        failed = apply(database, migration)
        marker = "V54 installed contracts did not verify before history registration: "
        require(failed.returncode != 0 and marker in failed.stderr,
                f"{label}: V54 did not reject at the strict installed guard: {failed.stderr[-3000:]}")
        refusal = json.loads(failed.stderr.split(marker, 1)[1].splitlines()[0])
        require(refusal["security_failures"] == ["migration_history_v54", "migration_history_sequence_v31",
                "migration_history_sequence_v30", "student_profile_facts_v54"],
                f"{label}: V54 failed for an unexpected reason")
        require(refusal["migration_count"] == 148 and refusal["migration_head"] == '20260929152445'
                and refusal["ready"] is False, f"{label}: Unexpected refusal history")
        require(legacy_trigger_prestate(local, database, snapshot) == prestate,
                f"{label}: Failed V54 committed catalog, history, ACL or row changes")
        predecessor(database)
        result[label] = {"exit_code": failed.returncode, "refusal": refusal, "exact_rollback": True,
                         "prestate_sha256": hashlib.sha256(json.dumps(prestate, sort_keys=True).encode()).hexdigest()}

    missing = clone("missing", source)
    local.sql(missing, "BEGIN; DROP TRIGGER set_students_is_minor ON public.students; "
              "DROP FUNCTION public.set_student_is_minor(); COMMIT;")
    predecessor(missing)
    require(local.sql(missing, "SELECT to_regprocedure('public.set_student_is_minor()') IS NULL;") == "t"
            and json.loads(local.sql(missing, MINOR_TRIGGER_SQL)) == [], "Missing legacy objects fixture is incomplete")
    require(snapshot(missing) == before, "Missing legacy objects changed source rows")
    restored = clone("missing_restore", "template0")
    dump = temporary / f"v53-missing-legacy-{os.getpid()}.dump"
    try:
        constraints = json.loads(local.sql(missing, CONSTRAINT_SQL))
        acls = json.loads(local.sql(missing, ACL_SQL))
        local.run([pg_dump, *local.connection, f"--dbname={missing}", "--format=custom", f"--file={dump}"])
        dump_hash = hashlib.sha256(dump.read_bytes()).hexdigest()
        local.run([pg_restore, *local.connection, f"--dbname={restored}", "--exit-on-error", str(dump)])
        statements, expected_constraints = normalization_plan(constraints, json.loads(local.sql(restored, CONSTRAINT_SQL)),
            acls, json.loads(local.sql(restored, ACL_SQL)), json.loads(PAIR_PATH.read_bytes()))
        local.sql(restored, "BEGIN;\n" + "\n".join(statements) + "\nCOMMIT;")
        require(json.loads(local.sql(restored, CONSTRAINT_SQL)) == expected_constraints
                and json.loads(local.sql(restored, ACL_SQL)) == acls, "Missing-shape restore changed constraints or ACLs")
        require(snapshot(restored) == before and hashlib.sha256(dump.read_bytes()).hexdigest() == dump_hash,
                "Missing-shape logical restore changed rows or dump")
        v55_checks = [
            ("V55_OPERATIONAL_READINESS_SQL", "EXPECTED_V55_OPERATIONAL_READINESS"),
            ("V55_CATALOG_STATE_SQL", "EXPECTED_V55_CATALOG_STATE"),
            ("V55_RELEASE_MANIFEST_SQL", "EXPECTED_V55_RELEASE_MANIFEST"),
            ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V55_EXPECTATION_STATE"),
            ("V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V55_RESOURCE_OWNERSHIP_MANIFEST"),
            ("V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V55_OPERATIONAL_CONTRACT"),
            ("V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V55_OPERATIONAL_MANIFEST_V12"),
            ("CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V55_CRITICAL_SURFACE_MANIFEST"),
            ("V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V55_OPERATIONAL_MANIFEST_V10"),
            ("V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V55_OPERATIONAL_MANIFEST_V11"),
            ("V55_STUDENT_PROFILE_STATE_SQL", "EXPECTED_V55_STUDENT_PROFILE_STATE"),
            ("V55_LEAD_CONVERSION_STATE_SQL", "EXPECTED_V55_LEAD_CONVERSION_STATE"),
            ("V55_LEAD_FOLLOW_UP_STATE_SQL", "EXPECTED_V55_LEAD_FOLLOW_UP_STATE"),
        ]
        names = list(dict.fromkeys([name for pair in v55_checks for name in pair] + ["EXPECTED_V55_RESTORED_CATALOG_STATE"]))
        module = (root / "scripts/studio-comp-migration-rollout.mjs").as_uri()
        v55_pins = json.loads(local.run(["node", "--input-type=module", "--eval",
            f"import * as m from {json.dumps(module)}; console.log(JSON.stringify(Object.fromEntries("
            f"{json.dumps(names)}.map(k=>[k,m[k]]))));"]))
        require(set(v55_pins) == set(names) and all(isinstance(v, str) and v for v in v55_pins.values()),
                "Incomplete V55 missing-shape expectations")
        all_pins = {**pinned, **v55_pins}
        unchanged = [(query, expected) for query, expected in checks
                     if not expected.startswith("EXPECTED_V54_")]
        unchanged.append(("V54_OPERATIONAL_READINESS_SQL", "EXPECTED_V54_OPERATIONAL_READINESS"))
        v55 = root / "supabase/migrations/20260930192626_converted_lead_enrollment_v55.sql"
        for database, is_restored in [(missing, False), (restored, True)]:
            predecessor(database, is_restored)
            upgraded = apply(database, migration)
            require(upgraded.returncode == 0, f"Missing-shape V54 failed: {upgraded.stderr[-3000:]}")
            require(verify_upgrade_snapshot(before, snapshot(database)), "Missing-shape V54 exceeded the scoped minor repair")
            v54_values = {}
            for query, expected in checks:
                if query == "V54_CATALOG_STATE_SQL" and is_restored:
                    expected = "EXPECTED_V54_RESTORED_CATALOG_STATE"
                value = local.sql(database, pinned[query])
                require(value == pinned[expected], f"Missing-shape V54 {query} did not match {expected}")
                v54_values[query] = value
            retained = snapshot(database)
            trigger = local.sql(database, MINOR_TRIGGER_SQL)
            upgraded = apply(database, v55)
            require(upgraded.returncode == 0, f"Missing-shape V55 failed: {upgraded.stderr[-3000:]}")
            require(snapshot(database) == retained and local.sql(database, MINOR_TRIGGER_SQL) == trigger,
                    "Missing-shape V55 changed retained rows or the V54 trigger")
            v55_values = {}
            for query, expected in v55_checks + unchanged:
                if query == "V55_CATALOG_STATE_SQL" and is_restored:
                    expected = "EXPECTED_V55_RESTORED_CATALOG_STATE"
                value = local.sql(database, all_pins[query])
                require(value == all_pins[expected], f"Missing-shape V55 {query} did not match {expected}")
                v55_values[query] = value
            result["missing_restored" if is_restored else "missing_canonical"] = {
                "v54": v54_values, "v55": v55_values, "retained_rows": True, "trigger_retained_by_v55": True}
        result["missing_dump_sha256"] = dump_hash
        result["v55_queries"] = v55_pins
    finally:
        dump.unlink(missing_ok=True)
    return result

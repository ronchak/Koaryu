#!/usr/bin/env python3
"""Prove V54 converted lead rows survive logical restore and V55 restores enrollment with archived or null program interest, exact retries and explicit minor knowledge."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20260930192626_converted_lead_enrollment_v55.sql"
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


def main(arguments):
    require(len(arguments) == 8, "Expected pg_dump pg_restore createdb psql socket port temporary root")
    pg_dump, pg_restore, createdb, psql, socket, port, temporary_arg, root_arg = arguments
    root, temporary = Path(root_arg).resolve(), Path(temporary_arg)
    local = LocalPostgres(psql, socket, port, temporary)
    versions = local.require_pg17(pg_dump, pg_restore, createdb, psql)
    source_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    shared = Path(__file__).with_name("local_postgres_verification.py")
    shared_hash = hashlib.sha256(shared.read_bytes()).hexdigest()
    names = [
        "V54_OPERATIONAL_READINESS_SQL", "EXPECTED_V54_OPERATIONAL_READINESS",
        "V54_CATALOG_STATE_SQL", "EXPECTED_V54_CATALOG_STATE", "EXPECTED_V54_RESTORED_CATALOG_STATE",
        "V54_RELEASE_MANIFEST_SQL", "EXPECTED_V54_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V54_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V54_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V54_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V54_OPERATIONAL_MANIFEST_V12",
        "CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V54_CRITICAL_SURFACE_MANIFEST",
        "V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V54_OPERATIONAL_MANIFEST_V10",
        "V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V54_OPERATIONAL_MANIFEST_V11",
        "V54_STUDENT_PROFILE_STATE_SQL", "EXPECTED_V54_STUDENT_PROFILE_STATE",
        "FINAL_OPERATIONAL_READINESS_SQL", "EXPECTED_OPERATIONAL_READINESS",
        "V55_CATALOG_STATE_SQL", "EXPECTED_V55_CATALOG_STATE", "EXPECTED_V55_RESTORED_CATALOG_STATE",
        "V55_RELEASE_MANIFEST_SQL", "EXPECTED_V55_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V55_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V55_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V55_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V55_OPERATIONAL_MANIFEST_V12",
        "CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V55_CRITICAL_SURFACE_MANIFEST",
        "V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V55_OPERATIONAL_MANIFEST_V10",
        "V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V55_OPERATIONAL_MANIFEST_V11",
        "V55_STUDENT_PROFILE_STATE_SQL", "EXPECTED_V55_STUDENT_PROFILE_STATE",
        "V53_DASHBOARD_DEFINITION_STATE_SQL", "EXPECTED_V53_DASHBOARD_DEFINITION_SHA256",
        "V52_OPERATIONAL_READINESS_SQL", "EXPECTED_V52_OPERATIONAL_READINESS",
        "V51_OPERATIONAL_READINESS_SQL", "EXPECTED_V51_OPERATIONAL_READINESS",
        "V50_OPERATIONAL_READINESS_SQL", "EXPECTED_V50_OPERATIONAL_READINESS",
        "V49_OPERATIONAL_READINESS_SQL", "EXPECTED_V49_OPERATIONAL_READINESS",
        "V48_OPERATIONAL_READINESS_SQL", "EXPECTED_V48_OPERATIONAL_READINESS",
        "V47_OPERATIONAL_READINESS_SQL", "EXPECTED_V47_OPERATIONAL_READINESS",
        "V46_OPERATIONAL_READINESS_SQL", "EXPECTED_V46_OPERATIONAL_READINESS",
        "V45_OPERATIONAL_READINESS_SQL", "EXPECTED_V45_OPERATIONAL_READINESS",
        "V44_OPERATIONAL_READINESS_SQL", "EXPECTED_V44_OPERATIONAL_READINESS",
        "V43_OPERATIONAL_READINESS_SQL", "EXPECTED_V43_OPERATIONAL_READINESS",
        "V42_OPERATIONAL_READINESS_SQL", "EXPECTED_V42_OPERATIONAL_READINESS",
        "V41_OPERATIONAL_READINESS_SQL", "EXPECTED_V41_OPERATIONAL_READINESS",
        "V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS",
        "V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS",
        "V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS",
        "V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS",
        "V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V50_PAYER_BALANCE_STATE",
        "V50_COLLECTION_FACTS_STATE_SQL", "EXPECTED_V50_COLLECTION_FACTS_STATE",
        "V50_PAYER_READ_STATE_SQL", "EXPECTED_V50_PAYER_READ_STATE",
        "V50_LANDING_STATE_SQL", "EXPECTED_V50_LANDING_STATE",
        "V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE",
        "V43_EXTERNAL_PAYMENT_STATE_SQL", "EXPECTED_V43_EXTERNAL_PAYMENT_STATE",
        "V44_LOCAL_PLAN_STATE_SQL", "EXPECTED_V44_LOCAL_PLAN_STATE",
        "V44_CLEAR_STATE_SQL", "EXPECTED_V44_CLEAR_STATE",
        "V49_SUBSCRIPTION_TERMS_STATE_SQL", "EXPECTED_V49_SUBSCRIPTION_TERMS_STATE",
        "V50_INVOICE_FACTS_STATE_SQL", "EXPECTED_V50_INVOICE_FACTS_STATE",
        "V50_ATTENTION_STATE_SQL", "EXPECTED_V50_ATTENTION_STATE",
        "V30_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V51_V30_OPERATIONAL_CONTRACT",
        "V30_REPLAY_REPAIRS_MANIFEST_SQL", "EXPECTED_V51_V30_REPLAY_REPAIRS_MANIFEST",
        "V51_CLOSEOUT_STATE_SQL", "EXPECTED_V51_CLOSEOUT_STATE",
        "V53_OPERATIONAL_READINESS_SQL", "EXPECTED_V53_OPERATIONAL_READINESS",
        "V55_LEAD_CONVERSION_STATE_SQL", "EXPECTED_V55_LEAD_CONVERSION_STATE",
        "V55_LEAD_FOLLOW_UP_STATE_SQL", "EXPECTED_V55_LEAD_FOLLOW_UP_STATE",
    ]
    module = (root / "scripts/studio-comp-migration-rollout.mjs").as_uri()
    pinned = json.loads(local.run(["node", "--input-type=module", "--eval",
        f"import * as m from {json.dumps(module)}; console.log(JSON.stringify(Object.fromEntries("
        f"{json.dumps(names)}.map(k=>[k,m[k]]))));"]))
    require(set(pinned) == set(names) and all(isinstance(v, str) and v for v in pinned.values()),
            "Incomplete version-bound restore expectations")

    def check(database, query, expected):
        value = local.sql(database, pinned[query])
        require(value == pinned[expected], f"{database}: {query} did not match {expected}")
        return value

    def snapshot(database):
        fields = []
        for table in TABLES:
            value = "to_jsonb(t)"
            fields.append(f"'{table}',(SELECT COALESCE(jsonb_agg({value} ORDER BY to_jsonb(t)->>'id',"
                          f"to_jsonb(t)::TEXT COLLATE \"C\"),'[]'::JSONB) FROM {table} t)")
        return json.loads(local.sql(database, "SET TIME ZONE 'UTC'; SELECT jsonb_build_object(" + ",".join(fields) + ");"))

    def predecessor(database, restored=False):
        check(database, "V54_OPERATIONAL_READINESS_SQL", "EXPECTED_V54_OPERATIONAL_READINESS")
        check(database, "V54_CATALOG_STATE_SQL", "EXPECTED_V54_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V54_CATALOG_STATE")
        check(database, "V54_RELEASE_MANIFEST_SQL", "EXPECTED_V54_RELEASE_MANIFEST")
        check(database, "V31_EXPECTATION_STATE_SQL", "EXPECTED_V54_EXPECTATION_STATE")
        check(database, "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V54_RESOURCE_OWNERSHIP_MANIFEST")
        check(database, "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V54_OPERATIONAL_CONTRACT")
        check(database, "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V54_OPERATIONAL_MANIFEST_V12")
        check(database, "CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V54_CRITICAL_SURFACE_MANIFEST")
        check(database, "V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V54_OPERATIONAL_MANIFEST_V10")
        check(database, "V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V54_OPERATIONAL_MANIFEST_V11")
        check(database, "V54_STUDENT_PROFILE_STATE_SQL", "EXPECTED_V54_STUDENT_PROFILE_STATE")
        require(local.sql(database, "SELECT count(*)=149 AND max(version)='20260930024404' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V54 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v36()') IS NULL;") == "t",
                "Restore predecessor already contains V55 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 150 and list(hashes)[-2:] == [
        "20260930024404_student_profile_qa_v54.sql", MIGRATION], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v55_source_{os.getpid()}"
    restored = f"koaryu_v55_restore_{os.getpid()}"
    canonical = f"koaryu_v55_canonical_{os.getpid()}"
    dump = temporary / f"v54-before-v55-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == "seeded" and len(before["public.leads"]) == 1
                and len(before["public.students"]) == 1 and len(before["public.student_guardians"]) == 1,
                "Retained converted lead fixture is incomplete")
        lead = before["public.leads"][0]
        actor = before["public.staff_roles"][0]["user_id"]
        old_result = json.loads(local.sql(source, f"SELECT to_jsonb(public.convert_lead_to_student_atomic('{lead['studio_id']}','{actor}','{lead['id']}','{lead['converted_student_id']}','{lead['program_id']}','active',CURRENT_DATE,NULL,NULL));"))
        require(old_result["stage"] == "offer_sent" and snapshot(source) == before,
                "V54 source no longer reproduces the converted-stage restoration bug")
        require(before["public.students"][0]["date_of_birth"] is None
                and before["public.students"][0]["is_minor"] is True,
                "V54 seed lost explicit minor knowledge without a DOB")
        predecessor(source)
        constraints, acls = json.loads(local.sql(source, CONSTRAINT_SQL)), json.loads(local.sql(source, ACL_SQL))
        local.run([pg_dump, *local.connection, f"--dbname={source}", "--format=custom", f"--file={dump}"])
        dump_hash = hashlib.sha256(dump.read_bytes()).hexdigest()
        local.run([pg_restore, *local.connection, f"--dbname={restored}", "--exit-on-error", str(dump)])
        statements, expected_constraints = normalization_plan(
            constraints, json.loads(local.sql(restored, CONSTRAINT_SQL)),
            acls, json.loads(local.sql(restored, ACL_SQL)), pairs,
        )
        local.sql(restored, "BEGIN;\n" + "\n".join(statements) + "\nCOMMIT;")
        require(json.loads(local.sql(restored, CONSTRAINT_SQL)) == expected_constraints, "Unexpected restored CHECK state")
        require(json.loads(local.sql(restored, ACL_SQL)) == acls, "Unexpected restored ACL state")
        require(snapshot(restored) == before, "Logical restore changed retained business rows")
        require(hashlib.sha256(dump.read_bytes()).hexdigest() == dump_hash, "Backup changed during restore")
        predecessor(restored, restored=True)
        local.run([createdb, *local.connection, "--owner=postgres", f"--template={source}", canonical])
        owned.append(canonical)
        for database, is_restored in [(canonical, False), (restored, True)]:
            predecessor(database, is_restored)
            require(snapshot(database) == before, "Predecessor rows changed before upgrade")
            require(hashlib.sha256(migration.read_bytes()).hexdigest() == hashes[MIGRATION], "Migration changed before execution")
            version, name = MIGRATION[:-4].split("_", 1)
            local.run([psql, *local.connection, f"--dbname={database}", "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--quiet",
                       "--single-transaction", f"--file={migration}",
                       f"--command=INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES('{version}','{name}');"])
            require(snapshot(database) == before, "Migration changed retained rows before continuation")
            checks = [
                ("FINAL_OPERATIONAL_READINESS_SQL", "EXPECTED_OPERATIONAL_READINESS"),
                ("V55_CATALOG_STATE_SQL", "EXPECTED_V55_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V55_CATALOG_STATE"),
                ("V55_RELEASE_MANIFEST_SQL", "EXPECTED_V55_RELEASE_MANIFEST"),
                ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V55_EXPECTATION_STATE"),
                ("V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V55_RESOURCE_OWNERSHIP_MANIFEST"),
                ("V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V55_OPERATIONAL_CONTRACT"),
                ("V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V55_OPERATIONAL_MANIFEST_V12"),
                ("CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V55_CRITICAL_SURFACE_MANIFEST"),
                ("V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V55_OPERATIONAL_MANIFEST_V10"),
                ("V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V55_OPERATIONAL_MANIFEST_V11"),
                ("V55_STUDENT_PROFILE_STATE_SQL", "EXPECTED_V55_STUDENT_PROFILE_STATE"),
                ("V53_DASHBOARD_DEFINITION_STATE_SQL", "EXPECTED_V53_DASHBOARD_DEFINITION_SHA256"),
                ("V52_OPERATIONAL_READINESS_SQL", "EXPECTED_V52_OPERATIONAL_READINESS"),
                ("V51_OPERATIONAL_READINESS_SQL", "EXPECTED_V51_OPERATIONAL_READINESS"),
                ("V50_OPERATIONAL_READINESS_SQL", "EXPECTED_V50_OPERATIONAL_READINESS"),
                ("V49_OPERATIONAL_READINESS_SQL", "EXPECTED_V49_OPERATIONAL_READINESS"),
                ("V48_OPERATIONAL_READINESS_SQL", "EXPECTED_V48_OPERATIONAL_READINESS"),
                ("V47_OPERATIONAL_READINESS_SQL", "EXPECTED_V47_OPERATIONAL_READINESS"),
                ("V46_OPERATIONAL_READINESS_SQL", "EXPECTED_V46_OPERATIONAL_READINESS"),
                ("V45_OPERATIONAL_READINESS_SQL", "EXPECTED_V45_OPERATIONAL_READINESS"),
                ("V44_OPERATIONAL_READINESS_SQL", "EXPECTED_V44_OPERATIONAL_READINESS"),
                ("V43_OPERATIONAL_READINESS_SQL", "EXPECTED_V43_OPERATIONAL_READINESS"),
                ("V42_OPERATIONAL_READINESS_SQL", "EXPECTED_V42_OPERATIONAL_READINESS"),
                ("V41_OPERATIONAL_READINESS_SQL", "EXPECTED_V41_OPERATIONAL_READINESS"),
                ("V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS"),
                ("V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS"),
                ("V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS"),
                ("V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS"),
                ("V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V50_PAYER_BALANCE_STATE"),
                ("V50_COLLECTION_FACTS_STATE_SQL", "EXPECTED_V50_COLLECTION_FACTS_STATE"),
                ("V50_PAYER_READ_STATE_SQL", "EXPECTED_V50_PAYER_READ_STATE"),
                ("V50_LANDING_STATE_SQL", "EXPECTED_V50_LANDING_STATE"),
                ("V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE"),
                ("V43_EXTERNAL_PAYMENT_STATE_SQL", "EXPECTED_V43_EXTERNAL_PAYMENT_STATE"),
                ("V44_LOCAL_PLAN_STATE_SQL", "EXPECTED_V44_LOCAL_PLAN_STATE"),
                ("V44_CLEAR_STATE_SQL", "EXPECTED_V44_CLEAR_STATE"),
                ("V49_SUBSCRIPTION_TERMS_STATE_SQL", "EXPECTED_V49_SUBSCRIPTION_TERMS_STATE"),
                ("V50_INVOICE_FACTS_STATE_SQL", "EXPECTED_V50_INVOICE_FACTS_STATE"),
                ("V50_ATTENTION_STATE_SQL", "EXPECTED_V50_ATTENTION_STATE"),
                ("V30_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V51_V30_OPERATIONAL_CONTRACT"),
                ("V30_REPLAY_REPAIRS_MANIFEST_SQL", "EXPECTED_V51_V30_REPLAY_REPAIRS_MANIFEST"),
                ("V51_CLOSEOUT_STATE_SQL", "EXPECTED_V51_CLOSEOUT_STATE"),
                ("V54_OPERATIONAL_READINESS_SQL", "EXPECTED_V54_OPERATIONAL_READINESS"),
                ("V53_OPERATIONAL_READINESS_SQL", "EXPECTED_V53_OPERATIONAL_READINESS"),
                ("V55_LEAD_CONVERSION_STATE_SQL", "EXPECTED_V55_LEAD_CONVERSION_STATE"),
                ("V55_LEAD_FOLLOW_UP_STATE_SQL", "EXPECTED_V55_LEAD_FOLLOW_UP_STATE"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            lead = before["public.leads"][0]
            studio, actor = lead["studio_id"], before["public.staff_roles"][0]["user_id"]
            lead_id, student_id, program = lead["id"], lead["converted_student_id"], lead["program_id"]
            proof = local.sql(database, f"""
BEGIN;
UPDATE public.programs SET archived_at=now() WHERE id='{program}';
SET LOCAL ROLE service_role;
DO $proof$
DECLARE operation UUID := gen_random_uuid(); result public.leads; replay public.leads;
    prior JSONB; after_restore JSONB; activities INTEGER;
BEGIN
    SELECT jsonb_build_array(
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.students t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.student_program_memberships t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.guardians t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.student_guardians t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.audit_logs t)
    ) INTO prior;
    IF (SELECT is_minor IS TRUE AND date_of_birth IS NULL FROM public.students WHERE id='{student_id}') IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'V55 restored converted minor lost explicit minor knowledge';
    END IF;
    SELECT count(*) INTO activities FROM public.lead_activities WHERE lead_id='{lead_id}';
    SELECT * INTO result FROM public.follow_up_lead_atomic('{studio}','{actor}','{lead_id}',operation,'{{"next_stage":"enrolled"}}');
    SELECT * INTO replay FROM public.follow_up_lead_atomic('{studio}','{actor}','{lead_id}',operation,'{{"next_stage":"enrolled"}}');
    IF result.stage IS DISTINCT FROM 'enrolled' OR result.follow_up_date IS NOT NULL
       OR result.converted_student_id IS DISTINCT FROM '{student_id}'::uuid
       OR to_jsonb(result) IS DISTINCT FROM to_jsonb(replay)
       OR (SELECT count(*) FROM public.lead_activities WHERE lead_id='{lead_id}') <> activities+2 THEN
        RAISE EXCEPTION 'V55 restored archived-program enrollment or keyed retry mismatch';
    END IF;
    PERFORM public.update_lead_atomic('{studio}','{actor}','{lead_id}','{{"stage":"offer_sent","program_id":null}}');
    SELECT * INTO result FROM public.convert_lead_to_student_atomic('{studio}','{actor}','{lead_id}',NULL,NULL,NULL,NULL,NULL,NULL);
    SELECT * INTO replay FROM public.convert_lead_to_student_atomic('{studio}','{actor}','{lead_id}',NULL,NULL,NULL,NULL,NULL,NULL);
    IF result.stage IS DISTINCT FROM 'enrolled' OR result.program_id IS NOT NULL
       OR result.converted_student_id IS DISTINCT FROM '{student_id}'::uuid
       OR to_jsonb(result) IS DISTINCT FROM to_jsonb(replay)
       OR (SELECT count(*) FROM public.lead_activities WHERE lead_id='{lead_id}') <> activities+4 THEN
        RAISE EXCEPTION 'V55 restored null-program enrollment or exact retry mismatch';
    END IF;
    SELECT jsonb_build_array(
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.students t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.student_program_memberships t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.guardians t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.student_guardians t),
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.audit_logs t)
    ) INTO after_restore;
    IF prior IS DISTINCT FROM after_restore THEN RAISE EXCEPTION 'V55 restoration changed conversion facts'; END IF;
END;
$proof$;
ROLLBACK;
SELECT 'continued';
""")
            require(proof.splitlines()[-1] == "continued", "Converted lead restoration continuation failed")
            require(snapshot(database) == before, "Converted lead restoration rollback changed retained rows")
            outcomes[("restored_" if is_restored else "canonical_") + "lead_restoration"] = "same student and idempotent retry"
            require({query: check(database, query, expected) for query, expected in checks} == values,
                    "Continuation changed the attested state")
            outcomes["restored" if is_restored else "canonical"] = values
        predecessor("postgres")
        predecessor(source)
        require(snapshot(source) == before, "Restore proof edited its source rows")
        require(all(hashlib.sha256((root / "supabase/migrations" / name).read_bytes()).hexdigest() == digest
                    for name, digest in hashes.items()), "Migration inputs changed during verification")
        require(hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == source_hash
                and hashlib.sha256(shared.read_bytes()).hexdigest() == shared_hash,
                "Restore helper inputs changed during verification")
        evidence = {
            "migrations": hashes, "dump_sha256": dump_hash, "helper_sha256": source_hash,
            "local_tools_sha256": shared_hash, "mapping_sha256": hashlib.sha256(mapping_bytes).hexdigest(),
            "tools": versions, "queries": pinned, "outcomes": outcomes,
            "business_before_sha256": hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
            "constraint_pairs": len(pairs), "billing_replays": 6, "acl_representations": len(statements) - 6,
        }
        (temporary / "v54-v55-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V55] PASS exact retained rows, archived/null-program enrollment, exact retries and explicit-minor preservation on canonical/restored copies", flush=True)
    finally:
        errors = []
        for database in reversed(owned):
            try:
                local.sql("postgres", f"DROP DATABASE {database} WITH (FORCE);")
            except Exception as error:
                errors.append(str(error))
        if errors:
            raise RuntimeError("Owned restore database cleanup failed: " + "; ".join(errors))
        dump.unlink(missing_ok=True)


if __name__ == "__main__":
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    main(sys.argv[1:])

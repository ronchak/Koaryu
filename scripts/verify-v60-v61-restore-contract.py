#!/usr/bin/env python3
"""Prove V60 imports survive V61 and logical restore, then continue and replay with provenance."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20261022190000_student_import_identity_guard_v61.sql"
SEED_SQL = r"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('00000000-0000-4000-8000-000000006101','authenticated','authenticated',
       'v61-restore@example.invalid','{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id,timezone)
VALUES('00000000-0000-4000-8000-000000006102','V61 retained import','v61-retained-import',
       '00000000-0000-4000-8000-000000006101','UTC');
INSERT INTO public.programs(id,studio_id,name) VALUES
 ('00000000-0000-4000-8000-000000006103','00000000-0000-4000-8000-000000006102','V61 program');
SET LOCAL ROLE service_role;
SELECT * FROM public.claim_student_import_run_v2(
 '00000000-0000-4000-8000-000000006102','00000000-0000-4000-8000-000000006101',
 'students_csv_execute','v61-retained','v61-hash','v61-token',45);
DO $seed$
DECLARE runid UUID;
BEGIN
 SELECT id INTO STRICT runid FROM public.student_import_runs WHERE idempotency_key='v61-retained';
 PERFORM public.import_student_row_atomic(
 jsonb_build_object('id','00000000-0000-4000-8000-000000006104','studio_id','00000000-0000-4000-8000-000000006102',
 'legal_first_name','Retained','legal_last_name','Student','_import_outcome',jsonb_build_object(
 'row_number',2,'is_valid',true,'issues','[]'::jsonb,'data','{}'::jsonb,'imported_without_belt',false)),
 '00000000-0000-4000-8000-000000006102',runid,'v61-token',2,'Retained Guardian','retained@example.invalid',NULL,'Parent',
 ARRAY['00000000-0000-4000-8000-000000006103'::uuid]);
END;
$seed$;
COMMIT;
SELECT 'seeded';
"""

CONTINUATION_SQL = r"""
BEGIN;
SET LOCAL ROLE service_role;
DO $continue$
DECLARE runid UUID; payload JSONB; first_result JSONB; replay_result JSONB; before_replay JSONB; after_replay JSONB;
 rejected BOOLEAN; guard_runid UUID; reused_gid UUID; original_contact JSONB; skip JSONB; skipped_receipt JSONB; original_run JSONB;
BEGIN
 SELECT id INTO STRICT runid FROM public.student_import_runs WHERE idempotency_key='v61-retained';
 payload := jsonb_build_object('id','00000000-0000-4000-8000-000000006105','studio_id','00000000-0000-4000-8000-000000006102',
 'legal_first_name','Continued','legal_last_name','Student','_import_outcome',jsonb_build_object(
 'row_number',3,'is_valid',true,'issues','[]'::jsonb,'data','{}'::jsonb,'imported_without_belt',false));
 SELECT to_jsonb(r) INTO first_result FROM public.import_student_row_atomic(payload,
 '00000000-0000-4000-8000-000000006102',runid,'v61-token',3,'Continued Guardian','continued@example.invalid',NULL,'Parent',
 ARRAY['00000000-0000-4000-8000-000000006103'::uuid]) r;
 IF first_result IS DISTINCT FROM jsonb_build_object('student_id','00000000-0000-4000-8000-000000006105','guardian_imported',true)
 OR NOT EXISTS(SELECT 1 FROM public.students WHERE id='00000000-0000-4000-8000-000000006105' AND import_run_id=runid AND source_system IS NULL AND source_id IS NULL)
 OR NOT EXISTS(SELECT 1 FROM public.guardians WHERE id=private.deterministic_import_uuid(runid,'guardian-row:3') AND import_run_id=runid)
 OR NOT EXISTS(SELECT 1 FROM private.student_import_receipts WHERE import_run_id=runid AND kind='student' AND key='3') THEN
  RAISE EXCEPTION 'V61 continuation did not stamp provenance and receipt';
 END IF;
 SELECT jsonb_build_object('students',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.students t),'guardians',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.guardians t),'student_guardians',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.student_guardians t),'student_program_memberships',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.student_program_memberships t),'student_import_runs',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.student_import_runs t),'receipts',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.import_run_id,t.kind,t.key) FROM private.student_import_receipts t)) INTO before_replay;
 SELECT to_jsonb(r) INTO replay_result FROM public.import_student_row_atomic(payload,
 '00000000-0000-4000-8000-000000006102',runid,'v61-token',3,'Continued Guardian','continued@example.invalid',NULL,'Parent',
 ARRAY['00000000-0000-4000-8000-000000006103'::uuid]) r;
 SELECT jsonb_build_object('students',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.students t),'guardians',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.guardians t),'student_guardians',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.student_guardians t),'student_program_memberships',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.student_program_memberships t),'student_import_runs',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.id) FROM public.student_import_runs t),'receipts',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.ctid::text) ORDER BY t.import_run_id,t.kind,t.key) FROM private.student_import_receipts t)) INTO after_replay;
 IF replay_result IS DISTINCT FROM first_result OR before_replay IS DISTINCT FROM after_replay THEN
  RAISE EXCEPTION 'V61 replay changed rows or physical tuples';
 END IF;
 -- The guarded call and reused guardian also continue on logical restores.
 SELECT (claim.run_row->>'id')::UUID INTO guard_runid FROM public.claim_student_import_run_v2(
  '00000000-0000-4000-8000-000000006102','00000000-0000-4000-8000-000000006101',
  'students_csv_execute','v61-guard-other','v61-guard-hash','guard-token',45) claim;
 payload:=payload||jsonb_build_object('id','00000000-0000-4000-8000-000000006106',
   'legal_first_name','Guarded','date_of_birth','2014-06-03',
   '_import_outcome',jsonb_set(payload->'_import_outcome','{row_number}','4'));
 PERFORM public.import_student_row_atomic(payload,'00000000-0000-4000-8000-000000006102',guard_runid,'guard-token',4,
   NULL,NULL,NULL,NULL,ARRAY['00000000-0000-4000-8000-000000006103'::UUID],ARRAY[]::UUID[]);
 payload:=payload||jsonb_build_object('id','00000000-0000-4000-8000-000000006107',
   '_import_outcome',jsonb_set(payload->'_import_outcome','{row_number}','5'));
 rejected:=false;
 BEGIN
   PERFORM public.import_student_row_atomic(payload,'00000000-0000-4000-8000-000000006102',runid,'v61-token',5,
     NULL,NULL,NULL,NULL,ARRAY['00000000-0000-4000-8000-000000006103'::UUID],ARRAY[]::UUID[]);
 EXCEPTION WHEN SQLSTATE 'P0409' THEN
   IF SQLERRM IS DISTINCT FROM 'student_import_duplicate_review_required' THEN RAISE; END IF;
   rejected:=true;
 END;
 IF NOT rejected OR EXISTS(SELECT 1 FROM public.students WHERE id='00000000-0000-4000-8000-000000006107')
 OR EXISTS(SELECT 1 FROM private.student_import_receipts WHERE import_run_id=runid AND key='5') THEN
   RAISE EXCEPTION 'Restored identity guard did not refuse the duplicate atomically';
 END IF;
 reused_gid:=private.deterministic_import_uuid(runid,'guardian-row:3');
 SELECT jsonb_build_array(to_jsonb(g),g.ctid::TEXT) INTO original_contact FROM public.guardians g WHERE id=reused_gid;
 payload:=payload||jsonb_build_object('legal_first_name','Sibling');
 PERFORM public.import_student_row_atomic(payload,'00000000-0000-4000-8000-000000006102',runid,'v61-token',5,
   'Ignored Contact',NULL,NULL,NULL,ARRAY['00000000-0000-4000-8000-000000006103'::UUID],ARRAY[]::UUID[],reused_gid);
 IF original_contact IS DISTINCT FROM (SELECT jsonb_build_array(to_jsonb(g),g.ctid::TEXT) FROM public.guardians g WHERE id=reused_gid)
 OR NOT EXISTS(SELECT 1 FROM public.student_guardians WHERE student_id='00000000-0000-4000-8000-000000006107' AND guardian_id=reused_gid)
 OR EXISTS(SELECT 1 FROM public.guardians WHERE id=private.deterministic_import_uuid(runid,'guardian-row:5')) THEN
   RAISE EXCEPTION 'Restored guardian reuse altered or copied the contact';
 END IF;
 skip:=jsonb_build_object('action','skip','retained_kind','row','retained_id_or_row',5,
  'outcome',jsonb_build_object('row_number',6,'is_valid',true,'issues','[]'::JSONB,'data','{}'::JSONB));
 PERFORM public.record_student_import_skip_v1('00000000-0000-4000-8000-000000006102',runid,'v61-token',6,skip);
 SELECT jsonb_build_array(to_jsonb(r),r.ctid::TEXT) INTO skipped_receipt FROM private.student_import_receipts r
 WHERE r.import_run_id=runid AND r.kind='skipped' AND r.key='6';
 SELECT jsonb_build_array(to_jsonb(r),r.ctid::TEXT) INTO original_run FROM public.student_import_runs r WHERE id=runid;
 IF public.record_student_import_skip_v1('00000000-0000-4000-8000-000000006102',runid,'v61-token',6,'{}') IS DISTINCT FROM skip
 OR skipped_receipt IS DISTINCT FROM (SELECT jsonb_build_array(to_jsonb(r),r.ctid::TEXT) FROM private.student_import_receipts r WHERE r.import_run_id=runid AND r.kind='skipped' AND r.key='6')
 OR original_run IS DISTINCT FROM (SELECT jsonb_build_array(to_jsonb(r),r.ctid::TEXT) FROM public.student_import_runs r WHERE id=runid) THEN
   RAISE EXCEPTION 'Restored skipped receipt replay changed the row or run';
 END IF;
END;
$continue$;
COMMIT;
SELECT 'continued and replayed';
"""


def require_v61_snapshot(before, after):
    import copy
    normalized = copy.deepcopy(after)
    for table, columns in {'public.students': ['import_run_id', 'source_system', 'source_id'],
                           'public.guardians': ['import_run_id']}.items():
        for row in normalized[table]:
            require(all(column in row and row[column] is None for column in columns),
                    'V61 backfilled retained provenance or source identity')
            for column in columns:
                del row[column]
    rows = normalized['private.koaryu_release_v31_expectations']
    prior = before['private.koaryu_release_v31_expectations']
    require(len(rows) == len(prior) == 1
            and prior[0]['expectation_key'] == rows[0]['expectation_key'] == 'operational_contract_v31'
            and prior[0]['expected_sha256'] == '1513ff10defced0c619f85c7927259165f6c9eb7ef1400be076f567fd39c85b3'
            and rows[0]['expected_sha256'] == '3189e1eac13e9b18668ab2977b7a092a828265cd4e81529bb0ace18dce6a6afb', 'V61 expectation correction differs')
    rows[0]['expected_sha256'] = prior[0]['expected_sha256']
    return normalized == before


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
        "V60_OPERATIONAL_READINESS_SQL", "EXPECTED_V60_OPERATIONAL_READINESS",
        "V60_AUTOMATION_TABLE_STATE_SQL", "EXPECTED_V60_AUTOMATION_TABLE_STATE", "EXPECTED_V60_RESTORED_AUTOMATION_TABLE_STATE",
        "V61_OPERATIONAL_READINESS_SQL", "EXPECTED_V61_OPERATIONAL_READINESS",
        "V61_TABLES_STATE_SQL", "EXPECTED_V61_TABLES_STATE", "EXPECTED_V61_RESTORED_TABLES_STATE",
        "V61_FUNCTIONS_STATE_SQL", "EXPECTED_V61_FUNCTIONS_STATE",
    ]
    module = (root / "scripts/release-attestation/student-import-v61.mjs").as_uri()
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
        tables = json.loads(local.sql(database, "SELECT jsonb_agg(n.nspname||'.'||c.relname ORDER BY n.nspname,c.relname) "
            "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' "
            "AND n.nspname IN ('public','private','auth') AND c.oid<>coalesce(to_regclass('private.timezone_names'),0);"))
        fields = ["SELECT '" + table + "' AS name,(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::TEXT COLLATE \"C\"),'[]') FROM " + table + " t) AS rows" for table in tables]
        return json.loads(local.sql(database, "SET TIME ZONE 'UTC'; SELECT jsonb_object_agg(name,rows) FROM (" + " UNION ALL ".join(fields) + ") retained;"))

    def predecessor(database, restored=False):
        check(database, "V60_OPERATIONAL_READINESS_SQL", "EXPECTED_V60_OPERATIONAL_READINESS")
        check(database, "V60_AUTOMATION_TABLE_STATE_SQL", "EXPECTED_V60_RESTORED_AUTOMATION_TABLE_STATE" if restored else "EXPECTED_V60_AUTOMATION_TABLE_STATE")
        require(local.sql(database, "SELECT count(*)=155 AND max(version)='20261021093000' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V60 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v42()') IS NULL;") == "t",
                "Restore predecessor already contains V61 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 156 and list(hashes)[-2:] == [
        "20261021093000_missed_class_gap_guards_v60.sql", MIGRATION], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = Path(__file__).with_name("v57-restore-constraint-pairs.json").read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v61_source_{os.getpid()}"
    restored = f"koaryu_v61_restore_{os.getpid()}"
    canonical = f"koaryu_v61_canonical_{os.getpid()}"
    dump = temporary / f"v60-before-v61-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed.endswith('seeded'), 'V61 source fixture did not seed')
        require(any(row['id'] == '00000000-0000-4000-8000-000000006104' for row in before['public.students'])
                and before['public.guardians'] and before['public.student_guardians']
                and before['private.student_import_receipts'], 'V61 requires populated retained import rows')
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
            require(require_v61_snapshot(before, snapshot(database)), "Migration changed retained rows before continuation")
            checks = [
                ("V61_OPERATIONAL_READINESS_SQL", "EXPECTED_V61_OPERATIONAL_READINESS"),
                ("V61_TABLES_STATE_SQL", "EXPECTED_V61_RESTORED_TABLES_STATE" if is_restored else "EXPECTED_V61_TABLES_STATE"),
                ("V61_FUNCTIONS_STATE_SQL", "EXPECTED_V61_FUNCTIONS_STATE"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            require(local.sql(database, CONTINUATION_SQL) == 'continued and replayed', 'V61 continuation/replay failed')
            check(database, 'V60_OPERATIONAL_READINESS_SQL', 'EXPECTED_V60_OPERATIONAL_READINESS')
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
        (temporary / "v60-v61-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V61] PASS retained rows, canonical/restored readiness, identity guard, guardian reuse and skipped replay", flush=True)
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

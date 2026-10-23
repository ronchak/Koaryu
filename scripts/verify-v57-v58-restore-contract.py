#!/usr/bin/env python3
"""Prove V57 expired pilot history and legacy bootstrap rows survive V58 GA upgrade and logical restore with exact current authority."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20261013013243_live_billing_authority_repairs_v58.sql"
# Reuse the retained diagnostic-writer fixture, excluding its current-schema
# attestation block. The historical scope RPC remains unchanged in V58.
_pilot_contract = (Path(__file__).resolve().parents[1] / "supabase/verification/studio_live_billing_authorizations_contract.sql").read_text()
SEED_SQL = "BEGIN;\n" + _pilot_contract[_pilot_contract.index("DO $contract$"):].replace("ROLLBACK;", "COMMIT;") + r"""
DO $legacy$
DECLARE s UUID; b UUID;
BEGIN
    SELECT id INTO s FROM public.studios WHERE name='Schema V3 Accountless Connect';
    SELECT bootstrap_id INTO b FROM public.prepare_connect_onboarding_bootstrap_atomic(
        s,repeat('a',40),1,
        '{"business_name":"Legacy incomplete","contact_email":null,"business_entity_type":"company","refresh_url":"https://example.invalid/refresh","return_url":"https://example.invalid/return"}',
        repeat('c',64),repeat('b',64),'koaryu-connect-account-'||s||'-g1','koaryu-connect-onboarding-'||s||'-g1-'||repeat('b',24));
    IF b IS NULL THEN RAISE EXCEPTION 'Legacy source fixture failed'; END IF;
END;
$legacy$;
-- Expire retained pilot evidence without pretending to renew or delete it.
ALTER TABLE public.studio_live_billing_authorizations DISABLE TRIGGER bind_live_billing_authorization_checkpoint;
UPDATE public.studio_live_billing_authorizations SET granted_at=now()-INTERVAL '2 days',expires_at=now()-INTERVAL '1 day';
ALTER TABLE public.studio_live_billing_authorizations ENABLE TRIGGER bind_live_billing_authorization_checkpoint;
UPDATE public.stripe_live_billing_reconciliation_checkpoints SET verified_at=now()-INTERVAL '2 days',expires_at=now()-INTERVAL '1 day';
UPDATE public.stripe_live_billing_reconciliation_checkpoints_v3 SET verified_at=now()-INTERVAL '2 days',expires_at=now()-INTERVAL '1 day';
SELECT 'seeded';
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
        "V57_OPERATIONAL_READINESS_SQL", "EXPECTED_V57_OPERATIONAL_READINESS",
        "V57_CATALOG_STATE_SQL", "EXPECTED_V57_CATALOG_STATE", "EXPECTED_V57_RESTORED_CATALOG_STATE",
        "V58_OPERATIONAL_READINESS_SQL", "EXPECTED_V58_OPERATIONAL_READINESS",
        "V58_CATALOG_STATE_SQL", "EXPECTED_V58_CATALOG_STATE", "EXPECTED_V58_RESTORED_CATALOG_STATE",
        "V58_AUTOMATION_TABLE_STATE_SQL", "EXPECTED_V58_AUTOMATION_TABLE_STATE", "EXPECTED_V58_RESTORED_AUTOMATION_TABLE_STATE",
        "V58_AUTOMATION_FUNCTION_STATE_SQL", "EXPECTED_V58_AUTOMATION_FUNCTION_STATE",
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
        # Preserve every business row, including legacy grants/checkpoints and
        # bootstrap requests. Only the declared V31 attestation singleton changes.
        tables = json.loads(local.sql(database, "SELECT jsonb_agg(n.nspname||'.'||c.relname ORDER BY n.nspname,c.relname) "
            "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' "
            "AND n.nspname IN ('public','private','auth') "
            "AND c.oid<>'private.koaryu_release_v31_expectations'::regclass;"))
        fields = ["SELECT '" + table + "' AS name,(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::TEXT COLLATE \"C\"),'[]') FROM " + table + " t) AS rows" for table in tables]
        return json.loads(local.sql(database, "SET TIME ZONE 'UTC'; SELECT jsonb_object_agg(name,rows) FROM (" + " UNION ALL ".join(fields) + ") retained;"))

    def predecessor(database, restored=False):
        check(database, "V57_OPERATIONAL_READINESS_SQL", "EXPECTED_V57_OPERATIONAL_READINESS")
        check(database, "V57_CATALOG_STATE_SQL", "EXPECTED_V57_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V57_CATALOG_STATE")
        require(local.sql(database, "SELECT count(*)=152 AND max(version)='20261005105341' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V57 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v39()') IS NULL AND to_regprocedure('public.studio_live_billing_supported_operations_v58(uuid,text)') IS NULL;") == "t",
                "Restore predecessor already contains V58 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 156 and list(hashes)[-5:] == [
        "20261005105341_automation_workflow_graph_v57.sql", MIGRATION,
        "20261014083106_timezone_names_reference_v59.sql",
        "20261021093000_missed_class_gap_guards_v60.sql",
        "20261022190000_student_import_identity_guard_v61.sql"], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = Path(__file__).with_name("v57-restore-constraint-pairs.json").read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v58_source_{os.getpid()}"
    restored = f"koaryu_v58_restore_{os.getpid()}"
    canonical = f"koaryu_v58_canonical_{os.getpid()}"
    dump = temporary / f"v57-before-v58-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == "seeded", "V57 pilot history fixture did not seed")
        require(len(before["public.stripe_connect_onboarding_bootstraps"]) == 1
                and before["public.stripe_connect_onboarding_bootstraps"][0]["reconciliation_checkpoint_id"] is not None,
                "Restore requires an actual legacy incomplete bootstrap")
        require(len(before["public.studio_live_billing_authorizations"]) == 2
                and len(before["public.stripe_live_billing_reconciliation_checkpoints"]) == 2,
                "Restore requires retained expired grants and checkpoints")
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
                ("V58_OPERATIONAL_READINESS_SQL", "EXPECTED_V58_OPERATIONAL_READINESS"),
                ("V58_CATALOG_STATE_SQL", "EXPECTED_V58_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V58_CATALOG_STATE"),
                ("V58_AUTOMATION_TABLE_STATE_SQL", "EXPECTED_V58_RESTORED_AUTOMATION_TABLE_STATE" if is_restored else "EXPECTED_V58_AUTOMATION_TABLE_STATE"),
                ("V58_AUTOMATION_FUNCTION_STATE_SQL", "EXPECTED_V58_AUTOMATION_FUNCTION_STATE"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            require(local.sql(database, "SELECT expected_sha256 FROM private.koaryu_release_v31_expectations WHERE expectation_key='operational_contract_v31';")
                    == "af3435a9266c9b482f7933dfc6ff5a756ec71fcf9eb7f3cba481e816226e50cb",
                    "V58 did not install the exact declared attestation singleton")
            continued = local.sql(database, """
BEGIN;
DO $legacy$
DECLARE s UUID; ready_studio UUID; b public.stripe_connect_onboarding_bootstraps; result RECORD;
BEGIN
    SELECT id INTO ready_studio FROM public.studios WHERE name='Schema V3 Live Billing Contract';
    SELECT id INTO s FROM public.studios WHERE name='Schema V3 Accountless Connect';
    IF EXISTS(SELECT 1 FROM public.studio_live_billing_authorizations WHERE expires_at>now())
       OR EXISTS(SELECT 1 FROM public.stripe_live_billing_reconciliation_checkpoints WHERE expires_at>now()) THEN
        RAISE EXCEPTION 'Legacy fixture must contain only expired authority';
    END IF;
    PERFORM public.authorize_studio_live_billing_mutation_atomic(ready_studio,'connected_invoice.pay','connect_payments','acct_ContractReadyV3',repeat('e',40));
    IF NOT FOUND THEN RAISE EXCEPTION 'Expired pilot history blocked GA payments'; END IF;
    SELECT * INTO b FROM public.stripe_connect_onboarding_bootstraps WHERE studio_id=s;
    SELECT * INTO result FROM public.preflight_connect_onboarding_bootstrap_resume(s,repeat('a',40));
    IF result.eligible IS DISTINCT FROM false OR result.phase IS DISTINCT FROM 'support_required' THEN
        RAISE EXCEPTION 'Legacy incomplete request silently converted to GA'; END IF;
    PERFORM public.load_connect_onboarding_bootstrap_recovery_context(s,repeat('a',40));
    IF FOUND THEN RAISE EXCEPTION 'Legacy recovery context reopened'; END IF;
    PERFORM public.prepare_connect_onboarding_bootstrap_atomic(s,repeat('a',40),1,b.recovery_context,b.account_create_payload_sha256,b.initial_link_context_sha256,b.account_create_idempotency_key,b.initial_link_idempotency_key);
    IF FOUND THEN RAISE EXCEPTION 'Legacy request prepared under GA'; END IF;
    PERFORM public.authorize_connect_onboarding_bootstrap_account_create_v2(b.id,s,repeat('a',40),1,b.account_create_payload_sha256,b.account_create_idempotency_key);
    IF FOUND THEN RAISE EXCEPTION 'Legacy request authorized account creation'; END IF;
    BEGIN
        PERFORM public.bind_connect_onboarding_bootstrap_account_v2(b.id,s,repeat('a',40),1,'acct_LegacyUnexpected','company');
        RAISE EXCEPTION 'Legacy account binding accepted';
    EXCEPTION WHEN SQLSTATE 'P0B21' THEN NULL;
    END;
END;
$legacy$;
ROLLBACK;
SELECT 'continued';
""")
            require(continued == "continued" and snapshot(database) == before,
                    "V58 legacy recovery barriers or retained pilot audit history changed")
            result = local.sql(database, (root / "supabase/verification/live_billing_ga_contract.sql").read_text())
            require(snapshot(database) == before, "GA continuation changed retained source rows")
            outcomes[("restored_" if is_restored else "canonical_") + "ga_continuation"] = result
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
        (temporary / "v57-v58-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V58] PASS canonical/restored retained expired pilot history, legacy recovery denial, ungranted quiet studios and complete GA bootstrap continuation", flush=True)
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

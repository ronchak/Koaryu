#!/usr/bin/env python3
"""Prove V42 logical restore and V43 atomic external-payment/audit continuation without historical repair."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20260910093958_external_payment_command_ownership_v43.sql"
STUDIO = "43000000-0000-4000-8000-000000000001"
ACTOR = "43000000-0000-4000-8000-000000000002"
RETRY_ACTOR = "43000000-0000-4000-8000-000000000003"
PAYER = "43000000-0000-4000-8000-000000000004"
LEGACY = "43000000-0000-4000-8000-000000000005"
LEGACY_REQUEST_HASH = "6346248088a49ef4aa12f1442d2b8eb0a48cfa8e7c34966fcd3a58dac16f7d77"
NEW_REQUEST_HASH = "9fd38e75c5c0cb553c42ffd2bac77bb228fb214eade39ee3493e2409502c6f81"
TABLES = ("auth.users", "public.staff_profiles", "public.studios", "public.staff_roles",
          "public.billing_payers", "public.billing_invoices", "public.billing_payments", "public.audit_logs")
SEED_SQL = f"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('{ACTOR}','authenticated','authenticated','external-owner@example.invalid','{{}}','{{}}',now(),now()),
      ('{RETRY_ACTOR}','authenticated','authenticated','external-retry@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES('{STUDIO}','External payment restore','external-payment-restore','{ACTOR}');
INSERT INTO public.staff_roles(studio_id,user_id,role)
VALUES('{STUDIO}','{ACTOR}','admin'),('{STUDIO}','{RETRY_ACTOR}','front_desk');
INSERT INTO public.billing_payers(id,studio_id,display_name,balance_cents,billing_status)
VALUES('{PAYER}','{STUDIO}','Retained payer',777,'past_due');
INSERT INTO public.billing_invoices(studio_id,payer_id,status,amount_due_cents,amount_remaining_cents,currency,external)
VALUES('{STUDIO}','{PAYER}','open',1000,1000,'usd',true);
INSERT INTO public.billing_payments(id,studio_id,payer_id,status,amount_cents,currency,payment_method_type,
 external_method,note,idempotency_key,request_hash,processed_at,net_collected_amount_cents,refundable_amount_cents)
VALUES('{LEGACY}','{STUDIO}','{PAYER}','externally_recorded',500,'eur','external','cash','Legacy note',
 'legacy-external','{LEGACY_REQUEST_HASH}','2026-09-01T00:00:00Z',500,0);
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
        "V42_OPERATIONAL_READINESS_SQL", "EXPECTED_V42_OPERATIONAL_READINESS",
        "V42_CATALOG_STATE_SQL", "EXPECTED_V42_CATALOG_STATE", "EXPECTED_V42_RESTORED_CATALOG_STATE",
        "V42_RELEASE_MANIFEST_SQL", "EXPECTED_V42_RELEASE_MANIFEST",
        "V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE",
        "V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE",
        "V43_OPERATIONAL_READINESS_SQL", "EXPECTED_V43_OPERATIONAL_READINESS",
        "V41_OPERATIONAL_READINESS_SQL", "EXPECTED_V41_OPERATIONAL_READINESS",
        "V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS",
        "V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS",
        "V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS",
        "V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS",
        "V43_RELEASE_MANIFEST_SQL", "EXPECTED_V43_RELEASE_MANIFEST",
        "V43_EXTERNAL_PAYMENT_STATE_SQL", "EXPECTED_V43_EXTERNAL_PAYMENT_STATE",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V42_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V42_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V42_OPERATIONAL_CONTRACT_V31",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V42_OPERATIONAL_MANIFEST_V12",
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
        fields = [f"'{table}',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)->>'id',"
                  f"to_jsonb(t)::TEXT COLLATE \"C\"),'[]'::JSONB) FROM {table} t)" for table in TABLES]
        return json.loads(local.sql(database, "SET TIME ZONE 'UTC'; SELECT jsonb_build_object(" + ",".join(fields) + ");"))

    def semantics(database):
        return {signature: local.sql(database, f"SELECT {signature};") for signature in ["private.koaryu_release_critical_surface_manifest_v16()","private.koaryu_release_critical_surface_manifest_v17()","private.koaryu_release_critical_surface_manifest_v18()","private.koaryu_release_operational_manifest_v10()","private.koaryu_release_operational_manifest_v11()","private.koaryu_release_student_rank_writer_manifest_v11()","private.koaryu_release_student_rank_writer_manifest_v13()","private.koaryu_release_resource_ownership_manifest_v31()","private.koaryu_release_operational_contract_v31()","private.koaryu_release_operational_manifest_v12()"]}

    def predecessor(database, restored=False):
        check(database, "V42_OPERATIONAL_READINESS_SQL", "EXPECTED_V42_OPERATIONAL_READINESS")
        check(database, "V42_CATALOG_STATE_SQL", "EXPECTED_V42_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V42_CATALOG_STATE")
        check(database, "V42_RELEASE_MANIFEST_SQL", "EXPECTED_V42_RELEASE_MANIFEST")
        check(database, "V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE")
        check(database, "V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE")
        require(local.sql(database, "SELECT count(*)=137 AND max(version)='20260910084231' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V42 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v24()') IS NULL AND to_regprocedure('public.record_external_payment_v1(uuid,uuid,uuid,integer,text,text,text,text,text)') IS NULL;") == "t",
                "Restore predecessor already contains V43 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 140 and list(hashes)[-4:] == [
        "20260910084231_independent_program_joining_dates_v42.sql", MIGRATION,
        "20260910135133_local_plan_write_ownership_v44.sql",
        "20260910185031_student_import_retry_ownership_v45.sql"], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v43_source_{os.getpid()}"
    restored = f"koaryu_v43_restore_{os.getpid()}"
    canonical = f"koaryu_v43_canonical_{os.getpid()}"
    dump = temporary / f"v42-before-v43-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == "seeded" and len(before["public.billing_payments"]) == 1
                and before["public.billing_payments"][0]["currency"] == "eur"
                and before["public.billing_payers"][0]["balance_cents"] == 777
                and len(before["public.billing_invoices"]) == 1 and not before["public.audit_logs"],
                "External-payment restore fixture is incomplete")
        predecessor(source)
        expected_semantics = semantics(source)
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
                ("V43_OPERATIONAL_READINESS_SQL", "EXPECTED_V43_OPERATIONAL_READINESS"),
                ("V42_OPERATIONAL_READINESS_SQL", "EXPECTED_V42_OPERATIONAL_READINESS"),
                ("V41_OPERATIONAL_READINESS_SQL", "EXPECTED_V41_OPERATIONAL_READINESS"),
                ("V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS"),
                ("V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS"),
                ("V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS"),
                ("V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS"),
                ("V42_CATALOG_STATE_SQL", "EXPECTED_V42_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V42_CATALOG_STATE"),
                ("V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE"),
                ("V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE"),
                ("V43_RELEASE_MANIFEST_SQL", "EXPECTED_V43_RELEASE_MANIFEST"),
                ("V43_EXTERNAL_PAYMENT_STATE_SQL", "EXPECTED_V43_EXTERNAL_PAYMENT_STATE"),
                ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V42_EXPECTATION_STATE"),
                ("V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V42_RESOURCE_OWNERSHIP_MANIFEST"),
                ("V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V42_OPERATIONAL_CONTRACT_V31"),
                ("V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V42_OPERATIONAL_MANIFEST_V12"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            require(semantics(database) == expected_semantics, "Upgrade or continuation changed declared semantic manifests")
            def record(actor, key, amount, currency, note, request_hash):
                note = note.replace("'", "''")
                return json.loads(local.sql(database, f"""
                    BEGIN; SET LOCAL ROLE service_role;
                    SELECT public.record_external_payment_v1('{STUDIO}','{actor}','{PAYER}',{amount},'{currency}',
                        'cash','{note}','{key}','{request_hash}');
                    COMMIT;
                """))
            legacy = record(RETRY_ACTOR, "legacy-external", 500, "eur", "Legacy note", LEGACY_REQUEST_HASH)
            require(legacy["id"] == LEGACY and snapshot(database) == before,
                    "Legacy replay changed confirmed facts or fabricated a historical audit")
            payment = record(ACTOR, "restored-external-command", 750, "usd", "Original note", NEW_REQUEST_HASH)
            after = snapshot(database)
            require(record(RETRY_ACTOR, "restored-external-command", 750, "usd", "Original note", NEW_REQUEST_HASH) == payment
                    and snapshot(database) == after, "New payment replay changed its record or audit")
            require(len(after["public.billing_payments"]) == 2 and len(after["public.audit_logs"]) == 1,
                    "Expected exactly one new payment and audit")
            require(next(row for row in after["public.billing_payments"] if row["id"] == LEGACY)
                    == before["public.billing_payments"][0], "New recording changed a legacy payment")
            audit = after["public.audit_logs"][0]
            require(audit["actor_id"] == ACTOR and audit["studio_id"] == STUDIO and audit["entity_id"] == payment["id"]
                    and audit["action"] == "billing.external_payment_recorded" and audit["entity_type"] == "billing"
                    and audit["metadata"] == {"amount_cents": 750, "external_method": "cash"}, "Original audit identity changed")
            for table in TABLES:
                if table not in ("public.billing_payments", "public.audit_logs"):
                    require(after[table] == before[table], f"Payment recording changed unrelated {table}")
            local.sql(database, f"SET ROLE service_role; SELECT public.recompute_billing_payer_balance_v1('{STUDIO}','{PAYER}');")
            repaired = snapshot(database)
            require(repaired["public.billing_payers"][0]["balance_cents"] == 1000,
                    "Payer balance completion changed the existing invoice-based formula")
            require(record(RETRY_ACTOR, "restored-external-command", 750, "usd", "Original note", NEW_REQUEST_HASH) == payment
                    and snapshot(database) == repaired, "Completed replay rewrote payment, audit or balance")
            require({query: check(database, query, expected) for query, expected in checks} == values,
                    "Continuation changed the attested state")
            require(semantics(database) == expected_semantics, "Upgrade or continuation changed declared semantic manifests")
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
            "tools": versions, "queries": pinned, "outcomes": outcomes, "semantics": expected_semantics,
            "business_before_sha256": hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
            "constraint_pairs": len(pairs), "billing_replays": 6, "acl_representations": len(statements) - 6,
        }
        (temporary / "v42-v43-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V43] PASS actual V42 backup/restore, exact normalization, no historical repair, "
              "original-actor payment/audit ownership, legacy replay and balance continuation on canonical/restored copies", flush=True)
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

#!/usr/bin/env python3
"""Prove V43 restore and V44 local-plan transaction/no-op continuation without historical backfill."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20260910135133_local_plan_write_ownership_v44.sql"
STUDIO = "44000000-0000-4000-8000-000000000001"
ACTOR = "44000000-0000-4000-8000-000000000002"
PROGRAM = "44000000-0000-4000-8000-000000000003"
PLAN = "44000000-0000-4000-8000-000000000004"
LEGACY_PLAN = "44000000-0000-4000-8000-000000000005"
CLEAR_STUDIO = "44000000-0000-4000-8000-000000000006"
CLEAR_PROGRAM = "44000000-0000-4000-8000-000000000007"
CLEAR_ACTOR = "44000000-0000-4000-8000-000000000008"
TABLES = ("auth.users", "public.staff_profiles", "public.studios", "public.staff_roles",
          "public.programs", "public.billing_plans", "public.billing_plan_programs",
          "public.billing_plan_prices", "public.studio_payment_accounts", "public.audit_logs",
          "public.billing_payers", "public.billing_invoices", "public.billing_payments")
SEED_SQL = f"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('{ACTOR}','authenticated','authenticated','plan-restore@example.invalid','{{}}','{{}}',now(),now()),
      ('{CLEAR_ACTOR}','authenticated','authenticated','clear-restore@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES('{STUDIO}','Local plan restore','local-plan-restore','{ACTOR}'),
      ('{CLEAR_STUDIO}','Local clear restore','local-clear-restore','{CLEAR_ACTOR}');
INSERT INTO public.staff_roles(studio_id,user_id,role)
VALUES('{STUDIO}','{ACTOR}','admin'),('{CLEAR_STUDIO}','{CLEAR_ACTOR}','admin');
INSERT INTO public.programs(id,studio_id,name,color_hex,sort_order)
VALUES('{PROGRAM}','{STUDIO}','Karate','#123456',0),('{CLEAR_PROGRAM}','{CLEAR_STUDIO}','Demo karate','#abcdef',0);
INSERT INTO public.billing_plans(id,studio_id,name,description,amount_cents,currency,status,
 stripe_account_id,stripe_product_id,stripe_price_id,stripe_price_version,metadata,updated_at)
VALUES('{PLAN}','{STUDIO}','Active USD','Keep description',1000,'usd','active',
 'acct_restore','prod_restore','price_restore',3,'{{"keep":"provider facts"}}','2000-01-01T00:00:00Z'),
 ('{LEGACY_PLAN}','{STUDIO}','Legacy EUR','Historical facts',500,'EUR','active',
 'acct_restore','prod_legacy','price_legacy',1,'{{}}','2000-01-01T00:00:00Z');
INSERT INTO public.billing_plan_programs(studio_id,billing_plan_id,program_id)
VALUES('{STUDIO}','{PLAN}','{PROGRAM}');
INSERT INTO public.billing_plan_prices(studio_id,billing_plan_id,stripe_account_id,stripe_product_id,
 stripe_price_id,amount_cents,currency,billing_interval,version)
VALUES('{STUDIO}','{PLAN}','acct_restore','prod_restore','price_restore',1000,'usd','monthly',3);
INSERT INTO public.studio_payment_accounts(studio_id) VALUES('{CLEAR_STUDIO}');
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
        "FINAL_OPERATIONAL_READINESS_SQL", "EXPECTED_OPERATIONAL_READINESS",
        "V44_RELEASE_MANIFEST_SQL", "EXPECTED_V44_RELEASE_MANIFEST",
        "V44_LOCAL_PLAN_STATE_SQL", "EXPECTED_V44_LOCAL_PLAN_STATE",
        "V44_CLEAR_STATE_SQL", "EXPECTED_V44_CLEAR_STATE",
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
        check(database, "V43_OPERATIONAL_READINESS_SQL", "EXPECTED_V43_OPERATIONAL_READINESS")
        check(database, "V42_CATALOG_STATE_SQL", "EXPECTED_V42_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V42_CATALOG_STATE")
        check(database, "V43_RELEASE_MANIFEST_SQL", "EXPECTED_V43_RELEASE_MANIFEST")
        check(database, "V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE")
        check(database, "V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE")
        check(database, "V43_EXTERNAL_PAYMENT_STATE_SQL", "EXPECTED_V43_EXTERNAL_PAYMENT_STATE")
        require(local.sql(database, "SELECT count(*)=138 AND max(version)='20260910093958' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V43 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v25()') IS NULL AND to_regprocedure('public.write_billing_plan_v1(uuid,uuid,uuid,jsonb,uuid[])') IS NULL;") == "t",
                "Restore predecessor already contains V44 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 139 and list(hashes)[-2:] == [
        "20260910093958_external_payment_command_ownership_v43.sql", MIGRATION], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v44_source_{os.getpid()}"
    restored = f"koaryu_v44_restore_{os.getpid()}"
    canonical = f"koaryu_v44_canonical_{os.getpid()}"
    dump = temporary / f"v43-before-v44-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == "seeded" and len(before["public.billing_plans"]) == 2
                and len(before["public.billing_plan_programs"]) == 1
                and len(before["public.billing_plan_prices"]) == 1
                and len(before["public.studio_payment_accounts"]) == 1
                and not before["public.audit_logs"], "Local-plan restore fixture is incomplete")
        require(next(row for row in before["public.billing_plans"] if row["id"] == LEGACY_PLAN)["currency"] == "EUR",
                "Restore must retain a confirmed non-USD definition")
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
                ("FINAL_OPERATIONAL_READINESS_SQL", "EXPECTED_OPERATIONAL_READINESS"),
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
                ("V43_EXTERNAL_PAYMENT_STATE_SQL", "EXPECTED_V43_EXTERNAL_PAYMENT_STATE"),
                ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V42_EXPECTATION_STATE"),
                ("V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V42_RESOURCE_OWNERSHIP_MANIFEST"),
                ("V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V42_OPERATIONAL_CONTRACT_V31"),
                ("V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V42_OPERATIONAL_MANIFEST_V12"),
                ("V44_RELEASE_MANIFEST_SQL", "EXPECTED_V44_RELEASE_MANIFEST"),
                ("V44_LOCAL_PLAN_STATE_SQL", "EXPECTED_V44_LOCAL_PLAN_STATE"),
                ("V44_CLEAR_STATE_SQL", "EXPECTED_V44_CLEAR_STATE"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            require(semantics(database) == expected_semantics, "Upgrade or continuation changed declared semantic manifests")
            def write_plan(studio, plan_id, patch, program_ids=None, actor=ACTOR):
                values = json.dumps(patch).replace("'", "''")
                plan_arg = "NULL" if plan_id is None else f"'{plan_id}'::UUID"
                programs_arg = "NULL" if program_ids is None else "ARRAY[" + ",".join(f"'{item}'::UUID" for item in program_ids) + "]::UUID[]"
                return json.loads(local.sql(database, f"SET TIME ZONE 'UTC'; SET ROLE service_role; SELECT public.write_billing_plan_v1('{studio}','{actor}',{plan_arg},'{values}'::JSONB,{programs_arg});"))
            current = next(row for row in before["public.billing_plans"] if row["id"] == PLAN)
            legacy = next(row for row in before["public.billing_plans"] if row["id"] == LEGACY_PLAN)
            require(write_plan(STUDIO, PLAN, {"name": "Active USD", "currency": "USD"}, [PROGRAM, PROGRAM])["plan"] == current
                    and write_plan(STUDIO, LEGACY_PLAN, {"currency": "eur"})["plan"] == legacy
                    and snapshot(database) == before, "No-op changed original plan, links, audit or historical currency")
            created = write_plan(STUDIO, None, {"name": "New USD", "amount_cents": 750}, [PROGRAM, PROGRAM])
            require(created["plan"]["currency"] == "usd" and created["plan"]["status"] == "pending"
                    and created["programs"] == [{"program_id": PROGRAM, "program_name": "Karate", "program_color_hex": "#123456"}],
                    "New plan/defaults/committed program snapshot mismatch")
            changed = write_plan(STUDIO, PLAN, {"amount_cents": 1250, "description": None}, [])
            require(changed["plan"]["status"] == "pending" and changed["plan"]["description"] is None
                    and changed["plan"]["stripe_price_id"] == "price_restore" and changed["programs"] == [],
                    "Real plan patch did not preserve provider identity or explicit clearing")
            after = snapshot(database)
            require(write_plan(STUDIO, PLAN, {"amount_cents": 1250, "description": None}, [])["plan"] == changed["plan"]
                    and snapshot(database) == after, "Repeated patch wrote another audit or changed the committed result")
            require(next(row for row in after["public.billing_plans"] if row["id"] == LEGACY_PLAN) == legacy
                    and after["public.billing_plan_prices"] == before["public.billing_plan_prices"],
                    "Local plan writes changed historical financial/provider facts")
            audits = after["public.audit_logs"]
            require(len(audits) == 2 and all(row["actor_id"] == ACTOR and row["studio_id"] == STUDIO
                    and row["entity_type"] == "billing" for row in audits)
                    and {row["action"] for row in audits} == {"billing.plan_created", "billing.plan_updated"},
                    "Expected one original-actor audit per actual local command")
            for table in TABLES:
                if table not in ("public.billing_plans", "public.billing_plan_programs", "public.audit_logs"):
                    require(after[table] == before[table], f"Local plan command changed unrelated {table}")
            # Database-first compatibility permits the old caller's direct writes.
            # Each local.sql call is a distinct request; this does not claim old callers became atomic.
            local.sql(database, f"SET ROLE service_role; UPDATE public.billing_plans SET description='Legacy caller note',status='pending' WHERE id='{PLAN}' AND studio_id='{STUDIO}';")
            local.sql(database, f"SET ROLE service_role; INSERT INTO public.billing_plan_programs(studio_id,billing_plan_id,program_id) VALUES('{STUDIO}','{PLAN}','{PROGRAM}');")
            old_result = write_plan(STUDIO, PLAN, {"description": "Legacy caller note"}, [PROGRAM])
            require(old_result["plan"]["description"] == "Legacy caller note" and len(old_result["programs"]) == 1
                    and len(snapshot(database)["public.audit_logs"]) == 2, "Old caller compatibility or new no-op continuation failed")
            before_clear = snapshot(database)
            demo_plan = write_plan(CLEAR_STUDIO, None, {"name": "Clear me", "amount_cents": 0}, [CLEAR_PROGRAM], actor=CLEAR_ACTOR)
            # Do not upgrade the shared advisory lock inside the same transaction.
            local.sql(database, f"SET ROLE service_role; SELECT public.clear_studio_operational_data_atomic('{CLEAR_STUDIO}',FALSE);")
            cleared = snapshot(database)
            require(not any(row["studio_id"] == CLEAR_STUDIO for row in cleared["public.billing_plans"])
                    and not any(row["studio_id"] == CLEAR_STUDIO for row in cleared["public.billing_plan_programs"])
                    and not any(row["studio_id"] == CLEAR_STUDIO for row in cleared["public.programs"])
                    and cleared["public.studio_payment_accounts"] == before_clear["public.studio_payment_accounts"],
                    "Clear companion changed target selection or platform-row preservation")
            require([row for row in cleared["public.billing_plans"] if row["studio_id"] == STUDIO]
                    == before_clear["public.billing_plans"]
                    and any(row["entity_id"] == demo_plan["plan"]["id"] and row["actor_id"] == CLEAR_ACTOR and row["studio_id"] == CLEAR_STUDIO for row in cleared["public.audit_logs"]),
                    "Clear changed another studio or removed the existing audit-retention behavior")
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
        (temporary / "v43-v44-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V44] PASS actual V43 backup/restore, no historical backfill, "
              "local plan/audit ownership, no-op preservation, old/new callers and guarded clear on canonical/restored copies", flush=True)
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

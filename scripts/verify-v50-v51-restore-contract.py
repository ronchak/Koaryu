#!/usr/bin/env python3
"""Prove retained invoice closeout claims survive V50 restore and replay after the lock-order repair without rewriting rows."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20260925030000_invoice_closeout_lock_order_v51.sql"
TABLES = ("auth.users", "public.studios", "public.staff_roles", "public.studio_payment_accounts",
          "public.billing_payers", "public.billing_invoices", "public.billing_invoice_mutation_owners",
          "public.billing_provider_operations", "public.billing_provider_operation_resources",
          "public.billing_provider_operation_resource_aliases")
SEED_SQL = """
BEGIN;
DO $seed$
DECLARE actor UUID := gen_random_uuid(); studio UUID := gen_random_uuid(); payer UUID := gen_random_uuid();
    finalized UUID := gen_random_uuid(); voiding UUID := gen_random_uuid(); claim JSONB;
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(actor,'authenticated','authenticated',actor||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Closeout restore',studio::TEXT,actor);
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,metadata)
    VALUES(studio,'acct_v51restore',jsonb_build_object('connect_account_generation',1));
    INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation)
    VALUES(payer,studio,'Closeout payer','acct_v51restore','cus_v51restore',1);
    INSERT INTO public.billing_invoices(id,studio_id,payer_id,invoice_type,status,amount_due_cents,amount_paid_cents,
        amount_remaining_cents,currency,stripe_invoice_id,stripe_account_id,stripe_customer_id,collection_method,metadata) VALUES
        (finalized,studio,payer,'manual','draft',500,0,500,'usd','in_'||replace(finalized::TEXT,'-',''),
         'acct_v51restore','cus_v51restore','send_invoice',jsonb_build_object('connect_account_generation',1)),
        (voiding,studio,payer,'manual','open',700,0,700,'usd','in_'||replace(voiding::TEXT,'-',''),
         'acct_v51restore','cus_v51restore','send_invoice',jsonb_build_object('connect_account_generation',1));
    claim := public.claim_billing_invoice_closeout_operation_v1(studio,actor,'invoice.finalize','invoice_finalize',
        finalized,payer,'restore-finalize',repeat('e',64),'acct_v51restore',1,gen_random_uuid(),30);
    UPDATE public.billing_provider_operations SET state='completed',provider_request_attempt_count=1,
        provider_object_id='in_'||replace(finalized::TEXT,'-',''),provider_succeeded_at=clock_timestamp(),
        projected_at=clock_timestamp(),completed_at=clock_timestamp(),result_code='invoice_closeout_completed',
        lease_owner=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,revision=revision+1
    WHERE id=(claim->'operation'->>'id')::UUID;
    UPDATE public.billing_invoices SET status='open' WHERE id=finalized;
    PERFORM public.claim_billing_invoice_closeout_operation_v1(studio,actor,'invoice.void','invoice_void',
        voiding,payer,'restore-void',repeat('f',64),'acct_v51restore',1,gen_random_uuid(),30);
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
        "V50_OPERATIONAL_READINESS_SQL", "EXPECTED_V50_OPERATIONAL_READINESS",
        "V50_CATALOG_STATE_SQL", "EXPECTED_V50_CATALOG_STATE", "EXPECTED_V50_RESTORED_CATALOG_STATE",
        "V50_RELEASE_MANIFEST_SQL", "EXPECTED_V50_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V50_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V50_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V50_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V50_OPERATIONAL_MANIFEST_V12",
        "V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V50_PAYER_BALANCE_STATE",
        "V51_CLOSEOUT_STATE_SQL", "EXPECTED_V50_CLOSEOUT_STATE",
        "FINAL_OPERATIONAL_READINESS_SQL", "EXPECTED_OPERATIONAL_READINESS",
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
        "V51_CATALOG_STATE_SQL", "EXPECTED_V51_CATALOG_STATE", "EXPECTED_V51_RESTORED_CATALOG_STATE",
        "V51_RELEASE_MANIFEST_SQL", "EXPECTED_V51_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V51_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V51_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V51_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V51_OPERATIONAL_MANIFEST_V12",
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
        "CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V50_CRITICAL_SURFACE_MANIFEST",
        "V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V50_OPERATIONAL_MANIFEST_V10",
        "V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V51_OPERATIONAL_MANIFEST_V11",
        "V30_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V51_V30_OPERATIONAL_CONTRACT",
        "V30_REPLAY_REPAIRS_MANIFEST_SQL", "EXPECTED_V51_V30_REPLAY_REPAIRS_MANIFEST",
        "V51_CLOSEOUT_STATE_SQL", "EXPECTED_V51_CLOSEOUT_STATE",
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

    def semantics(database):
        return {signature: local.sql(database, f"SELECT {signature};") for signature in ["private.koaryu_release_critical_surface_manifest_v16()","private.koaryu_release_critical_surface_manifest_v17()"]}

    def predecessor(database, restored=False):
        check(database, "V50_OPERATIONAL_READINESS_SQL", "EXPECTED_V50_OPERATIONAL_READINESS")
        check(database, "V50_CATALOG_STATE_SQL", "EXPECTED_V50_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V50_CATALOG_STATE")
        check(database, "V50_RELEASE_MANIFEST_SQL", "EXPECTED_V50_RELEASE_MANIFEST")
        check(database, "V31_EXPECTATION_STATE_SQL", "EXPECTED_V50_EXPECTATION_STATE")
        check(database, "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V50_RESOURCE_OWNERSHIP_MANIFEST")
        check(database, "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V50_OPERATIONAL_CONTRACT")
        check(database, "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V50_OPERATIONAL_MANIFEST_V12")
        check(database, "V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V50_PAYER_BALANCE_STATE")
        check(database, "V51_CLOSEOUT_STATE_SQL", "EXPECTED_V50_CLOSEOUT_STATE")
        require(local.sql(database, "SELECT count(*)=145 AND max(version)='20260920154441' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V50 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v32()') IS NULL;") == "t",
                "Restore predecessor already contains V51 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 146 and list(hashes)[-2:] == [
        "20260920154441_billing_due_date_facts_v50.sql", MIGRATION], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v51_source_{os.getpid()}"
    restored = f"koaryu_v51_restore_{os.getpid()}"
    canonical = f"koaryu_v51_canonical_{os.getpid()}"
    dump = temporary / f"v50-before-v51-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == "seeded"
                and sorted(row["state"] for row in before["public.billing_provider_operations"]) == ["completed", "started"]
                and len(before["public.billing_provider_operation_resource_aliases"]) == 2
                and len(before["public.billing_invoice_mutation_owners"]) == 2,
                "Terminal and nonterminal closeout claim fixture is incomplete")
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
                ("V51_CATALOG_STATE_SQL", "EXPECTED_V51_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V51_CATALOG_STATE"),
                ("V51_RELEASE_MANIFEST_SQL", "EXPECTED_V51_RELEASE_MANIFEST"),
                ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V51_EXPECTATION_STATE"),
                ("V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V51_RESOURCE_OWNERSHIP_MANIFEST"),
                ("V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V51_OPERATIONAL_CONTRACT"),
                ("V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V51_OPERATIONAL_MANIFEST_V12"),
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
                ("CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V50_CRITICAL_SURFACE_MANIFEST"),
                ("V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V50_OPERATIONAL_MANIFEST_V10"),
                ("V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V51_OPERATIONAL_MANIFEST_V11"),
                ("V30_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V51_V30_OPERATIONAL_CONTRACT"),
                ("V30_REPLAY_REPAIRS_MANIFEST_SQL", "EXPECTED_V51_V30_REPLAY_REPAIRS_MANIFEST"),
                ("V51_CLOSEOUT_STATE_SQL", "EXPECTED_V51_CLOSEOUT_STATE"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            require(semantics(database) == expected_semantics, "Upgrade or continuation changed declared semantic manifests")
            # Retained terminal and in-flight closeout claims keep replaying their original operation.
            studio = before["public.studios"][0]["id"]
            actor = before["public.staff_roles"][0]["user_id"]
            payer = before["public.billing_payers"][0]["id"]
            operations = {row["operation_type"]: row for row in before["public.billing_provider_operations"]}
            for kind, resource_type, key, digest in [("invoice.finalize", "invoice_finalize", "restore-finalize", "e" * 64),
                                                     ("invoice.void", "invoice_void", "restore-void", "f" * 64)]:
                operation = operations[kind]
                invoice = next(row["resource_id"] for row in before["public.billing_provider_operation_resources"]
                               if row["operation_id"] == operation["id"])
                replay = json.loads(local.sql(database,
                    "BEGIN; SELECT public.claim_billing_invoice_closeout_operation_v1("
                    f"'{studio}','{actor}','{kind}','{resource_type}','{invoice}','{payer}','{key}','{digest}',"
                    "'acct_v51restore',1,gen_random_uuid(),30); ROLLBACK;"))
                require(replay["outcome"] == "replay" and replay["operation"]["id"] == operation["id"],
                        f"Retained {kind} closeout claim did not replay after the upgrade")
                outcomes[("restored_" if is_restored else "canonical_") + kind] = replay["outcome"]
            require(snapshot(database) == before, "Closeout replay rewrote retained claims")
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
        (temporary / "v50-v51-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V51] PASS retained closeout claims, legacy caller readiness and lock-ordered replay on canonical/restored copies", flush=True)
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

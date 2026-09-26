#!/usr/bin/env python3
"""Prove V45 refund receipts survive restore and complete after their own verified projection."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20260914033337_refund_projection_recovery_v46.sql"
TABLES = ("auth.users", "public.staff_profiles", "public.studios", "public.staff_roles",
          "public.studio_payment_accounts", "public.billing_payers", "public.billing_payments",
          "public.billing_refunds", "public.billing_provider_operations",
          "public.billing_provider_operation_resources", "public.billing_provider_operation_resource_aliases",
          "public.students", "public.billing_invoices", "public.audit_logs")
SEED_SQL = """
BEGIN;
DO $proof$
DECLARE
  actor UUID:=gen_random_uuid(); studio UUID:=gen_random_uuid(); payer UUID:=gen_random_uuid();
  payment UUID:=gen_random_uuid(); lease UUID:=gen_random_uuid(); operation JSONB; claim JSONB; state TEXT;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(actor,'authenticated','authenticated',actor||'@example.invalid','{}','{}',now(),now());
  INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Refund recovery',studio::TEXT,actor);
  INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
  INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,charges_enabled,payouts_enabled,metadata)
  VALUES(studio,'acct_refundproof',true,true,'{"connect_account_generation":1}');
  INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation)
  VALUES(payer,studio,'Refund payer','acct_refundproof','cus_refundproof',1);
  INSERT INTO public.billing_payments(id,studio_id,payer_id,stripe_customer_id,stripe_payment_intent_id,stripe_charge_id,
    stripe_account_id,connect_account_generation,status,amount_cents,currency,net_collected_amount_cents,refundable_amount_cents,processed_at)
  VALUES(payment,studio,payer,'cus_refundproof','pi_refundproof','ch_refundproof','acct_refundproof',1,'succeeded',1000,'usd',1000,1000,now());
  claim:=public.claim_billing_provider_operation_resource_v1(studio,actor,'payment.refund','payment',payment,payer,
    'refund-proof',repeat('a',64),'acct_refundproof',1,lease,30);
  operation:=claim->'operation';
  FOREACH state IN ARRAY ARRAY['provider_request_in_flight','provider_succeeded','projected'] LOOP
    IF state='projected' THEN
      INSERT INTO public.billing_refunds(studio_id,payment_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
        stripe_account_id,connect_account_generation,amount_cents,status)
      VALUES(studio,payment,'re_refundproof','ch_refundproof','pi_refundproof','acct_refundproof',1,500,'succeeded');
    END IF;
    operation:=public.transition_billing_provider_operation_v1((operation->>'id')::UUID,studio,actor,'payment.refund',
      'refund-proof',repeat('a',64),'acct_refundproof',1,lease,(operation->>'revision')::BIGINT,state,
      p_provider_object_id=>CASE WHEN state<>'provider_request_in_flight' THEN 're_refundproof' END,
      p_result_code=>CASE state WHEN 'provider_request_in_flight' THEN 'payment_refund_started'
        WHEN 'provider_succeeded' THEN 'payment_refund_status_succeeded' ELSE 'payment_refund_projected' END,
      p_result_summary=>'amount_cents:500')->'operation';
  END LOOP;
  BEGIN
    PERFORM public.complete_billing_provider_operation_v1((operation->>'id')::UUID,studio,actor,'payment.refund',
      'refund-proof',repeat('a',64),'acct_refundproof',1,lease,(operation->>'revision')::BIGINT,'payment_refund_completed');
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='injected_before_commit';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM<>'injected_before_commit' THEN RAISE; END IF;
  END;
  IF (SELECT refunded_amount_cents FROM public.billing_payments WHERE id=payment) IS DISTINCT FROM 500
     OR (SELECT billing_provider_operations.state FROM public.billing_provider_operations WHERE id=(operation->>'id')::UUID) IS DISTINCT FROM 'projected' THEN
    RAISE EXCEPTION 'Completion failure did not preserve the projected refund.';
  END IF;
END;
$proof$;
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
        "V45_OPERATIONAL_READINESS_SQL", "EXPECTED_V45_OPERATIONAL_READINESS",
        "V45_CATALOG_STATE_SQL", "EXPECTED_V45_CATALOG_STATE", "EXPECTED_V45_RESTORED_CATALOG_STATE",
        "V45_RELEASE_MANIFEST_SQL", "EXPECTED_V45_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V45_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V45_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V45_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V45_OPERATIONAL_MANIFEST_V12",
        "V46_OPERATIONAL_READINESS_SQL", "EXPECTED_V46_OPERATIONAL_READINESS",
        "V44_OPERATIONAL_READINESS_SQL", "EXPECTED_V44_OPERATIONAL_READINESS",
        "V43_OPERATIONAL_READINESS_SQL", "EXPECTED_V43_OPERATIONAL_READINESS",
        "V42_OPERATIONAL_READINESS_SQL", "EXPECTED_V42_OPERATIONAL_READINESS",
        "V41_OPERATIONAL_READINESS_SQL", "EXPECTED_V41_OPERATIONAL_READINESS",
        "V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS",
        "V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS",
        "V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS",
        "V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS",
        "V46_CATALOG_STATE_SQL", "EXPECTED_V46_CATALOG_STATE", "EXPECTED_V46_RESTORED_CATALOG_STATE",
        "V46_RELEASE_MANIFEST_SQL", "EXPECTED_V46_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V46_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V46_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V46_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V46_OPERATIONAL_MANIFEST_V12",
        "V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE",
        "V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE",
        "V43_EXTERNAL_PAYMENT_STATE_SQL", "EXPECTED_V43_EXTERNAL_PAYMENT_STATE",
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
        fields = []
        for table in TABLES:
            value = "to_jsonb(t)"
            fields.append(f"'{table}',(SELECT COALESCE(jsonb_agg({value} ORDER BY to_jsonb(t)->>'id',"
                          f"to_jsonb(t)::TEXT COLLATE \"C\"),'[]'::JSONB) FROM {table} t)")
        return json.loads(local.sql(database, "SET TIME ZONE 'UTC'; SELECT jsonb_build_object(" + ",".join(fields) + ");"))
    contract_sources = {
        name: (root / "supabase" / "verification" / name).read_bytes()
        for name in ("refund_projection_recovery_contract.sql",)
    }

    def semantics(database):
        return {signature: local.sql(database, f"SELECT {signature};") for signature in ["private.koaryu_release_critical_surface_manifest_v16()","private.koaryu_release_critical_surface_manifest_v17()","private.koaryu_release_critical_surface_manifest_v18()","private.koaryu_release_operational_manifest_v10()","private.koaryu_release_operational_manifest_v11()"]}

    def predecessor(database, restored=False):
        check(database, "V45_OPERATIONAL_READINESS_SQL", "EXPECTED_V45_OPERATIONAL_READINESS")
        check(database, "V45_CATALOG_STATE_SQL", "EXPECTED_V45_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V45_CATALOG_STATE")
        check(database, "V45_RELEASE_MANIFEST_SQL", "EXPECTED_V45_RELEASE_MANIFEST")
        check(database, "V31_EXPECTATION_STATE_SQL", "EXPECTED_V45_EXPECTATION_STATE")
        check(database, "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V45_RESOURCE_OWNERSHIP_MANIFEST")
        check(database, "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V45_OPERATIONAL_CONTRACT")
        check(database, "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V45_OPERATIONAL_MANIFEST_V12")
        require(local.sql(database, "SELECT count(*)=140 AND max(version)='20260910185031' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V45 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v27()') IS NULL;") == "t",
                "Restore predecessor already contains V46 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 146 and list(hashes)[-7:] == [
        "20260910185031_student_import_retry_ownership_v45.sql", MIGRATION,
        "20260914055301_refund_completion_locking_v47.sql",
        "20260920035023_enrollment_activation_execution_v48.sql",
        "20260920052705_subscription_unknown_terms_v49.sql",
        "20260920154441_billing_due_date_facts_v50.sql",
        "20260925030000_invoice_closeout_lock_order_v51.sql"], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v46_source_{os.getpid()}"
    restored = f"koaryu_v46_restore_{os.getpid()}"
    canonical = f"koaryu_v46_canonical_{os.getpid()}"
    dump = temporary / f"v45-before-v46-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == "seeded" and len(before["public.billing_payments"]) == 1
                and before["public.billing_payments"][0]["refunded_amount_cents"] == 500
                and before["public.billing_provider_operations"][0]["state"] == "projected"
                and len(before["public.billing_refunds"]) == 1, "Refund restore seed is incomplete")
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
                ("V46_CATALOG_STATE_SQL", "EXPECTED_V46_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V46_CATALOG_STATE"),
                ("V46_RELEASE_MANIFEST_SQL", "EXPECTED_V46_RELEASE_MANIFEST"),
                ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V46_EXPECTATION_STATE"),
                ("V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V46_RESOURCE_OWNERSHIP_MANIFEST"),
                ("V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V46_OPERATIONAL_CONTRACT"),
                ("V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V46_OPERATIONAL_MANIFEST_V12"),
                ("V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE"),
                ("V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE"),
                ("V43_EXTERNAL_PAYMENT_STATE_SQL", "EXPECTED_V43_EXTERNAL_PAYMENT_STATE"),
                ("V44_LOCAL_PLAN_STATE_SQL", "EXPECTED_V44_LOCAL_PLAN_STATE"),
                ("V44_CLEAR_STATE_SQL", "EXPECTED_V44_CLEAR_STATE"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            require(semantics(database) == expected_semantics, "Upgrade or continuation changed declared semantic manifests")
            operation = before["public.billing_provider_operations"][0]
            payment = before["public.billing_payments"][0]
            claim = json.loads(local.sql(database, f"SET ROLE service_role; SELECT public.claim_billing_provider_operation_resource_v1('{operation['studio_id']}','{operation['actor_id']}','payment.refund','payment','{payment['id']}','{payment['payer_id']}','refund-proof','{operation['request_sha256']}','acct_refundproof',1,'{operation['lease_owner']}',30);"))
            require(claim["operation"]["id"] == operation["id"] and claim["operation"]["state"] == "projected",
                    "Restored receipt did not retain its recovery identity")
            completed = json.loads(local.sql(database, f"SET ROLE service_role; SELECT public.complete_billing_provider_operation_v1('{operation['id']}','{operation['studio_id']}','{operation['actor_id']}','payment.refund','refund-proof','{operation['request_sha256']}','acct_refundproof',1,'{operation['lease_owner']}',{claim['operation']['revision']},'payment_refund_completed');"))
            require(completed["operation"]["state"] == "completed"
                    and completed["operation"]["provider_request_attempt_count"] == 1,
                    "Refund continuation did not complete the original single attempt")
            after = snapshot(database)
            require(all(after[table] == before[table] for table in TABLES
                        if table != "public.billing_provider_operations"),
                    "Refund completion changed payment, refund, claim or unrelated rows")
            for name, content in contract_sources.items():
                local.sql(database, content.decode("utf8"))
                require((root / "supabase" / "verification" / name).read_bytes() == content,
                        "Refund continuation contract changed during verification")
            require(snapshot(database) == after, "Rollback-scoped proof changed retained rows")
            outcomes["contract_inputs"] = {name: hashlib.sha256(content).hexdigest() for name, content in contract_sources.items()}
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
        (temporary / "v45-v46-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V46] PASS canonical/restored V45 receipts and rows preserved, "
              "same-key refund completion and retained backend readiness", flush=True)
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

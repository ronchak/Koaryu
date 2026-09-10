#!/usr/bin/env python3
"""Verify a genuine V40 restore and the additive V41 payer-balance upgrade."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
from uuid import NAMESPACE_URL, UUID, uuid5

from local_postgres_verification import (
    ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require,
)

MIGRATION = "20260908183744_serialize_billing_payer_balance_v41.sql"
STUDIO = "00000000-0000-4000-8000-000000041002"
ACTOR = "00000000-0000-4000-8000-000000041001"
PAYER = "00000000-0000-4000-8000-000000041003"
INVOICE = "00000000-0000-4000-8000-000000041005"
TABLES = (
    "auth.users", "public.staff_profiles", "private.stripe_connect_account_identity_guards",
    "public.studios", "public.staff_roles", "public.studio_payment_accounts",
    "public.billing_payers", "public.billing_invoices", "public.billing_invoice_items",
    "public.audit_logs", "public.billing_provider_operations",
    "public.billing_provider_operation_resources", "public.billing_provider_operation_resource_aliases",
    "private.billing_invoice_retry_hash_ledger_v33",
)
SEMANTICS = (
    "koaryu_release_critical_surface_manifest_v16", "koaryu_release_critical_surface_manifest_v17",
    "koaryu_release_critical_surface_manifest_v18", "koaryu_release_operational_manifest_v10",
    "koaryu_release_operational_manifest_v11", "koaryu_release_resource_ownership_manifest_v31",
    "koaryu_release_operational_contract_v31", "koaryu_release_operational_manifest_v12",
    "koaryu_release_student_rank_writer_manifest_v11", "koaryu_release_student_rank_writer_manifest_v13",
)
SEED_SQL = r"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('00000000-0000-4000-8000-000000041001','authenticated','authenticated','balance-restore@example.invalid','{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES('00000000-0000-4000-8000-000000041002','Balance restore fixture','balance-restore-fixture','00000000-0000-4000-8000-000000041001');
INSERT INTO public.staff_roles(studio_id,user_id,role)
VALUES('00000000-0000-4000-8000-000000041002','00000000-0000-4000-8000-000000041001','admin');
INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,metadata)
VALUES('00000000-0000-4000-8000-000000041002','acct_balancerestore','{"connect_account_generation":1}');
INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation,balance_cents,billing_status)
VALUES('00000000-0000-4000-8000-000000041003','00000000-0000-4000-8000-000000041002','Retained payer','acct_balancerestore','cus_balancerestore',1,777,'failed'),
      ('00000000-0000-4000-8000-000000041004','00000000-0000-4000-8000-000000041002','Untouched payer',NULL,NULL,NULL,888,'failed');
INSERT INTO public.billing_invoices(id,studio_id,payer_id,stripe_invoice_id,stripe_account_id,stripe_customer_id,status,amount_due_cents,amount_remaining_cents,collection_method,metadata)
VALUES('00000000-0000-4000-8000-000000041005','00000000-0000-4000-8000-000000041002','00000000-0000-4000-8000-000000041003','in_balancerestore','acct_balancerestore','cus_balancerestore','open',100,100,'send_invoice','{"connect_account_generation":1}'),
      ('00000000-0000-4000-8000-000000041006','00000000-0000-4000-8000-000000041002','00000000-0000-4000-8000-000000041003',NULL,NULL,NULL,'open',300,300,NULL,'{}');
DO $receipt$
DECLARE
    studio UUID := '00000000-0000-4000-8000-000000041002';
    actor UUID := '00000000-0000-4000-8000-000000041001';
    payer UUID := '00000000-0000-4000-8000-000000041003';
    invoice UUID := '00000000-0000-4000-8000-000000041005';
    lease UUID := gen_random_uuid();
    request_hash TEXT;
    operation JSONB;
BEGIN
    request_hash:=private.billing_invoice_retry_base_hash_v33(studio,invoice,'in_balancerestore','acct_balancerestore',1);
    SET LOCAL ROLE service_role;
    IF current_user <> 'service_role' THEN RAISE EXCEPTION 'Receipt fixture requires service_role'; END IF;
    operation:=public.claim_billing_provider_operation_resource_v1(studio,actor,'invoice.retry','invoice',invoice,payer,
        'balance-restore-retry',request_hash,'acct_balancerestore',1,lease,30)->'operation';
    operation:=public.transition_billing_provider_operation_v1(
        p_operation_id=>(operation->>'id')::UUID,p_studio_id=>studio,p_actor_id=>actor,p_operation_type=>'invoice.retry',
        p_caller_request_key=>'balance-restore-retry',p_request_sha256=>request_hash,
        p_stripe_connected_account_id=>'acct_balancerestore',p_connect_account_generation=>1,p_lease_owner=>lease,
        p_expected_revision=>(operation->>'revision')::BIGINT,p_to_state=>'provider_request_in_flight',
        p_result_code=>'invoice_retry_started',p_result_summary=>'invoice_retry_mode:pay')->'operation';
    operation:=public.transition_billing_provider_operation_v1(
        p_operation_id=>(operation->>'id')::UUID,p_studio_id=>studio,p_actor_id=>actor,p_operation_type=>'invoice.retry',
        p_caller_request_key=>'balance-restore-retry',p_request_sha256=>request_hash,
        p_stripe_connected_account_id=>'acct_balancerestore',p_connect_account_generation=>1,p_lease_owner=>lease,
        p_expected_revision=>(operation->>'revision')::BIGINT,p_to_state=>'provider_succeeded',
        p_provider_object_id=>'in_balancerestore',p_result_code=>'invoice_retry_provider_paid')->'operation';
    UPDATE public.billing_invoices SET status='paid',amount_paid_cents=100,amount_remaining_cents=0 WHERE id=invoice;
    operation:=public.transition_billing_provider_operation_v1(
        p_operation_id=>(operation->>'id')::UUID,p_studio_id=>studio,p_actor_id=>actor,p_operation_type=>'invoice.retry',
        p_caller_request_key=>'balance-restore-retry',p_request_sha256=>request_hash,
        p_stripe_connected_account_id=>'acct_balancerestore',p_connect_account_generation=>1,p_lease_owner=>lease,
        p_expected_revision=>(operation->>'revision')::BIGINT,p_to_state=>'projected',
        p_result_code=>'invoice_retry_projected',p_result_summary=>'invoice_retry_mode:pay')->'operation';
    operation:=public.complete_billing_provider_operation_v1(
        p_operation_id=>(operation->>'id')::UUID,p_studio_id=>studio,p_actor_id=>actor,p_operation_type=>'invoice.retry',
        p_caller_request_key=>'balance-restore-retry',p_request_sha256=>request_hash,
        p_stripe_connected_account_id=>'acct_balancerestore',p_connect_account_generation=>1,p_lease_owner=>lease,
        p_expected_revision=>(operation->>'revision')::BIGINT,p_result_code=>'invoice_retry_completed')->'operation';
    IF operation->>'state' IS DISTINCT FROM 'completed' THEN RAISE EXCEPTION 'Retained receipt is not completed'; END IF;
    PERFORM set_config('balance_restore.operation',operation->>'id',true);
    PERFORM set_config('balance_restore.hash',request_hash,true);
    RESET ROLE;
END;
$receipt$;
SELECT jsonb_build_object('operation_id',current_setting('balance_restore.operation'),'request_hash',current_setting('balance_restore.hash'));
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
        "V40_CATALOG_STATE_SQL", "EXPECTED_V40_CATALOG_STATE", "EXPECTED_V40_RESTORED_CATALOG_STATE",
        "V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS",
        "V40_RELEASE_MANIFEST_SQL", "EXPECTED_V40_RELEASE_MANIFEST",
        "V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE",
        "V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS",
        "V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS",
        "V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS",
        "FINAL_OPERATIONAL_READINESS_SQL", "EXPECTED_OPERATIONAL_READINESS",
        "V41_RELEASE_MANIFEST_SQL", "EXPECTED_V41_RELEASE_MANIFEST",
        "V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE",
    ]
    module = (root / "scripts/studio-comp-migration-rollout.mjs").as_uri()
    pinned = json.loads(local.run(["node", "--input-type=module", "--eval",
        f"import * as m from {json.dumps(module)}; console.log(JSON.stringify(Object.fromEntries("
        f"{json.dumps(names)}.map(k=>[k,m[k]]))));"]))
    require(set(pinned) == set(names) and all(isinstance(v, str) and v for v in pinned.values()),
            "Incomplete version-bound balance restore expectations")

    def check(database, query, expected):
        value = local.sql(database, pinned[query])
        require(value == pinned[expected], f"{database}: {query} did not match {expected}")
        return value

    def snapshot(database):
        fields = [f"'{table}',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)->>'id',"
                  f"to_jsonb(t)::TEXT COLLATE \"C\"),'[]'::JSONB) FROM {table} t)" for table in TABLES]
        return json.loads(local.sql(database, "SET TIME ZONE 'UTC'; SELECT jsonb_build_object(" + ",".join(fields) + ");"))

    def semantics(database):
        return {name: local.sql(database, f"SELECT private.{name}();") for name in SEMANTICS}

    def predecessor(database, restored=False):
        check(database, "V40_CATALOG_STATE_SQL", "EXPECTED_V40_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V40_CATALOG_STATE")
        check(database, "V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS")
        check(database, "V40_RELEASE_MANIFEST_SQL", "EXPECTED_V40_RELEASE_MANIFEST")
        check(database, "V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE")
        require(local.sql(database, "SELECT count(*)=135 AND max(version)='20260908133504' FROM supabase_migrations.schema_migrations;") == "t",
                "Balance restore requires the actual V40 history")
        require(local.sql(database, "SELECT to_regprocedure('public.recompute_billing_payer_balance_v1(uuid,uuid)') IS NULL "
                          "AND to_regprocedure('public.koaryu_release_schema_preflight_v22()') IS NULL;") == "t",
                "Balance restore predecessor already contains V41 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 136 and list(hashes)[-3:] == [
        "20260908080420_student_membership_preservation_v39.sql",
        "20260908133504_rank_history_command_ownership_v40.sql", MIGRATION], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v41_source_{os.getpid()}"
    restored = f"koaryu_v41_restore_{os.getpid()}"
    canonical = f"koaryu_v41_canonical_{os.getpid()}"
    dump = temporary / f"v40-before-v41-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = json.loads(local.sql(source, SEED_SQL))
        UUID(seed["operation_id"])
        require(re.fullmatch(r"[0-9a-f]{64}", seed["request_hash"]) is not None, "Invalid retained receipt hash")
        audit_id = str(uuid5(NAMESPACE_URL, "koaryu:billing.invoice_retry_requested:" + seed["operation_id"]))
        local.sql(source, f"INSERT INTO public.audit_logs(id,studio_id,actor_id,action,entity_type,entity_id,metadata)"
                  f"VALUES('{audit_id}','{STUDIO}','{ACTOR}','billing.invoice_retry_requested','billing','{INVOICE}',"
                  f"jsonb_build_object('operation_id','{seed['operation_id']}','stripe_invoice_id','in_balancerestore','status','paid'));")
        before = snapshot(source)
        require(len(before["public.billing_payers"]) == 2 and len(before["public.billing_invoices"]) == 2
                and len(before["public.billing_provider_operations"]) == 1
                and len(before["private.billing_invoice_retry_hash_ledger_v33"]) == 1,
                "Balance restore fixture is incomplete")
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
            require(snapshot(database) == before, "V41 changed retained rows before explicit repair")
            checks = [
                ("FINAL_OPERATIONAL_READINESS_SQL", "EXPECTED_OPERATIONAL_READINESS"),
                ("V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS"),
                ("V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS"),
                ("V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS"),
                ("V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS"),
                ("V40_CATALOG_STATE_SQL", "EXPECTED_V40_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V40_CATALOG_STATE"),
                ("V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE"),
                ("V41_RELEASE_MANIFEST_SQL", "EXPECTED_V41_RELEASE_MANIFEST"),
                ("V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            require(semantics(database) == expected_semantics, "Additive V41 changed existing semantic manifests")
            local.sql(database, f"BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL ROLE service_role; "
                      f"SELECT public.recompute_billing_payer_balance_v1('{STUDIO}','{PAYER}'); COMMIT;")
            after = snapshot(database)
            expected = json.loads(json.dumps(before))
            changed = next(row for row in after["public.billing_payers"] if row["id"] == PAYER)
            intended = next(row for row in expected["public.billing_payers"] if row["id"] == PAYER)
            intended.update(balance_cents=300, billing_status="past_due", updated_at=changed["updated_at"])
            require(after == expected, "Explicit repair changed unintended retained fields")
            replay = json.loads(local.sql(database, f"BEGIN; SET LOCAL ROLE service_role; "
                f"SELECT public.claim_billing_provider_operation_resource_v1('{STUDIO}','{ACTOR}','invoice.retry','invoice',"
                f"'{INVOICE}','{PAYER}','balance-restore-retry','{seed['request_hash']}','acct_balancerestore',1,gen_random_uuid(),30); COMMIT;"))
            require(replay["operation"]["id"] == seed["operation_id"] and replay["operation"]["state"] == "completed",
                    "Retained completed receipt did not replay")
            require(snapshot(database) == after, "Completed replay changed persisted facts")
            require({query: check(database, query, expected) for query, expected in checks} == values,
                    "Repair/replay changed the attested state")
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
        (temporary / "v40-v41-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V41] PASS actual V40 backup/restore, exact normalization, no migration backfill, "
              "scoped balance repair and completed receipt replay on canonical/restored copies", flush=True)
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

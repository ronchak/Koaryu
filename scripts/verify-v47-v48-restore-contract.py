#!/usr/bin/env python3
"""Prove V47 activation identities survive restore and zero-attempt execution uses current seats."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20260920035023_enrollment_activation_execution_v48.sql"
TABLES = ("auth.users", "public.staff_profiles", "public.studios", "public.staff_roles",
          "public.studio_payment_accounts", "public.billing_payers", "public.billing_plans",
          "public.billing_subscriptions", "public.students", "public.student_billing_enrollments",
          "public.billing_provider_operations", "public.billing_provider_operation_resources",
          "public.billing_provider_operation_resource_aliases", "public.audit_logs")
F = {name: f"48000000-0000-4000-8000-{index:012d}" for index, name in enumerate(
    ["actor", "studio", "payer", "plan", "group", "student", "enrollment", "existing_student",
     "existing", "later_student", "later", "lease"], 1)}
INTENT = {"version": 1, "operation_type": "enrollment.activate.invoice", "studio_id": F["studio"],
    "enrollment_id": F["enrollment"], "student_id": F["student"], "payer_id": F["payer"],
    "plan_id": F["plan"], "account_id": "acct_ActivationRestore48", "generation": 1,
    "customer_id": "cus_activation48", "product_id": "prod_activation48", "price_id": "price_activation48",
    "group_id": F["group"], "branch": "update_quantity", "expected_subscription_id": "sub_activation48",
    "expected_item_id": "si_activation48", "expected_quantity": 2}
INTENT["desired_sha256"] = hashlib.sha256(json.dumps(INTENT, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
SEED_SQL = f"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('{F['actor']}','authenticated','authenticated','activation48-{F['actor']}@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)VALUES('{F['studio']}','Activation proof','activation-{F['studio']}','{F['actor']}');
INSERT INTO public.staff_roles(studio_id,user_id,role)VALUES('{F['studio']}','{F['actor']}','admin');
INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,status,charges_enabled,payouts_enabled,details_submitted,metadata)
VALUES('{F['studio']}','acct_ActivationRestore48','charges_enabled',true,true,true,'{{"connect_account_generation":1}}');
INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation)
VALUES('{F['payer']}','{F['studio']}','Activation payer','acct_ActivationRestore48','cus_activation48',1);
INSERT INTO public.billing_plans(id,studio_id,name,amount_cents,currency,billing_interval,status,stripe_account_id,stripe_product_id,stripe_price_id)
VALUES('{F['plan']}','{F['studio']}','Activation plan',5000,'usd','monthly','active','acct_ActivationRestore48','prod_activation48','price_activation48');
INSERT INTO public.billing_subscriptions(id,studio_id,payer_id,stripe_account_id,stripe_customer_id,stripe_subscription_id,collection_mode,billing_interval,currency,status,metadata)
VALUES('{F['group']}','{F['studio']}','{F['payer']}','acct_ActivationRestore48','cus_activation48','sub_activation48','invoice_link','monthly','usd','active','{{"connect_account_generation":1}}');
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name)VALUES
('{F['student']}','{F['studio']}','Pending','Seat'),('{F['existing_student']}','{F['studio']}','Existing','Seat'),('{F['later_student']}','{F['studio']}','Later','Seat');
INSERT INTO public.student_billing_enrollments(id,studio_id,student_id,payer_id,billing_plan_id,collection_mode,status,metadata)VALUES
('{F['enrollment']}','{F['studio']}','{F['student']}','{F['payer']}','{F['plan']}','invoice_link','pending','{json.dumps({'provider_activation_intent':INTENT})}'),
('{F['later']}','{F['studio']}','{F['later_student']}','{F['payer']}','{F['plan']}','invoice_link','pending','{{}}');
INSERT INTO public.student_billing_enrollments(id,studio_id,student_id,payer_id,billing_plan_id,collection_mode,status,billing_subscription_id,stripe_subscription_id,stripe_subscription_item_id)
VALUES('{F['existing']}','{F['studio']}','{F['existing_student']}','{F['payer']}','{F['plan']}','invoice_link','active','{F['group']}','sub_activation48','si_activation48');
UPDATE public.student_billing_enrollments SET status='active',billing_subscription_id='{F['group']}',stripe_subscription_id='sub_activation48',stripe_subscription_item_id='si_activation48' WHERE id='{F['later']}';
DO $claim$ BEGIN PERFORM public.claim_billing_provider_operation_resource_v1('{F['studio']}','{F['actor']}','enrollment.activate.invoice','enrollment','{F['enrollment']}','{F['payer']}','activation-restore','{INTENT['desired_sha256']}','acct_ActivationRestore48',1,'{F['lease']}',5); END; $claim$;
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
        "V47_OPERATIONAL_READINESS_SQL", "EXPECTED_V47_OPERATIONAL_READINESS",
        "V47_CATALOG_STATE_SQL", "EXPECTED_V47_CATALOG_STATE", "EXPECTED_V47_RESTORED_CATALOG_STATE",
        "V47_RELEASE_MANIFEST_SQL", "EXPECTED_V47_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V47_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V47_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V47_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V47_OPERATIONAL_MANIFEST_V12",
        "V48_OPERATIONAL_READINESS_SQL", "EXPECTED_V48_OPERATIONAL_READINESS",
        "V45_OPERATIONAL_READINESS_SQL", "EXPECTED_V45_OPERATIONAL_READINESS",
        "V44_OPERATIONAL_READINESS_SQL", "EXPECTED_V44_OPERATIONAL_READINESS",
        "V43_OPERATIONAL_READINESS_SQL", "EXPECTED_V43_OPERATIONAL_READINESS",
        "V42_OPERATIONAL_READINESS_SQL", "EXPECTED_V42_OPERATIONAL_READINESS",
        "V41_OPERATIONAL_READINESS_SQL", "EXPECTED_V41_OPERATIONAL_READINESS",
        "V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS",
        "V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS",
        "V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS",
        "V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS",
        "V48_CATALOG_STATE_SQL", "EXPECTED_V48_CATALOG_STATE", "EXPECTED_V48_RESTORED_CATALOG_STATE",
        "V48_RELEASE_MANIFEST_SQL", "EXPECTED_V48_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V48_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V48_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V48_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V48_OPERATIONAL_MANIFEST_V12",
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

    def semantics(database):
        return {signature: local.sql(database, f"SELECT {signature};") for signature in ["private.koaryu_release_critical_surface_manifest_v16()","private.koaryu_release_critical_surface_manifest_v17()","private.koaryu_release_critical_surface_manifest_v18()","private.koaryu_release_operational_manifest_v10()","private.koaryu_release_operational_manifest_v11()"]}

    def predecessor(database, restored=False):
        check(database, "V47_OPERATIONAL_READINESS_SQL", "EXPECTED_V47_OPERATIONAL_READINESS")
        check(database, "V47_CATALOG_STATE_SQL", "EXPECTED_V47_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V47_CATALOG_STATE")
        check(database, "V47_RELEASE_MANIFEST_SQL", "EXPECTED_V47_RELEASE_MANIFEST")
        check(database, "V31_EXPECTATION_STATE_SQL", "EXPECTED_V47_EXPECTATION_STATE")
        check(database, "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V47_RESOURCE_OWNERSHIP_MANIFEST")
        check(database, "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V47_OPERATIONAL_CONTRACT")
        check(database, "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V47_OPERATIONAL_MANIFEST_V12")
        require(local.sql(database, "SELECT count(*)=142 AND max(version)='20260914055301' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V47 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v29()') IS NULL AND to_regprocedure('public.begin_billing_enrollment_activation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,uuid,text,text)') IS NULL;") == "t",
                "Restore predecessor already contains V48 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 146 and list(hashes)[-5:] == [
        "20260914055301_refund_completion_locking_v47.sql", MIGRATION,
        "20260920052705_subscription_unknown_terms_v49.sql",
        "20260920154441_billing_due_date_facts_v50.sql",
        "20260925030000_invoice_closeout_lock_order_v51.sql"], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v48_source_{os.getpid()}"
    restored = f"koaryu_v48_restore_{os.getpid()}"
    canonical = f"koaryu_v48_canonical_{os.getpid()}"
    dump = temporary / f"v47-before-v48-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == "seeded" and len(before["public.student_billing_enrollments"]) == 3
                and before["public.billing_provider_operations"][0]["provider_request_attempt_count"] == 0,
                "Activation restore seed is incomplete")
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
                ("V48_OPERATIONAL_READINESS_SQL", "EXPECTED_V48_OPERATIONAL_READINESS"),
                ("V47_OPERATIONAL_READINESS_SQL", "EXPECTED_V47_OPERATIONAL_READINESS"),
                ("V45_OPERATIONAL_READINESS_SQL", "EXPECTED_V45_OPERATIONAL_READINESS"),
                ("V44_OPERATIONAL_READINESS_SQL", "EXPECTED_V44_OPERATIONAL_READINESS"),
                ("V43_OPERATIONAL_READINESS_SQL", "EXPECTED_V43_OPERATIONAL_READINESS"),
                ("V42_OPERATIONAL_READINESS_SQL", "EXPECTED_V42_OPERATIONAL_READINESS"),
                ("V41_OPERATIONAL_READINESS_SQL", "EXPECTED_V41_OPERATIONAL_READINESS"),
                ("V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS"),
                ("V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS"),
                ("V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS"),
                ("V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS"),
                ("V48_CATALOG_STATE_SQL", "EXPECTED_V48_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V48_CATALOG_STATE"),
                ("V48_RELEASE_MANIFEST_SQL", "EXPECTED_V48_RELEASE_MANIFEST"),
                ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V48_EXPECTATION_STATE"),
                ("V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V48_RESOURCE_OWNERSHIP_MANIFEST"),
                ("V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V48_OPERATIONAL_CONTRACT"),
                ("V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V48_OPERATIONAL_MANIFEST_V12"),
                ("V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE"),
                ("V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE"),
                ("V43_EXTERNAL_PAYMENT_STATE_SQL", "EXPECTED_V43_EXTERNAL_PAYMENT_STATE"),
                ("V44_LOCAL_PLAN_STATE_SQL", "EXPECTED_V44_LOCAL_PLAN_STATE"),
                ("V44_CLEAR_STATE_SQL", "EXPECTED_V44_CLEAR_STATE"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            require(semantics(database) == expected_semantics, "Upgrade or continuation changed declared semantic manifests")
            operation = before["public.billing_provider_operations"][0]
            claimed = json.loads(local.sql(database, f"SET ROLE service_role; SELECT public.claim_billing_provider_operation_resource_v1('{F['studio']}','{F['actor']}','enrollment.activate.invoice','enrollment','{F['enrollment']}','{F['payer']}','activation-restore','{INTENT['desired_sha256']}','acct_ActivationRestore48',1,'{F['lease']}',300);"))
            local.sql(database, f"SET ROLE service_role; SELECT public.claim_billing_subscription_quantity_sync('{F['studio']}','{F['group']}','{F['lease']}',120);")
            result = json.loads(local.sql(database, f"SET ROLE service_role; SELECT public.begin_billing_enrollment_activation_v1('{operation['id']}','{F['studio']}','{F['actor']}','enrollment.activate.invoice','activation-restore','{INTENT['desired_sha256']}','acct_ActivationRestore48',1,'{F['lease']}',{claimed['operation']['revision']},'{F['enrollment']}','{F['lease']}','sub_activation48');"))
            require(result["operation"]["id"] == operation["id"] and result["operation"]["provider_request_attempt_count"] == 1
                    and result["execution"]["expected_quantity"] == 3,
                    "Restored zero-attempt receipt did not use three current seats")
            after = snapshot(database)
            pending = next(row for row in after["public.student_billing_enrollments"] if row["id"] == F["enrollment"])
            intent = pending["metadata"]["provider_activation_intent"]
            require({key:value for key,value in intent.items() if key != "executions"} == INTENT
                    and intent["executions"] == {operation["id"]: result["execution"]},
                    "Execution overwrote the legacy request or used its stale quantity")
            mutable = {"public.student_billing_enrollments", "public.billing_subscriptions", "public.billing_provider_operations"}
            require(all(after[table] == before[table] for table in TABLES if table not in mutable),
                    "Beginning activation changed unrelated rows")
            require([row for row in after["public.student_billing_enrollments"] if row["id"] != F["enrollment"]]
                    == [row for row in before["public.student_billing_enrollments"] if row["id"] != F["enrollment"]],
                    "Beginning activation changed another seat")
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
        (temporary / "v47-v48-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V48] PASS canonical/restored rows and legacy activation identity preserved; fresh quantity owned with one attempt", flush=True)
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

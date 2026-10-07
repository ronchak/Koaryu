#!/usr/bin/env python3
"""Prove V55 rows survive canonical and logical restore upgrade to V56, then continue automation rules, delivery decisions, suppression and encrypted credential revisions."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20261004220435_missed_class_automation_v56.sql"
import subprocess

TABLES = ("auth.users", "public.studios", "public.staff_roles", "public.programs", "public.leads",
          "public.lead_activities", "public.lead_follow_up_operations", "public.students",
          "public.student_program_memberships", "public.guardians", "public.student_guardians", "public.audit_logs",
          "public.studio_subscriptions", "public.class_sessions", "public.attendance")
SEED_SQL = """
BEGIN;
SET LOCAL TIME ZONE 'UTC';
DO $seed$
DECLARE actor UUID := gen_random_uuid(); studio UUID := gen_random_uuid(); lead UUID := gen_random_uuid();
    program UUID := gen_random_uuid(); adult UUID := gen_random_uuid(); minor UUID := gen_random_uuid();
    held UUID := gen_random_uuid(); guardian UUID := gen_random_uuid(); session_id UUID := gen_random_uuid();
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
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(studio,'active',true);
    UPDATE public.studios SET timezone='UTC' WHERE id=studio;
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email,is_minor,hold_start_date,hold_end_date)
    VALUES(adult,studio,'RestoreAdult','Fixture','adult.restore@example.invalid',false,NULL,NULL),
          (minor,studio,'RestoreMinor','Fixture','minor.restore@example.invalid',true,NULL,NULL),
          (held,studio,'RestoreHeld','Fixture','held.restore@example.invalid',false,CURRENT_DATE-1,CURRENT_DATE+1);
    INSERT INTO public.guardians(id,studio_id,first_name,last_name,email,is_primary_contact)
    VALUES(guardian,studio,'Restore','Guardian','guardian.restore@example.invalid',true);
    INSERT INTO public.student_guardians(student_id,guardian_id) VALUES(minor,guardian);
    INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time)
    VALUES(session_id,studio,'Restore retained class',CURRENT_DATE-20,'00:00','01:00');
    INSERT INTO public.attendance(studio_id,session_id,student_id,status,checked_in_at)
    SELECT studio,session_id,id,'present',now()-INTERVAL '20 days' FROM public.students WHERE id IN (adult,minor,held);
END;
$seed$;
SELECT 'seeded';
COMMIT;
"""

CONTRACT_BASE = "611b1a7c885613d28d1861fd69f57190e5b302be"
CONTRACT_SHA256 = "cf827777be54b8160890df6f87e4cca3d7909f9f14daad2fdf6b7d0528faaeca"


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
        "V55_OPERATIONAL_READINESS_SQL", "EXPECTED_V55_OPERATIONAL_READINESS",
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
        "V55_LEAD_CONVERSION_STATE_SQL", "EXPECTED_V55_LEAD_CONVERSION_STATE",
        "V55_LEAD_FOLLOW_UP_STATE_SQL", "EXPECTED_V55_LEAD_FOLLOW_UP_STATE",
        "V56_OPERATIONAL_READINESS_SQL", "EXPECTED_V56_OPERATIONAL_READINESS",
        "V56_CATALOG_STATE_SQL", "EXPECTED_V56_CATALOG_STATE", "EXPECTED_V56_RESTORED_CATALOG_STATE",
        "V56_RELEASE_MANIFEST_SQL", "EXPECTED_V56_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V56_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V56_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V56_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V56_OPERATIONAL_MANIFEST_V12",
        "CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V56_CRITICAL_SURFACE_MANIFEST",
        "V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V56_OPERATIONAL_MANIFEST_V10",
        "V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V56_OPERATIONAL_MANIFEST_V11",
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
        "V54_OPERATIONAL_READINESS_SQL", "EXPECTED_V54_OPERATIONAL_READINESS",
        "V53_OPERATIONAL_READINESS_SQL", "EXPECTED_V53_OPERATIONAL_READINESS",
        "V56_AUTOMATION_TABLE_STATE_SQL", "EXPECTED_V56_AUTOMATION_TABLE_STATE",
        "V56_AUTOMATION_FUNCTION_STATE_SQL", "EXPECTED_V56_AUTOMATION_FUNCTION_STATE",
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
        check(database, "V55_OPERATIONAL_READINESS_SQL", "EXPECTED_V55_OPERATIONAL_READINESS")
        check(database, "V55_CATALOG_STATE_SQL", "EXPECTED_V55_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V55_CATALOG_STATE")
        check(database, "V55_RELEASE_MANIFEST_SQL", "EXPECTED_V55_RELEASE_MANIFEST")
        check(database, "V31_EXPECTATION_STATE_SQL", "EXPECTED_V55_EXPECTATION_STATE")
        check(database, "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V55_RESOURCE_OWNERSHIP_MANIFEST")
        check(database, "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V55_OPERATIONAL_CONTRACT")
        check(database, "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V55_OPERATIONAL_MANIFEST_V12")
        check(database, "CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V55_CRITICAL_SURFACE_MANIFEST")
        check(database, "V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V55_OPERATIONAL_MANIFEST_V10")
        check(database, "V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V55_OPERATIONAL_MANIFEST_V11")
        check(database, "V55_STUDENT_PROFILE_STATE_SQL", "EXPECTED_V55_STUDENT_PROFILE_STATE")
        check(database, "V55_LEAD_CONVERSION_STATE_SQL", "EXPECTED_V55_LEAD_CONVERSION_STATE")
        check(database, "V55_LEAD_FOLLOW_UP_STATE_SQL", "EXPECTED_V55_LEAD_FOLLOW_UP_STATE")
        require(local.sql(database, "SELECT count(*)=150 AND max(version)='20260930192626' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V55 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v37()') IS NULL AND to_regprocedure('public.get_missed_class_automation_rule_v1(uuid,uuid)') IS NULL AND to_regprocedure('public.get_automation_email_credential_v1(text)') IS NULL;") == "t",
                "Restore predecessor already contains V56 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 152 and list(hashes)[-3:] == [
        "20260930192626_converted_lead_enrollment_v55.sql", MIGRATION,
        "20261005105341_automation_workflow_graph_v57.sql"], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v56_source_{os.getpid()}"
    restored = f"koaryu_v56_restore_{os.getpid()}"
    canonical = f"koaryu_v56_canonical_{os.getpid()}"
    dump = temporary / f"v55-before-v56-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == "seeded" and len(before["public.leads"]) == 1
                and len(before["public.students"]) == 4 and len(before["public.student_guardians"]) == 2
                and len(before["public.attendance"]) == 3,
                "V55 retained lead and automation eligibility fixtures are incomplete")
        require(local.sql(source, "SELECT to_regclass('public.automation_rules') IS NULL AND "
                          "to_regclass('private.automation_email_credentials') IS NULL;") == "t",
                "V55 source already has automation tables")
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
                ("V56_OPERATIONAL_READINESS_SQL", "EXPECTED_V56_OPERATIONAL_READINESS"),
                ("V56_CATALOG_STATE_SQL", "EXPECTED_V56_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V56_CATALOG_STATE"),
                ("V56_RELEASE_MANIFEST_SQL", "EXPECTED_V56_RELEASE_MANIFEST"),
                ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V56_EXPECTATION_STATE"),
                ("V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V56_RESOURCE_OWNERSHIP_MANIFEST"),
                ("V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V56_OPERATIONAL_CONTRACT"),
                ("V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V56_OPERATIONAL_MANIFEST_V12"),
                ("CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V56_CRITICAL_SURFACE_MANIFEST"),
                ("V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V56_OPERATIONAL_MANIFEST_V10"),
                ("V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V56_OPERATIONAL_MANIFEST_V11"),
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
                ("V55_OPERATIONAL_READINESS_SQL", "EXPECTED_V55_OPERATIONAL_READINESS"),
                ("V56_AUTOMATION_TABLE_STATE_SQL", "EXPECTED_V56_AUTOMATION_TABLE_STATE"),
                ("V56_AUTOMATION_FUNCTION_STATE_SQL", "EXPECTED_V56_AUTOMATION_FUNCTION_STATE"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            contract = root / "supabase/verification/missed_class_automation_contract.sql"
            require(local.run(["git", "-C", str(root), "rev-parse", "--is-shallow-repository"]) == "false",
                    "Historical V56 contract requires full Git history")
            local.run(["git", "-C", str(root), "merge-base", "--is-ancestor", CONTRACT_BASE, "HEAD"])
            # This immutable V56 input predates the final shared V57 assertions.
            # Preserve the original bytes and reviewed hash rather than repinning history.
            contract_bytes = subprocess.check_output(
                ["git", "-C", str(root), "show", CONTRACT_BASE + ":supabase/verification/missed_class_automation_contract.sql"],
                env=local.env,
            )
            require(hashlib.sha256(contract_bytes).hexdigest() == CONTRACT_SHA256,
                    "Automation business contract differs from its reviewed restore input")
            local.sql(database, contract_bytes.decode())
            require(snapshot(database) == before, "Automation contract changed retained V55 rows")
            proof = local.sql(database, """
BEGIN;
SET LOCAL ROLE service_role;
DO $proof$
DECLARE studio UUID; actor UUID; j JSONB; k JSONB; claims JSONB; item JSONB;
    first_token TEXT; first_recipient TEXT; count_attempts INTEGER:=0; conflict BOOLEAN;
BEGIN
    SELECT id,owner_id INTO studio,actor FROM public.studios WHERE name='Converted lead restore';
    IF public.get_missed_class_automation_rule_v1(studio,actor) IS DISTINCT FROM '{"rule":null}'::JSONB
       OR EXISTS(SELECT 1 FROM public.automation_rules) THEN RAISE EXCEPTION 'Restore missing-rule read wrote state'; END IF;
    j:=public.save_missed_class_automation_rule_v1(studio,actor,0,true,14,'Restore subject','Restore body','reply.restore@example.invalid');
    IF j->'rule'->>'revision' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'Restore rule revision1 missing'; END IF;
    conflict:=false;
    BEGIN PERFORM public.save_missed_class_automation_rule_v1(studio,actor,0,true,14,'Stale','Stale','reply.restore@example.invalid');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'AUTOMATION_RULE_CONFLICT' THEN RAISE; END IF; conflict:=true; END;
    IF NOT conflict THEN RAISE EXCEPTION 'Restore stale rule CAS succeeded'; END IF;
    j:=public.save_missed_class_automation_rule_v1(studio,actor,1,true,14,'Restore subject2','Restore body2','reply.restore@example.invalid');
    IF j->'rule'->>'revision' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'Restore rule revision did not continue'; END IF;
    j:=public.preview_missed_class_automation_v1(studio,actor,14);
    IF (j->>'eligible_count')::INTEGER<>2 OR NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(j->'recipients') r WHERE r->>'recipient_kind'='guardian' AND r->>'recipient_email'='guardian.restore@example.invalid' AND r->>'skip_reason' IS NULL)
       OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j->'recipients') r WHERE r->>'skip_reason'='on_hold') THEN
        RAISE EXCEPTION 'Restore guardian routing or effective hold changed'; END IF;
    j:=public.enqueue_missed_class_automations_v1(10);
    IF (j->>'enqueued')::INTEGER<>2 THEN RAISE EXCEPTION 'Restore enqueue count changed'; END IF;
    claims:=public.claim_missed_class_automations_v1(2);
    IF jsonb_array_length(claims->'items')<>2 THEN RAISE EXCEPTION 'Restore claim count changed'; END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(claims->'items') LOOP
        j:=public.begin_missed_class_automation_v1((item->>'id')::UUID,(item->>'claim_token')::UUID);
        IF j->>'ready' IS DISTINCT FROM 'true' OR j->>'state' IS DISTINCT FROM 'sending' THEN RAISE EXCEPTION 'Restore begin did not commit sending'; END IF;
        count_attempts:=count_attempts+1;
        IF count_attempts=1 THEN first_token:=j->'message'->>'unsubscribe_token'; first_recipient:=j->'message'->>'recipient_email'; END IF;
        k:=public.settle_missed_class_automation_v1((item->>'id')::UUID,(item->>'claim_token')::UUID,
            CASE WHEN count_attempts=1 THEN 'accepted' ELSE 'unknown' END);
        IF k->>'updated' IS DISTINCT FROM 'true' OR k->>'state' IS DISTINCT FROM (CASE WHEN count_attempts=1 THEN 'accepted' ELSE 'unknown' END) THEN
            RAISE EXCEPTION 'Restore accepted or unknown settlement changed'; END IF;
    END LOOP;
    IF (public.enqueue_missed_class_automations_v1(10)->>'enqueued')::INTEGER<>0 THEN RAISE EXCEPTION 'Restore reopened attempted episode'; END IF;
    PERFORM public.suppress_missed_class_automation_v1(first_token);
    IF NOT EXISTS(SELECT 1 FROM public.automation_suppressions s WHERE s.studio_id=studio AND s.recipient_email=first_recipient) THEN
        RAISE EXCEPTION 'Restore original recipient suppression was not retained'; END IF;
    j:=public.get_automation_email_credential_v1('microsoft_graph:primary');
    IF j->>'revision' IS DISTINCT FROM '0' OR j->>'encrypted_credentials' IS NOT NULL THEN RAISE EXCEPTION 'Restore credential absence mismatch'; END IF;
    j:=public.save_automation_email_credential_v1('microsoft_graph:primary',0,'opaque-ciphertext-fixture-v1');
    k:=public.save_automation_email_credential_v1('microsoft_graph:primary',1,'opaque-ciphertext-fixture-v2');
    IF j->>'revision' IS DISTINCT FROM '1' OR k->>'revision' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'Restore encrypted credential revision did not continue'; END IF;
    conflict:=false;
    BEGIN PERFORM public.save_automation_email_credential_v1('microsoft_graph:primary',1,'stale-opaque-ciphertext-fixture');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'AUTOMATION_EMAIL_CREDENTIAL_CONFLICT' THEN RAISE; END IF; conflict:=true; END;
    IF NOT conflict OR public.get_automation_email_credential_v1('microsoft_graph:primary') IS DISTINCT FROM k THEN
        RAISE EXCEPTION 'Restore credential CAS overwrote newer ciphertext'; END IF;
END;
$proof$;
ROLLBACK;
SELECT 'continued';
""")
            require(proof.splitlines()[-1] == "continued", "Automation restore continuation failed")
            require(snapshot(database) == before, "Automation continuation changed retained V55 rows")
            outcomes[("restored_" if is_restored else "canonical_") + "automation"] = {
                "rule_revision": 2, "eligible": 2, "accepted": 1, "unknown": 1,
                "suppressed": 1, "credential_revision": 2, "contract_sha256": CONTRACT_SHA256,
            }
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
        (temporary / "v55-v56-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V56] PASS retained V55 rows, rule CAS, guardian/hold eligibility, accepted/unknown episodes, suppression and credential revision continuation on canonical/restored copies", flush=True)
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

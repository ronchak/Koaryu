import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CURRENT_RELEASE, releaseState } from "./release-attestation/states.mjs";
import { MIGRATION_VERSIONS } from "./release-attestation/generated-history.mjs";
import { renderPreflight } from "./release-attestation/preflight.mjs";
import { AUTOMATION_TABLE_FACTS_V56_SQL, AUTOMATION_FUNCTION_FACTS_V56_SQL } from "./release-attestation/preflight-policy.mjs";
import { V56_RELEASE_MANIFEST_SQL, EXPECTED_V56_AUTOMATION_TABLE_STATE, EXPECTED_V56_AUTOMATION_FUNCTION_STATE } from "./studio-comp-migration-rollout.mjs";
import schema from "./release-attestation/preflight-schema.json" with { type: "json" };

const read = name => fs.readFileSync(new URL(name, import.meta.url), "utf8");
const migration = read("../supabase/migrations/20261004220435_missed_class_automation_v56.sql");

test("V56 requires exact V55 before effects and full installed facts before history registration", () => {
  assert.equal(CURRENT_RELEASE, "v56");
  const state = releaseState("v56", MIGRATION_VERSIONS);
  assert.equal(state.predecessor, "v55");
  assert.equal(state.count, 151);
  assert.equal(state.head, "20261004220435");
  assert.equal(state.pending.length, 67);
  assert.equal(state.preflight, "public.koaryu_release_schema_preflight_v37()");
  assert.ok(migration.includes(renderPreflight(state)));
  assert.ok(migration.indexOf("V56 requires a fully verified V55 predecessor") < migration.indexOf("CREATE TABLE"));
  assert.ok(migration.indexOf("V56 installed contracts did not verify") > migration.indexOf("CREATE FUNCTION public.koaryu_release_schema_preflight_v37()"));
  const predecessor = read("../supabase/migrations/20260930192626_converted_lead_enrollment_v55.sql");
  const body = /CREATE FUNCTION public\.koaryu_release_schema_preflight_v36\(\)[\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/.exec(predecessor)?.[1];
  assert.ok(body);
  const digest = createHash("sha256").update(body).digest("hex");
  assert.equal(digest, "bf8eb2b0cebd23371297280e9c968d89e82987bfba66bc93ae5b9a997f43d706");
  assert.ok(migration.includes(digest));
  assert.match(migration, /GET DIAGNOSTICS changed = ROW_COUNT;[\s\S]*changed <> 1/);
  assert.ok(V56_RELEASE_MANIFEST_SQL.includes("public.koaryu_release_schema_preflight_v36()"));
  assert.ok(V56_RELEASE_MANIFEST_SQL.includes("public.koaryu_release_schema_preflight_v37()"));
});

test("V56 binds all automation storage, function definitions and effective ACLs", () => {
  for (const term of ["automation_rules", "automation_deliveries", "automation_suppressions", "automation_email_credentials", "relpersistence", "relrowsecurity", "relforcerowsecurity", "attnotnull", "attidentity", "attgenerated", "attacl", "aclexplode", "pg_get_constraintdef", "confdeltype", "indisvalid", "indisready", "indislive", "pg_get_indexdef", "pg_get_triggerdef", "tgenabled", "pg_policy"]) {
    assert.ok(AUTOMATION_TABLE_FACTS_V56_SQL.includes(term), term);
  }
  for (const term of ["pg_get_functiondef", "prosrc", "provolatile", "prosecdef", "proconfig", "pg_get_function_arguments", "pg_get_function_result", "overloads", "acldefault", "aclexplode", "is_grantable", "timestamp with time zone"]) {
    assert.ok(AUTOMATION_FUNCTION_FACTS_V56_SQL.includes(term), term);
  }
  assert.equal(schema.checks.automation_tables_v56.expected, EXPECTED_V56_AUTOMATION_TABLE_STATE);
  assert.equal(schema.checks.automation_functions_v56.expected, EXPECTED_V56_AUTOMATION_FUNCTION_STATE);
  assert.equal(schema.states.v56.extends, "v55");
  assert.equal(schema.checks.student_profile_facts_v55.expected, "fad46920fe7205c3de8d9a3cf04994de52c257e3dd5d1d1b66710566470a4029");
  assert.equal(migration.match(/CREATE POLICY reject_ambiguous_staff_membership_access ON public\.automation_/g)?.length, 3);
  assert.ok(migration.includes("length(provider_key) >= 1 AND length(provider_key) <= 128"));
});

test("V56 restore proves retained data and continuation on independent canonical and logical copies", () => {
  const script = read("./verify-v55-v56-restore-contract.py");
  for (const term of ["for database, is_restored", "normalization_plan", "V55_OPERATIONAL_READINESS_SQL", "snapshot(database) == before", "Restore proof edited its source rows", "Restore rule revision did not continue", "Restore guardian routing or effective hold changed", "Restore accepted or unknown settlement changed", "Restore original recipient suppression", "Restore credential CAS overwrote newer ciphertext", "CONTRACT_SHA256"]) {
    assert.ok(script.includes(term), term);
  }
  const historical = read("./verify-v54-v55-restore-contract.py");
  assert.ok(historical.includes('"V55_OPERATIONAL_READINESS_SQL", "EXPECTED_V55_OPERATIONAL_READINESS"'));
  assert.ok(!historical.includes("FINAL_OPERATIONAL_READINESS_SQL"));
  const verifier = read("./verify-supabase-contracts-local.sh");
  for (const term of ["verify-v55-v56-restore-contract.py", "verify-automation-concurrency.py", "SET UNLOGGED", "AUTOMATION_FUNCTION_NEGATIVES", "AUTOMATION_TABLE_NEGATIVES", "automation_tables_v56", "automation_functions_v56"]) assert.ok(verifier.includes(term), term);
});

// Exercise the direct-entry evaluation point with provider work replaced by a
// local probe. Importing the module alone would miss declarations after main().
test("direct CLI entry can read the V56 raw queries before starting work", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "koaryu-entry-order-"));
  try {
    let source = read("./studio-comp-migration-rollout.mjs");
    source = source.replace(/from "(\.\/[^"\n]+)"/g, (_match, name) =>
      `from "${new URL(name, new URL("./studio-comp-migration-rollout.mjs", import.meta.url)).href}"`);
    const entry = /  main\(\)\.catch\(\(error\) => \{[\s\S]*?\n  \}\);/;
    assert.equal(source.match(entry)?.length, 1);
    source = source.replace(entry, `  process.stdout.write(JSON.stringify([
      V56_AUTOMATION_TABLE_STATE_SQL, V56_AUTOMATION_FUNCTION_STATE_SQL
    ].map(value => typeof value === "string" && value.includes("automation"))));`);
    const filename = path.join(temporary, "rollout-entry.mjs");
    fs.writeFileSync(filename, source);
    assert.equal(execFileSync(process.execPath, [fs.realpathSync(filename)], { encoding: "utf8" }), "[true,true]");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

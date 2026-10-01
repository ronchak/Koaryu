import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CURRENT_RELEASE, releaseState } from "./release-attestation/states.mjs";
import { MIGRATION_VERSIONS } from "./release-attestation/generated-history.mjs";
import { renderPreflight } from "./release-attestation/preflight.mjs";
import { STUDENT_PROFILE_FACTS_V55_SQL } from "./release-attestation/preflight-policy.mjs";
import schema from "./release-attestation/preflight-schema.json" with { type: "json" };

const read = relative => fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const migration = read("../supabase/migrations/20260930192626_converted_lead_enrollment_v55.sql");

test("V55 has one exact V54 predecessor and complete version-bound readiness", () => {
  assert.equal(CURRENT_RELEASE, "v55");
  const state = releaseState("v55", MIGRATION_VERSIONS);
  assert.equal(state.predecessor, "v54");
  assert.equal(state.count, 150);
  assert.equal(state.head, "20260930192626");
  assert.equal(state.pending.length, 66);
  assert.equal(state.preflight, "public.koaryu_release_schema_preflight_v36()");
  const generated = renderPreflight(state);
  assert.ok(migration.includes(generated));
  for (const fact of ["student_profile_facts_v55", "convert_lead_to_student_atomic_v55", "follow_up_lead_atomic_v55"]) {
    assert.ok(generated.includes(fact), fact);
  }
  for (const historicalFact of ["student_profile_facts_v54", "follow_up_lead_atomic_v52"]) {
    assert.ok(!generated.includes(historicalFact), historicalFact);
  }
  assert.match(migration, /V55 requires a fully verified V54 predecessor/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.koaryu_release_schema_preflight_v35\(\)/);
  assert.match(migration, /V55 installed contracts did not verify before history registration/);
  assert.ok(migration.indexOf("FUNCTION public.follow_up_lead_atomic(") < migration.indexOf("FUNCTION public.koaryu_release_schema_preflight_v36()"));
  assert.match(migration, /v_lead\.converted_student_id IS NOT NULL[\s\S]*v_lead\.stage = 'enrolled'/);
});

test("V55 student and lead facts retain full definitions, ACLs and minor bindings", () => {
  for (const fact of ["pg_get_functiondef", "prosrc", "aclexplode", "pg_get_userbyid", "proconfig", "pg_get_triggerdef", "tgenabled", "tgtype", "tgargs", "binding_matches"]) {
    assert.ok(STUDENT_PROFILE_FACTS_V55_SQL.includes(fact), fact);
  }
  for (const key of ["convert_lead_to_student_atomic_v55", "follow_up_lead_atomic_v55"]) {
    const check = schema.checks[key];
    assert.equal(check.kind, "function_contract");
    assert.equal(check.securityDefiner, false);
    assert.equal(check.volatility, "v");
    assert.equal(check.returnType, "public.leads");
    assert.deepEqual(check.acl, [["postgres", "postgres", "EXECUTE", false], ["service_role", "postgres", "EXECUTE", false]]);
  }
  assert.equal(schema.checks.student_profile_facts_v54.expected, "9c677c2dc39dd42bda08c1da53826d94dd876d687dbaf920a2597be8a8e8b586");
  assert.equal(schema.checks.follow_up_lead_atomic_v52.expected, "128596070e145066d03b1289ef37ef791c8ad46cf3176ba4241448bcae4dc348");
  const historical = fs.readFileSync(fileURLToPath(new URL("../supabase/migrations/20260930024404_student_profile_qa_v54.sql", import.meta.url)));
  // V54 was deliberately repaired after its production apply rolled back.
  // This source identity changed for the missing-only trigger repair, not for V55 business SQL.
  assert.equal(createHash("sha256").update(historical).digest("hex"), "7bc935faabaf3c26e34d94e2ea91be62ddde68f610ef3a990f04e4bdc36deebe");
});

test("V55 restore requires exact retained rows and proves archived/null enrollment and minor preservation on both copies", () => {
  const script = read("./verify-v54-v55-restore-contract.py");
  for (const text of ["for database, is_restored", "normalization_plan", "snapshot(database) == before", "V54_OPERATIONAL_READINESS_SQL", "V55_STUDENT_PROFILE_STATE_SQL", "V55_LEAD_CONVERSION_STATE_SQL", "V55_LEAD_FOLLOW_UP_STATE_SQL", "archived-program enrollment or keyed retry mismatch", "null-program enrollment or exact retry mismatch", "converted minor lost explicit minor knowledge", "restoration changed conversion facts", "Restore proof edited its source rows"]) {
    assert.ok(script.includes(text), text);
  }
  assert.ok(!script.includes("verify_upgrade_snapshot("));
  const historical = read("./verify-v53-v54-restore-contract.py");
  assert.ok(historical.includes('"V54_OPERATIONAL_READINESS_SQL", "EXPECTED_V54_OPERATIONAL_READINESS"'));
  assert.ok(!historical.includes("FINAL_OPERATIONAL_READINESS_SQL"));
});

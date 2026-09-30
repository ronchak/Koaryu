import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { CURRENT_RELEASE, releaseState } from "./release-attestation/states.mjs";
import { MIGRATION_VERSIONS } from "./release-attestation/generated-history.mjs";
import { renderPreflight } from "./release-attestation/preflight.mjs";
import { STUDENT_PROFILE_FACTS_V54_SQL } from "./release-attestation/preflight-policy.mjs";

const migration = fs.readFileSync(new URL("../supabase/migrations/20260930024404_student_profile_qa_v54.sql", import.meta.url), "utf8");

test("V54 has one exact successor and a guarded V53 compatibility consumer", () => {
  assert.equal(CURRENT_RELEASE, "v54");
  const state = releaseState("v54", MIGRATION_VERSIONS);
  assert.equal(state.predecessor, "v53");
  assert.equal(state.count, 149);
  assert.equal(state.pending.length, 65);
  assert.equal(state.preflight, "public.koaryu_release_schema_preflight_v35()");
  assert.match(renderPreflight(state), /student_profile_facts_v54/);
  assert.match(migration, /V54 requires a fully verified V53 predecessor/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.koaryu_release_schema_preflight_v34/);
  assert.ok(migration.indexOf("CREATE FUNCTION public.student_business_date") < migration.indexOf("CREATE OR REPLACE FUNCTION public.set_student_is_minor"));
  assert.match(migration, /lead\.converted_student_id = student\.id[\s\S]*lead\.studio_id = student\.studio_id[\s\S]*lead\.is_minor IS TRUE/);
});

test("student profile facts cover installed definitions, complete ACLs and both exact trigger bindings", () => {
  for (const fact of ["pg_get_functiondef", "prosrc", "aclexplode", "pg_get_userbyid", "proconfig", "pg_get_triggerdef", "tgenabled", "tgtype", "tgargs", "tgrelid=pg_catalog.to_regclass('public.students')", "binding_matches"]) {
    assert.ok(STUDENT_PROFILE_FACTS_V54_SQL.includes(fact), fact);
  }
  for (const signature of ["public.student_business_date(uuid)", "public.validate_student_birth_date()", "public.set_student_is_minor()", "public.convert_lead_to_student_atomic", "private.write_student_profile_atomic"]) {
    assert.ok(STUDENT_PROFILE_FACTS_V54_SQL.includes(signature), signature);
  }
});

test("restore comparison accepts only source minor correction and refuses other retained row changes", () => {
  const fixture = new URL("./release-attestation/fixtures/python-v54-business.py.inc", import.meta.url).pathname;
  const script = `import json,copy\nfrom pathlib import Path\nnamespace={"json":json,"require":lambda condition,message: condition or (_ for _ in ()).throw(AssertionError(message))}\nexec(Path(${JSON.stringify(fixture)}).read_text(),namespace)\ncheck=namespace["verify_upgrade_snapshot"]\nbefore={"public.students":[{"id":"s","studio_id":"dojo","date_of_birth":None,"is_minor":False,"updated_at":"2026-01-01","legal_first_name":"Minor"},{"id":"adult","studio_id":"dojo","date_of_birth":"2000-01-01","is_minor":False,"updated_at":"2026-01-01"}],"public.leads":[{"converted_student_id":"s","studio_id":"dojo","is_minor":True},{"converted_student_id":"adult","studio_id":"dojo","is_minor":True}],"public.guardians":[{"id":"g","first_name":"Guardian"}]}\nafter=copy.deepcopy(before);after["public.students"][0].update(is_minor=True,updated_at="2026-09-30")\nassert check(before,after)\nassert not check(before,before)\nfor table,field,value in [("public.students","legal_first_name","Changed"),("public.guardians","first_name","Changed")]:\n changed=copy.deepcopy(after);changed[table][0][field]=value;assert not check(before,changed)\nchanged=copy.deepcopy(after);changed["public.students"][1]["is_minor"]=True;assert not check(before,changed)\nprint("verified")\n`;
  assert.equal(execFileSync("python3", ["-c", script], { encoding: "utf8" }).trim(), "verified");
});

test("V54 logical restore upgrades canonical and restored copies and exercises guarded continuation", () => {
  const script = fs.readFileSync(new URL("./verify-v53-v54-restore-contract.py", import.meta.url), "utf8");
  for (const text of ["for database, is_restored", "normalization_plan", "verify_upgrade_snapshot(before, snapshot(database))", "V54_STUDENT_PROFILE_STATE_SQL", "V53_OPERATIONAL_READINESS_SQL", "Restored profile accepted a future birth date", "Restored profile did not add a guardian", "Restore proof edited its source rows"]) {
    assert.ok(script.includes(text), text);
  }
});

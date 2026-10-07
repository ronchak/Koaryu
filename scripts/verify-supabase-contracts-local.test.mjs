import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { V52_LEAD_RECEIPT_STATE_SQL, V52_LEAD_UPDATE_STATE_SQL } from "./studio-comp-migration-rollout.mjs";

const verifier = fs.readFileSync(new URL("./verify-supabase-contracts-local.sh", import.meta.url), "utf8");
const start = verifier.indexOf("assert_payment_writer_rejects() {");
const end = verifier.indexOf("\nwhile IFS='|' read -r writer_name", start);
assert.ok(start >= 0 && end > start);
const helper = verifier.slice(start, end);

for (const [name, query] of [["unterminated receipt query", V52_LEAD_RECEIPT_STATE_SQL], ["terminated writer query", V52_LEAD_UPDATE_STATE_SQL]]) {
  test(`negative verifier separates ${name} from its readiness assertion`, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "koaryu-sql-composition-"));
    try {
      fs.writeFileSync(path.join(temporary, "query.sql"), query);
      const mock = path.join(temporary, "psql");
      fs.writeFileSync(mock, `#!/bin/bash
if [[ "$*" == *--command=* ]]; then printf 'baseline\\n'; exit; fi
input="$(cat)"
if [[ "$input" == BEGIN* ]]; then
  printf '%s\\n' "$input" > "$COMPOSITION_DIR/composed.sql"
  printf 'mutated\\n'
else
  printf 'expected\\n'
fi
`, { mode: 0o755 });
      const harness = `set -euo pipefail
PSQL="$COMPOSITION_DIR/psql"
psql_args=(--no-psqlrc)
readiness_snapshot_sql=baseline
readiness_before=baseline
current_readiness_sql=baseline
current_readiness_before=baseline
${helper}
query="$(cat "$COMPOSITION_DIR/query.sql")"
assert_payment_writer_rejects test "SELECT 1;" "$query" expected required_failure
`;
      execFileSync("bash", ["-c", harness], { env: { ...process.env, COMPOSITION_DIR: temporary }, encoding: "utf8" });
      const sql = fs.readFileSync(path.join(temporary, "composed.sql"), "utf8");
      assert.match(sql, /;\s*DO \$check\$/, "The raw query must end before the DO readiness assertion");
      assert.ok(sql.includes(query.trim()), "The helper must retain the actual raw query");
      assert.match(sql, /\$check\$;\s*ROLLBACK;/);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}


test("V56 keeps all restore steps, exact inventory and the complete readiness/lead probes", () => {
  assert.match(verifier, /migration_files\[@\].*-ne 152/);
  assert.match(verifier, /verification_files\[@\].*-ne 75/);
  for (const text of [
    "verify-v53-v54-restore-contract.py", "verify-v54-v55-restore-contract.py", "verify-v55-v56-restore-contract.py",
    "[V56 readiness]", "[V56 release]", "[V56 semantics]",
    "V54_OPERATIONAL_READINESS_SQL|EXPECTED_V54_OPERATIONAL_READINESS",
    "V55_LEAD_CONVERSION_STATE_SQL|EXPECTED_V55_LEAD_CONVERSION_STATE",
    "V55_LEAD_FOLLOW_UP_STATE_SQL|EXPECTED_V55_LEAD_FOLLOW_UP_STATE",
    "ARRAY[37,36,35,34,33,32,31,30,29,28,27,26,25,24,23,22,21,20,19,18]",
    "verify-lead-command-concurrency.py", "verify-automation-concurrency.py",
    "unlogged outbox|ALTER TABLE public.automation_deliveries SET UNLOGGED;",
    "V56_AUTOMATION_TABLE_STATE_SQL|EXPECTED_V56_AUTOMATION_TABLE_STATE",
  ]) assert.ok(verifier.includes(text), text);
  assert.ok(verifier.indexOf('if [[ "$migration_filename" == "20260930192626')
    < verifier.indexOf('echo "[migration $migration_index/$migration_total] RUN'));
  const leadSuite = fs.readFileSync(new URL("./verify-lead-command-concurrency.py", import.meta.url), "utf8");
  assert.ok(leadSuite.includes("len(results) == 75"));
  assert.ok(leadSuite.includes("len({row[\"case\"] for row in results}) == 75"));
});


test("final V56 semantics uses only V55 pins for changed lead/student definitions", () => {
  const block = /done <<'V56_CHECKS'\n([\s\S]*?)\nV56_CHECKS/.exec(verifier)?.[1];
  assert.ok(block, "The final semantic loop must exist");
  for (const historical of ["V52_LEAD_FOLLOW_UP_STATE", "V54_STUDENT_PROFILE_STATE"]) {
    assert.ok(!block.includes(historical), historical);
  }
  for (const pair of [
    "V55_STUDENT_PROFILE_STATE_SQL|EXPECTED_V55_STUDENT_PROFILE_STATE",
    "V55_LEAD_CONVERSION_STATE_SQL|EXPECTED_V55_LEAD_CONVERSION_STATE",
    "V55_LEAD_FOLLOW_UP_STATE_SQL|EXPECTED_V55_LEAD_FOLLOW_UP_STATE",
  ]) assert.ok(block.includes(pair), pair);
  const uiContract = fs.readFileSync(new URL("../supabase/verification/release_ui_atomic_contract.sql", import.meta.url), "utf8");
  assert.equal(uiContract.match(/'student_profile_facts_v55'/g)?.length, 2);
  assert.ok(!uiContract.includes("'student_profile_facts_v54'"));
  assert.ok(uiContract.includes("public.koaryu_release_schema_preflight_v35()"));
  assert.ok(uiContract.includes("public.koaryu_release_schema_preflight_v34()"));
  assert.ok(uiContract.includes("(149,'20260930024404'), (150,'20260930192626')"));
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { V52_LEAD_RECEIPT_STATE_SQL, V52_LEAD_UPDATE_STATE_SQL } from "./studio-comp-migration-rollout.mjs";
import { CURRENT_RELEASE, releaseState } from "./release-attestation/states.mjs";
import { MIGRATION_VERSIONS } from "./release-attestation/generated-history.mjs";

const verifier = fs.readFileSync(new URL("./verify-supabase-contracts-local.sh", import.meta.url), "utf8");
const start = verifier.indexOf("assert_payment_writer_rejects() {");
const end = verifier.indexOf("\nwhile IFS='|' read -r writer_name", start);
assert.ok(start >= 0 && end > start);
const helper = verifier.slice(start, end);

test("direct CI student/rank race accepts the declared current release and retained predecessors", () => {
  const race = fs.readFileSync(new URL("./verify-student-profile-rank-plan-concurrency.sh", import.meta.url), "utf8");
  const profiles = [...race.matchAll(/(?:IF|ELSIF) history_count=(\d+) AND history_head='(\d+)'\s+AND to_regprocedure\('[^']+'\) IS (?:NOT )?NULL THEN\s+phase:='(v\d+)'; preflight:='([^']+)';/g)];
  const expected = [...new Set(["v56", "v57", "v58", "v59", "v60", CURRENT_RELEASE])].map(id => {
    const state = releaseState(id, MIGRATION_VERSIONS);
    return [String(state.count), state.head, id, state.preflight];
  });
  assert.deepEqual(profiles.map(match => match.slice(1)), expected);
  assert.match(race, /readiness\.ready IS DISTINCT FROM true/);
  assert.match(race, /readiness\.migration_count IS DISTINCT FROM history_count/);
  assert.match(race, /readiness\.migration_head IS DISTINCT FROM history_head/);
  assert.match(race, /readiness\.security_failures IS DISTINCT FROM ARRAY\[\]::TEXT\[\]/);
  assert.match(race, /v57\|v58\|v59\|v60\) expected_delete_error="ERROR:  AUTOMATION_STUDIO_BUSY"/);
});

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
compatibility_proven_keys=" "
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
  assert.match(verifier, /migration_files\[@\].*-ne 156/);
  assert.match(verifier, /verification_files\[@\].*-ne 77/);
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


test("current-candidate billing concurrency runs once after complete V58 readiness", () => {
  const invocation = 'run_interruptible python3 "$ROOT_DIR/scripts/verify-billing-command-concurrency.py" "$PSQL" "$SOCKET_DIR" "$PG_PORT"';
  assert.equal(verifier.split(invocation).length - 1, 1);
  const readiness = verifier.indexOf('echo "[V58 readiness] PASS complete GA catalog and authority"');
  const billing = verifier.indexOf(invocation);
  assert.ok(readiness >= 0 && readiness < billing);
});

test("V59 exercises rewritten callers after installing the timezone migration", () => {
  const installed = verifier.indexOf('--file="$MIGRATION_DIR/20261014083106_timezone_names_reference_v59.sql"');
  const callers = verifier.indexOf('for verification_filename in belt_test_recipient_contract.sql workflow_current_facts_contract.sql workflow_invoice_episode_contract.sql workflow_advance_contract.sql;');
  assert.ok(installed >= 0 && callers > installed);
  assert.match(verifier, /V58_OPERATIONAL_READINESS_SQL/);
  assert.match(verifier, /verify-v58-v59-restore-contract\.py/);
  assert.match(verifier, /EXPLAIN ANALYZE SELECT private\.timezone_name_known/);
});

test("V60 runs the missed-class contract only after installing the gap guards", () => {
  const installed = verifier.indexOf('--file="$MIGRATION_DIR/20261021093000_missed_class_gap_guards_v60.sql"');
  const contract = verifier.indexOf('--file="$VERIFICATION_DIR/missed_class_automation_contract.sql"');
  assert.ok(installed >= 0 && contract > installed);
  assert.equal(verifier.split('--file="$VERIFICATION_DIR/missed_class_automation_contract.sql"').length - 1, 1);
  assert.match(verifier, /workflow_advance_contract\.sql\|missed_class_automation_contract\.sql\) continue ;;/);
  assert.match(verifier, /verify-v59-v60-restore-contract\.py/);
  assert.ok(verifier.indexOf("V59_OPERATIONAL_READINESS_SQL") < installed);
  assert.ok(verifier.indexOf("FINAL_OPERATIONAL_READINESS_SQL", installed) > installed);
});

test("CI parts gate every in-loop restore proof to history and stop after their own checks", () => {
  const historyExit = verifier.indexOf('if [[ "$SUITE_PART" == history ]]; then');
  assert.ok(historyExit > 0);
  const lines = verifier.slice(0, historyExit).split("\n");
  let proofs = 0;
  lines.forEach((line, index) => {
    if (!/scripts\/verify-v\d+-v\d+-restore-contract\./.test(line)) return;
    proofs += 1;
    const opener = lines.slice(0, index).reverse().find((candidate) => /^\s+if (part_enabled|\[\[)/.test(candidate));
    assert.match(opener, /part_enabled history/, line);
  });
  assert.equal(proofs, 25);
  const driftStart = verifier.indexOf("if part_enabled drift; then\nassert_history_index_rejects() {");
  const driftExit = verifier.indexOf('fi\nif [[ "$SUITE_PART" == drift ]]; then');
  assert.ok(historyExit < driftStart && driftStart < driftExit);
  assert.ok(verifier.indexOf("[concurrency] RUN Core checkout") > driftExit);
  assert.ok(verifier.indexOf("[payment writer negative] RUN") > driftStart);
  assert.ok(verifier.indexOf("[payment writer negative] RUN") < driftExit);
});

test("an unknown CI part is refused before any database work", () => {
  const result = spawnSync("bash", [fileURLToPath(new URL("./verify-supabase-contracts-local.sh", import.meta.url))], {
    env: { PATH: process.env.PATH, KOARYU_DB_SUITE_PART: "everything" },
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must be all, current, drift or history/);
});

test("payment writer negatives prove the compatibility chain once per failure key and readiness once after rollback", () => {
  assert.match(helper, /compatibility_proven_keys" != \*" \$expected_failure "\*/);
  assert.ok(!helper.includes("readiness_after"));
  const finalCheck = verifier.indexOf("[payment writer negative] FAIL rollback did not restore the exact V18-V37 readiness baseline");
  const lastCaller = verifier.lastIndexOf("assert_payment_writer_rejects \"$term refuses unknown\"");
  assert.ok(lastCaller > 0 && finalCheck > lastCaller);
});


test("V61 runs the complete import proof after upgrade and gates the former newest restore to history", () => {
  const installed = verifier.indexOf('--file="$MIGRATION_DIR/20261022190000_student_import_identity_guard_v61.sql"');
  assert.ok(installed > verifier.indexOf('verify-v60-v61-restore-contract.py'));
  assert.ok(verifier.indexOf('--file="$VERIFICATION_DIR/student_import_row_atomic_contract.sql"', installed) > installed);
  assert.ok(verifier.indexOf('--file="$VERIFICATION_DIR/release_ui_atomic_contract.sql"', installed) > installed);
  assert.match(verifier, /if part_enabled history; then\n  echo "\[V60 upgrade\/restore\] RUN[^\n]*\n  run_interruptible python3 "\$ROOT_DIR\/scripts\/verify-v59-v60-restore-contract.py"/);
  assert.match(verifier, /V61_OPERATIONAL_READINESS_SQL/);
});

test("history branch reaches the retained V60 proof before its early exit", () => {
  const start = verifier.indexOf('if [[ "$SUITE_PART" == history ]]; then');
  const end = verifier.indexOf('\necho "[V33 hash parity]', start);
  assert.ok(start >= 0 && end > start);
  const branch = verifier.slice(start, end);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "koaryu-history-dispatch-"));
  try {
    for (const part of ["history", "current", "all"]) {
      const trace = path.join(temporary, part);
      const harness = `set -euo pipefail
SUITE_PART="${part}"
ROOT_DIR=/candidate
MIGRATION_DIR=/candidate/supabase/migrations
PSQL=psql
PG_DUMP=pg_dump
PG_RESTORE=pg_restore
CREATEDB=createdb
SOCKET_DIR=/owned/socket
PG_PORT=5432
TEMP_DIR=/owned
psql_args=(--no-psqlrc)
run_interruptible() { printf '%s\\n' "$*" >> "$DISPATCH_TRACE"; }
${branch}
printf 'non-history dispatch\\n'
`;
      const output = execFileSync("bash", ["-c", harness], {
        env: { ...process.env, DISPATCH_TRACE: trace }, encoding: "utf8",
      });
      if (part !== "history") {
        assert.equal(output.trim(), "non-history dispatch");
        assert.ok(!fs.existsSync(trace));
        continue;
      }
      const calls = fs.readFileSync(trace, "utf8").trim().split("\n");
      const migrations = [
        ["20261005105341", "automation_workflow_graph_v57"],
        ["20261013013243", "live_billing_authority_repairs_v58"],
        ["20261014083106", "timezone_names_reference_v59"],
      ];
      assert.equal(calls.length, 4);
      migrations.forEach(([version, name], index) => {
        assert.ok(calls[index].includes(`--file=/candidate/supabase/migrations/${version}_${name}.sql`));
        assert.ok(calls[index].includes(`VALUES('${version}','${name}')`));
      });
      assert.equal(calls[3], "python3 /candidate/scripts/verify-v59-v60-restore-contract.py pg_dump pg_restore createdb psql /owned/socket 5432 /owned /candidate");
      assert.ok(!output.includes("non-history dispatch"));
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

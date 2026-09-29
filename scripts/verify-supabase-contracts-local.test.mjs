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

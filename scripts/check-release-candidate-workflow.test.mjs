import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { validateReleaseCandidateWorkflow } from "./check-release-candidate-workflow.mjs";

const workflowPath = new URL(
  "../.github/workflows/release-candidate.yml",
  import.meta.url,
);
const workflow = fs.readFileSync(workflowPath, "utf8");

test("release-candidate workflow covers every pull request path", () => {
  assert.deepEqual(validateReleaseCandidateWorkflow(workflow), []);
});

test("release-candidate workflow rejects a path-filtered pull request", () => {
  const weakened = workflow.replace(
    "  pull_request:\n",
    "  pull_request:\n    paths:\n      - frontend/**\n",
  );

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /must not use path filters/,
  );
});

test("release-candidate workflow rejects a missing remediation ledger count check", () => {
  const weakened = workflow.replace("npm run check:remediation-ledger", "npm run omitted-ledger-check");

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /npm run check:remediation-ledger/,
  );
});

test("release-candidate workflow rejects a missing required suite", () => {
  const weakened = workflow.replace(
    "scripts/verify-supabase-contracts.sh",
    "scripts/omitted-database-check.sh",
  );

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /scripts\/verify-supabase-contracts\.sh/,
  );
});

test("release-candidate workflow requires isolated restore and concurrency proofs", () => {
  const weakened = workflow.replace(
    "npm run check:supabase-contracts-local",
    "npm run omitted-restore-check",
  );
  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /npm run check:supabase-contracts-local/,
  );
});

test("release-candidate workflow requires the exact-SHA verifier tests", () => {
  const weakened = workflow.replace(
    "node --test scripts/verify-deployed-release.test.mjs",
    "node --test scripts/unrelated-release-test.mjs",
  );

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /verify-deployed-release\.test\.mjs/,
  );
});

test("release-candidate repository controls require complete history", () => {
  const weakened = workflow.replace("          fetch-depth: 0\n", "");

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /fetch complete history/,
  );
});

test("release-candidate workflow rejects a missing aggregate dependency", () => {
  const weakened = workflow.replace("      - database\n", "");

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /depend on every required candidate job/,
  );
});

test("release-candidate workflow rejects removed aggregate assertions", () => {
  const weakened = workflow.replace(
    /          test \"\$[A-Z_]+_RESULT\" = success\n/g,
    "          true\n",
  );

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /aggregate gate must fail closed/,
  );
});

test("release-candidate workflow rejects a removed or renamed performance job", () => {
  const weakened = workflow.replace(
    "  performance-regression:\n",
    "  performance-check:\n",
  );

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /workflow must define the performance-regression job/,
  );
});

test("release-candidate workflow rejects a replaced performance gate command", () => {
  const weakened = workflow.replace(
    'run: npm run check:performance-regression -- --expected-sha "$EXPECTED_HEAD_SHA"',
    "run: echo performance gate omitted",
  );

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /missing control: run: npm run check:performance-regression/,
  );
});

test("release-candidate workflow requires the versioned performance budget manifest", () => {
  const weakened = workflow.replace(
    /performance\/dashboard-home-budget\.json/g,
    "performance/removed-budget.json",
  );

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /missing control: performance\/dashboard-home-budget\.json/,
  );
});

test("release-candidate workflow rejects a missing aggregate performance dependency", () => {
  const weakened = workflow.replace("      - performance-regression\n", "");

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /depend on every required candidate job exactly once/,
  );
});

test("release-candidate workflow rejects a missing aggregate performance assertion", () => {
  const weakened = workflow.replace(
    '          test "$PERFORMANCE_REGRESSION_RESULT" = success\n',
    "          true\n",
  );

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /aggregate gate must fail closed on performance-regression/,
  );
});

test("database skips and parts require the repository-owned selection", () => {
  for (const [before, after] of [
    ["    needs: repository-controls\n", ""],
    [
      "    if: ${{ needs.repository-controls.outputs.database-scope != 'skip' }}",
      "    if: false",
    ],
    ["database-scope: ${{ steps.scope.outputs.database-scope }}", "database-scope: skip"],
    ["database-parts: ${{ steps.scope.outputs.database-parts }}", "database-parts: '[\"current\"]'"],
    [
      "        part: ${{ fromJSON(needs.repository-controls.outputs.database-parts) }}",
      "        part: [current]",
    ],
    [
      "BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}",
      "BASE_SHA: main",
    ],
    ['test "$DATABASE_PARTS" = "$expected_parts"', "true"],
    ['test "$DATABASE_ISOLATED_RESULT" = skipped', "true"],
    ["*) exit 1 ;;", "*) true ;;"],
    ['git show "$BASE_SHA:scripts/select-release-checks.mjs"', 'git show "HEAD:scripts/select-release-checks.mjs"'],
    ['GITHUB_OUTPUT="$scope_output" node "$scope_script"', 'node scripts/select-release-checks.mjs'],
    ["selected=full", "selected=skip"],
    ["KOARYU_DB_SUITE_PART: ${{ matrix.part }}", "KOARYU_DB_SUITE_PART: all"],
  ]) {
    assert.notEqual(workflow.replace(before, after), workflow, before);
    assert.notDeepEqual(
      validateReleaseCandidateWorkflow(workflow.replace(before, after)),
      [],
      before,
    );
  }
});

test("application and security jobs cannot acquire skip conditions", () => {
  for (const job of [
    "repository-controls",
    "frontend",
    "backend",
    "performance-regression",
    "static-analysis",
  ]) {
    const changed = workflow.replace(
      `  ${job}:\n`,
      `  ${job}:\n    if: false\n`,
    );
    assert.match(
      validateReleaseCandidateWorkflow(changed).join("\n"),
      /must remain unconditional/,
    );
  }
});

// Execute the actual aggregate shell rather than reimplementing its acceptance
// logic in a test. The GHA runner uses errexit for its default bash run steps.
const aggregateRun = workflow
  .slice(workflow.indexOf("  release-candidate:"))
  .split("        run: |\n")[1]
  .split("\n")
  .filter((line) => line.startsWith("          "))
  .map((line) => line.slice(10))
  .join("\n");
const fullParts = '["current","drift","history"]';
const currentParts = '["current","drift"]';
function gate(overrides = {}) {
  const env = {
    PATH: process.env.PATH,
    DATABASE_SCOPE: "full",
    DATABASE_PARTS: fullParts,
    REPOSITORY_RESULT: "success",
    FRONTEND_RESULT: "success",
    BACKEND_RESULT: "success",
    DATABASE_RESULT: "success",
    DATABASE_ISOLATED_RESULT: "success",
    PERFORMANCE_REGRESSION_RESULT: "success",
    STATIC_ANALYSIS_RESULT: "success",
    ...overrides,
  };
  return spawnSync("bash", ["-e", "-o", "pipefail", "-c", aggregateRun], {
    env,
  }).status;
}
const skipped = {
  DATABASE_SCOPE: "skip",
  DATABASE_RESULT: "skipped",
  DATABASE_ISOLATED_RESULT: "skipped",
};

test("actual aggregate accepts full or current checks and only the explicitly selected database skip", () => {
  assert.equal(gate(), 0);
  assert.equal(gate({ DATABASE_SCOPE: "current", DATABASE_PARTS: currentParts }), 0);
  assert.equal(gate(skipped), 0);
});

test("actual aggregate refuses missing/unknown selection, mismatched parts and failed, canceled or unexpected database outcomes", () => {
  for (const value of ["", "unknown", "FULL", "docs-only"])
    assert.notEqual(gate({ DATABASE_SCOPE: value }), 0, value);
  assert.notEqual(gate({ DATABASE_PARTS: currentParts }), 0);
  assert.notEqual(gate({ DATABASE_SCOPE: "current" }), 0);
  assert.notEqual(gate({ DATABASE_PARTS: "" }), 0);
  for (const name of ["DATABASE", "DATABASE_ISOLATED"]) {
    for (const result of ["skipped", "failure", "cancelled", ""]) {
      assert.notEqual(gate({ [`${name}_RESULT`]: result }), 0, `${name}=${result}`);
      assert.notEqual(
        gate({ DATABASE_SCOPE: "current", DATABASE_PARTS: currentParts, [`${name}_RESULT`]: result }),
        0,
        `current ${name}=${result}`,
      );
    }
    for (const result of ["success", "failure", "cancelled", ""])
      assert.notEqual(gate({ ...skipped, [`${name}_RESULT`]: result }), 0, `skip ${name}=${result}`);
  }
});

test("actual database-skip gate still refuses any other failed, skipped or canceled suite", () => {
  for (const name of [
    "REPOSITORY",
    "FRONTEND",
    "BACKEND",
    "PERFORMANCE_REGRESSION",
    "STATIC_ANALYSIS",
  ]) {
    for (const result of ["failure", "skipped", "cancelled", ""]) {
      assert.notEqual(
        gate({ ...skipped, [`${name}_RESULT`]: result }),
        0,
        `${name}=${result}`,
      );
    }
  }
});

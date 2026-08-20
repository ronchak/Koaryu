import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

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
    /performance\/dashboard-summary-budget\.json/g,
    "performance/removed-budget.json",
  );

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /missing control: performance\/dashboard-summary-budget\.json/,
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

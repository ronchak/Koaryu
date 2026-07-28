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

test("release-candidate workflow requires the authenticated restore fixture contract", () => {
  const weakened = workflow.replace(
    "npm run test:authenticated-restore",
    "node -e 'console.log(\"restore check omitted\")'",
  );

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /npm run test:authenticated-restore/,
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

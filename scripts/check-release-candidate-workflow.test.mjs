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

test("release-candidate workflow rejects a missing aggregate dependency", () => {
  const weakened = workflow.replace("      - database\n", "");

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /depend on every required candidate job/,
  );
});

test("release-candidate workflow rejects a missing browser-smoke dependency", () => {
  const weakened = workflow.replace("      - browser-smoke\n", "");

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /depend on every required candidate job/,
  );
});

test("release-candidate workflow rejects a conditional required browser smoke", () => {
  const weakened = workflow.replace(
    "      - name: Run required browser smoke\n",
    "      - name: Run required browser smoke\n        if: false\n",
  );

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /browser-smoke step must not be conditional/,
  );
});

test("release-candidate workflow rejects an unbounded browser-smoke job", () => {
  const weakened = workflow.replace(
    "  browser-smoke:\n    name: Required production browser smoke\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n",
    "  browser-smoke:\n    name: Required production browser smoke\n    runs-on: ubuntu-latest\n",
  );

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /timeout of at most 15 minutes/,
  );
});

test("release-candidate workflow rejects always-uploaded browser artifacts", () => {
  const weakened = workflow.replace(
    "      - name: Preserve browser failure artifacts\n        if: failure()\n",
    "      - name: Preserve browser failure artifacts\n        if: always()\n",
  );

  assert.match(
    validateReleaseCandidateWorkflow(weakened).join("\n"),
    /retain only bounded failure artifacts/,
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

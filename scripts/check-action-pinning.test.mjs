import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  validateWorkflowActionPins,
  validateWorkflowDirectory,
} from "./check-action-pinning.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workflowDirectory = path.join(scriptDirectory, "..", ".github", "workflows");

test("repository workflows pin every remote action immutably", () => {
  assert.deepEqual(validateWorkflowDirectory(workflowDirectory), []);
});

test("floating action tags are rejected", () => {
  const workflow = `
steps:
  - uses: actions/checkout@v7
`;

  assert.match(
    validateWorkflowActionPins(workflow).join("\n"),
    /full 40-character commit SHA/,
  );
});

test("full action pins require readable version comments", () => {
  const workflow = `
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
`;

  assert.match(
    validateWorkflowActionPins(workflow).join("\n"),
    /readable version comment/,
  );
});

test("non-canonical uses keys fail closed instead of bypassing the scan", () => {
  const workflow = `
steps:
  - uses : actions/checkout@v7
`;

  assert.match(
    validateWorkflowActionPins(workflow).join("\n"),
    /single-line, reviewable action reference/,
  );
});

test("local actions and reusable workflows remain allowed", () => {
  const workflow = `
steps:
  - uses: ./.github/actions/local-check
`;

  assert.deepEqual(validateWorkflowActionPins(workflow), []);
});

test("Docker action references fail closed without an automated update path", () => {
  const workflow = `
steps:
  - uses: docker://alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`;

  assert.match(
    validateWorkflowActionPins(workflow).join("\n"),
    /configured GitHub Actions updater cannot maintain/,
  );
});

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const mergeScript = fileURLToPath(new URL("./merge-release-pr.sh", import.meta.url));

function validPullRequest() {
  return {
    baseRefOid: "base-sha",
    headRefOid: "head-sha",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "Release candidate gate",
        workflowName: "Release candidate",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
      {
        __typename: "StatusContext",
        context: "Vercel",
        state: "SUCCESS",
      },
    ],
  };
}

function runGuard(payload, { expectedHead = "head-sha", expectedBase = "base-sha" } = {}) {
  const fakeBin = mkdtempSync(path.join(tmpdir(), "koaryu-merge-guard-"));
  const callLog = path.join(fakeBin, "calls.log");
  const fakeGh = path.join(fakeBin, "gh");
  writeFileSync(
    fakeGh,
    `#!/bin/sh
printf '%s\n' "$*" >> "$GH_CALL_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s' "$PR_JSON"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  exit 0
fi
exit 1
`,
  );
  chmodSync(fakeGh, 0o755);

  try {
    const result = spawnSync(
      mergeScript,
      ["7", expectedHead, expectedBase],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          GH_CALL_LOG: callLog,
          PR_JSON: JSON.stringify(payload),
        },
      },
    );
    const calls = readFileSync(callLog, "utf8").trim().split("\n");
    return { ...result, calls };
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

test("guarded merge passes the exact head to GitHub after every check succeeds", () => {
  const result = runGuard(validPullRequest());

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.calls.at(-1),
    "pr merge 7 --merge --match-head-commit head-sha",
  );
});

const rejectionCases = [
  ["head drift", (payload) => { payload.headRefOid = "moved-head"; }, /PR head moved/],
  ["base drift", (payload) => { payload.baseRefOid = "moved-base"; }, /PR base moved/],
  ["draft", (payload) => { payload.isDraft = true; }, /still a draft/],
  ["unclean merge", (payload) => { payload.mergeStateStatus = "BEHIND"; }, /not CLEAN/],
  ["missing gate", (payload) => { payload.statusCheckRollup.shift(); }, /lacks one successful/],
  [
    "duplicate gate",
    (payload) => { payload.statusCheckRollup.unshift({ ...payload.statusCheckRollup[0] }); },
    /lacks one successful/,
  ],
  [
    "wrong gate workflow",
    (payload) => { payload.statusCheckRollup[0].workflowName = "Spoofed workflow"; },
    /lacks one successful/,
  ],
  [
    "pending check",
    (payload) => {
      payload.statusCheckRollup.push({
        __typename: "CheckRun",
        name: "Pending",
        workflowName: "Other",
        status: "IN_PROGRESS",
        conclusion: "",
      });
    },
    /pending, or failing/,
  ],
  [
    "failing status",
    (payload) => { payload.statusCheckRollup[1].state = "FAILURE"; },
    /pending, or failing/,
  ],
];

for (const [name, mutate, expectedError] of rejectionCases) {
  test(`guarded merge rejects ${name}`, () => {
    const payload = validPullRequest();
    mutate(payload);
    const result = runGuard(payload);

    assert.equal(result.status, 1);
    assert.match(result.stderr, expectedError);
    assert.equal(result.calls.some((call) => call.startsWith("pr merge ")), false);
  });
}

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
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
const HEAD_SHA = "1111111111111111111111111111111111111111";
const BASE_SHA = "2222222222222222222222222222222222222222";
const MOVED_HEAD_SHA = "3333333333333333333333333333333333333333";
const MOVED_BASE_SHA = "4444444444444444444444444444444444444444";
const REPOSITORY = "ronchak/Koaryu";
const PR_FIELDS = "baseRefName,baseRefOid,headRefOid,isDraft,mergeStateStatus,statusCheckRollup";

function validPullRequest() {
  return {
    baseRefName: "main",
    baseRefOid: BASE_SHA,
    headRefOid: HEAD_SHA,
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

function validRenderService() {
  return {
    id: "srv-d7mogk1kh4rs73aq6hqg",
    name: "Koaryu",
    branch: "main",
    repo: "https://github.com/ronchak/Koaryu",
    rootDir: "backend",
    type: "web_service",
    serviceDetails: {
      url: "https://koaryu.onrender.com",
      healthCheckPath: "/health",
    },
    autoDeployTrigger: "off",
    autoDeploy: "no",
  };
}

function runGuard(
  payload,
  {
    secondPayload = payload,
    expectedHead = HEAD_SHA,
    expectedBase = BASE_SHA,
    prNumber = "7",
    ghRepo = "attacker/redirected-repository",
    renderPayload = validRenderService(),
    secondRenderPayload = renderPayload,
    renderApiKey = "test-render-api-key",
  } = {},
) {
  const fakeBin = mkdtempSync(path.join(tmpdir(), "koaryu-merge-guard-"));
  const callLog = path.join(fakeBin, "calls.log");
  const viewCount = path.join(fakeBin, "view-count");
  const fakeGh = path.join(fakeBin, "gh");
  const renderCount = path.join(fakeBin, "render-count");
  const fakeCurl = path.join(fakeBin, "curl");
  writeFileSync(
    fakeGh,
    `#!/bin/sh
printf '%s\n' "$*" >> "$GH_CALL_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  count=0
  if [ -f "$GH_VIEW_COUNT" ]; then
    count="$(sed -n '1p' "$GH_VIEW_COUNT")"
  fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$GH_VIEW_COUNT"
  if [ "$count" -eq 1 ]; then
    printf '%s' "$PR_JSON_FIRST"
  else
    printf '%s' "$PR_JSON_SECOND"
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  exit 0
fi
exit 1
`,
  );
  chmodSync(fakeGh, 0o755);
  writeFileSync(
    fakeCurl,
    `#!/bin/sh
count=0
if [ -f "$RENDER_VIEW_COUNT" ]; then
  count="$(sed -n '1p' "$RENDER_VIEW_COUNT")"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$RENDER_VIEW_COUNT"
if [ "$count" -eq 1 ]; then
  printf '%s' "$RENDER_JSON_FIRST"
else
  printf '%s' "$RENDER_JSON_SECOND"
fi
`,
  );
  chmodSync(fakeCurl, 0o755);

  try {
    const result = spawnSync(
      mergeScript,
      [prNumber, expectedHead, expectedBase],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          GH_CALL_LOG: callLog,
          GH_VIEW_COUNT: viewCount,
          GH_REPO: ghRepo,
          PR_JSON_FIRST: JSON.stringify(payload),
          PR_JSON_SECOND: JSON.stringify(secondPayload),
          RENDER_API_KEY: renderApiKey,
          RENDER_VIEW_COUNT: renderCount,
          RENDER_JSON_FIRST: JSON.stringify(renderPayload),
          RENDER_JSON_SECOND: JSON.stringify(secondRenderPayload),
        },
      },
    );
    const calls = existsSync(callLog)
      ? readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean)
      : [];
    return { ...result, calls };
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

test("guarded merge passes the exact head to GitHub after every check succeeds", () => {
  const result = runGuard(validPullRequest());

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.slice(0, 2), [
    `pr view 7 --repo ${REPOSITORY} --json ${PR_FIELDS}`,
    `pr view 7 --repo ${REPOSITORY} --json ${PR_FIELDS}`,
  ]);
  assert.equal(
    result.calls.at(-1),
    `pr merge 7 --repo ${REPOSITORY} --merge --match-head-commit ${HEAD_SHA}`,
  );
  assert.doesNotMatch(result.stdout + result.stderr, /test-render-api-key/);
  assert.match(result.stdout, /"authenticated_readback":true/);
  assert.match(result.stdout, /"auto_deploy":"off"/);
});

for (const [name, options, expectedError] of [
  [
    "enabled Render auto-deploy",
    { renderPayload: { ...validRenderService(), autoDeployTrigger: "commit", autoDeploy: "yes" } },
    /auto-deploy is not disabled/,
  ],
  [
    "wrong Render service",
    { renderPayload: { ...validRenderService(), name: "koaryu-staging" } },
    /pinned koaryu production service/,
  ],
  [
    "wrong Render service-name casing",
    { renderPayload: { ...validRenderService(), name: "koaryu" } },
    /pinned koaryu production service/,
  ],
  [
    "wrong Render service id",
    { renderPayload: { ...validRenderService(), id: "srv-other" } },
    /pinned koaryu production service/,
  ],
  [
    "wrong canonical Render identity",
    { renderPayload: { ...validRenderService(), repo: "https://github.com/attacker/Koaryu" } },
    /canonical production repository/,
  ],
  ["missing Render branch", { renderPayload: { ...validRenderService(), branch: undefined } }, /not main/],
  ["null Render branch", { renderPayload: { ...validRenderService(), branch: null } }, /not main/],
  ["empty Render branch", { renderPayload: { ...validRenderService(), branch: "" } }, /not main/],
  [
    "Render provider drift before merge",
    { secondRenderPayload: { ...validRenderService(), autoDeployTrigger: "commit" } },
    /auto-deploy is not disabled/,
  ],
  ["missing Render API key", { renderApiKey: "" }, /RENDER_API_KEY is required/],
]) {
  test(`guarded merge rejects ${name}`, () => {
    const result = runGuard(validPullRequest(), options);

    assert.equal(result.status, 1);
    assert.match(result.stderr, expectedError);
    assert.equal(result.calls.some((call) => call.startsWith("pr merge ")), false);
  });
}

const rejectionCases = [
  ["non-main base branch", (payload) => { payload.baseRefName = "codex/stacked-base"; }, /not main/],
  ["missing base branch", (payload) => { delete payload.baseRefName; }, /not main/],
  ["null base branch", (payload) => { payload.baseRefName = null; }, /not main/],
  ["empty base branch", (payload) => { payload.baseRefName = ""; }, /not main/],
  ["head drift", (payload) => { payload.headRefOid = MOVED_HEAD_SHA; }, /PR head moved/],
  ["base drift", (payload) => { payload.baseRefOid = MOVED_BASE_SHA; }, /PR base moved/],
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

test("guarded merge rejects a retargeted base in the final snapshot", () => {
  const firstPayload = validPullRequest();
  const secondPayload = validPullRequest();
  secondPayload.baseRefName = "codex/stacked-base";

  const result = runGuard(firstPayload, { secondPayload });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not main/);
  assert.equal(result.calls.filter((call) => call.startsWith("pr view ")).length, 2);
  assert.equal(result.calls.some((call) => call.startsWith("pr merge ")), false);
});

test("guarded merge rejects option-like PR input before invoking GitHub", () => {
  const result = runGuard(validPullRequest(), { prNumber: "--repo=attacker/repo" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /positive integer/);
  assert.deepEqual(result.calls, []);
});

for (const [name, options, expectedError] of [
  ["short head SHA", { expectedHead: "abc123" }, /Expected head SHA/],
  ["uppercase base SHA", { expectedBase: BASE_SHA.toUpperCase().replaceAll("2", "A") }, /Expected base SHA/],
]) {
  test(`guarded merge rejects ${name} before invoking GitHub`, () => {
    const result = runGuard(validPullRequest(), options);

    assert.equal(result.status, 2);
    assert.match(result.stderr, expectedError);
    assert.deepEqual(result.calls, []);
  });
}

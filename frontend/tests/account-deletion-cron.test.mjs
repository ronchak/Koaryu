import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

const deadmanUrl = "https://deadman.example.com/deletion-worker";
process.env.ACCOUNT_DELETION_WORKER_SECRET = "W".repeat(40);
process.env.CRON_SECRET = "cron-secret";
process.env.OPERATIONAL_ALERTS_ENABLED = "true";
process.env.BACKEND_API_URL = "https://koaryu-staging.onrender.com/api/v1";
process.env.VERCEL_TARGET_ENV = "staging";
process.env.VERCEL_GIT_COMMIT_SHA = "a".repeat(40);
process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_URL = deadmanUrl;
process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_HOST = "other.example.com";
process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_URL_SHA256 = createHash("sha256")
  .update(deadmanUrl)
  .digest("hex");
process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_BEARER_SECRET = "D".repeat(40);

const { GET } = await import(
  "../src/app/api/cron/account-deletions/process-due/route.ts?deadman-preflight-test"
);

test("account deletion cron preflights dead-man configuration before worker invocation", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return Response.json({ processed: 0 });
  };
  try {
    const response = await GET(new Request(
      "https://staging.example.test/api/cron/account-deletions/process-due",
      { headers: { authorization: "Bearer cron-secret" } },
    ));

    assert.equal(response.status, 500);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

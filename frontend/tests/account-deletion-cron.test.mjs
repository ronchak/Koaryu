import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import { handleAccountDeletionCron } from "../src/app/api/cron/account-deletions/process-due/route.ts";

const ENV_KEYS = [
  "ACCOUNT_DELETION_WORKER_SECRET",
  "BACKEND_API_URL",
  "CRON_SECRET",
  "NEXT_PUBLIC_API_URL",
  "OPERATIONAL_ALERTS_ENABLED",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_URL",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_HOST",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_URL_SHA256",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_BEARER_SECRET",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_ENV",
  "VERCEL_TARGET_ENV",
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const DEADMAN_URL = "https://deadman.example.com/deletion-worker";

function request(secret = "cron-secret") {
  return new Request(
    "https://staging.example.test/api/cron/account-deletions/process-due",
    { headers: { authorization: `Bearer ${secret}` } },
  );
}

function pinnedJson(payload, status = 200, headers = {}) {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Buffer.from(JSON.stringify(payload)),
  };
}

describe("account deletion cron backend binding", () => {
  let httpsRequests;
  let localRequests;
  let deadManRequests;
  let httpsRequest;
  let localRequest;
  let deadManSender;

  beforeEach(() => {
    process.env.ACCOUNT_DELETION_WORKER_SECRET = "W".repeat(40);
    process.env.BACKEND_API_URL = "https://koaryu-staging.onrender.com/api/v1";
    delete process.env.NEXT_PUBLIC_API_URL;
    process.env.CRON_SECRET = "cron-secret";
    process.env.OPERATIONAL_ALERTS_ENABLED = "false";
    process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_URL = DEADMAN_URL;
    process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_HOST = "deadman.example.com";
    process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_URL_SHA256 = createHash("sha256")
      .update(DEADMAN_URL)
      .digest("hex");
    process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_BEARER_SECRET = "D".repeat(40);
    process.env.VERCEL_GIT_COMMIT_SHA = "a".repeat(40);
    process.env.VERCEL_TARGET_ENV = "staging";
    delete process.env.VERCEL_ENV;
    httpsRequests = [];
    localRequests = [];
    deadManRequests = [];
    httpsRequest = async (options) => {
      httpsRequests.push(options);
      return pinnedJson({ processed: 0 });
    };
    localRequest = async (options) => {
      localRequests.push(options);
      return pinnedJson({ processed: 0 });
    };
    deadManSender = async (options) => {
      deadManRequests.push(options);
      return "deadman-receipt";
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const invoke = (incoming = request()) => handleAccountDeletionCron(incoming, {
    httpsRequest,
    localRequest,
    deadManSender,
  });

  it("rejects arbitrary, ambiguous, and non-exact URLs without constructing HTTPS", async (context) => {
    const rejectedTargets = [
      "https://attacker.example.test/api/v1",
      "https://user:password@koaryu-staging.onrender.com/api/v1",
      " https://koaryu-staging.onrender.com/api/v1",
      "https://koaryu-staging.onrender.com/api/v1\n",
      "https://koaryu-staging.onrender.com/api/v1/",
      "https://koaryu-staging.onrender.com/api/v1/../credential-sink",
      "https://koaryu-staging.оnrender.com/api/v1",
      "http://localhost:8001/api/v1",
    ];
    for (const target of rejectedTargets) {
      await context.test(target.replaceAll("\n", "\\n"), async () => {
        process.env.BACKEND_API_URL = target;
        assert.equal((await invoke()).status, 500);
        assert.equal(httpsRequests.length, 0);
      });
    }
  });

  it("rejects every cross-environment target without constructing HTTPS", async (context) => {
    for (const [environment, target] of [
      ["staging", "https://koaryu.onrender.com/api/v1"],
      ["production", "https://koaryu-staging.onrender.com/api/v1"],
      ["development", "https://koaryu-staging.onrender.com/api/v1"],
      ["test", "https://koaryu.onrender.com/api/v1"],
    ]) {
      await context.test(`${environment} -> ${target}`, async () => {
        process.env.VERCEL_TARGET_ENV = environment;
        process.env.BACKEND_API_URL = target;
        assert.equal((await invoke()).status, 500);
        assert.equal(httpsRequests.length, 0);
      });
    }
  });

  it("validates the exact backend before worker-secret configuration", async () => {
    process.env.BACKEND_API_URL = "https://attacker.example.test/api/v1";
    delete process.env.ACCOUNT_DELETION_WORKER_SECRET;
    const response = await invoke();
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { detail: "Backend API URL is not configured." });
    assert.equal(httpsRequests.length, 0);
  });

  it("rejects unsafe cron and worker secrets before HTTPS construction", async (context) => {
    for (const value of [
      ` ${"W".repeat(40)}`,
      `${"W".repeat(40)} `,
      `${"W".repeat(40)}\t`,
      `${"W".repeat(40)}\r`,
      `${"W".repeat(40)}\n`,
      `${"W".repeat(40)}\x7f`,
    ]) {
      await context.test(`worker ${JSON.stringify(value)}`, async () => {
        process.env.ACCOUNT_DELETION_WORKER_SECRET = value;
        assert.equal((await invoke()).status, 500);
        assert.equal(httpsRequests.length, 0);
      });
    }
    process.env.ACCOUNT_DELETION_WORKER_SECRET = "W".repeat(40);
    process.env.CRON_SECRET = "cron-secret\x7f";
    assert.equal((await invoke()).status, 401);
    assert.equal(httpsRequests.length, 0);
  });

  it("uses the exact target through bounded pinned HTTPS without forwarding Authorization", async () => {
    const response = await invoke();
    assert.equal(response.status, 200);
    assert.equal(httpsRequests.length, 1);
    assert.equal(
      httpsRequests[0].url,
      "https://koaryu-staging.onrender.com/api/v1/internal/account-deletions/process-due",
    );
    assert.equal(httpsRequests[0].headers["x-internal-secret"], "W".repeat(40));
    assert.equal(httpsRequests[0].headers.Authorization, undefined);
    assert.equal(httpsRequests[0].timeoutMs, 20_000);
    assert.equal(httpsRequests[0].maxResponseBytes, 64 * 1024);
  });

  it("uses the bounded local requester for an exact development backend", async () => {
    process.env.VERCEL_TARGET_ENV = "development";
    process.env.BACKEND_API_URL = "http://localhost:8001/api/v1";

    const response = await invoke();

    assert.equal(response.status, 200);
    assert.equal(httpsRequests.length, 0);
    assert.equal(localRequests.length, 1);
    assert.equal(
      localRequests[0].url,
      "http://localhost:8001/api/v1/internal/account-deletions/process-due",
    );
  });

  it("preflights dead-man configuration before worker invocation", async () => {
    process.env.OPERATIONAL_ALERTS_ENABLED = "true";
    process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_HOST = "other.example.com";
    assert.equal((await invoke()).status, 500);
    assert.equal(httpsRequests.length, 0);
  });

  it("sends dead-man only after a successful worker heartbeat", async () => {
    process.env.OPERATIONAL_ALERTS_ENABLED = "true";
    httpsRequest = async (options) => {
      httpsRequests.push(options);
      return pinnedJson(
        { processed: 0 },
        200,
        { "x-koaryu-heartbeat-sequence": "9" },
      );
    };
    assert.equal((await invoke()).status, 200);
    assert.equal(deadManRequests.length, 1);
    assert.equal(deadManRequests[0].sequence, 9);
  });
});

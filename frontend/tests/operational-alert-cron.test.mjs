import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import { handleOperationalAlertCron } from "../src/app/api/cron/operational-alerts/evaluate/route.ts";

const ENV_KEYS = [
  "BACKEND_API_URL",
  "CRON_SECRET",
  "OPERATIONAL_ALERTS_ENABLED",
  "OPERATIONAL_ALERT_WORKER_SECRET",
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL",
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_HOST",
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL_SHA256",
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_BEARER_SECRET",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_ENV",
  "VERCEL_TARGET_ENV",
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function request(secret = "cron-secret") {
  return new Request("https://staging.example.test/api/cron/operational-alerts/evaluate", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

function validUpstreamBody() {
  return {
    environment: "staging",
    mode: "https",
    metrics: {
      "stripe-live-webhook-failure": 0,
      "account-deletion-worker-overdue": 0,
      "support-urgent-untriaged": 0,
      "billing-reconciliation-stale": 0,
    },
    lifecycle_events: {},
    deliveries_claimed: 0,
    deliveries_delivered: 0,
    deliveries_failed: 0,
    heartbeat_recorded: true,
    heartbeat_sequence: 7,
  };
}

function pinnedJson(payload, status = 200) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(payload)),
  };
}

describe("operational alert cron proxy", () => {
  let httpsRequests;
  let localRequests;
  let deadManRequests;
  let httpsRequest;
  let localRequest;
  let deadManSender;

  beforeEach(() => {
    process.env.BACKEND_API_URL = "https://koaryu-staging.onrender.com/api/v1";
    process.env.CRON_SECRET = "cron-secret";
    process.env.OPERATIONAL_ALERTS_ENABLED = "true";
    process.env.OPERATIONAL_ALERT_WORKER_SECRET = "W".repeat(40);
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL = "https://deadman.example.com/evaluator";
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_HOST = "deadman.example.com";
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL_SHA256 = createHash("sha256")
      .update(process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL)
      .digest("hex");
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_BEARER_SECRET = "D".repeat(40);
    process.env.VERCEL_GIT_COMMIT_SHA = "a".repeat(40);
    process.env.VERCEL_TARGET_ENV = "staging";
    httpsRequests = [];
    localRequests = [];
    deadManRequests = [];
    httpsRequest = async (options) => {
      httpsRequests.push(options);
      return pinnedJson(validUpstreamBody());
    };
    localRequest = async (options) => {
      localRequests.push(options);
      return pinnedJson({ ...validUpstreamBody(), environment: "development" });
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

  const invoke = (incoming = request()) => handleOperationalAlertCron(incoming, {
    httpsRequest,
    localRequest,
    deadManSender,
  });

  it("is unauthorized before checking configuration", async () => {
    const result = await invoke(request("wrong"));
    assert.equal(result.status, 401);
    assert.equal(httpsRequests.length, 0);
  });

  it("stays inactive by default", async () => {
    process.env.OPERATIONAL_ALERTS_ENABLED = "false";
    const result = await invoke();
    assert.equal(result.status, 204);
    assert.equal(httpsRequests.length, 0);
  });

  it("rejects unsafe cron and evaluator secrets before HTTPS construction", async (context) => {
    const unsafeValues = [
      ` ${"W".repeat(40)}`,
      `${"W".repeat(40)} `,
      `${"W".repeat(40)}\t`,
      `${"W".repeat(40)}\r`,
      `${"W".repeat(40)}\n`,
      `${"W".repeat(40)}\x7f`,
    ];
    for (const value of unsafeValues) {
      await context.test(`worker ${JSON.stringify(value)}`, async () => {
        process.env.OPERATIONAL_ALERT_WORKER_SECRET = value;
        assert.equal((await invoke()).status, 500);
        assert.equal(httpsRequests.length, 0);
      });
    }
    process.env.OPERATIONAL_ALERT_WORKER_SECRET = "W".repeat(40);
    for (const value of [" cron-secret", "cron-secret ", "cron-secret\t", "cron-secret\x7f"]) {
      await context.test(`cron ${JSON.stringify(value)}`, async () => {
        process.env.CRON_SECRET = value;
        assert.equal((await invoke()).status, 401);
        assert.equal(httpsRequests.length, 0);
      });
    }
  });

  it("refuses cross-environment or arbitrary backend targets", async () => {
    process.env.VERCEL_TARGET_ENV = "production";
    assert.equal((await invoke()).status, 500);
    process.env.VERCEL_TARGET_ENV = "staging";
    process.env.BACKEND_API_URL = "https://attacker.example.test/api/v1";
    assert.equal((await invoke()).status, 500);
    assert.equal(httpsRequests.length, 0);
  });

  it("preflights dead-man identity before invoking the backend", async () => {
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_HOST = "other.example.com";
    assert.equal((await invoke()).status, 500);
    assert.equal(httpsRequests.length, 0);
  });

  it("uses only the pinned HTTPS requester and returns a counts-only summary", async () => {
    httpsRequest = async (options) => {
      httpsRequests.push(options);
      return pinnedJson({ ...validUpstreamBody(), unsafe: "must-not-pass" });
    };
    const result = await invoke();
    const body = await result.json();

    assert.equal(result.status, 200);
    assert.equal(httpsRequests.length, 1);
    assert.equal(
      httpsRequests[0].url,
      "https://koaryu-staging.onrender.com/api/v1/internal/operational-alerts/evaluate",
    );
    assert.equal(httpsRequests[0].headers["X-Internal-Secret"], "W".repeat(40));
    assert.equal(httpsRequests[0].headers.Authorization, undefined);
    assert.equal(httpsRequests[0].timeoutMs, 20_000);
    assert.equal(httpsRequests[0].maxResponseBytes, 64 * 1024);
    assert.equal(body.unsafe, undefined);
    assert.equal(deadManRequests.length, 1);
    assert.equal(result.headers.get("cache-control"), "no-store, private");
  });

  it("uses the bounded local requester for an exact development backend", async () => {
    process.env.VERCEL_TARGET_ENV = "development";
    process.env.BACKEND_API_URL = "http://127.0.0.1:8001/api/v1";

    const result = await invoke();

    assert.equal(result.status, 200);
    assert.equal(httpsRequests.length, 0);
    assert.equal(localRequests.length, 1);
    assert.equal(
      localRequests[0].url,
      "http://127.0.0.1:8001/api/v1/internal/operational-alerts/evaluate",
    );
  });

  it("does not send dead-man success for failed, inconsistent, or unrecorded drains", async (context) => {
    const unsafeBodies = [
      { ...validUpstreamBody(), deliveries_claimed: 2, deliveries_delivered: 0, deliveries_failed: 2 },
      { ...validUpstreamBody(), deliveries_claimed: 2, deliveries_delivered: 1 },
      { ...validUpstreamBody(), heartbeat_recorded: false },
      { ...validUpstreamBody(), heartbeat_sequence: 0 },
    ];
    for (const body of unsafeBodies) {
      await context.test(JSON.stringify(body), async () => {
        httpsRequest = async () => pinnedJson(body);
        const result = await invoke();
        assert.equal(result.status, 502);
        assert.equal(deadManRequests.length, 0);
      });
    }
  });

  it("does not forward unexpected upstream payloads", async () => {
    httpsRequest = async () => pinnedJson({ requester_email: "private@example.test" });
    const result = await invoke();
    const serialized = JSON.stringify(await result.json());
    assert.equal(result.status, 502);
    assert.doesNotMatch(serialized, /private@example|requester_email/);
  });

  it("fails closed when the independent dead-man rejects the check-in", async () => {
    deadManSender = async () => { throw new Error("bad receipt"); };
    const result = await invoke();
    assert.equal(result.status, 502);
  });
});

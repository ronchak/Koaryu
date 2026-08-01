import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import { GET } from "../src/app/api/cron/operational-alerts/evaluate/route.ts";

const ORIGINAL_FETCH = globalThis.fetch;
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

describe("operational alert cron proxy", () => {
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
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("is unauthorized before checking configuration", async () => {
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response();
    };

    const result = await GET(request("wrong"));

    assert.equal(result.status, 401);
    assert.equal(fetched, false);
  });

  it("stays inactive by default", async () => {
    process.env.OPERATIONAL_ALERTS_ENABLED = "false";
    const result = await GET(request());

    assert.equal(result.status, 204);
    assert.equal(await result.text(), "");
  });

  it("refuses a staging backend binding in production", async () => {
    process.env.VERCEL_TARGET_ENV = "production";
    const result = await GET(request());

    assert.equal(result.status, 500);
  });

  it("rejects the documented worker-secret placeholder", async () => {
    process.env.OPERATIONAL_ALERT_WORKER_SECRET =
      "long-random-secret-for-operational-alert-evaluation";

    const result = await GET(request());

    assert.equal(result.status, 500);
  });

  it("does not forward the dedicated secret to an unpinned backend", async () => {
    process.env.BACKEND_API_URL = "https://backend.example.test/api/v1";
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return Response.json(validUpstreamBody());
    };

    const result = await GET(request());

    assert.equal(result.status, 500);
    assert.equal(fetched, false);
  });

  it("preflights dead-man identity before invoking the backend", async () => {
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_HOST = "other.example.com";
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return Response.json(validUpstreamBody());
    };

    const result = await GET(request());

    assert.equal(result.status, 500);
    assert.equal(fetched, false);
  });

  it("calls only the guarded evaluator and returns a counts-only summary", async () => {
    let captured;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("deadman.example.com")) {
        return Response.json({ receipt_id: "deadman-receipt-7" });
      }
      captured = { url: String(url), init };
      return Response.json({ ...validUpstreamBody(), unsafe: "must-not-pass" });
    };

    const result = await GET(request());
    const body = await result.json();

    assert.equal(result.status, 200);
    assert.equal(
      captured.url,
      "https://koaryu-staging.onrender.com/api/v1/internal/operational-alerts/evaluate",
    );
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers["X-Internal-Secret"], "W".repeat(40));
    assert.equal(body.unsafe, undefined);
    assert.deepEqual(body.metrics, validUpstreamBody().metrics);
    assert.equal(result.headers.get("cache-control"), "no-store, private");
  });

  it("does not forward an unexpected upstream payload", async () => {
    globalThis.fetch = async () => Response.json({ requester_email: "private@example.test" });

    const result = await GET(request());
    const serialized = JSON.stringify(await result.json());

    assert.equal(result.status, 502);
    assert.doesNotMatch(serialized, /private@example|requester_email/);
  });

  it("rejects a backend response whose environment label does not match staging", async () => {
    globalThis.fetch = async () => Response.json({
      ...validUpstreamBody(),
      environment: "development",
    });

    const result = await GET(request());

    assert.equal(result.status, 502);
  });

  it("fails closed when the exact dead-man receipt is malformed", async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes("deadman.example.com")) {
        return Response.json({ receipt_id: "ok", extra: "not-allowed" });
      }
      return Response.json(validUpstreamBody());
    };

    const result = await GET(request());

    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), { detail: "Could not reach operational alert evaluator." });
  });
});

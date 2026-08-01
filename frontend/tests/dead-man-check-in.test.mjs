import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import { sendDeadManCheckIn } from "../src/lib/dead-man-check-in.ts";

const KEYS = [
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL",
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_HOST",
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL_SHA256",
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_BEARER_SECRET",
];
const ORIGINAL = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const URL = "https://deadman.example.com/check/evaluator";

describe("dead-man check-in", () => {
  beforeEach(() => {
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL = URL;
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_HOST = "deadman.example.com";
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL_SHA256 = createHash("sha256")
      .update(URL)
      .digest("hex");
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_BEARER_SECRET = "S".repeat(40);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("uses the exact fingerprint, stable heartbeat identity, and no redirects", async () => {
    let captured;
    const receipt = await sendDeadManCheckIn({
      workerId: "evaluator",
      environment: "staging",
      commitSha: "a".repeat(40),
      sequence: 17,
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init };
        return Response.json({ receipt_id: "receipt-17" });
      },
    });

    assert.equal(receipt, "receipt-17");
    assert.equal(captured.url, URL);
    assert.equal(captured.init.redirect, "error");
    assert.equal(captured.init.headers["Idempotency-Key"], "koaryu:staging:evaluator:17");
    assert.equal(
      captured.init.headers["X-Koaryu-Destination-Fingerprint"],
      process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL_SHA256,
    );
  });

  it("refuses a fingerprint mismatch before network access", async () => {
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL_SHA256 = "0".repeat(64);
    let fetched = false;

    await assert.rejects(sendDeadManCheckIn({
      workerId: "evaluator",
      environment: "staging",
      commitSha: "a".repeat(40),
      sequence: 1,
      fetchImpl: async () => {
        fetched = true;
        return Response.json({ receipt_id: "receipt" });
      },
    }), /not safely configured/);
    assert.equal(fetched, false);
  });

  it("refuses a URL whose hostname is outside the exact provider allowlist", async () => {
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_HOST = "other.example.com";
    let fetched = false;

    await assert.rejects(sendDeadManCheckIn({
      workerId: "evaluator",
      environment: "staging",
      commitSha: "a".repeat(40),
      sequence: 1,
      fetchImpl: async () => {
        fetched = true;
        return Response.json({ receipt_id: "receipt" });
      },
    }), /not safely configured/);
    assert.equal(fetched, false);
  });

  it("requires a strict bounded receipt", async () => {
    await assert.rejects(sendDeadManCheckIn({
      workerId: "evaluator",
      environment: "staging",
      commitSha: "a".repeat(40),
      sequence: 1,
      fetchImpl: async () => Response.json({ receipt_id: "receipt", extra: true }),
    }), /receipt is invalid/);
  });
});

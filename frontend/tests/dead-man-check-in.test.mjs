import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import { sendDeadManCheckIn } from "../src/lib/dead-man-check-in.ts";

const KEYS = [
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL",
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_HOST",
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL_SHA256",
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_BEARER_SECRET",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_URL",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_HOST",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_URL_SHA256",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_BEARER_SECRET",
];
const ORIGINAL = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const URL = "https://deadman.example.com/check/evaluator";
const DELETION_URL = "https://deadman-backup.example.com/check/deletion";

function pinnedJson(payload, status = 200) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(payload)),
  };
}

describe("dead-man check-in", () => {
  beforeEach(() => {
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL = URL;
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_HOST = "deadman.example.com";
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL_SHA256 = createHash("sha256")
      .update(URL)
      .digest("hex");
    process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_BEARER_SECRET = "S".repeat(40);
    process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_URL = DELETION_URL;
    process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_HOST = "deadman-backup.example.com";
    process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_URL_SHA256 = createHash("sha256")
      .update(DELETION_URL)
      .digest("hex");
    process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_BEARER_SECRET = "D".repeat(40);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("uses the exact fingerprint and stable heartbeat identity through pinned HTTPS", async () => {
    let captured;
    const receipt = await sendDeadManCheckIn({
      workerId: "evaluator",
      environment: "staging",
      commitSha: "a".repeat(40),
      sequence: 17,
      requestImpl: async (options) => {
        captured = options;
        return pinnedJson({ receipt_id: "receipt-17" });
      },
    });

    assert.equal(receipt, "receipt-17");
    assert.equal(captured.url, URL);
    assert.equal(captured.timeoutMs, 10_000);
    assert.equal(captured.maxResponseBytes, 4096);
    assert.equal(captured.headers["Idempotency-Key"], "koaryu:staging:evaluator:17");
    assert.equal(
      captured.headers["X-Koaryu-Destination-Fingerprint"],
      process.env.OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL_SHA256,
    );
  });

  it("refuses unsafe evaluator and deletion bearers before network construction", async (context) => {
    for (const [workerId, environmentKey, fill] of [
      ["evaluator", "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_BEARER_SECRET", "S"],
      ["deletion-worker", "OPERATIONAL_ALERT_DELETION_DEADMAN_BEARER_SECRET", "D"],
    ]) {
      for (const value of [
        ` ${fill.repeat(40)}`,
        `${fill.repeat(40)} `,
        `${fill.repeat(40)}\t`,
        `${fill.repeat(40)}\r`,
        `${fill.repeat(40)}\n`,
        `${fill.repeat(40)}\x7f`,
      ]) {
        await context.test(`${workerId}: ${JSON.stringify(value)}`, async () => {
          process.env[environmentKey] = value;
          let requested = false;
          await assert.rejects(sendDeadManCheckIn({
            workerId,
            environment: "staging",
            commitSha: "a".repeat(40),
            sequence: 1,
            requestImpl: async () => {
              requested = true;
              return pinnedJson({ receipt_id: "receipt" });
            },
          }), /not safely configured/);
          assert.equal(requested, false);
          process.env[environmentKey] = fill.repeat(40);
        });
      }
    }
  });

  it("refuses fingerprint or host drift before network access", async () => {
    for (const [name, value] of [
      ["OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL_SHA256", "0".repeat(64)],
      ["OPERATIONAL_ALERT_EVALUATOR_DEADMAN_HOST", "other.example.com"],
    ]) {
      process.env[name] = value;
      let requested = false;
      await assert.rejects(sendDeadManCheckIn({
        workerId: "evaluator",
        environment: "staging",
        commitSha: "a".repeat(40),
        sequence: 1,
        requestImpl: async () => {
          requested = true;
          return pinnedJson({ receipt_id: "receipt" });
        },
      }), /not safely configured/);
      assert.equal(requested, false);
      if (name.endsWith("URL_SHA256")) {
        process.env[name] = createHash("sha256").update(URL).digest("hex");
      } else {
        process.env[name] = "deadman.example.com";
      }
    }
  });

  it("requires a strict receipt", async () => {
    await assert.rejects(sendDeadManCheckIn({
      workerId: "evaluator",
      environment: "staging",
      commitSha: "a".repeat(40),
      sequence: 1,
      requestImpl: async () => pinnedJson({ receipt_id: "receipt", extra: true }),
    }), /receipt is invalid/);
  });
});

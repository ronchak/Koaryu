import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyResource,
  openVerifiedBrowser,
  sanitizeServerTiming,
} from "../scripts/capture-dashboard-performance.mjs";

describe("privacy-safe performance evidence", () => {
  it("verifies the exact SHA before launching a browser", async () => {
    const order = [];
    const browser = {};
    const result = await openVerifiedBrowser({ expectedSha: "a".repeat(40) }, {
      verifyDeployment: async () => {
        order.push("verify");
        return { verified: true };
      },
      launchBrowser: async () => {
        order.push("launch");
        return browser;
      },
    });

    assert.deepEqual(order, ["verify", "launch"]);
    assert.equal(result.browser, browser);
  });

  it("does not launch when exact-SHA verification fails", async () => {
    let launched = false;
    await assert.rejects(openVerifiedBrowser({}, {
      verifyDeployment: async () => { throw new Error("SHA mismatch"); },
      launchBrowser: async () => { launched = true; },
    }), /SHA mismatch/);
    assert.equal(launched, false);
  });

  it("retains only allowlisted route labels and numeric server timing", () => {
    assert.equal(
      classifyResource("https://koaryu.app/api/proxy/dashboard/bootstrap?studio=private"),
      "dashboard-bootstrap",
    );
    assert.equal(classifyResource("https://koaryu.app/api/support/tickets/private"), null);
    assert.deepEqual(sanitizeServerTiming(
      "koaryu_summary_total;dur=12.4, private;desc=customer@example.test, customer_123;dur=9",
    ), [
      { name: "koaryu_summary_total", duration_ms: 12.4 },
    ]);
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createIntentPrefetchPolicy } from "../src/lib/intent-prefetch.ts";

test("intent prefetch respects constrained connections and bounds speculative requests", () => {
  let now = 1000;
  const allow = createIntentPrefetchPolicy(() => now);
  assert.equal(allow("/billing", { saveData: true }), false);
  assert.equal(allow("/billing", { effectiveType: "2g" }), false);
  assert.equal(allow("/billing"), true);
  assert.equal(allow("/reports"), false);
  now += 251;
  assert.equal(allow("/reports"), true);
  now += 1000;
  assert.equal(allow("/billing"), false);
  now += 30000;
  assert.equal(allow("/billing"), true);
});

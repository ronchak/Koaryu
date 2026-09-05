import assert from "node:assert/strict";
import { test } from "node:test";
import { withCurrentLiveAuthRead } from "../src/lib/store-action-types.ts";

test("read replay stops after two rotations and reports an actionable error", async () => {
  let calls = 0;
  const failures = [];
  await assert.rejects(withCurrentLiveAuthRead(
    () => ({ token: `token-${calls}`, isCurrent: () => false, canRetryAfterTokenChange: () => true }),
    async () => { calls += 1; return []; },
    error => failures.push(error.message)
  ), /Session changed repeatedly/);
  assert.equal(calls, 3);
  assert.deepEqual(failures, ["Session changed repeatedly. Please retry loading this data."]);
});

test("ordinary read failures are never retried", async () => {
  let calls = 0;
  await assert.rejects(withCurrentLiveAuthRead(
    () => ({ token: "current-token", isCurrent: () => true, canRetryAfterTokenChange: () => false }),
    async () => { calls += 1; throw new Error("Read failed"); },
    () => assert.fail("ordinary failures do not exhaust auth retries")
  ), /Read failed/);
  assert.equal(calls, 1);
});

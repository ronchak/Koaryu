import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { invalidateEligibilityAfterStudentMutation } from "../src/lib/store-eligibility-invalidation.ts";

describe("student eligibility invalidation", () => {
  it("clears stale rows and force-refreshes the selected ladder", async () => {
    const eligibilityCacheRef = { current: { "ladder-1": [{ student_id: "old" }] } };
    const currentLadderIdRef = { current: "ladder-1" };
    const calls = [];
    let cleared = 0;

    invalidateEligibilityAfterStudentMutation({
      clearCurrentEligibility: () => { cleared += 1; },
      currentLadderIdRef,
      eligibilityCacheRef,
      onRefreshError: (error) => { throw error; },
      refreshEligibility: async (...args) => {
        calls.push(args);
        return [];
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(eligibilityCacheRef.current, {});
    assert.equal(cleared, 1);
    assert.deepEqual(calls, [["ladder-1", { force: true }]]);
  });

  it("only clears state when no ladder is selected", () => {
    const eligibilityCacheRef = { current: { stale: [] } };
    let refreshes = 0;

    invalidateEligibilityAfterStudentMutation({
      clearCurrentEligibility: () => undefined,
      currentLadderIdRef: { current: null },
      eligibilityCacheRef,
      onRefreshError: () => undefined,
      refreshEligibility: async () => {
        refreshes += 1;
        return [];
      },
    });

    assert.deepEqual(eligibilityCacheRef.current, {});
    assert.equal(refreshes, 0);
  });
});

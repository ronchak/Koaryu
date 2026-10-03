import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearPendingRankTransition,
  isTerminalRankTransitionError,
  loadPendingRankTransition,
  persistPendingRankTransition,
  rankTransitionFingerprint,
} from "../src/lib/rank-transition-operation.ts";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("rank transition operation receipts", () => {
  it("restores a transition and clears only its exact operation", () => {
    const session = storage();
    const pending = {
      fingerprint: rankTransitionFingerprint({
        student_id: "student-1",
        to_rank_id: "yellow",
        notes: "Ready",
      }),
      operationId: "11111111-1111-4111-8111-111111111111",
    };
    persistPendingRankTransition("promotion", "student-1", pending, session);
    assert.deepEqual(loadPendingRankTransition("promotion", "student-1", session), pending);
    assert.equal(loadPendingRankTransition("demotion", "student-1", session), null);
    const replacement = { ...pending, operationId: "22222222-2222-4222-8222-222222222222" };
    persistPendingRankTransition("promotion", "student-1", replacement, session);
    clearPendingRankTransition("promotion", "student-1", pending.operationId, session);
    assert.deepEqual(loadPendingRankTransition("promotion", "student-1", session), replacement);
    clearPendingRankTransition("promotion", "student-1", replacement.operationId, session);
    assert.equal(loadPendingRankTransition("promotion", "student-1", session), null);
  });

  it("distinguishes payloads and classifies only deterministic 4xx failures as terminal", () => {
    assert.notEqual(
      rankTransitionFingerprint({ student_id: "student-1", to_rank_id: "yellow" }),
      rankTransitionFingerprint({ student_id: "student-1", to_rank_id: "orange" }),
    );
    assert.equal(isTerminalRankTransitionError(Object.assign(new Error(), { status: 400 })), true);
    assert.equal(isTerminalRankTransitionError(Object.assign(new Error(), { status: 408 })), false);
    assert.equal(isTerminalRankTransitionError(Object.assign(new Error(), { status: 500 })), false);
  });
});

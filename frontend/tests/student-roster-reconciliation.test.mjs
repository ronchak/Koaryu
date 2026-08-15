import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isStudentRosterSnapshotCurrent,
  shouldRetryStudentRosterRefresh,
} from "../src/lib/student-roster-reconciliation.ts";

describe("student roster reconciliation", () => {
  const decision = (overrides = {}) => isStudentRosterSnapshotCurrent({
    authCurrent: true,
    currentMutationEpoch: 4,
    currentRequestSequence: 7,
    mutationEpochAtStart: 4,
    requestSequence: 7,
    ...overrides,
  });

  it("commits an uncontested newest full-roster refresh", () => {
    assert.equal(decision(), true);
  });

  it("rejects a delayed refresh after any newer mutation", () => {
    assert.equal(decision({ currentMutationEpoch: 5 }), false);
  });

  it("rejects older overlapping refreshes and stale auth generations", () => {
    assert.equal(decision({ currentRequestSequence: 8 }), false);
    assert.equal(decision({ authCurrent: false }), false);
  });
});

describe("superseded student roster refresh retry", () => {
  const retry = (overrides = {}) => shouldRetryStudentRosterRefresh({
    attempt: 1,
    authCurrent: true,
    currentRequestSequence: 7,
    maxAttempts: 2,
    requestSequence: 7,
    ...overrides,
  });

  it("re-fetches when a concurrent mutation superseded the newest request", () => {
    // Without this the caller is told reconciliation succeeded, so a bulk
    // status change can stay absent from the local roster indefinitely.
    assert.equal(retry(), true);
  });

  it("stops once the attempt budget is spent", () => {
    assert.equal(retry({ attempt: 2 }), false);
    assert.equal(retry({ attempt: 2, maxAttempts: 3 }), true);
  });

  it("defers to a newer request rather than racing it", () => {
    assert.equal(retry({ currentRequestSequence: 8 }), false);
  });

  it("does not retry across a stale auth generation", () => {
    assert.equal(retry({ authCurrent: false }), false);
  });
});

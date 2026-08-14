import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isStudentRosterSnapshotCurrent } from "../src/lib/student-roster-reconciliation.ts";

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

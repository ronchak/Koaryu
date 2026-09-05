import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chooseStudentRosterRecoveryTarget,
  isStudentRosterRequestCurrent,
  MAX_STUDENT_ROSTER_CURSOR_RECOVERY_ATTEMPTS,
} from "../src/lib/student-roster-pagination.ts";

const history = new Map([
  [1, {
    pageOrdinal: 1,
    requestCursor: null,
    nextCursor: "cursor-1-2",
    previousCursor: null,
  }],
  [2, {
    pageOrdinal: 2,
    requestCursor: "cursor-1-2",
    nextCursor: "cursor-2-3",
    previousCursor: "cursor-2-1",
  }],
  [3, {
    pageOrdinal: 3,
    requestCursor: "cursor-2-3",
    nextCursor: "cursor-3-4",
    previousCursor: "cursor-3-2",
  }],
]);

describe("student roster cursor traversal", () => {
  it("walks nearest-prior recovery through the held query-bound chain", () => {
    assert.deepEqual(
      chooseStudentRosterRecoveryTarget({
        recoverTo: "nearest_prior",
        failedPageOrdinal: 4,
        history,
        attemptedPageOrdinals: new Set([4]),
      }),
      { pageOrdinal: 3, cursor: "cursor-2-3" }
    );
    assert.deepEqual(
      chooseStudentRosterRecoveryTarget({
        recoverTo: "nearest_prior",
        failedPageOrdinal: 4,
        history,
        attemptedPageOrdinals: new Set([3, 4]),
      }),
      { pageOrdinal: 2, cursor: "cursor-1-2" }
    );
  });

  it("resets first-page recovery to a null cursor and stops after the bound", () => {
    assert.deepEqual(
      chooseStudentRosterRecoveryTarget({
        recoverTo: "first",
        failedPageOrdinal: 5,
        history,
        attemptedPageOrdinals: new Set([5]),
      }),
      { pageOrdinal: 1, cursor: null }
    );
    assert.equal(
      chooseStudentRosterRecoveryTarget({
        recoverTo: "first",
        failedPageOrdinal: 5,
        history,
        attemptedPageOrdinals: new Set([1, 2, 3, 4]),
        maxAttempts: MAX_STUDENT_ROSTER_CURSOR_RECOVERY_ATTEMPTS,
      }),
      null
    );
  });

  it("falls back to first when no valid prior page remains and rejects stale responses", () => {
    assert.deepEqual(
      chooseStudentRosterRecoveryTarget({
        recoverTo: "nearest_prior",
        failedPageOrdinal: 3,
        history,
        attemptedPageOrdinals: new Set([2, 3]),
      }),
      { pageOrdinal: 1, cursor: null }
    );
    assert.equal(isStudentRosterRequestCurrent({
      requestSequence: 8,
      activeRequestSequence: 8,
      requestQueryKey: "query-a",
      activeQueryKey: "query-a",
      authCurrent: true,
    }), true);
    assert.equal(isStudentRosterRequestCurrent({
      requestSequence: 7,
      activeRequestSequence: 8,
      requestQueryKey: "query-a",
      activeQueryKey: "query-a",
      authCurrent: true,
    }), false);
    assert.equal(isStudentRosterRequestCurrent({
      requestSequence: 8,
      activeRequestSequence: 8,
      requestQueryKey: "query-a",
      activeQueryKey: "query-b",
      authCurrent: true,
    }), false);
  });
});

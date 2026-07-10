import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getAttendanceToggleTransition,
  runOptimisticAttendanceToggle,
} from "../src/lib/schedule-store-model.ts";
import { buildSessionAttendanceSummary } from "../src/lib/session-detail-model.ts";

const sessionId = "session-1";
const studentId = "student-1";
const roster = [{ id: studentId }];

function record(status, overrides = {}) {
  return {
    id: "attendance-1",
    studio_id: "studio-1",
    session_id: sessionId,
    student_id: studentId,
    status,
    checked_in_at: "2026-07-10T20:00:00.000Z",
    is_cross_program: false,
    counts_toward_eligibility: true,
    student_name: "Aiko Tanaka",
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("optimistic attendance toggle controller", () => {
  it("covers the complete unmarked, present, late, absent, unmarked cycle", () => {
    let attendance = [];
    const expected = ["present", "late", "absent", null];

    for (const nextStatus of expected) {
      const transition = getAttendanceToggleTransition(attendance, sessionId, studentId);
      assert.equal(transition.nextStatus, nextStatus);
      attendance = nextStatus ? [record(nextStatus)] : [];
    }

    assert.equal(
      getAttendanceToggleTransition([record("excused")], sessionId, studentId).nextStatus,
      "present",
      "legacy excused records re-enter the supported UI cycle at present"
    );
  });

  it("transitions from the newest duplicate regardless of input order", () => {
    const staleAbsent = record("absent", {
      id: "stale-absent",
      checked_in_at: "2026-07-10T19:00:00.000Z",
    });
    const currentPresent = record("present", {
      id: "current-present",
      checked_in_at: "2026-07-10T20:00:00.000Z",
    });

    for (const attendance of [
      [staleAbsent, currentPresent],
      [currentPresent, staleAbsent],
    ]) {
      const transition = getAttendanceToggleTransition(attendance, sessionId, studentId);
      assert.equal(transition.existing.id, "current-present");
      assert.equal(transition.previousStatus, "present");
      assert.equal(transition.nextStatus, "late");
    }
  });

  it("publishes optimistic row and counter state before the request settles, then reconciles", async () => {
    let attendance = [];
    let sessionCount = 0;
    const request = deferred();
    const togglePromise = runOptimisticAttendanceToggle({
      attendance,
      checkedInAt: "2026-07-10T20:01:00.000Z",
      commitAttendance(update) {
        attendance = update(attendance);
      },
      commitSessionCountDelta(delta) {
        sessionCount += delta;
      },
      name: "Aiko Tanaka",
      optimisticId: "optimistic-session-1-student-1",
      request: () => request.promise,
      sessionId,
      studentId,
    });

    assert.equal(attendance[0].id, "optimistic-session-1-student-1");
    assert.equal(attendance[0].status, "present");
    assert.equal(sessionCount, 1);
    assert.deepEqual(buildSessionAttendanceSummary(attendance, roster, true), {
      presentCount: 1,
      absentCount: 0,
      unmarkedCount: 0,
    });

    request.resolve(record("present", { id: "server-attendance-1" }));
    await togglePromise;

    assert.equal(attendance[0].id, "server-attendance-1");
    assert.equal(attendance[0].student_name, "Aiko Tanaka");
    assert.equal(sessionCount, 1);
  });

  it("rolls an optimistic deletion and its counters back after request failure", async () => {
    const original = record("absent");
    let attendance = [original];
    let sessionCount = 0;
    const request = deferred();
    const togglePromise = runOptimisticAttendanceToggle({
      attendance,
      checkedInAt: "2026-07-10T20:01:00.000Z",
      commitAttendance(update) {
        attendance = update(attendance);
      },
      commitSessionCountDelta(delta) {
        sessionCount += delta;
      },
      name: "Aiko Tanaka",
      optimisticId: "unused",
      request: () => request.promise,
      sessionId,
      studentId,
    });

    assert.deepEqual(attendance, []);
    assert.deepEqual(buildSessionAttendanceSummary(attendance, roster, true), {
      presentCount: 0,
      absentCount: 0,
      unmarkedCount: 1,
    });

    request.reject(new Error("network failed"));
    await assert.rejects(togglePromise, /network failed/);

    assert.deepEqual(attendance, [original]);
    assert.equal(sessionCount, 0);
    assert.deepEqual(buildSessionAttendanceSummary(attendance, roster, true), {
      presentCount: 0,
      absentCount: 1,
      unmarkedCount: 0,
    });
  });
});

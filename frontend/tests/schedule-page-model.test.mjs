import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  beginSessionAttendanceRefresh,
  clearSessionAttendanceRefresh,
  createAttendanceToggleQueue,
  formatScheduleDateKey,
  getActiveScheduleStudents,
  getScheduleSessionAttendance,
  getScheduleWeekDates,
  getVisibleScheduleRange,
  isCompleteScheduleRoster,
  isSessionAttendanceReady,
  navigateScheduleDate,
  recurringClassOverlapsRange,
  runSessionAttendanceRefresh,
} from "../src/lib/schedule-page-model.ts";

function student(id, status) {
  return { id, status };
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

describe("schedule page model", () => {
  it("builds day, week, and month visible ranges from local calendar dates", () => {
    const base = new Date(2026, 4, 20, 15);

    assert.equal(formatScheduleDateKey(base), "2026-05-20");
    assert.deepEqual(
      getScheduleWeekDates(base).map(formatScheduleDateKey),
      [
        "2026-05-17",
        "2026-05-18",
        "2026-05-19",
        "2026-05-20",
        "2026-05-21",
        "2026-05-22",
        "2026-05-23",
      ]
    );
    assert.deepEqual(getVisibleScheduleRange(base, "day"), {
      start: "2026-05-20",
      end: "2026-05-20",
    });
    assert.deepEqual(getVisibleScheduleRange(base, "week"), {
      start: "2026-05-17",
      end: "2026-05-23",
    });
    assert.deepEqual(getVisibleScheduleRange(base, "month"), {
      start: "2026-04-26",
      end: "2026-06-06",
    });
  });

  it("navigates by the active schedule view", () => {
    const base = new Date(2026, 4, 20, 15);

    assert.equal(formatScheduleDateKey(navigateScheduleDate(base, "day", 1)), "2026-05-21");
    assert.equal(formatScheduleDateKey(navigateScheduleDate(base, "week", -1)), "2026-05-13");
    assert.equal(formatScheduleDateKey(navigateScheduleDate(base, "month", 1)), "2026-06-20");
  });

  it("checks recurring-class overlap and selected-session attendance outside the route", () => {
    const visibleRange = { start: "2026-05-17", end: "2026-05-23" };

    assert.equal(
      recurringClassOverlapsRange({ startDate: "2026-05-01", endDate: "2026-05-18" }, visibleRange),
      true
    );
    assert.equal(
      recurringClassOverlapsRange({ startDate: "2026-05-24", endDate: null }, visibleRange),
      false
    );
    assert.deepEqual(
      getScheduleSessionAttendance(
        [
          { id: "att-1", session_id: "session-1" },
          { id: "att-2", session_id: "session-2" },
        ],
        { id: "session-1" }
      ),
      [{ id: "att-1", session_id: "session-1" }]
    );
    assert.deepEqual(getScheduleSessionAttendance([{ id: "att-1", session_id: "session-1" }], null), []);
  });

  it("keeps only active and trialing students available for attendance", () => {
    assert.deepEqual(
      getActiveScheduleStudents([
        student("active", "active"),
        student("trialing", "trialing"),
        student("inactive", "inactive"),
        student("paused", "paused"),
      ]).map((item) => item.id),
      ["active", "trialing"]
    );
  });

  it("tracks session attendance refresh through pending and success", async () => {
    const request = deferred();
    const states = [];
    const refreshPromise = runSessionAttendanceRefresh({
      isCurrent: () => true,
      onStateChange: (state) => states.push(state),
      refresh: () => request.promise,
      sessionId: "session-1",
    });

    assert.deepEqual(states, [{ sessionId: "session-1", status: "pending" }]);
    request.resolve({ committed: true });
    await refreshPromise;
    assert.deepEqual(states, [
      { sessionId: "session-1", status: "pending" },
      { sessionId: "session-1", status: "ready" },
    ]);
  });

  it("resets same-session readiness across close and reopen", () => {
    const ready = { sessionId: "session-1", status: "ready" };
    assert.equal(isSessionAttendanceReady(ready, "session-1"), true);

    const closed = clearSessionAttendanceRefresh();
    assert.equal(isSessionAttendanceReady(closed, null), false);

    const reopened = beginSessionAttendanceRefresh("session-1");
    assert.equal(isSessionAttendanceReady(reopened, "session-1"), false);
  });

  it("requires the roster load to finish before attendance is complete", () => {
    assert.equal(isCompleteScheduleRoster({
      studentsLoaded: false,
      studentsMayBePartial: false,
    }), false);
    assert.equal(isCompleteScheduleRoster({
      studentsLoaded: true,
      studentsMayBePartial: true,
    }), false);
    assert.equal(isCompleteScheduleRoster({
      studentsLoaded: true,
      studentsMayBePartial: false,
    }), true);
  });

  it("keeps session attendance unavailable after refresh failure", async () => {
    const states = [];

    await assert.rejects(
      runSessionAttendanceRefresh({
        isCurrent: () => true,
        onStateChange: (state) => states.push(state),
        refresh: async () => {
          throw new Error("load failed");
        },
        sessionId: "session-1",
      }),
      /load failed/
    );
    assert.deepEqual(states, [
      { sessionId: "session-1", status: "pending" },
      { sessionId: "session-1", status: "error" },
    ]);
  });

  it("keeps a superseded snapshot pending until an authoritative retry commits", async () => {
    const states = [];
    const authoritativeRetry = deferred();
    let attempts = 0;

    const refreshPromise = runSessionAttendanceRefresh({
      isCurrent: () => true,
      onStateChange: (state) => states.push(state),
      refresh: async () => {
        attempts += 1;
        return attempts === 1
          ? { committed: false }
          : authoritativeRetry.promise;
      },
      sessionId: "session-1",
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 2);
    assert.deepEqual(states, [{ sessionId: "session-1", status: "pending" }]);

    authoritativeRetry.resolve({ committed: true });
    await refreshPromise;
    assert.deepEqual(states, [
      { sessionId: "session-1", status: "pending" },
      { sessionId: "session-1", status: "ready" },
    ]);
  });

  it("serializes overlapping same-student toggles through failure and later success", async () => {
    const pendingSnapshots = [];
    const queue = createAttendanceToggleQueue((ids) => {
      pendingSnapshots.push([...ids]);
    });
    const first = deferred();
    const events = [];
    const firstRun = queue.run("student-1", async () => {
      events.push("first-start");
      await first.promise;
    });
    const secondRun = queue.run("student-1", async () => {
      events.push("second-start");
      events.push("second-success");
    });

    await Promise.resolve();
    assert.deepEqual(events, ["first-start"]);
    assert.deepEqual(pendingSnapshots.at(-1), ["student-1"]);

    first.reject(new Error("first failed"));
    await assert.rejects(firstRun, /first failed/);
    await secondRun;

    assert.deepEqual(events, ["first-start", "second-start", "second-success"]);
    assert.deepEqual(pendingSnapshots.at(-1), []);
  });
});

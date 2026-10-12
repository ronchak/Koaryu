import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  beginSessionAttendanceRefresh,
  clearSessionAttendanceRefresh,
  createAttendanceToggleQueue,
  DEFAULT_SCHEDULE_PAGE_VIEW,
  formatScheduleDateKey,
  getActiveScheduleStudents,
  getScheduleCanvasRange,
  getScheduleTimeCanvasBounds,
  getScheduleSessionAttendance,
  getScheduleWeekDates,
  getVisibleScheduleRange,
  isCompleteScheduleRoster,
  isSessionAttendanceReady,
  layoutScheduleTimeItems,
  navigateScheduleDate,
  runSessionAttendanceRefresh,
} from "../src/lib/schedule-page-model.ts";

function student(id, status, overrides = {}) {
  return { id, status, ...overrides };
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
  it("opens on the month view by default", () => {
    assert.equal(DEFAULT_SCHEDULE_PAGE_VIEW, "month");
  });

  it("builds day, week, and month visible ranges from local calendar dates", () => {
    const base = new Date(2026, 4, 20, 15);

    assert.equal(formatScheduleDateKey(base), "2026-05-20");
    assert.deepEqual(getScheduleWeekDates(base).map(formatScheduleDateKey), [
      "2026-05-17",
      "2026-05-18",
      "2026-05-19",
      "2026-05-20",
      "2026-05-21",
      "2026-05-22",
      "2026-05-23",
    ]);
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
    assert.equal(
      formatScheduleDateKey(navigateScheduleDate(new Date(2026, 0, 31, 12), "month", 1)),
      "2026-02-28",
    );
    assert.equal(
      formatScheduleDateKey(navigateScheduleDate(new Date(2026, 11, 31, 12), "month", -1)),
      "2026-11-30",
    );
  });

  it("lays out duration and overlap on one deterministic time canvas", () => {
    const items = [
      { id: "early", start_time: "05:30", end_time: "06:30" },
      { id: "a", start_time: "09:00", end_time: "10:30" },
      { id: "b", start_time: "09:30", end_time: "10:00" },
      { id: "c", start_time: "11:00", end_time: "12:00" },
      { id: "late", start_time: "21:30", end_time: "22:30" },
    ];

    assert.deepEqual(getScheduleTimeCanvasBounds(items), {
      startMinute: 5 * 60,
      endMinute: 23 * 60,
    });
    const blocks = layoutScheduleTimeItems(items);
    const a = blocks.find((block) => block.item.id === "a");
    const b = blocks.find((block) => block.item.id === "b");
    const c = blocks.find((block) => block.item.id === "c");
    assert.equal(a.endMinute - a.startMinute, 90);
    assert.equal(a.laneCount, 2);
    assert.equal(b.laneCount, 2);
    assert.notEqual(a.lane, b.lane);
    assert.equal(a.overlaps, true);
    assert.equal(c.laneCount, 1);
    assert.equal(c.overlaps, false);
  });

  it("checks selected-session attendance outside the route", () => {
    assert.deepEqual(
      getScheduleSessionAttendance(
        [
          { id: "att-1", session_id: "session-1" },
          { id: "att-2", session_id: "session-2" },
        ],
        { id: "session-1" },
      ),
      [{ id: "att-1", session_id: "session-1" }],
    );
    assert.deepEqual(
      getScheduleSessionAttendance([{ id: "att-1", session_id: "session-1" }], null),
      [],
    );
  });

  it("reserves optional drawn footprints while retaining default time layout and actual overlap flags", () => {
    const items = [
      { id: "a", start_time: "00:00", end_time: "00:15" },
      { id: "b", start_time: "00:15", end_time: "00:30" },
      { id: "c", start_time: "00:30", end_time: "01:00" },
      { id: "d", start_time: "01:00", end_time: "01:30" },
      { id: "long-a", start_time: "09:00", end_time: "10:00" },
      { id: "long-b", start_time: "10:00", end_time: "11:00" },
    ];
    const defaults = layoutScheduleTimeItems(items);
    assert.ok(
      defaults.every((block) => block.lane === 0 && block.laneCount === 1 && !block.overlaps),
    );
    const options = {
      getOccupiedInterval: (block) => {
        const visibleMinutes = Math.max(45, block.endMinute - block.startMinute);
        const occupiedMinutes = Math.max(55, visibleMinutes);
        const startMinute = Math.max(0, block.startMinute - (occupiedMinutes - visibleMinutes) / 2);
        return { startMinute, endMinute: startMinute + occupiedMinutes };
      },
    };
    const drawn = layoutScheduleTimeItems(items, options);
    assert.deepEqual(
      drawn.map((block) => block.lane),
      [0, 1, 2, 0, 0, 0],
    );
    assert.deepEqual(
      drawn.map((block) => block.laneCount),
      [3, 3, 3, 3, 1, 1],
    );
    assert.ok(drawn.every((block) => !block.overlaps));
    assert.deepEqual(
      drawn.map(({ item, startMinute, endMinute }) => ({ item, startMinute, endMinute })),
      defaults.map(({ item, startMinute, endMinute }) => ({ item, startMinute, endMinute })),
    );
    assert.deepEqual(layoutScheduleTimeItems([...items].reverse(), options), drawn);
  });

  it("keeps actual overlaps separate from a drawn group and sorts equal times by ID", () => {
    const items = [
      { id: "b", start_time: "23:00", end_time: "23:15" },
      { id: "a", start_time: "23:00", end_time: "23:15" },
      { id: "c", start_time: "23:15", end_time: "23:30" },
    ];
    const blocks = layoutScheduleTimeItems(items, {
      getOccupiedInterval: (block) => ({
        startMinute: block.startMinute - 5,
        endMinute: block.startMinute + 50,
      }),
    });
    assert.deepEqual(
      blocks.map((block) => block.item.id),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      blocks.map((block) => block.lane),
      [0, 1, 2],
    );
    assert.deepEqual(
      blocks.map((block) => block.laneCount),
      [3, 3, 3],
    );
    assert.deepEqual(
      blocks.map((block) => block.overlaps),
      [true, true, false],
    );
    assert.equal(blocks[2].endMinute, 23 * 60 + 30);
  });

  it("keeps attendance status filtering while deriving known ages and preserving explicit minor status without a birth date", () => {
    const birthday = student("active", "active", {
      date_of_birth: "2008-05-20",
      is_minor: true,
    });
    const nullDob = student("trialing", "trialing", {
      date_of_birth: null,
      is_minor: true,
    });
    const source = [
      birthday,
      nullDob,
      student("inactive", "inactive"),
      student("paused", "paused"),
    ];
    const beforeBirthday = getActiveScheduleStudents(source, "2026-05-19");
    const current = getActiveScheduleStudents(source, "2026-05-20");

    assert.deepEqual(
      current.map((item) => item.id),
      ["active", "trialing"],
    );
    assert.equal(beforeBirthday[0].is_minor, true);
    assert.equal(beforeBirthday[1].is_minor, true);
    assert.equal(current[0].is_minor, false);
    assert.equal(current[1].is_minor, true);
    assert.equal(birthday.is_minor, true);
    assert.equal(nullDob.is_minor, true);
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
    assert.equal(
      isCompleteScheduleRoster({
        studentsLoaded: false,
        studentsMayBePartial: false,
      }),
      false,
    );
    assert.equal(
      isCompleteScheduleRoster({
        studentsLoaded: true,
        studentsMayBePartial: true,
      }),
      false,
    );
    assert.equal(
      isCompleteScheduleRoster({
        studentsLoaded: true,
        studentsMayBePartial: false,
      }),
      true,
    );
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
      /load failed/,
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
        return attempts === 1 ? { committed: false } : authoritativeRetry.promise;
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

describe("schedule canvas range", () => {
  it("uses 9 AM to 9 PM without classes and a six-hour minimum without padding", () => {
    assert.deepEqual(getScheduleCanvasRange([]), { startMinute: 9 * 60, endMinute: 21 * 60 });
    assert.deepEqual(
      getScheduleCanvasRange([
        { id: "a", start_time: "16:00", end_time: "16:45" },
        { id: "b", start_time: "18:00", end_time: "19:30" },
      ]),
      { startMinute: 16 * 60, endMinute: 22 * 60 },
    );
    assert.deepEqual(
      getScheduleCanvasRange([
        { id: "early", start_time: "06:00", end_time: "07:00" },
        { id: "late", start_time: "20:00", end_time: "21:00" },
      ]),
      { startMinute: 6 * 60, endMinute: 21 * 60 },
    );
  });

  it("rounds outward to whole hours and shifts the six-hour minimum back at midnight", () => {
    assert.deepEqual(
      getScheduleCanvasRange([
        { id: "early", start_time: "10:15", end_time: "11:00" },
        { id: "late", start_time: "18:00", end_time: "19:30" },
      ]),
      { startMinute: 10 * 60, endMinute: 20 * 60 },
    );
    assert.deepEqual(
      getScheduleCanvasRange([{ id: "late", start_time: "23:15", end_time: "23:45" }]),
      { startMinute: 18 * 60, endMinute: 24 * 60 },
    );
    assert.deepEqual(
      getScheduleCanvasRange([{ id: "zero-duration", start_time: "16:00", end_time: "16:00" }]),
      { startMinute: 16 * 60, endMinute: 22 * 60 },
    );
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDate } from "../src/lib/students-page-model.ts";
import { shiftDateKey, studioDateKey } from "../src/lib/date.ts";
import {
  consumeRosterReturn,
  loadRosterReturn,
  saveRosterReturn,
  safeStudentsReturn,
} from "../src/lib/student-roster-location.ts";

test("studio day is independent of browser zone through midnight and DST", () => {
  assert.equal(
    studioDateKey("America/Los_Angeles", new Date("2026-09-06T02:00:00Z")),
    "2026-09-05",
  );
  assert.equal(studioDateKey("Asia/Tokyo", new Date("2026-09-06T02:00:00Z")), "2026-09-06");
  for (const instant of ["2026-03-08T09:59:59Z", "2026-03-08T10:00:00Z"]) {
    assert.equal(studioDateKey("America/Los_Angeles", new Date(instant)), "2026-03-08");
  }
  assert.equal(shiftDateKey("2026-03-08", -1), "2026-03-07");
  assert.equal(shiftDateKey("2026-11-01", 1), "2026-11-02");
});
test("return destinations are internal, bounded roster queries", () => {
  for (const href of [
    "https://evil.test",
    "//evil.test",
    "/students/../../evil",
    "/students\\evil",
    "/students#x",
  ]) {
    assert.equal(safeStudentsReturn(href), "/students");
  }
  assert.equal(
    safeStudentsReturn("/students?status=active&token=secret&sort=name"),
    "/students?status=active&sort=name",
  );
});
test("roster return context is bounded, expiring, and scoped to identity", () => {
  const items = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => items.get(key),
    setItem: (key, value) => items.set(key, value),
  };
  const state = {
    scope: "user:studio:admin:1",
    href: "/students?status=active",
    page: 3,
    cursor: "signed-cursor",
    history: [],
    scroll: 120,
    focusId: "student-1",
    savedAt: Date.now(),
  };
  saveRosterReturn(state);
  assert.deepEqual(loadRosterReturn(state.scope, state.href), state);
  assert.equal(loadRosterReturn("other:studio:admin:2", state.href), null);
  saveRosterReturn({ ...state, savedAt: Date.now() - 31 * 60_000 });
  assert.equal(loadRosterReturn(state.scope, state.href), null);
  delete globalThis.sessionStorage;
});

test("date-only membership displays as the same calendar day in roster and detail", () => {
  assert.equal(formatDate("2023-09-02"), "Sep 2, 2023");
});

test("a restored return record is consumed without deleting a newer record", () => {
  const items = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => items.get(key),
    setItem: (key, value) => items.set(key, value),
    removeItem: (key) => items.delete(key),
  };
  const state = {
    scope: "user:studio:admin:1",
    href: "/students",
    page: 3,
    cursor: "cursor",
    history: [],
    scroll: 120,
    focusId: "student-1",
    savedAt: Date.now(),
  };
  saveRosterReturn(state);
  consumeRosterReturn(state);
  assert.equal(loadRosterReturn(state.scope, state.href), null);
  saveRosterReturn({ ...state, savedAt: state.savedAt + 1 });
  consumeRosterReturn(state);
  assert.equal(loadRosterReturn(state.scope, state.href).savedAt, state.savedAt + 1);
  delete globalThis.sessionStorage;
});

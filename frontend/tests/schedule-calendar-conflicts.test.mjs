import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildEntriesForDate,
  getConflictingSessionIds,
  groupSessionsByDate,
} from "../src/lib/schedule-calendar.ts";

const session = (id, extra = {}) => ({
  id,
  name: `Synthetic ${id}`,
  date: "2026-10-07",
  start_time: "18:00",
  end_time: "19:00",
  status: "scheduled",
  ...extra,
});

describe("calendar session conflicts", () => {
  it("does not flag a canceled class or its overlapping replacement", () => {
    const sessions = [session("canceled", { status: "canceled" }), session("replacement")];
    assert.deepEqual([...getConflictingSessionIds(sessions)], []);
    assert.deepEqual([...getConflictingSessionIds([...sessions].reverse())], []);
    // Cancellation still occupies its calendar entry; this is not a deletion.
    const entries = buildEntriesForDate({
      date: new Date(2026, 9, 7, 12),
      sessionsByDate: groupSessionsByDate(sessions),
      templatesByDay: new Map(),
    });
    assert.deepEqual(
      entries.map((entry) => entry.session.id),
      ["canceled", "replacement"],
    );
    assert.equal(entries[0].session.status, "canceled");
  });

  it("does not create conflicts between canceled classes", () => {
    assert.deepEqual(
      [
        ...getConflictingSessionIds([
          session("a", { status: "canceled" }),
          session("b", { status: "canceled" }),
        ]),
      ],
      [],
    );
  });

  it("preserves genuine conflicts for scheduled, in-progress and completed classes", () => {
    const sessions = [
      session("scheduled"),
      session("in-progress", { status: "in_progress", start_time: "18:15" }),
      session("completed", { status: "completed", start_time: "18:30" }),
      session("canceled", { status: "canceled" }),
    ];
    assert.deepEqual([...getConflictingSessionIds(sessions)].sort(), [
      "completed",
      "in-progress",
      "scheduled",
    ]);
  });

  it("keeps adjacent classes non-conflicting and leaves input order unchanged", () => {
    const sessions = [
      session("later", { start_time: "19:00", end_time: "20:00" }),
      session("earlier"),
    ];
    assert.deepEqual([...getConflictingSessionIds(sessions)], []);
    assert.deepEqual(
      sessions.map(({ id }) => id),
      ["later", "earlier"],
    );
    assert.deepEqual([...getConflictingSessionIds([])], []);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildEntriesForDate,
  groupSessionsByDate,
  groupTemplatesByDay,
} from "../src/lib/schedule-calendar.ts";
import { getVisibleScheduleSummary } from "../src/lib/schedule-page-model.ts";

const date = new Date(2026, 9, 6, 12);
const template = (id, extra = {}) => ({
  id,
  name: "Karate",
  start_time: "09:00",
  end_time: "10:00",
  day_of_week: 2,
  start_date: "2026-10-06",
  end_date: "2026-10-06",
  is_active: true,
  program_id: "karate",
  ...extra,
});
const session = (extra = {}) => ({
  id: "session-a",
  template_id: "series-a",
  name: "Karate",
  date: "2026-10-06",
  start_time: "09:00",
  end_time: "10:00",
  program_id: "karate",
  status: "scheduled",
  ...extra,
});
const entries = (sessions, templates) =>
  buildEntriesForDate({
    date,
    sessionsByDate: groupSessionsByDate(sessions),
    templatesByDay: groupTemplatesByDay(templates),
    showTemplatePlaceholders: true,
  });
const placeholders = (sessions, templates) =>
  entries(sessions, templates)
    .filter((entry) => entry.kind === "template")
    .map((entry) => entry.template.id);

describe("schedule template identity", () => {
  it("keeps a parallel series visible when another series has the same name and times", () => {
    const sessions = [session()];
    const templates = [template("series-a"), template("series-b")];
    assert.deepEqual(placeholders(sessions, templates), ["series-b"]);
    for (const view of ["month", "week", "day"]) {
      assert.deepEqual(
        getVisibleScheduleSummary({ currentDate: date, view, sessions, templates }),
        {
          scheduled: 1,
          recurringSlots: 1,
        },
      );
    }
  });

  it("keeps every persisted session and matches each linked series independently", () => {
    const sessions = [session(), session({ id: "session-b", template_id: "series-b" })];
    const result = entries(sessions, [template("series-a"), template("series-b")]);
    assert.deepEqual(
      result.map((entry) => [entry.kind, entry.session?.id]),
      [
        ["session", "session-a"],
        ["session", "session-b"],
      ],
    );
  });

  it("uses the matching link even after a generated session is renamed or rescheduled", () => {
    assert.deepEqual(
      placeholders(
        [session({ name: "Updated Karate", start_time: "11:00", end_time: "12:00" })],
        [template("series-a")],
      ),
      [],
    );
  });

  it("a canceled occurrence occupies only its own series, and deletion restores its slot", () => {
    const templates = [template("series-a"), template("series-b")];
    assert.deepEqual(placeholders([session({ status: "canceled" })], templates), ["series-b"]);
    assert.deepEqual(placeholders([], templates), ["series-a", "series-b"]);
  });

  it("preserves name/time compatibility for legacy sessions without a template link", () => {
    for (const template_id of [null, undefined]) {
      assert.deepEqual(placeholders([session({ template_id })], [template("series-a")]), []);
      assert.deepEqual(
        placeholders([session({ template_id, name: "Judo" })], [template("series-a")]),
        ["series-a"],
      );
    }
  });

  it("keeps an unrelated linked session from hiding a template outside the loaded series set", () => {
    assert.deepEqual(placeholders([session()], [template("series-b")]), ["series-b"]);
  });
});

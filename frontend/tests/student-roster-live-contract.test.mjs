import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  normalizeStudentListSearch,
  shouldScheduleStudentRosterSearch,
} from "../src/lib/student-list-page.ts";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const controllerSource = source("../src/lib/students-page-controller.ts");
const pagesSource = source("../src/lib/store-student-pages.ts");
const querySource = source("../src/lib/student-roster-query.ts");

describe("live student roster cursor consumer", () => {
  it("keeps the settled search debounce and server-owned derived modes", () => {
    assert.match(controllerSource, /STUDENTS_SEARCH_DEBOUNCE_MS = 250/);
    assert.match(controllerSource, /shouldScheduleStudentRosterSearch\(normalizedSearch, debouncedSearch\)/);
    assert.match(controllerSource, /fullRoster: fullRosterRequested/);
    assert.match(controllerSource, /inactivityDays: inactivityThreshold/);
    assert.match(controllerSource, /newStudents \? \{ newStudents \}/);
    assert.match(controllerSource, /today,/);
    assert.match(controllerSource, /requestRosterPage\(pageRef\.current \+ 1, pagedNextCursor\)/);
    assert.match(controllerSource, /requestRosterPage\(Math\.max\(1, pageRef\.current - 1\), pagedPreviousCursor\)/);
  });

  it("does not schedule another request when raw input normalizes to the settled query", () => {
    assert.equal(normalizeStudentListSearch("  Ava,(Kids)%_\nLane  "), "Ava Kids Lane");
    assert.equal(shouldScheduleStudentRosterSearch(" Ava, ", "Ava"), true);
    assert.equal(shouldScheduleStudentRosterSearch("Ava  Lane", "Ava Lane"), true);
    assert.equal(shouldScheduleStudentRosterSearch("Ava", "Ava Lane"), false);
  });

  it("does not let the optimized route hydrate or locally scan broad datasets", () => {
    assert.doesNotMatch(controllerSource, /fetchAllStudents/);
    assert.doesNotMatch(controllerSource, /refreshScheduleRange\([^\n]*inactivity/);
    assert.match(controllerSource, /inactivityThreshold && usesDerivedRosterFilters/);
    assert.match(controllerSource, /config\.isPreviewMode/);
    assert.match(controllerSource, /listStudentsPage\(/);
    assert.doesNotMatch(controllerSource, /fetchStudentPage\(/);
  });

  it("keeps complete-snapshot callers bounded by server cursor progress", () => {
    assert.match(pagesSource, /fullRoster: true/);
    assert.match(pagesSource, /if \(!result\.has_next\)/);
    assert.match(pagesSource, /seenCursors\.has\(result\.next_cursor\)/);
    assert.doesNotMatch(pagesSource, /page \+= 1/);
    assert.match(querySource, /if \(query\.cursor\)/);
    assert.match(querySource, /params\.set\("cursor", query\.cursor\)/);
    assert.match(querySource, /params\.set\("page", String\(Math\.max\(1, query\.page \|\| 1\)\)\)/);
  });
});

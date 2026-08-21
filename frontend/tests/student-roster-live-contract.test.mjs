import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  hasStudentRosterSearchChanged,
  normalizeStudentListSearch,
  shouldScheduleStudentRosterSearch,
} from "../src/lib/student-list-page.ts";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const controllerSource = source("../src/lib/students-page-controller.ts");
const pagesSource = source("../src/lib/store-student-pages.ts");
const querySource = source("../src/lib/student-roster-query.ts");

function applySearchInput(state, value) {
  const effectiveChanged = hasStudentRosterSearchChanged(state.lastInputSearch, value);
  return {
    ...state,
    lastInputSearch: value,
    visibleSearch: value,
    ...(effectiveChanged
      ? { cursor: null, page: 1, resetCount: state.resetCount + 1 }
      : {}),
  };
}

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
    assert.match(controllerSource, /const lastInputNormalizedSearchRef = useRef\(normalizedSearch\)/);
    assert.match(controllerSource, /if \(hasStudentRosterSearchChanged\(previousNormalizedSearch, nextNormalizedSearch\)\)/);
  });

  it("does not schedule another request when raw input normalizes to the settled query", () => {
    assert.equal(normalizeStudentListSearch("  Ava,(Kids)%_\nLane  "), "Ava Kids Lane");
    assert.equal(shouldScheduleStudentRosterSearch(" Ava, ", "Ava"), true);
    assert.equal(shouldScheduleStudentRosterSearch("Ava  Lane", "Ava Lane"), true);
    assert.equal(shouldScheduleStudentRosterSearch("Ava", "Ava Lane"), false);
  });

  it("retains page state for equivalent edits and resets only changed effective searches", () => {
    const initial = {
      cursor: "cursor-page-3",
      page: 3,
      requestCount: 1,
      resetCount: 0,
      lastInputSearch: "Ava Lane",
      settledSearch: "Ava Lane",
    };

    const equivalentEdit = "Ava,(Lane)%_\n";
    const equivalentState = applySearchInput(initial, equivalentEdit);
    assert.equal(equivalentState.visibleSearch, equivalentEdit);
    assert.deepEqual(
      {
        cursor: equivalentState.cursor,
        page: equivalentState.page,
        requestCount: equivalentState.requestCount,
        resetCount: equivalentState.resetCount,
      },
      {
        cursor: "cursor-page-3",
        page: 3,
        requestCount: 1,
        resetCount: 0,
      },
    );

    const changedEdit = "Ava Smith";
    const changedState = applySearchInput(initial, changedEdit);
    assert.equal(changedState.visibleSearch, changedEdit);
    assert.equal(shouldScheduleStudentRosterSearch(changedEdit, initial.settledSearch), false);
    const successiveEquivalentState = applySearchInput(changedState, "Ava,(Smith)%_");
    assert.deepEqual(
      {
        cursor: successiveEquivalentState.cursor,
        page: successiveEquivalentState.page,
        requestCount: successiveEquivalentState.requestCount,
        resetCount: successiveEquivalentState.resetCount,
      },
      {
        cursor: null,
        page: 1,
        requestCount: 1,
        resetCount: 1,
      },
    );
    assert.equal(shouldScheduleStudentRosterSearch(changedEdit, changedEdit), true);
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

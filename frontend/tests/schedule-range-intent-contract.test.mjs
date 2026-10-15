import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const reportsPageSource = source("../src/app/(dashboard)/reports/page.tsx");
const scheduleControllerSource = source("../src/lib/schedule-page-controller.ts");
const studentsControllerSource = source("../src/lib/students-page-controller.ts");
const scheduleActionsSource = source("../src/lib/store-schedule-actions.ts");
const storeSource = source("../src/lib/store.tsx");
const initialReconciliationSource = storeSource.slice(
  storeSource.indexOf("const reconcileScheduleAttempt"),
  storeSource.indexOf("const reconcileSchedule ="),
);
const rangeRefreshSource = scheduleActionsSource.slice(
  scheduleActionsSource.indexOf("const refreshScheduleRange"),
  scheduleActionsSource.indexOf("const refreshSessionAttendance"),
);

describe("schedule range intent contracts", () => {
  it("keeps Reports and other analytics callers on the read-only path", () => {
    assert.match(
      reportsPageSource,
      /refreshScheduleRange\([\s\S]*?reportScheduleRange\.endDate,\s*"read",?\s*\)/,
    );
    assert.doesNotMatch(reportsPageSource, /"materialize"/);
    assert.match(
      studentsControllerSource,
      /refreshScheduleRange\(range\.startDate, range\.endDate, "read"\)/,
    );
    assert.match(storeSource, /await reconcileSchedule\("read"\)/);
    assert.match(storeSource, /reconcileSchedule\("read"\)\.catch/);
  });

  it("paints the calendar from a read and materializes only windows with ungenerated slots", () => {
    // Every view loads the month grid around its date, kept while it covers the
    // view, from one GET first.
    assert.match(
      scheduleControllerSource,
      /resolveScheduleLoadRange\(storedLoadRange, currentDate, view\)/,
    );
    assert.doesNotMatch(scheduleControllerSource, /getVisibleScheduleRange/);
    assert.match(
      scheduleControllerSource,
      /refreshScheduleRange\(loadRange\.start, loadRange\.end, "read"\)/,
    );
    // The POST follows that read only when the window still shows recurring
    // placeholders, once per read, and never for staff who cannot manage the schedule.
    assert.match(
      scheduleControllerSource,
      /settledReadToken === loadToken && canManageSchedule && hasUnmaterializedSlots/,
    );
    assert.match(
      scheduleControllerSource,
      /countUnmaterializedRecurringSlots\(\{ range: loadRange/,
    );
    assert.match(scheduleControllerSource, /materializedTokenRef\.current === loadToken\) return;/);
    assert.match(
      scheduleControllerSource,
      /refreshScheduleRange\(loadRange\.start, loadRange\.end, "materialize"\)/,
    );
    assert.equal(scheduleControllerSource.match(/"materialize"/g)?.length, 1);
    // Post-create materialization belongs to the store's mutation finish, not a second
    // controller refresh. The controller observes that owner's outcome instead.
    assert.match(
      scheduleActionsSource,
      /scheduleRefresh: mutation\.finish\(\{ awaitSharedRefresh: true \}\)/,
    );
    assert.match(scheduleControllerSource, /await createdTemplate\.scheduleRefresh;/);
    assert.match(scheduleControllerSource, /scheduleRefresh === "failed"/);
    assert.match(scheduleActionsSource, /await reconcileSchedule\("materialize"\)/);
    assert.match(rangeRefreshSource, /await reconcileSchedule\(intent\)/);
  });

  it("uses one schedule-window request instead of templates, sessions, and attendance fan-out", () => {
    assert.match(rangeRefreshSource, /await reconcileSchedule\(intent\)/);
    assert.doesNotMatch(rangeRefreshSource, /fetchScheduleWindowRange|api\.get|api\.post/);
    for (const readPath of [initialReconciliationSource]) {
      assert.match(readPath, /fetchScheduleWindowRange\(/);
      assert.match(readPath, /setTemplates\(scheduleWindow\.templates\)/);
      assert.doesNotMatch(readPath, /Promise\.allSettled/);
      assert.doesNotMatch(readPath, /\/schedule\/templates/);
      assert.doesNotMatch(readPath, /\/schedule\/attendance/);
      assert.doesNotMatch(readPath, /\/schedule\/sessions\?/);
    }
  });
});

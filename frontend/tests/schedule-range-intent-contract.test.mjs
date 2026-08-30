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
  storeSource.indexOf("const reconcileSchedule =")
);
const rangeRefreshSource = scheduleActionsSource.slice(
  scheduleActionsSource.indexOf("const refreshScheduleRange"),
  scheduleActionsSource.indexOf("const refreshSessionAttendance")
);

describe("schedule range intent contracts", () => {
  it("keeps Reports and other analytics callers on the read-only path", () => {
    assert.match(
      reportsPageSource,
      /refreshScheduleRange\([\s\S]*?reportScheduleRange\.endDate,\s*"read"\s*\)/
    );
    assert.doesNotMatch(reportsPageSource, /"materialize"/);
    assert.match(
      studentsControllerSource,
      /refreshScheduleRange\(range\.startDate, range\.endDate, "read"\)/
    );
    assert.match(storeSource, /await reconcileSchedule\("read"\)/);
    assert.match(storeSource, /reconcileSchedule\("read"\)\.catch/);
  });

  it("keeps calendar and attendance workflows explicitly materializing recurring sessions", () => {
    assert.equal(
      scheduleControllerSource.match(/refreshScheduleRange\([\s\S]*?"materialize"\s*\)/g)?.length,
      2
    );
    assert.match(scheduleActionsSource, /await reconcileSchedule\("materialize"\)/);
    assert.match(scheduleActionsSource, /reconcileSchedule\("materialize"\)\.catch/);
  });

  it("uses one schedule-window request instead of templates, sessions, and attendance fan-out", () => {
    for (const readPath of [initialReconciliationSource, rangeRefreshSource]) {
      assert.match(readPath, /fetchScheduleWindowRange\(/);
      assert.match(readPath, /setTemplates\(scheduleWindow\.templates\)/);
      assert.doesNotMatch(readPath, /Promise\.allSettled/);
      assert.doesNotMatch(readPath, /\/schedule\/templates/);
      assert.doesNotMatch(readPath, /\/schedule\/attendance/);
      assert.doesNotMatch(readPath, /\/schedule\/sessions\?/);
    }
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { invalidateEligibilityAfterStudentMutation } from "../src/lib/store-eligibility-invalidation.ts";

describe("student eligibility invalidation", () => {
  it("wires committed CSV imports through the shared student-mutation invalidation", () => {
    const importActionsSource = readFileSync(
      new URL("../src/lib/store-student-import-actions.ts", import.meta.url),
      "utf8"
    );
    const storeSource = readFileSync(
      new URL("../src/lib/store.tsx", import.meta.url),
      "utf8"
    );

    assert.match(importActionsSource, /onStudentMutation: \(\) => void/);
    assert.match(
      importActionsSource,
      /execution\.importedStudents\.length > 0[\s\S]*persistStudents\(execution\.students\);[\s\S]*onStudentMutation\(\);/
    );
    assert.match(
      importActionsSource,
      /liveRequest\.isCurrent\(\) && shouldRefreshBelts[\s\S]*onStudentMutation\(\);/
    );
    assert.match(
      storeSource,
      /useStoreStudentImportActions\(\{[\s\S]*onStudentMutation,[\s\S]*refreshPrograms,/
    );
  });

  it("invalidates preview eligibility after bulk status changes and lead conversion", () => {
    const bulkActionsSource = readFileSync(
      new URL("../src/lib/store-student-bulk-actions.ts", import.meta.url),
      "utf8"
    );
    const leadActionsSource = readFileSync(
      new URL("../src/lib/store-lead-actions.ts", import.meta.url),
      "utf8"
    );

    assert.match(
      bulkActionsSource,
      /if \(isPreviewMode\)[\s\S]*persistStudents\(applyStatusToStudents[\s\S]*onStudentMutation\(\);/
    );
    assert.match(
      leadActionsSource,
      /if \(isPreviewMode\)[\s\S]*persistStudents\(\[conversion\.student, \.\.\.studentsRef\.current\]\);[\s\S]*persistLeads[\s\S]*onStudentMutation\(\);/
    );
  });

  it("clears stale rows and force-refreshes the selected ladder", async () => {
    const eligibilityCacheRef = { current: { "ladder-1": [{ student_id: "old" }] } };
    const currentLadderIdRef = { current: "ladder-1" };
    const calls = [];
    let cleared = 0;

    invalidateEligibilityAfterStudentMutation({
      clearCurrentEligibility: () => { cleared += 1; },
      currentLadderIdRef,
      eligibilityCacheRef,
      onRefreshError: (error) => { throw error; },
      refreshEligibility: async (...args) => {
        calls.push(args);
        return [];
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(eligibilityCacheRef.current, {});
    assert.equal(cleared, 1);
    assert.deepEqual(calls, [["ladder-1", { force: true }]]);
  });

  it("only clears state when no ladder is selected", () => {
    const eligibilityCacheRef = { current: { stale: [] } };
    let refreshes = 0;

    invalidateEligibilityAfterStudentMutation({
      clearCurrentEligibility: () => undefined,
      currentLadderIdRef: { current: null },
      eligibilityCacheRef,
      onRefreshError: () => undefined,
      refreshEligibility: async () => {
        refreshes += 1;
        return [];
      },
    });

    assert.deepEqual(eligibilityCacheRef.current, {});
    assert.equal(refreshes, 0);
  });
});

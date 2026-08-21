import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../src/lib/store-student-roster-actions.ts", import.meta.url),
  "utf8",
);
const actionSource = await readFile(
  new URL("../src/lib/student-bulk-archive-action.ts", import.meta.url),
  "utf8",
);

describe("live student bulk archive seam", () => {
  it("sends one normalized archive request instead of serial deletes", () => {
    assert.match(source, /deleteStudentsAction\(/);
    assert.match(source, /normalizeStudentIds,/);
    assert.match(source, /api\.post<[\s\S]*?>\(\s*"\/students\/bulk\/archive"/);
    assert.equal((source.match(/\/students\/bulk\/archive/g) || []).length, 1);
    assert.doesNotMatch(source, /api\.delete/);
  });

  it("keeps preview cleanup and guarded error reconciliation", () => {
    assert.match(actionSource, /revokeObjectURL\(photoUrl\)/);
    assert.match(actionSource, /persistStudents\(/);
    assert.match(actionSource, /onStudentMutation\(\)/);
    assert.match(actionSource, /fetchAllStudents\(/);
    assert.match(actionSource, /isStudentRosterSnapshotCurrent\(/);
    assert.match(actionSource, /if \(!liveRequest\.isCurrent\(\)/);
  });
});

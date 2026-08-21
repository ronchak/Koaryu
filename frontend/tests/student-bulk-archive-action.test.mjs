import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deleteStudentsAction } from "../src/lib/student-bulk-archive-action.ts";

const students = [
  { id: "one", name: "One" },
  { id: "two", name: "Two" },
  { id: "three", name: "Three" },
];

function options(overrides = {}) {
  const state = {
    students: [...students],
    epoch: 0,
    requestSequence: 0,
    posts: [],
    commits: [],
    persisted: [],
    mutations: 0,
    revoked: [],
    current: true,
    ...overrides,
  };
  const base = {
    beginLiveAuthRequest: () => ({ token: "token", isCurrent: () => state.current }),
    commitStudents: (next) => {
      const value = typeof next === "function" ? next(state.students) : next;
      state.students = value;
      state.commits.push(value);
    },
    fetchAllStudents: async () => state.refreshedStudents || state.students,
    ids: [" one ", "two", "one", ""],
    isPreviewMode: false,
    isStudentRosterSnapshotCurrent: () => true,
    normalizeStudentIds: (ids) => [...new Set(ids.map((id) => id.trim()).filter(Boolean))],
    onStudentMutation: () => { state.mutations += 1; },
    persistStudents: (next) => { state.persisted.push(next); state.students = next; },
    postArchive: async (token, ids) => { state.posts.push({ token, ids }); },
    previewStudentPhotoUrlsRef: { current: { one: "blob:one" } },
    revokeObjectURL: (url) => { state.revoked.push(url); },
    studentMutationEpochRef: { get current() { return state.epoch; }, set current(value) { state.epoch = value; } },
    studentRosterRequestSequenceRef: { get current() { return state.requestSequence; }, set current(value) { state.requestSequence = value; } },
    studentsMayBePartial: true,
    studentsRef: { get current() { return state.students; } },
  };
  return { state, options: { ...base, ...overrides } };
}

describe("student bulk archive action", () => {
  it("posts one normalized request and removes the archived rows after success", async () => {
    const { state, options: actionOptions } = options();
    await deleteStudentsAction(actionOptions);
    assert.deepEqual(state.posts, [{ token: "token", ids: ["one", "two"] }]);
    assert.deepEqual(state.students.map((student) => student.id), ["three"]);
    assert.equal(state.mutations, 1);
  });

  it("suppresses a stale request completion", async () => {
    const { state, options: actionOptions } = options({
      postArchive: async () => { state.current = false; },
    });
    await deleteStudentsAction(actionOptions);
    assert.deepEqual(state.students, students);
    assert.equal(state.mutations, 0);
    assert.equal(state.commits.length, 0);
  });

  it("reconciles an ambiguous failure and rethrows the original error", async () => {
    const original = new Error("network timeout");
    const refreshedStudents = [students[2]];
    const { state, options: actionOptions } = options({
      postArchive: async () => { throw original; },
      refreshedStudents,
      isStudentRosterSnapshotCurrent: () => true,
    });
    await assert.rejects(deleteStudentsAction(actionOptions), (error) => error === original);
    assert.equal(state.mutations, 1);
    assert.deepEqual(state.students, refreshedStudents);
    assert.equal(state.commits.length, 1);
  });

  it("cleans preview state without making a network request", async () => {
    const { state, options: actionOptions } = options({
      isPreviewMode: true,
      postArchive: async () => { throw new Error("network call"); },
    });
    await deleteStudentsAction(actionOptions);
    assert.deepEqual(state.posts, []);
    assert.deepEqual(state.revoked, ["blob:one"]);
    assert.deepEqual(state.persisted[0].map((student) => student.id), ["three"]);
    assert.equal(state.mutations, 1);
  });
});

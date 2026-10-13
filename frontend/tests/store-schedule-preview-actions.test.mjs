import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";
import { buildReportsPageModel } from "../src/lib/report-metrics.ts";
import { createScheduleCoordinatorState } from "../src/lib/schedule-store-model.ts";

// Exercise the real preview action; only React hooks and external I/O are replaced.
function actionsFixture() {
  const { add, modules } = createCommonJsPacker({
    react: "exports.useCallback=fn=>fn;exports.useRef=value=>({current:value});",
    "@/lib/api": "exports.api={};",
    "@/lib/store-storage": "exports.localId=()=> 'preview-session';",
  });
  const id = add("@/lib/store-schedule-actions");
  const createActions = new Function(
    `const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}return require(${id}).useStoreScheduleActions;`,
  )();
  const sessionsRef = { current: [] };
  const unexpected = () => {
    throw new Error("Unexpected live action or unrelated preview write");
  };
  const actions = createActions({
    attendanceRef: { current: [] },
    beginLiveAuthRequest: unexpected,
    isPreviewMode: true,
    persistAttendance: unexpected,
    persistSessions: (next) => {
      sessionsRef.current = next;
    },
    persistTemplates: unexpected,
    reconcileSchedule: unexpected,
    scheduleCoordinatorRef: { current: createScheduleCoordinatorState() },
    sessionsRef,
    setAttendance: unexpected,
    setScheduleLoadError: unexpected,
    setScheduleStatus: unexpected,
    setSessions: unexpected,
    setTemplates: unexpected,
    templatesRef: { current: [] },
  });
  return { actions, sessionsRef };
}

const sessionInput = {
  name: "Karate single class",
  date: "2026-10-13",
  start_time: "18:00",
  end_time: "19:00",
  capacity: 12,
};

function reportFor(sessions) {
  return buildReportsPageModel({
    attendance: [],
    leads: [],
    programs: [{ id: "karate", name: "Karate" }],
    sessions,
    today: sessionInput.date,
  });
}

test("preview single classes keep program and instructor assignments for schedule and reports", async () => {
  const { actions, sessionsRef } = actionsFixture();
  await actions.addSession({
    ...sessionInput,
    program_id: "karate",
    instructor_id: "instructor-1",
  });

  const [session] = sessionsRef.current;
  assert.equal(session.program_id, "karate");
  assert.equal(session.instructor_id, "instructor-1");
  assert.equal(session.capacity, 12);
  // The schedule's selected-program view uses this same program-id predicate.
  assert.deepEqual(
    sessionsRef.current.filter((item) => item.program_id === "karate"),
    [session],
  );
  assert.deepEqual(
    reportFor(sessionsRef.current).programAttendanceRows.map((row) => [
      row.programId,
      row.label,
      row.sessions,
    ]),
    [["karate", "Karate", 1]],
  );
});

test("preview single classes still support omitted optional assignments", async () => {
  const { actions, sessionsRef } = actionsFixture();
  await actions.addSession(sessionInput);

  assert.equal(sessionsRef.current.length, 1);
  assert.equal(sessionsRef.current[0].program_id, undefined);
  assert.equal(sessionsRef.current[0].instructor_id, undefined);
  assert.deepEqual(
    reportFor(sessionsRef.current).programAttendanceRows.map((row) => [row.programId, row.label]),
    [[null, "No program"]],
  );
});

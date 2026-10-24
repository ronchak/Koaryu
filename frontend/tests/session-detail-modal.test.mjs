import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

const { add, modules } = createCommonJsPacker({
  react: "module.exports=testReact;",
  "react/jsx-runtime": "module.exports=testJsx;",
  "lucide-react": "module.exports=new Proxy({},{get:()=>()=>null});",
});
const component = add("@/components/schedule/session-detail-modal");
const { ScheduleSessionDetailModal } = new Function(
  "testReact",
  "testJsx",
  `const modules=[${modules.join(",")}],cache={};
   function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
   return require(${component});`,
)(React, jsx);

function render(status, props = {}) {
  return renderToStaticMarkup(
    React.createElement(ScheduleSessionDetailModal, {
      canManageSchedule: true,
      open: true,
      session: {
        id: "session-1",
        name: "Synthetic class",
        date: "2026-10-21",
        start_time: "18:00",
        end_time: "19:00",
        status,
      },
      students: [{ id: "student-1", legal_first_name: "Test", legal_last_name: "Student" }],
      attendance: [],
      isAttendanceReady: true,
      isStudentRosterComplete: true,
      onClose() {},
      onToggleAttendance() {},
      onDeleteSession() {},
      ...props,
    }),
  );
}

function attendanceButton(html) {
  const button = html.match(/<button\b[^>]*data-attendance-student-id="student-1"[^>]*>/)?.[0];
  assert.ok(button, "The student remains visible in class details");
  return button;
}

test("canceled class details disable attendance and explain why, even after records load", () => {
  for (const props of [
    {},
    { isAttendanceReady: false },
    { isStudentRosterComplete: false },
    { pendingAttendanceStudentIds: new Set(["student-1"]) },
    { attendanceError: "Previous request failed" },
  ]) {
    const html = render("canceled", props);
    assert.match(attendanceButton(html), /\bdisabled=""/);
    assert.match(html, /Attendance is unavailable for canceled classes\./);
    assert.match(html, /data-attendance-commit-state="canceled"/);
    assert.doesNotMatch(html, /Tap a student to check them in|Saved as marked/);
    assert.match(html, /Close session details/);
  }
});

test("non-canceled classes retain attendance actions and existing readiness guards", () => {
  for (const status of ["scheduled", "in_progress", "completed"]) {
    const html = render(status);
    assert.doesNotMatch(attendanceButton(html), /\bdisabled=/);
    assert.match(html, /data-attendance-commit-state="saved"/);
    assert.match(html, /Tap a student to check them in/);
    for (const props of [
      { isAttendanceReady: false },
      { isStudentRosterComplete: false },
      { isLoadingStudentRoster: true },
      { pendingAttendanceStudentIds: new Set(["student-1"]) },
    ]) {
      assert.match(attendanceButton(render(status, props)), /\bdisabled=""/);
    }
  }
});

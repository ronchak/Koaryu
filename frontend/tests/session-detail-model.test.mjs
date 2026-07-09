import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAttendanceByStudentId,
  buildSessionAttendanceSummary,
  buildSessionLabels,
  buildSessionRosterSections,
  formatSessionDate,
  formatSessionTime,
  getActiveStudentProgramIds,
  getScheduleStudentName,
  studentBelongsToProgram,
} from "../src/lib/session-detail-model.ts";

const programs = [
  { id: "adult", name: "Adult Karate", color_hex: "#111111" },
  { id: "kids", name: "Kids Karate", color_hex: "#222222" },
  { id: "archived", name: "Archived Program", color_hex: "#333333" },
];

const session = {
  id: "session-1",
  name: "Evening Karate",
  date: "2026-05-30",
  start_time: "18:00",
  end_time: "19:30",
  status: "scheduled",
  program_id: "adult",
};

function student(id, firstName, lastName, programId, memberships = []) {
  return {
    id,
    legal_first_name: firstName,
    legal_last_name: lastName,
    preferred_name: null,
    program_id: programId,
    program_memberships: memberships,
  };
}

describe("session detail model", () => {
  it("formats labels and summarizes attendance outside the modal", () => {
    assert.equal(formatSessionTime("00:15"), "12:15 AM");
    assert.equal(formatSessionTime("13:05"), "1:05 PM");
    assert.equal(formatSessionDate("2026-05-30"), "Saturday, May 30");
    assert.deepEqual(buildSessionLabels(true, session), {
      date: "Saturday, May 30",
      startTime: "6:00 PM",
      endTime: "7:30 PM",
    });
    assert.equal(buildSessionLabels(false, session), null);

    assert.deepEqual(
      buildSessionAttendanceSummary(
        [
          { student_id: "one", status: "present" },
          { student_id: "two", status: "late" },
          { student_id: "three", status: "absent" },
        ],
        true
      ),
      { checkedInCount: 2, absentCount: 1 }
    );
    assert.deepEqual(buildSessionAttendanceSummary([{ student_id: "one", status: "present" }], false), {
      checkedInCount: 0,
      absentCount: 0,
    });
  });

  it("summarizes the same latest per-student attendance state used by roster rows", () => {
    const attendance = [
      { id: "stale-jordan", student_id: "jordan", status: "absent" },
      { id: "current-jordan", student_id: "jordan", status: "present" },
      { id: "current-avery", student_id: "avery", status: "absent" },
    ];
    const attendanceByStudentId = buildAttendanceByStudentId(attendance, true);

    assert.equal(attendanceByStudentId.get("jordan").status, "present");
    assert.deepEqual(buildSessionAttendanceSummary(attendance, true), {
      checkedInCount: 1,
      absentCount: 1,
    });
  });

  it("resolves active program membership and display names deterministically", () => {
    const activeStudent = student("one", "Jordan", "Lee", "kids", [
      { program_id: "adult", status: "active", ended_at: null },
      { program_id: "archived", status: "ended", ended_at: "2026-01-01" },
    ]);
    const preferredStudent = { ...activeStudent, preferred_name: "Jay" };

    assert.deepEqual(getActiveStudentProgramIds(activeStudent), ["adult", "kids"]);
    assert.equal(studentBelongsToProgram(activeStudent, "adult"), true);
    assert.equal(studentBelongsToProgram(activeStudent, "archived"), false);
    assert.equal(getScheduleStudentName(preferredStudent), "Jay Lee");
  });

  it("builds sorted class-program and drop-in roster sections", () => {
    const attendanceByStudentId = buildAttendanceByStudentId(
      [
        { student_id: "b", status: "present" },
        { student_id: "c", status: "absent" },
      ],
      true
    );

    const sections = buildSessionRosterSections({
      open: true,
      session,
      programs,
      attendanceByStudentId,
      students: [
        student("b", "Blake", "Stone", "kids", [{ program_id: "adult", status: "active", ended_at: null }]),
        student("a", "Alex", "River", "adult"),
        student("c", "Casey", "Vale", "kids"),
      ],
    });

    assert.deepEqual(sections.classProgramRows.map((row) => row.studentName), [
      "Alex River",
      "Blake Stone",
    ]);
    assert.deepEqual(sections.otherProgramRows.map((row) => row.studentName), ["Casey Vale"]);
    assert.equal(sections.classProgramRows[1].attendanceRecord.status, "present");
    assert.deepEqual(sections.classProgramRows[0].programs.map((program) => program.name), ["Adult Karate"]);
  });
});

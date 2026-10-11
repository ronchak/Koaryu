import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";

register("./helpers/path-alias-loader.mjs", import.meta.url);

const { buildPreviewHomePayload } = await import("../src/lib/dashboard/preview-home-payload.ts");
const {
  MOCK_ATTENDANCE,
  MOCK_CLASS_TEMPLATES,
  MOCK_ELIGIBILITY,
  MOCK_LEADS,
  MOCK_SESSIONS,
  MOCK_STUDENTS,
} = await import("../src/lib/mock-data.ts");
const { MOCK_BELT_LADDERS, MOCK_PROGRAMS, DEMO_STUDIO_NAME } =
  await import("../src/lib/preview-studio-data.ts");
const { buildStudentInactivityRows } = await import("../src/lib/student-insights.ts");
const { selectDashboardBillingSummary } = await import("../src/lib/dashboard-billing-summary.ts");
const { shiftDateKey } = await import("../src/lib/date.ts");

const today = MOCK_SESSIONS[0].date;
const now = new Date(`${today}T12:00:00.000Z`);
const roles = ["admin", "front_desk", "instructor"];
const build = (role = "admin", date = today) => buildPreviewHomePayload({ today: date, role, now });
const count = (value) => assert.ok(Number.isInteger(value) && value >= 0);

function withExtraRecords(array, rows, run) {
  const previous = [...array];
  try {
    array.push(...rows);
    run();
  } finally {
    array.splice(0, array.length, ...previous);
  }
}

function assertShape(payload, role) {
  assert.equal(payload.generated_at, now.toISOString());
  assert.deepEqual(payload.viewer, { role });
  assert.deepEqual(payload.studio, {
    id: "preview-studio",
    name: DEMO_STUDIO_NAME,
    timezone: "UTC",
    today,
  });
  for (const key of ["needs_attention", "classes_today", "stats", "recent_students"]) {
    assert.ok(Object.hasOwn(payload, key));
    assert.notEqual(payload[key], null);
  }
  for (const value of Object.values(payload.stats.active_students)) count(value);
  for (const value of Object.values(payload.stats.attendance)) count(value);
  assert.equal(payload.stats.attendance.window_days, 30);
  assert.ok(payload.classes_today.rows.length <= 5);
  count(payload.classes_today.total);
  count(payload.classes_today.overflow);
  for (const row of payload.classes_today.rows) {
    for (const key of ["id", "name", "start_time", "end_time"]) {
      assert.equal(typeof row[key], "string");
    }
    count(row.checked_in);
    if (row.capacity !== null) count(row.capacity);
  }
  assert.ok(payload.needs_attention.items.length <= 6);
  for (const item of payload.needs_attention.items) {
    assert.ok(["payments", "setup", "away", "contact"].includes(item.kind));
    count(item.count);
    assert.ok(item.count > 0);
    if (Object.hasOwn(item, "student_id")) {
      assert.equal(item.kind, "contact");
      assert.equal(item.count, 1);
      assert.equal(typeof item.student_id, "string");
    }
  }
  assert.ok(payload.recent_students.length <= 5);
  for (const row of payload.recent_students) {
    for (const key of ["id", "name", "status", "started_on"]) {
      assert.equal(typeof row[key], "string");
    }
  }
  const seesFollowUps = role !== "instructor";
  const seesPromotions = role !== "front_desk";
  assert.equal(Object.hasOwn(payload, "follow_ups"), seesFollowUps);
  assert.equal(Object.hasOwn(payload.stats, "follow_ups"), seesFollowUps);
  assert.equal(Object.hasOwn(payload, "ready_to_promote"), seesPromotions);
  assert.equal(Object.hasOwn(payload.stats, "promotions"), seesPromotions);
  if (seesFollowUps) {
    assert.ok(payload.follow_ups.rows.length <= 6);
    for (const key of ["due_count", "overdue_count", "due_today_count"]) {
      count(payload.stats.follow_ups[key]);
    }
    for (const row of payload.follow_ups.rows) {
      for (const key of ["id", "first_name", "last_name", "follow_up_date"]) {
        assert.equal(typeof row[key], "string");
      }
      assert.ok(
        ["inquiry", "trial_scheduled", "trial_completed", "offer_sent"].includes(row.stage),
      );
    }
  }
  if (seesPromotions) {
    count(payload.stats.promotions.ready_count);
    count(payload.stats.promotions.needs_approval);
    assert.ok(payload.ready_to_promote.rows.length <= 6);
    for (const row of payload.ready_to_promote.rows) {
      assert.equal(typeof row.student_id, "string");
      assert.equal(typeof row.name, "string");
      assert.equal(typeof row.to.name, "string");
      if (row.from !== null) assert.equal(typeof row.from.name, "string");
      for (const belt of [row.from, row.to].filter(Boolean)) {
        if (belt.color !== null) assert.equal(typeof belt.color, "string");
      }
      count(row.classes_at_rank);
      assert.equal(typeof row.needs_approval, "boolean");
    }
  }
  const forbidden =
    role === "instructor"
      ? ["payments", "setup", "contact"]
      : role === "front_desk"
        ? ["setup"]
        : [];
  assert.ok(payload.needs_attention.items.every((item) => !forbidden.includes(item.kind)));
}

describe("preview Home payload", () => {
  for (const role of roles) {
    it(`has the required shape and omits forbidden keys for ${role}`, () => {
      const payload = build(role);
      assertShape(payload, role);
      assertShape(JSON.parse(JSON.stringify(payload)), role);
    });

    it(`links only to real preview records for ${role}`, () => {
      const payload = build(role);
      const students = new Set(MOCK_STUDENTS.map((student) => student.id));
      const leads = new Set(MOCK_LEADS.map((lead) => lead.id));
      const sessions = new Set(MOCK_SESSIONS.map((session) => session.id));
      for (const row of payload.classes_today.rows) assert.ok(sessions.has(row.id));
      for (const row of payload.follow_ups?.rows ?? []) assert.ok(leads.has(row.id));
      for (const row of payload.ready_to_promote?.rows ?? [])
        assert.ok(students.has(row.student_id));
      for (const row of payload.recent_students) assert.ok(students.has(row.id));
      for (const item of payload.needs_attention.items) {
        if (Object.hasOwn(item, "student_id")) assert.ok(students.has(item.student_id));
      }
    });
  }

  it("derives counts, attendance and recent students from the same demo records", () => {
    const payload = build();
    const current = MOCK_SESSIONS.filter(
      (session) => session.date === today && session.status !== "canceled",
    );
    assert.equal(payload.classes_today.total, current.length);
    assert.equal(payload.classes_today.overflow, Math.max(current.length - 5, 0));
    assert.equal(payload.classes_today.rows.length, Math.min(current.length, 5));
    for (const row of payload.classes_today.rows) {
      assert.equal(
        row.checked_in,
        MOCK_ATTENDANCE.filter(
          (record) => record.session_id === row.id && record.status !== "absent",
        ).length,
      );
    }
    const active = MOCK_STUDENTS.filter((student) =>
      ["active", "trialing"].includes(student.status),
    );
    assert.equal(payload.stats.active_students.total, MOCK_STUDENTS.length);
    assert.equal(payload.stats.active_students.active, active.length);
    assert.equal(
      payload.stats.active_students.trialing,
      active.filter((student) => student.status === "trialing").length,
    );
    assert.equal(
      payload.stats.active_students.on_hold,
      MOCK_STUDENTS.filter((student) => student.status === "paused").length,
    );
    assert.equal(
      payload.needs_attention.items.find((item) => item.kind === "payments").count,
      selectDashboardBillingSummary({ isPreviewMode: true, summary: null }).paymentAttentionCount,
    );
    assert.equal(
      payload.needs_attention.items.find((item) => item.kind === "away").count,
      buildStudentInactivityRows(MOCK_STUDENTS, MOCK_SESSIONS, MOCK_ATTENDANCE, today).filter(
        (row) => row.daysInactive >= 14,
      ).length,
    );
    const contact = payload.needs_attention.items.find((item) => item.kind === "contact");
    assert.equal(
      contact.count,
      active.filter(
        (student) =>
          student.emergency_contact_name == null || student.emergency_contact_name === "",
      ).length,
    );
    assert.equal(Object.hasOwn(contact, "student_id"), contact.count === 1);
    assert.deepEqual(
      payload.recent_students.map((row) => row.id),
      [...MOCK_STUDENTS]
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
        .slice(0, 5)
        .map((student) => student.id),
    );
    assert.equal(
      payload.needs_attention.items.some((item) => item.kind === "setup"),
      false,
    );
  });

  it("orders classes by start time then id and follow-ups by date then id", () => {
    const extraSessions = ["zz", "aa", "bb", "cc"].map((id) => ({
      ...MOCK_SESSIONS[0],
      id,
      start_time: "16:00",
    }));
    const extraLeads = ["zz", "aa", "bb", "cc"].map((id) => ({
      ...MOCK_LEADS[0],
      id,
      follow_up_date: shiftDateKey(today, -2),
    }));
    withExtraRecords(MOCK_SESSIONS, extraSessions, () =>
      withExtraRecords(MOCK_LEADS, extraLeads, () => {
        const payload = build();
        assert.deepEqual(
          payload.classes_today.rows.map((row) => row.id),
          [...MOCK_SESSIONS]
            .filter((session) => session.date === today && session.status !== "canceled")
            .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id))
            .slice(0, 5)
            .map((session) => session.id),
        );
        assert.equal(payload.classes_today.overflow, Math.max(payload.classes_today.total - 5, 0));
        const due = MOCK_LEADS.filter(
          (lead) =>
            !["enrolled", "closed_lost"].includes(lead.stage) &&
            lead.follow_up_date &&
            lead.follow_up_date <= today,
        ).sort(
          (a, b) => a.follow_up_date.localeCompare(b.follow_up_date) || a.id.localeCompare(b.id),
        );
        assert.deepEqual(
          payload.follow_ups.rows.map((row) => row.id),
          due.slice(0, 6).map((lead) => lead.id),
        );
        const stats = payload.stats.follow_ups;
        assert.equal(stats.due_count, due.length);
        assert.ok(stats.due_count >= payload.follow_ups.rows.length);
        assert.equal(stats.overdue_count, due.filter((lead) => lead.follow_up_date < today).length);
        assert.equal(stats.due_today_count, stats.due_count - stats.overdue_count);
        assert.equal(stats.oldest_due_date, due[0].follow_up_date);
      }),
    );
  });

  it("includes both attendance window endpoints and excludes canceled, future and nonpositive-capacity seats", () => {
    const extra = [
      { id: "window-start", date: shiftDateKey(today, -30), capacity: 10 },
      { id: "too-old", date: shiftDateKey(today, -31), capacity: 10 },
      { id: "future", date: shiftDateKey(today, 1), capacity: 10 },
      { id: "canceled", date: today, capacity: 10, status: "canceled" },
      { id: "zero-capacity", date: today, capacity: 0 },
      { id: "null-capacity", date: today, capacity: null },
    ].map((row) => ({ ...MOCK_SESSIONS[0], ...row, attendance_count: 999 }));
    const attendance = extra.flatMap((session) => [
      { ...MOCK_ATTENDANCE[0], id: `${session.id}-present`, session_id: session.id },
      {
        ...MOCK_ATTENDANCE[0],
        id: `${session.id}-absent`,
        session_id: session.id,
        status: "absent",
      },
    ]);
    const baseline = build().stats.attendance;
    withExtraRecords(MOCK_SESSIONS, extra, () =>
      withExtraRecords(MOCK_ATTENDANCE, attendance, () => {
        const payload = build();
        assert.deepEqual(payload.stats.attendance, {
          window_days: 30,
          sessions: baseline.sessions + 3,
          seats_filled: baseline.seats_filled + 1,
          capacity: baseline.capacity + 10,
        });
        assert.ok(payload.classes_today.rows.every((row) => row.id !== "canceled"));
      }),
    );
  });

  it("counts approval-only promotions and uses Belt Tracker rank and progress ordering", () => {
    const seeds = structuredClone(MOCK_ELIGIBILITY);
    try {
      const marc = MOCK_ELIGIBILITY.find((row) => row.student_id === "mock-2");
      marc.classes_since_promo = 20;
      marc.days_at_rank = 90;
      MOCK_ELIGIBILITY[0].classes_since_promo = 8;
      MOCK_ELIGIBILITY[0].days_at_rank = 30;
      MOCK_ELIGIBILITY.push({
        ...MOCK_ELIGIBILITY[0],
        student_id: "mock-10",
        classes_since_promo: 16,
        days_at_rank: 60,
      });
      const payload = build();
      assert.deepEqual(payload.stats.promotions, { ready_count: 4, needs_approval: 1 });
      assert.deepEqual(
        payload.ready_to_promote.rows.map((row) => row.student_id),
        ["mock-10", "mock-1", "mock-5", "mock-2"],
      );
      const row = payload.ready_to_promote.rows[3];
      assert.equal(row.needs_approval, true);
      assert.deepEqual(row.from, { name: "Black Tip", color: "#FFFFFF" });
      assert.deepEqual(row.to, { name: "Yellow Belt", color: "#EAB308" });
      assert.equal(row.classes_at_rank, 20);
      assert.ok(payload.stats.promotions.ready_count >= payload.ready_to_promote.rows.length);
    } finally {
      MOCK_ELIGIBILITY.splice(0, MOCK_ELIGIBILITY.length, ...seeds);
    }
  });

  it("keeps all ready entries in the count while limiting unranked promotion rows to six", () => {
    const students = [...MOCK_STUDENTS];
    try {
      const unranked = students
        .filter(
          (student) => student.status === "active" && student.program_id === "program-bjj-core",
        )
        .map((student) => ({
          ...student,
          current_belt_rank_id: null,
          program_memberships: student.program_memberships.map((membership) => ({
            ...membership,
            current_belt_rank_id: null,
          })),
        }));
      MOCK_STUDENTS.splice(0, MOCK_STUDENTS.length, ...unranked);
      const payload = build();
      assert.equal(payload.stats.promotions.ready_count, unranked.length);
      assert.ok(payload.stats.promotions.ready_count > 6);
      assert.equal(payload.stats.promotions.needs_approval, 0);
      assert.equal(payload.ready_to_promote.rows.length, 6);
      assert.ok(payload.ready_to_promote.rows.every((row) => row.from === null));
      assert.deepEqual(
        payload.ready_to_promote.rows.map((row) => row.name),
        unranked
          .map(
            (student) =>
              `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`,
          )
          .sort((a, b) => a.localeCompare(b))
          .slice(0, 6),
      );
    } finally {
      MOCK_STUDENTS.splice(0, MOCK_STUDENTS.length, ...students);
    }
  });

  it("includes a single missing contact id and computes ordered setup steps only for admins", () => {
    const students = [...MOCK_STUDENTS];
    const programs = [...MOCK_PROGRAMS];
    const ladders = [...MOCK_BELT_LADDERS];
    const templates = [...MOCK_CLASS_TEMPLATES];
    try {
      const active = students.filter((student) => ["active", "trialing"].includes(student.status));
      MOCK_STUDENTS.splice(
        0,
        MOCK_STUDENTS.length,
        ...students.map((student) => ({
          ...student,
          emergency_contact_name: student.id === active[0].id ? "" : "Contact",
        })),
      );
      MOCK_PROGRAMS.splice(0, MOCK_PROGRAMS.length);
      MOCK_BELT_LADDERS.splice(0, MOCK_BELT_LADDERS.length);
      MOCK_CLASS_TEMPLATES.splice(0, MOCK_CLASS_TEMPLATES.length);
      const payload = build();
      assert.deepEqual(
        payload.needs_attention.items.find((item) => item.kind === "contact"),
        { kind: "contact", count: 1, student_id: active[0].id },
      );
      assert.deepEqual(
        payload.needs_attention.items.find((item) => item.kind === "setup"),
        { kind: "setup", count: 2, next_step: "programs" },
      );
      assert.deepEqual(
        payload.needs_attention.items.map((item) => item.kind),
        ["payments", "setup", "away", "contact"],
      );
      assertShape(build("front_desk"), "front_desk");
      assertShape(build("instructor"), "instructor");
      assert.deepEqual(payload.stats.promotions, { ready_count: 0, needs_approval: 0 });
      assert.deepEqual(payload.ready_to_promote.rows, []);
    } finally {
      MOCK_STUDENTS.splice(0, MOCK_STUDENTS.length, ...students);
      MOCK_PROGRAMS.splice(0, MOCK_PROGRAMS.length, ...programs);
      MOCK_BELT_LADDERS.splice(0, MOCK_BELT_LADDERS.length, ...ladders);
      MOCK_CLASS_TEMPLATES.splice(0, MOCK_CLASS_TEMPLATES.length, ...templates);
    }
  });

  it("returns empty due lists with a null oldest date before all preview follow-ups", () => {
    const payload = build("admin", shiftDateKey(today, -40));
    assert.deepEqual(payload.stats.follow_ups, {
      due_count: 0,
      overdue_count: 0,
      due_today_count: 0,
      oldest_due_date: null,
    });
    assert.deepEqual(payload.follow_ups.rows, []);
    assert.deepEqual(payload.classes_today, { total: 0, overflow: 0, rows: [] });
  });

  it("is deterministic, does not mutate sources, returns fresh objects and makes no network calls", () => {
    const sources = [
      MOCK_STUDENTS,
      MOCK_SESSIONS,
      MOCK_ATTENDANCE,
      MOCK_LEADS,
      MOCK_ELIGIBILITY,
      MOCK_PROGRAMS,
      MOCK_BELT_LADDERS,
      MOCK_CLASS_TEMPLATES,
    ];
    const snapshot = structuredClone(sources);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("Unexpected preview network call");
    };
    try {
      for (const role of roles) {
        const first = build(role);
        const second = build(role);
        assert.deepEqual(first, second);
        assert.notEqual(first, second);
        first.classes_today.rows[0].name = "Changed by caller";
        assert.deepEqual(build(role), second);
      }
      assert.deepEqual(sources, snapshot);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

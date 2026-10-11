import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildHomeModel,
  homeLeadHref,
  homeRoleClass,
  homeScheduleHref,
  homeStudentHref,
  studioMinutesSinceMidnight,
  HOME_ATTENTION_LIMIT,
  HOME_ATTENTION_ORDER,
  HOME_FOLLOW_UP_LIMIT,
  HOME_LINKS,
  HOME_NEW_STUDENT_LIMIT,
  HOME_PROMOTION_LIMIT,
  HOME_ROLES,
  HOME_SENTENCE_CLAUSE_LIMIT,
  HOME_SENTENCE_CLAUSE_ORDER,
  HOME_SETUP_STEPS,
  HOME_STAT_ORDER,
} from "../src/lib/dashboard/home-model.ts";

const TODAY = "2026-10-10";

function payload(role = "admin") {
  const result = {
    generated_at: `${TODAY}T12:00:00Z`,
    viewer: { role },
    studio: { id: "studio-1", name: "Test studio", timezone: "UTC", today: TODAY },
    needs_attention: { items: [] },
    classes_today: { rows: [], total: 0, overflow: 0 },
    stats: {
      active_students: { total: 15, active: 10, trialing: 2, on_hold: 3 },
      attendance: { window_days: 30, sessions: 5, seats_filled: 7, capacity: 74 },
    },
    recent_students: [],
  };
  if (role !== "instructor") {
    result.stats.follow_ups = {
      due_count: 0,
      overdue_count: 0,
      due_today_count: 0,
      oldest_due_date: null,
    };
    result.follow_ups = { rows: [] };
  }
  if (role !== "front_desk") {
    result.stats.promotions = { ready_count: 0, needs_approval: 0 };
    result.ready_to_promote = { rows: [] };
  }
  return result;
}

function model(data = payload(), options = {}) {
  return buildHomeModel({
    state: { status: "ready", payload: data, error: null, asOf: null, ...options.state },
    role: options.role ?? null,
    nowMinutes: Object.hasOwn(options, "nowMinutes") ? options.nowMinutes : 12 * 60,
  });
}

const classRow = (extra = {}) => ({
  id: "session-1",
  name: "Basics",
  start_time: "12:00",
  end_time: "13:00",
  checked_in: 0,
  capacity: 12,
  ...extra,
});

function agendaRow(extra = {}, nowMinutes = 12 * 60) {
  const data = payload();
  data.classes_today = { rows: [classRow(extra)], total: 1, overflow: 0 };
  return model(data, { nowMinutes }).agenda.rows[0];
}

describe("Home model states", () => {
  it("loading and error without payload leave all sections and sentence null", () => {
    for (const status of ["loading", "error"]) {
      assert.deepEqual(model(null, { state: { status, error: null } }), {
        status,
        asOf: null,
        error: null,
        today: null,
        stats: null,
        attention: null,
        agenda: null,
        panels: { followUps: null, promotions: null, newStudents: null },
        sentence: null,
      });
    }
  });

  it("error with retained payload computes sections and sentence and preserves status/asOf/error", () => {
    const data = payload();
    data.classes_today.total = 3;
    data.needs_attention.items = [{ kind: "payments", count: 1 }];
    const ready = model(data);
    const state = { status: "error", error: "Connection lost", asOf: "2026-10-10T09:41:00Z" };
    assert.deepEqual(model(data, { state }), { ...ready, ...state });
    assert.deepEqual(ready.sentence, { classes: 3, clauses: [{ kind: "payments", count: 1 }] });
    assert.equal(ready.today, TODAY);
  });

  it("no-studio payload gives an empty stat list and null sections", () => {
    const data = payload();
    delete data.studio;
    assert.deepEqual(model(data), {
      status: "ready",
      asOf: null,
      error: null,
      today: null,
      stats: [],
      attention: null,
      agenda: null,
      panels: { followUps: null, promotions: null, newStudents: null },
      sentence: null,
    });
  });
});

describe("Home stats", () => {
  for (const [role, ids] of [
    ["admin", ["followUps", "promotions", "activeStudents", "attendance"]],
    ["front_desk", ["followUps", "activeStudents", "attendance"]],
    ["instructor", ["promotions", "activeStudents", "attendance"]],
  ]) {
    it(`D1 presence and order for ${role}`, () => {
      assert.deepEqual(
        model(payload(role)).stats.map((stat) => stat.id),
        ids,
      );
    });
  }

  it("each stat disappears when its stats section is absent", () => {
    for (const [key, id] of [
      ["follow_ups", "followUps"],
      ["promotions", "promotions"],
      ["active_students", "activeStudents"],
      ["attendance", "attendance"],
    ]) {
      const data = payload();
      delete data.stats[key];
      assert.deepEqual(
        model(data).stats.map((stat) => stat.id),
        HOME_STAT_ORDER.filter((s) => s !== id),
      );
    }
    const data = payload();
    delete data.stats;
    assert.deepEqual(model(data).stats, []);
  });

  it("follow-ups choose overdue, today and none tones, links and notes", () => {
    for (const [counts, expected] of [
      [
        { due_count: 3, overdue_count: 2, due_today_count: 1, oldest_due_date: "2026-10-08" },
        {
          value: 3,
          tone: "alert",
          href: "/leads?focus=overdue",
          note: { kind: "overdue", oldestDays: 2 },
        },
      ],
      [
        { due_count: 2, overdue_count: 0, due_today_count: 2 },
        { value: 2, tone: "warn", href: "/leads?focus=today", note: { kind: "today" } },
      ],
      [
        { due_count: 0, overdue_count: 0, due_today_count: 0 },
        { value: 0, tone: "calm", href: "/leads", note: { kind: "none" } },
      ],
    ]) {
      const data = payload();
      Object.assign(data.stats.follow_ups, counts);
      assert.deepEqual(model(data).stats[0], { id: "followUps", ...expected });
    }
  });

  it("follow-up oldestDays has a minimum of one, row fallback and null for unknown dates", () => {
    for (const [oldest, rows, expected] of [
      [TODAY, [], 1],
      ["2026-10-11", [], 1],
      [
        null,
        [
          {
            id: "lead-1",
            first_name: "A",
            last_name: "B",
            stage: "inquiry",
            follow_up_date: "2026-10-08",
          },
        ],
        2,
      ],
      [null, [], null],
      ["not-a-date", [], null],
    ]) {
      const data = payload();
      Object.assign(data.stats.follow_ups, {
        due_count: 1,
        overdue_count: 1,
        oldest_due_date: oldest,
      });
      data.follow_ups.rows = rows;
      assert.deepEqual(model(data).stats[0].note, { kind: "overdue", oldestDays: expected });
    }
  });

  it("promotions choose approval, ready and none notes and tones", () => {
    for (const [ready_count, needs_approval, tone, note] of [
      [3, 2, "warn", { kind: "approval", count: 2 }],
      [3, 0, "calm", { kind: "ready" }],
      [0, 0, "neutral", { kind: "none" }],
    ]) {
      const data = payload();
      data.stats.promotions = { ready_count, needs_approval };
      assert.deepEqual(
        model(data).stats.find((s) => s.id === "promotions"),
        {
          id: "promotions",
          value: ready_count,
          tone,
          note,
          href: "/belt-tracker#belt-ready-title",
        },
      );
    }
  });

  it("active students use active rather than total and preserve trialing/on-hold counts", () => {
    assert.deepEqual(
      model().stats.find((s) => s.id === "activeStudents"),
      {
        id: "activeStudents",
        value: 10,
        tone: "neutral",
        href: "/students",
        note: { trialing: 2, onHold: 3 },
      },
    );
    const data = payload();
    data.stats.active_students = { total: 0, active: 0, trialing: 0, on_hold: 0 };
    assert.deepEqual(model(data).stats.find((s) => s.id === "activeStudents").note, {
      trialing: 0,
      onHold: 0,
    });
  });

  it("attendance rounds 7/74 to 9 percent and keeps its numeric window note", () => {
    assert.deepEqual(
      model().stats.find((s) => s.id === "attendance"),
      {
        id: "attendance",
        value: 9,
        unit: "percent",
        tone: "neutral",
        href: "/reports",
        note: { kind: "filled", filled: 7, capacity: 74, windowDays: 30 },
      },
    );
  });

  it("attendance has null value and no unit when sessions or capacity are zero", () => {
    for (const [sessions, capacity] of [
      [0, 74],
      [5, 0],
      [0, 0],
    ]) {
      const data = payload();
      Object.assign(data.stats.attendance, { sessions, capacity });
      const stat = model(data).stats.find((s) => s.id === "attendance");
      assert.deepEqual(stat, {
        id: "attendance",
        value: null,
        tone: "neutral",
        href: "/reports",
        note: { kind: "none" },
      });
      assert.equal(Object.hasOwn(stat, "unit"), false);
    }
  });
});

describe("Home attention", () => {
  it("D2 sorts, drops zero/duplicate/unknown kinds, caps rows and emphasizes only the first", () => {
    const data = payload();
    data.needs_attention.items = [
      { kind: "contact", count: 3 },
      { kind: "away", count: 0 },
      { kind: "setup", count: 4, next_step: "classes" },
      { kind: "away", count: 11 },
      { kind: "payments", count: 2 },
      { kind: "payments", count: 9 },
      ...Array.from({ length: 10 }, () => ({ kind: "future-kind", count: 100 })),
    ];
    const items = model(data).attention.items;
    assert.deepEqual(items, [
      {
        kind: "payments",
        count: 2,
        tone: "alert",
        href: "/billing?tab=invoices",
        emphasized: true,
      },
      {
        kind: "setup",
        count: 4,
        tone: "warn",
        href: "/schedule",
        nextStep: "classes",
        emphasized: false,
      },
      {
        kind: "away",
        count: 11,
        tone: "warn",
        href: "/students?inactiveDays=14",
        emphasized: false,
      },
      {
        kind: "contact",
        count: 3,
        tone: "warn",
        href: "/students?status=active",
        studentId: null,
        emphasized: false,
      },
    ]);
    assert.ok(items.length <= 6);
    assert.equal(items.filter((item) => item.emphasized).length, 1);
  });

  it("all five setup steps use their D2 hrefs", () => {
    for (const [next_step, href] of [
      ["programs", "/settings"],
      ["students", "/students/import"],
      ["belts", "/belt-tracker"],
      ["classes", "/schedule"],
      ["billing", "/billing"],
    ]) {
      const data = payload();
      data.needs_attention.items = [{ kind: "setup", count: 1, next_step }];
      assert.deepEqual(model(data).attention.items, [
        {
          kind: "setup",
          count: 1,
          tone: "warn",
          href,
          nextStep: next_step,
          emphasized: true,
        },
      ]);
    }
  });

  it("unknown setup step is dropped and the next valid row is emphasized", () => {
    const data = payload();
    data.needs_attention.items = [
      { kind: "setup", count: 1, next_step: "unknown" },
      { kind: "away", count: 1 },
    ];
    assert.deepEqual(model(data).attention.items, [
      { kind: "away", count: 1, tone: "warn", href: "/students?inactiveDays=14", emphasized: true },
    ]);
  });

  it("contact opens an encoded profile only with count one and a present student id", () => {
    for (const [count, student_id, studentId, href] of [
      [1, "student/a ?&", "student/a ?&", "/students/student%2Fa%20%3F%26"],
      [1, undefined, null, "/students?status=active"],
      [1, "", null, "/students?status=active"],
      [2, "student-1", null, "/students?status=active"],
    ]) {
      const data = payload();
      data.needs_attention.items = [{ kind: "contact", count, student_id }];
      assert.deepEqual(model(data).attention.items, [
        { kind: "contact", count, studentId, href, tone: "warn", emphasized: true },
      ]);
    }
  });

  it("empty attention is a present empty list and omitted attention is null", () => {
    const data = payload();
    assert.deepEqual(model(data).attention, { items: [] });
    data.needs_attention.items = [
      { kind: "payments", count: 0 },
      { kind: "away", count: -1 },
    ];
    assert.deepEqual(model(data).attention, { items: [] });
    delete data.needs_attention;
    assert.equal(model(data).attention, null);
  });
});

describe("Home agenda", () => {
  it("absent agenda is null while empty agenda preserves total and null overflow", () => {
    const data = payload();
    assert.deepEqual(model(data).agenda, { rows: [], overflow: null, total: 0 });
    delete data.classes_today;
    assert.equal(model(data).agenda, null);
    assert.equal(model(data).sentence, null);
  });

  it("phases cover unknown clock, before, exact start, during and exact end", () => {
    for (const [now, phase] of [
      [null, "unknown"],
      [NaN, "unknown"],
      [Infinity, "unknown"],
      [719, "upcoming"],
      [720, "started"],
      [779, "started"],
      [780, "ended"],
      [800, "ended"],
    ]) {
      const row = agendaRow({}, now);
      assert.equal(row.phase, phase, `nowMinutes=${now}`);
      assert.equal(row.action, ["started", "ended"].includes(phase) ? "takeAttendance" : "open");
    }
  });

  it("HH:MM and HH:MM:SS clocks agree and malformed starts give unknown phase", () => {
    for (const start_time of ["12:00", "12:00:00", "12:00:00.123456", " 12:00 "]) {
      assert.equal(agendaRow({ start_time, end_time: "13:00:00" }).phase, "started");
    }
    for (const start_time of ["nonsense", "25:00", "12:60", "24:01", "12", ""]) {
      assert.equal(agendaRow({ start_time }).phase, "unknown", start_time);
    }
  });

  it("cross-midnight classes stay started before midnight and midnight ends roll forward", () => {
    const overnight = { start_time: "23:00", end_time: "01:00" };
    assert.equal(agendaRow(overnight, 22 * 60).phase, "upcoming");
    assert.equal(agendaRow(overnight, 23 * 60).phase, "started");
    assert.equal(agendaRow(overnight, 1439).phase, "started");
    assert.equal(agendaRow({ ...overnight, end_time: "00:00" }, 1439).phase, "started");
  });

  it("countKind and action choose checked-in, spots, no check-ins and none", () => {
    for (const [extra, now, phase, countKind, action] of [
      [{ checked_in: 4 }, 719, "upcoming", "checkedIn", "open"],
      [{ checked_in: 4 }, 720, "started", "checkedIn", "takeAttendance"],
      [{ checked_in: 4, capacity: null }, 780, "ended", "checkedIn", "takeAttendance"],
      [{}, 719, "upcoming", "spots", "open"],
      [{}, 720, "started", "noCheckIns", "takeAttendance"],
      [{ capacity: null }, 780, "ended", "noCheckIns", "takeAttendance"],
      [{ capacity: null }, 719, "upcoming", "none", "open"],
      [{ capacity: 0 }, 719, "upcoming", "none", "open"],
      [{}, null, "unknown", "spots", "open"],
      [{ capacity: null }, null, "unknown", "none", "open"],
    ]) {
      const row = agendaRow(extra, now);
      assert.deepEqual(
        { phase: row.phase, countKind: row.countKind, action: row.action },
        { phase, countKind, action },
      );
    }
  });

  it("emphasizes the first not-ended class and none when all ended", () => {
    const data = payload();
    data.classes_today.rows = [
      classRow({ id: "ended", start_time: "09:00", end_time: "10:00" }),
      classRow({ id: "current" }),
      classRow({ id: "next", start_time: "14:00", end_time: "15:00" }),
    ];
    assert.deepEqual(
      model(data).agenda.rows.map((r) => r.emphasized),
      [false, true, false],
    );
    assert.deepEqual(
      model(data, { nowMinutes: 16 * 60 }).agenda.rows.map((r) => r.emphasized),
      [false, false, false],
    );
    assert.deepEqual(
      model(data, { nowMinutes: 13 * 60 }).agenda.rows.map((r) => r.emphasized),
      [false, false, true],
    );
  });

  it("preserves row fields, encoded hrefs, overflow and total independently of row count", () => {
    const data = payload();
    data.classes_today = {
      rows: [classRow({ id: "session/a ?&", checked_in: 4, capacity: null })],
      total: 13,
      overflow: 12,
    };
    assert.deepEqual(model(data).agenda, {
      rows: [
        {
          id: "session/a ?&",
          name: "Basics",
          startTime: "12:00",
          endTime: "13:00",
          checkedIn: 4,
          capacity: null,
          phase: "started",
          countKind: "checkedIn",
          action: "takeAttendance",
          emphasized: true,
          href: "/schedule?date=2026-10-10&session=session%2Fa%20%3F%26",
        },
      ],
      total: 13,
      overflow: { count: 12, href: "/schedule?date=2026-10-10" },
    });
    data.classes_today.overflow = 0;
    assert.equal(model(data).agenda.overflow, null);
  });
});

describe("Home panels", () => {
  it("follow-ups join names, map overdue/today and preserve lead stage and encoded link", () => {
    const data = payload();
    data.follow_ups.rows = [
      {
        id: "lead/a ?&",
        first_name: "  Ada ",
        last_name: " Lovelace  ",
        follow_up_date: "2026-10-08",
        stage: "offer_sent",
      },
      {
        id: "today",
        first_name: " Solo ",
        last_name: " ",
        follow_up_date: TODAY,
        stage: "trial_scheduled",
      },
    ];
    assert.deepEqual(model(data).panels.followUps.rows, [
      {
        id: "lead/a ?&",
        name: "Ada Lovelace",
        due: { kind: "overdue", days: 2 },
        stage: "offer_sent",
        href: "/leads?lead=lead%2Fa%20%3F%26",
      },
      {
        id: "today",
        name: "Solo",
        due: { kind: "today" },
        stage: "trial_scheduled",
        href: "/leads?lead=today",
      },
    ]);
  });

  it("promotions map ranked/unranked belts, null colours, classes and approval", () => {
    const data = payload();
    data.ready_to_promote.rows = [
      {
        student_id: "student/a ?&",
        name: "Ada",
        from: { name: "White", color: "#FFFFFF" },
        to: { name: "Yellow", color: null },
        classes_at_rank: 9,
        needs_approval: true,
      },
      {
        student_id: "unranked",
        name: "New student",
        from: null,
        to: { name: "White" },
        classes_at_rank: 1,
        needs_approval: false,
      },
      {
        student_id: "no-colour",
        name: "No colour",
        from: { name: "White", color: null },
        to: { name: "Yellow", color: "#EAB308" },
        classes_at_rank: 12,
        needs_approval: false,
      },
    ];
    assert.deepEqual(model(data).panels.promotions.rows, [
      {
        studentId: "student/a ?&",
        name: "Ada",
        from: { name: "White", color: "#FFFFFF" },
        to: { name: "Yellow", color: null },
        classesAtRank: 9,
        needsApproval: true,
        href: "/students/student%2Fa%20%3F%26",
      },
      {
        studentId: "unranked",
        name: "New student",
        from: null,
        to: { name: "White", color: null },
        classesAtRank: 1,
        needsApproval: false,
        href: "/students/unranked",
      },
      {
        studentId: "no-colour",
        name: "No colour",
        from: { name: "White", color: null },
        to: { name: "Yellow", color: "#EAB308" },
        classesAtRank: 12,
        needsApproval: false,
        href: "/students/no-colour",
      },
    ]);
  });

  it("new students map all statuses including unknown and null/omitted startedOn", () => {
    for (const [status, expected] of [
      ["active", "active"],
      ["trialing", "trialing"],
      ["paused", "paused"],
      ["inactive", "inactive"],
      ["canceled", "canceled"],
      ["unexpected", "unknown"],
    ]) {
      const data = payload();
      data.recent_students = [
        { id: "student/a ?&", name: "Ada", status, started_on: "2026-10-03" },
      ];
      assert.deepEqual(model(data).panels.newStudents.rows, [
        {
          id: "student/a ?&",
          name: "Ada",
          status: expected,
          startedOn: "2026-10-03",
          href: "/students/student%2Fa%20%3F%26",
        },
      ]);
      data.recent_students[0].started_on = null;
      assert.equal(model(data).panels.newStudents.rows[0].startedOn, null);
      delete data.recent_students[0].started_on;
      assert.equal(model(data).panels.newStudents.rows[0].startedOn, null);
    }
  });

  it("D4 caps follow-ups/promotions/new students at 6/6/5 and keeps server ordering", () => {
    const data = payload();
    for (let i = 0; i < 9; i++) {
      data.follow_ups.rows.push({
        id: `lead-${i}`,
        first_name: "A",
        last_name: "B",
        follow_up_date: "2026-10-08",
        stage: "inquiry",
      });
      data.ready_to_promote.rows.push({
        student_id: `promotion-${i}`,
        name: "A",
        from: null,
        to: { name: "White", color: null },
        classes_at_rank: 1,
        needs_approval: false,
      });
      data.recent_students.push({
        id: `student-${i}`,
        name: "A",
        status: "active",
        started_on: null,
      });
    }
    const snapshot = structuredClone(data);
    const panels = model(data).panels;
    assert.deepEqual(
      panels.followUps.rows.map((r) => r.id),
      Array.from({ length: 6 }, (_, i) => `lead-${i}`),
    );
    assert.deepEqual(
      panels.promotions.rows.map((r) => r.studentId),
      Array.from({ length: 6 }, (_, i) => `promotion-${i}`),
    );
    assert.deepEqual(
      panels.newStudents.rows.map((r) => r.id),
      Array.from({ length: 5 }, (_, i) => `student-${i}`),
    );
    assert.deepEqual(data, snapshot, "mapping must not mutate the payload");
  });

  it("empty panel sections keep rows arrays and omitted sections become null", () => {
    const data = payload();
    assert.deepEqual(model(data).panels, {
      followUps: { rows: [] },
      promotions: { rows: [] },
      newStudents: { rows: [] },
    });
    delete data.follow_ups;
    delete data.ready_to_promote;
    delete data.recent_students;
    assert.deepEqual(model(data).panels, { followUps: null, promotions: null, newStudents: null });
  });
});

// D6 worked examples are the oracle for these numeric facts. Copy renders later.
const sentenceExamples = [
  {
    role: "admin",
    classes: 3,
    payments: 1,
    overdue: 2,
    dueToday: 1,
    expected: [
      ["payments", 1],
      ["followUpsOverdue", 2],
    ],
  },
  { role: "admin", classes: 0, dueToday: 2, expected: [["followUpsToday", 2]] },
  { role: "admin", classes: 2, expected: [] },
  { role: "admin", classes: 0, expected: [] },
  { role: "admin", classes: 0, setup: 4, expected: [["setup", 4]] },
  {
    role: "admin",
    classes: 5,
    payments: 3,
    approvals: 2,
    ready: 2,
    expected: [
      ["payments", 3],
      ["approvals", 2],
    ],
  },
  {
    role: "admin",
    classes: 1,
    ready: 3,
    away: 11,
    expected: [
      ["ready", 3],
      ["away", 11],
    ],
  },
  {
    role: "admin",
    classes: 12,
    payments: 1,
    overdue: 4,
    setup: 1,
    expected: [
      ["payments", 1],
      ["followUpsOverdue", 4],
    ],
  },
  { role: "admin", classes: 1, overdue: 1, expected: [["followUpsOverdue", 1]] },
  {
    role: "front_desk",
    classes: 3,
    payments: 1,
    dueToday: 3,
    expected: [
      ["payments", 1],
      ["followUpsToday", 3],
    ],
  },
  { role: "front_desk", classes: 2, contacts: 18, expected: [["contacts", 18]] },
  { role: "instructor", classes: 4, ready: 2, approvals: 1, expected: [["ready", 2]] },
  { role: "instructor", classes: 0, away: 1, expected: [["away", 1]] },
];

function sentencePayload(example) {
  const data = payload(example.role);
  data.classes_today.total = example.classes;
  data.needs_attention.items = [
    { kind: "payments", count: example.payments ?? 0 },
    { kind: "setup", count: example.setup ?? 0, next_step: "classes" },
    { kind: "away", count: example.away ?? 0 },
    { kind: "contact", count: example.contacts ?? 0 },
  ].filter((item) => item.count > 0);
  if (data.stats.follow_ups)
    Object.assign(data.stats.follow_ups, {
      overdue_count: example.overdue ?? 0,
      due_today_count: example.dueToday ?? 0,
      due_count: (example.overdue ?? 0) + (example.dueToday ?? 0),
    });
  if (data.stats.promotions)
    Object.assign(data.stats.promotions, {
      ready_count: example.ready ?? 0,
      needs_approval: example.approvals ?? 0,
    });
  return data;
}

describe("Home sentence", () => {
  for (const [index, example] of sentenceExamples.entries()) {
    it(`D6 example ${index + 1}: ${example.role}`, () => {
      assert.deepEqual(model(sentencePayload(example), { role: example.role }).sentence, {
        classes: example.classes,
        clauses: example.expected.map(([kind, count]) => ({ kind, count })),
      });
    });
  }

  it("approvals are admin-only and ready is instructor-always/admin-without-approval/front-desk-never", () => {
    for (const [role, needs_approval, expected] of [
      ["admin", 1, [{ kind: "approvals", count: 1 }]],
      ["admin", 0, [{ kind: "ready", count: 3 }]],
      ["instructor", 1, [{ kind: "ready", count: 3 }]],
      ["instructor", 0, [{ kind: "ready", count: 3 }]],
      ["front_desk", 1, []],
      ["front_desk", 0, []],
    ]) {
      const data = payload();
      data.stats.promotions = { ready_count: 3, needs_approval };
      assert.deepEqual(model(data, { role }).sentence.clauses, expected);
    }
  });

  it("due-today is excluded whenever overdue is positive", () => {
    const data = sentencePayload({ role: "admin", classes: 1, overdue: 1, dueToday: 10, away: 2 });
    assert.deepEqual(model(data).sentence.clauses, [
      { kind: "followUpsOverdue", count: 1 },
      { kind: "away", count: 2 },
    ]);
    data.stats.follow_ups.overdue_count = 0;
    data.stats.follow_ups.due_count = 10;
    assert.deepEqual(model(data).sentence.clauses, [
      { kind: "followUpsToday", count: 10 },
      { kind: "away", count: 2 },
    ]);
  });

  it("null role falls back to payload viewer and explicit role takes precedence", () => {
    const data = sentencePayload({ role: "instructor", classes: 4, ready: 2, approvals: 1 });
    assert.deepEqual(model(data).sentence.clauses, [{ kind: "ready", count: 2 }]);
    assert.deepEqual(model(data, { role: "admin" }).sentence.clauses, [
      { kind: "approvals", count: 1 },
    ]);
    data.viewer.role = "unknown";
    assert.deepEqual(model(data).sentence.clauses, []);
  });

  it("omitted agenda leaves sentence null even with visible needs", () => {
    const data = sentencePayload({ role: "admin", classes: 3, payments: 1 });
    delete data.classes_today;
    assert.equal(model(data).sentence, null);
  });
});

describe("Home constants and helpers", () => {
  it("constants keep the approved orders, limits, roles, setup steps and links", () => {
    assert.deepEqual(HOME_ROLES, ["admin", "front_desk", "instructor"]);
    assert.deepEqual(HOME_STAT_ORDER, ["followUps", "promotions", "activeStudents", "attendance"]);
    assert.deepEqual(HOME_ATTENTION_ORDER, ["payments", "setup", "away", "contact"]);
    assert.deepEqual(HOME_SENTENCE_CLAUSE_ORDER, [
      "payments",
      "followUpsOverdue",
      "setup",
      "approvals",
      "followUpsToday",
      "ready",
      "away",
      "contacts",
    ]);
    assert.deepEqual(
      [
        HOME_ATTENTION_LIMIT,
        HOME_SENTENCE_CLAUSE_LIMIT,
        HOME_FOLLOW_UP_LIMIT,
        HOME_PROMOTION_LIMIT,
        HOME_NEW_STUDENT_LIMIT,
      ],
      [6, 2, 6, 6, 5],
    );
    assert.deepEqual(HOME_SETUP_STEPS, [
      { id: "programs", href: "/settings" },
      { id: "students", href: "/students/import" },
      { id: "belts", href: "/belt-tracker" },
      { id: "classes", href: "/schedule" },
      { id: "billing", href: "/billing" },
    ]);
    assert.deepEqual(HOME_LINKS, {
      leads: "/leads",
      leadsOverdue: "/leads?focus=overdue",
      leadsToday: "/leads?focus=today",
      beltTrackerReady: "/belt-tracker#belt-ready-title",
      students: "/students",
      studentsActive: "/students?status=active",
      studentsAway: "/students?inactiveDays=14",
      billingInvoices: "/billing?tab=invoices",
      reports: "/reports",
      schedule: "/schedule",
    });
  });

  it("href helpers encode path and query values including dates and omit absent sessions", () => {
    assert.equal(homeLeadHref("a/b ?&"), "/leads?lead=a%2Fb%20%3F%26");
    assert.equal(homeStudentHref("a/b ?&"), "/students/a%2Fb%20%3F%26");
    assert.equal(homeScheduleHref("date ?&"), "/schedule?date=date%20%3F%26");
    assert.equal(
      homeScheduleHref(TODAY, "a/b ?&"),
      "/schedule?date=2026-10-10&session=a%2Fb%20%3F%26",
    );
  });

  it("studio minutes use the studio zone at midnight and reject invalid zones/dates", () => {
    assert.equal(studioMinutesSinceMidnight("UTC", new Date("2026-10-10T00:00:00Z")), 0);
    assert.equal(
      studioMinutesSinceMidnight("America/Los_Angeles", new Date("2026-10-10T07:00:00Z")),
      0,
    );
    assert.equal(studioMinutesSinceMidnight("Asia/Kolkata", new Date("2026-10-10T00:00:00Z")), 330);
    assert.equal(studioMinutesSinceMidnight("UTC", new Date("2026-10-10T23:59:59Z")), 1439);
    assert.equal(
      studioMinutesSinceMidnight("invalid/timezone", new Date("2026-10-10T00:00:00Z")),
      null,
    );
    assert.equal(studioMinutesSinceMidnight("UTC", new Date("invalid")), null);
  });

  it("homeRoleClass accepts only the three exact role strings", () => {
    for (const role of ["admin", "front_desk", "instructor"])
      assert.equal(homeRoleClass(role), role);
    for (const role of [null, undefined, "owner", "Admin", " admin ", "", 0, {}, ["admin"]])
      assert.equal(homeRoleClass(role), null);
  });
});

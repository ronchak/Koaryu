import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import {
  HOME_COPY,
  words,
  plural,
  homeSentenceText,
  homeStatCopy,
  homeAttentionCopy,
  homeNewStudentMeta,
  homeBeltPairLabel,
  homeGreeting,
  homeEyebrow,
  clock,
  homeClassCount,
  homeClassAction,
  homeFollowUpTag,
  homeFollowUpNextStep,
  homePromotionMeta,
  homeRefreshErrorDetail,
} from "../src/lib/dashboard/home-copy.ts";
import { getLeadNextAction } from "../src/components/leads/lead-focus.ts";
import { buildHomeModel } from "../src/lib/dashboard/home-model.ts";
import { homePayload } from "./helpers/home-fixtures.mjs";

const examples = [
  [
    "admin",
    3,
    { payments: 1, overdue: 2, due: 1 },
    "Three classes today, one payment to chase, and two follow-ups overdue.",
  ],
  ["admin", 0, { due: 2 }, "No classes today and two follow-ups due today."],
  ["admin", 2, {}, "Two classes today and nothing else needs you."],
  ["admin", 0, {}, "No classes today and nothing needs you."],
  ["admin", 0, { setup: 4 }, "No classes today and four setup steps left."],
  [
    "admin",
    5,
    { payments: 3, approval: 2 },
    "Five classes today, three payments to chase, and two promotions to approve.",
  ],
  [
    "admin",
    1,
    { ready: 3, away: 11 },
    "One class today, three students ready for the next belt, and 11 students haven't been in for two weeks.",
  ],
  [
    "admin",
    12,
    { payments: 1, overdue: 4, setup: 1 },
    "12 classes today, one payment to chase, and four follow-ups overdue.",
  ],
  ["admin", 1, { overdue: 1 }, "One class today and one follow-up overdue."],
  [
    "front_desk",
    3,
    { payments: 1, due: 3 },
    "Three classes today, one payment to chase, and three follow-ups due today.",
  ],
  [
    "front_desk",
    2,
    { contact: 18 },
    "Two classes today and 18 students have no emergency contact on file.",
  ],
  [
    "instructor",
    4,
    { ready: 2, approval: 1 },
    "Four classes today and two students ready for the next belt.",
  ],
  ["instructor", 0, { away: 1 }, "No classes today and one student hasn't been in for two weeks."],
];
for (const [index, [role, classes, counts, expected]] of examples.entries()) {
  test(`D6 worked example ${index + 1} formats the real model sentence`, () => {
    const payload = homePayload(role);
    payload.classes_today.total = classes;
    payload.needs_attention.items = ["payments", "setup", "away", "contact"]
      .filter((kind) => counts[kind])
      .map((kind) => ({
        kind,
        count: counts[kind],
        ...(kind === "setup" ? { next_step: "classes" } : {}),
      }));
    if (payload.stats.follow_ups)
      Object.assign(payload.stats.follow_ups, {
        overdue_count: counts.overdue ?? 0,
        due_today_count: counts.due ?? 0,
        due_count: (counts.overdue ?? 0) + (counts.due ?? 0),
      });
    if (payload.stats.promotions)
      Object.assign(payload.stats.promotions, {
        ready_count: counts.ready ?? 0,
        needs_approval: counts.approval ?? 0,
      });
    const model = buildHomeModel({
      state: { status: "ready", payload, error: null, asOf: null },
      role,
      nowMinutes: 720,
    });
    assert.equal(homeSentenceText(model.sentence), expected);
  });
}
test("words uses lowercase inline, sentence casing at start, and digits after ten", () => {
  const names = [
    "no",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
  ];
  for (const [n, word] of names.entries()) {
    assert.equal(words(n), word);
    assert.equal(words(n, "start"), word[0].toUpperCase() + word.slice(1));
  }
  for (const n of [11, 12, 1000]) assert.equal(words(n), n.toLocaleString("en-US"));
});
const pairs = [
  ["sentence.payments", "one payment to chase", "two payments to chase"],
  ["sentence.followUpsOverdue", "one follow-up overdue", "two follow-ups overdue"],
  ["sentence.setup", "one setup step left", "two setup steps left"],
  ["sentence.approvals", "one promotion to approve", "two promotions to approve"],
  ["sentence.followUpsToday", "one follow-up due today", "two follow-ups due today"],
  ["sentence.ready", "one student ready for the next belt", "two students ready for the next belt"],
  [
    "sentence.away",
    "one student hasn't been in for two weeks",
    "two students haven't been in for two weeks",
  ],
  [
    "sentence.contacts",
    "one student has no emergency contact on file",
    "two students have no emergency contact on file",
  ],
  ["stats.followUps.note.overdue", "Oldest 1 day overdue", "Oldest 2 days overdue"],
  ["stats.promotions.note.approval", "1 needs approval", "2 need approval"],
  ["stats.activeStudents.note.trialing", "1 trialing", "2 trialing"],
  ["stats.activeStudents.note.onHold", "1 on hold", "2 on hold"],
  ["attention.payments.title", "One payment needs a look", "Two payments need a look"],
  ["attention.setup.title", "One setup step left", "Two setup steps left"],
  ["attention.away.title", "One student away", "Two students away"],
  [
    "attention.contact.title",
    "No emergency contact for one student",
    "No emergency contact for two students",
  ],
  ["agenda.checkedIn", "1 checked in", "2 checked in"],
  ["agenda.spots", "1 spot", "2 spots"],
  ["agenda.more", "One more class", "Two more classes"],
  ["followUps.tag.overdue", "1 day overdue", "2 days overdue"],
  ["promotions.classes.ranked", "1 class since last belt", "2 classes since last belt"],
  ["promotions.classes.unranked", "1 class so far", "2 classes so far"],
];
for (const [path, one, two] of pairs)
  test(`D7 plural pair ${path}`, () => {
    const keys = path.split(".");
    if (keys[0] === "sentence") keys.splice(1, 0, "clauses");
    const pair = keys.reduce((value, key) => value[key], HOME_COPY);
    assert.equal(plural(pair, 1), one);
    assert.equal(plural(pair, 2), two);
  });
test("D7 orchestrator rulings preserve statuses, overdue fallback, percent and belt speech", () => {
  for (const [status, text] of [
    ["active", "Active"],
    ["trialing", "Trialing"],
    ["paused", "On hold"],
    ["inactive", "Inactive"],
    ["canceled", "Canceled"],
  ]) {
    assert.equal(homeNewStudentMeta({ status, startedOn: null }), text);
    assert.equal(
      homeNewStudentMeta({ status, startedOn: "2026-10-03" }),
      `Started Oct 3 · ${text}`,
    );
  }
  assert.equal(homeNewStudentMeta({ status: "unknown", startedOn: null }), null);
  assert.equal(homeNewStudentMeta({ status: "unknown", startedOn: "2026-10-03" }), "Started Oct 3");
  assert.equal(
    homeStatCopy({ id: "followUps", value: 1, note: { kind: "overdue", oldestDays: null } }).note,
    "Overdue",
  );
  assert.equal(
    homeStatCopy({
      id: "attendance",
      value: 9,
      unit: "percent",
      note: { kind: "filled", filled: 7, capacity: 74, windowDays: 30 },
    }).unit,
    "%",
  );
  assert.equal(
    homeStatCopy({ id: "attendance", value: null, note: { kind: "none" } }).unit,
    undefined,
  );
  assert.equal(
    homeBeltPairLabel({ from: { name: "White" }, to: { name: "Yellow" } }),
    "White to Yellow",
  );
  assert.equal(homeBeltPairLabel({ from: null, to: { name: "White" } }), "No belt yet to White");
  assert.equal(
    homeAttentionCopy({ kind: "contact", count: 1, studentId: "student-1" }).action,
    HOME_COPY.attention.contact.action.profile,
  );
  assert.equal(
    homeAttentionCopy({ kind: "contact", count: 1, studentId: null }).action,
    HOME_COPY.attention.contact.action.students,
  );
});
test("D7 helpers render dates, row counts, tags, next steps and error clocks", () => {
  for (const displayName of ["", "owner@example.test"])
    assert.equal(
      homeGreeting({
        timezone: "UTC",
        now: new Date("2026-10-10T09:00:00Z"),
        displayName,
        legalFirstName: null,
      }),
      "Good morning.",
    );
  assert.equal(homeEyebrow("2026-10-10", true), "Saturday, October 10 · Preview data");
  assert.equal(clock("16:00:00"), "4:00 PM");
  assert.deepEqual(homeClassCount({ countKind: "checkedIn", checkedIn: 4 }), {
    kind: "meta",
    text: "4 checked in",
  });
  assert.deepEqual(homeClassCount({ countKind: "spots", capacity: 12 }), {
    kind: "meta",
    text: "12 spots",
  });
  assert.equal(homeClassCount({ countKind: "none" }), null);
  assert.deepEqual(homeClassCount({ countKind: "noCheckIns" }), {
    kind: "tag",
    text: HOME_COPY.agenda.noCheckIns,
    tone: "warn",
  });
  assert.equal(homeClassAction({ action: "open" }), HOME_COPY.agenda.action.upcoming);
  assert.equal(homeClassAction({ action: "takeAttendance" }), HOME_COPY.agenda.action.started);
  assert.deepEqual(homeFollowUpTag({ kind: "overdue", days: 2 }), {
    label: "2 days overdue",
    tone: "alert",
  });
  assert.deepEqual(homeFollowUpTag({ kind: "today" }), {
    label: HOME_COPY.followUps.tag.today,
    tone: "warn",
  });
  assert.equal(
    homeFollowUpNextStep("inquiry"),
    getLeadNextAction({ stage: "inquiry", follow_up_date: "due" }),
  );
  assert.equal(
    homePromotionMeta({ from: { name: "White" }, classesAtRank: 9 }),
    "9 classes since last belt",
  );
  assert.equal(homePromotionMeta({ from: null, classesAtRank: 9 }), "9 classes so far");
  assert.equal(
    homeRefreshErrorDetail("2026-10-10T17:45:00Z", "UTC"),
    HOME_COPY.error.refresh.detail("5:45 PM"),
  );
  assert.equal(homeRefreshErrorDetail("bad", "UTC"), null);
});
test("every string literal and template fragment in home-copy avoids banned words and Unicode arrows", () => {
  const source = readFileSync(
    new URL("../src/lib/dashboard/home-copy.ts", import.meta.url),
    "utf8",
  );
  const file = ts.createSourceFile("home-copy.ts", source, ts.ScriptTarget.Latest, true);
  let checked = 0;
  function visit(node) {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      checked++;
      assert.doesNotMatch(
        node.text,
        /\b(summary|contract|bounded|role-safe|entitled|source|evidence|snapshot|arrangement|partial|unavailable)\b/i,
        `banned copy at ${file.getLineAndCharacterOfPosition(node.pos).line + 1}: ${node.text}`,
      );
      assert.doesNotMatch(node.text, /[\u2190-\u21ff\u27f0-\u27ff\u2900-\u297f]/u);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(checked > 150, "scan must cover the whole file, including function templates");
});

test("sentence forms when inputs are missing (Fable, Phase 3 M3 and ruling)", () => {
  assert.equal(
    homeSentenceText({
      classes: null,
      clauses: [
        { kind: "payments", count: 1 },
        { kind: "followUpsOverdue", count: 1 },
      ],
    }),
    "One payment to chase and one follow-up overdue.",
  );
  assert.equal(homeSentenceText({ classes: null, clauses: [] }), "Nothing needs you.");
  assert.equal(homeSentenceText({ classes: null, clauses: [], incomplete: true }), "");
  assert.equal(
    homeSentenceText({ classes: 3, clauses: [], incomplete: true }),
    "Three classes today.",
  );
});

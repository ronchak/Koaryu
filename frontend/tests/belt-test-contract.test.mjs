import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as m from "../src/lib/belt-test-contract.ts";

const bytes = readFileSync(new URL("./fixtures/belt-test-contract.json", import.meta.url));
const f = JSON.parse(bytes),
  ids = f.ids,
  event = f.events.scheduled,
  recipient = f.recipients.approved;
const clone = (value) => structuredClone(value);
const uid = (n) => `abcdefab-cdef-4abc-8def-${String(n).padStart(12, "0")}`;
const other = uid(999);
const pair = (row) => ({
  student_id: row.student_id,
  student_program_membership_id: row.student_program_membership_id,
});
const fields = (changes = {}) => ({
  name: event.name,
  ladderId: event.ladder_id,
  schedule: { starts_at: event.starts_at, ends_at: event.ends_at, timezone: event.timezone },
  location: "",
  status: "draft",
  ...changes,
});
const identity = (command, changes = {}) => ({
  operationId: ids.operation,
  studioId: ids.studio,
  command,
  ...(command === "belt_test.create" ? {} : { eventId: ids.event }),
  ...(command === "belt_test.revoke" ? { recipientId: ids.recipient } : {}),
  ...changes,
});
function rejectChanges(guard, value, changes) {
  for (const change of changes)
    assert.equal(guard({ ...value, ...change }), false, JSON.stringify(change));
}
function closed(guard, value) {
  for (const key of Object.keys(value)) {
    const missing = { ...value };
    delete missing[key];
    assert.equal(guard(missing), false, `missing ${key}`);
  }
  for (const key of ["", "extra", "__proto__", "constructor", "toString", Symbol("extra")])
    assert.equal(guard({ ...value, [key]: true }), false);
  assert.equal(guard(Object.create(value)), false);
  for (const invalid of [null, undefined, [], "", 0, false]) assert.equal(guard(invalid), false);
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function letterIds(value, upper = false) {
  if (Array.isArray(value)) return value.map((row) => letterIds(row, upper));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, letterIds(v, upper)]));
  if (typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)) {
    const id = `abcdefab-cdef-4abc-8def-${value.slice(-12)}`;
    return upper ? id.toUpperCase() : id;
  }
  return value;
}

test("fixture records the actual Pydantic serializer and exact clean source", () => {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "3d933923bfdca2da248cb55ab13b5d2e22d83b87245d600127c2be852bf878da",
  );
  assert.equal(f.provenance.source_sha, "b6baed958ea952b1c8d2c54fc0a17f341051d0c7");
  assert.match(f.provenance.method, /Actual Pydantic/);
  assert.equal(
    f.provenance.source_sha256["frontend/src/types/generated/api-contracts.ts"],
    "c0dc10ae6595ff92d4ffb222ba30198390977ef8dae4234b6359d0ee0c23417e",
  );
});
test("all canonical event and recipient branches remain valid", () => {
  for (const row of Object.values(f.events))
    assert.ok(m.isBeltTestEvent(row, ids.studio, ids.event));
  for (const row of Object.values(f.recipients))
    assert.ok(m.isBeltTestRecipient(row, ids.studio, ids.event, row.id));
  assert.ok(m.isBeltTestEventPage(f.event_page, ids.studio));
  assert.ok(m.isBeltTestRecipientPage(f.recipient_page, ids.studio, ids.event));
  assert.ok(m.isBeltTestCandidates(f.candidates));
  assert.ok(m.isBeltTestApproval(f.approval, ids.studio, ids.event));
  assert.ok(
    m.isBeltTestRecipient(
      { ...recipient, revision: 1, approved_schedule_revision: 50 },
      ids.studio,
      ids.event,
    ),
  );
  assert.ok(
    m.isBeltTestEvent(
      { ...event, created_at: event.updated_at, updated_at: event.created_at },
      ids.studio,
    ),
  );
});
test("canonical objects require every own key and reject unknown/prototype fields", () => {
  closed((v) => m.isBeltTestEvent(v, ids.studio), event);
  closed((v) => m.isBeltTestRecipient(v, ids.studio, ids.event), recipient);
  closed((v) => m.isBeltTestEventPage(v, ids.studio), f.event_page);
  closed((v) => m.isBeltTestRecipientPage(v, ids.studio, ids.event), f.recipient_page);
  closed((v) => m.isBeltTestApproval(v, ids.studio, ids.event), f.approval);
  closed((v) => m.isBeltTestCandidates([v]), f.candidates[0]);
  closed(
    (v) => m.isBeltTestReceipt(v, identity("belt_test.create")),
    f.receipts["belt_test.create"],
  );
});
test("event and recipient guards reject malformed enums, revisions, IDs and nulls", () => {
  rejectChanges((v) => m.isBeltTestEvent(v, ids.studio, ids.event), event, [
    { id: other },
    { studio_id: other },
    { status: ["scheduled"] },
    { status: { toString: () => "scheduled" } },
    { name: " padded " },
    { name: "" },
    { location: null },
    { program_id: undefined },
    { ladder_id: "sample-ladder" },
    { created_by: false },
    { created_at: "invalid" },
    { updated_at: null },
    { schedule_revision: 4 },
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "3", true].map((revision) => ({
      revision,
    })),
    ...[0, -1, 1.5, NaN, Infinity, "2", true].map((schedule_revision) => ({ schedule_revision })),
  ]);
  rejectChanges((v) => m.isBeltTestRecipient(v, ids.studio, ids.event, ids.recipient), recipient, [
    { id: other },
    { event_id: other },
    { studio_id: other },
    { student_id: null },
    { student_program_membership_id: undefined },
    { approved_current_rank_id: "sample-rank" },
    { approved_target_rank_id: null },
    { approved_by: 0 },
    { state: ["approved"] },
    { state: {} },
    { state: "revoked" },
    { revoked_at: event.starts_at },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { approved_schedule_revision: 0 },
    { approved_at: false },
  ]);
});
test("malformed scope and result contexts return false without coercion or throws", () => {
  for (const bad of [
    null,
    undefined,
    [],
    {},
    false,
    0,
    "preview-id",
    {
      toString() {
        throw Error("coercion");
      },
    },
  ]) {
    assert.equal(m.isBeltTestEvent(event, bad), false);
    assert.equal(m.isBeltTestEventPage(f.event_page, bad), false);
    assert.equal(m.isBeltTestRecipient(recipient, ids.studio, bad), false);
    assert.equal(m.isBeltTestRecipientPage(f.recipient_page, ids.studio, bad), false);
    assert.equal(m.isBeltTestApproval(f.approval, ids.studio, bad), false);
    assert.equal(m.isBeltTestReceipt(f.receipts["belt_test.create"], bad), false);
    assert.equal(m.isBeltTestCreateResult(f.events.create, ids.studio, bad), false);
    assert.equal(
      m.isBeltTestUpdateResult(f.events.name_update, bad, f.requests.name_update),
      false,
    );
    assert.equal(m.isBeltTestUpdateResult(f.events.name_update, event, bad), false);
    assert.equal(m.isBeltTestApproveResult(f.approval, bad, f.requests.approve), false);
    assert.equal(m.isBeltTestApproveResult(f.approval, event, bad), false);
    assert.equal(
      m.isBeltTestRevokeResult(f.recipients.revoked, event, bad, f.requests.revoke),
      false,
    );
    assert.equal(m.isBeltTestRevokeResult(f.recipients.revoked, event, recipient, bad), false);
  }
});
test("pages retain opaque cursors and enforce only documented limits", () => {
  const guard = (v, limit) => m.isBeltTestEventPage(v, ids.studio, limit);
  for (const next_cursor of [" ", "🧭".repeat(512), "x".repeat(512)])
    assert.ok(guard({ items: [], next_cursor, has_more: true }));
  for (const limit of [0, 101, 1.5, NaN, "1", null])
    assert.equal(guard(f.event_page, limit), false);
  rejectChanges(guard, f.event_page, [
    { next_cursor: "" },
    { next_cursor: "x".repeat(513) },
    { next_cursor: "🧭".repeat(513) },
    { next_cursor: null },
    { has_more: 1 },
    { has_more: false },
    { items: [event, event] },
    { items: [event, { ...event, id: other }], total: 2 },
  ]);
  assert.equal(guard({ ...f.event_page, items: [event, { ...event, id: other }] }, 1), false);
  assert.ok(guard({ items: [], next_cursor: null, has_more: false }));
  const duplicatePair = { ...recipient, id: other };
  assert.equal(
    m.isBeltTestRecipientPage(
      { ...f.recipient_page, items: [recipient, duplicatePair] },
      ids.studio,
      ids.event,
    ),
    false,
  );
  for (const guard of [
    (items) => m.isBeltTestCandidates(items),
    (items) => m.isBeltTestEventPage({ ...f.event_page, items }, ids.studio),
    (items) => m.isBeltTestApproval({ ...f.approval, items }, ids.studio, ids.event),
  ])
    assert.equal(guard(Array(1)), false);
});
test("candidate facts are complete advisory observations with unbounded row count", () => {
  const row = f.candidates[0];
  assert.ok(
    m.isBeltTestCandidates([
      { ...row, next_rank_id: null, next_rank_name: null, next_rank_color: null },
    ]),
  );
  assert.ok(m.isBeltTestCandidates([row, { ...row, student_program_membership_id: null }]));
  assert.ok(
    m.isBeltTestCandidates(Array.from({ length: 101 }, (_, n) => ({ ...row, student_id: uid(n) }))),
  );
  assert.ok(
    m.isBeltTestCandidates([
      { ...row, classes_since_promo: 0, classes_met: false, is_eligible: true },
    ]),
  );
  assert.equal(m.isBeltTestCandidates([row, row]), false);
  rejectChanges((v) => m.isBeltTestCandidates([v]), row, [
    { student_name: null },
    { next_rank_name: false },
    { program_id: "local-program" },
    { student_program_membership_id: undefined },
    ...["classes_since_promo", "classes_required", "days_at_rank", "days_required"].flatMap((key) =>
      [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, false, "0"].map((v) => ({ [key]: v })),
    ),
    ...["classes_met", "time_met", "needs_approval", "is_eligible"].flatMap((key) =>
      [null, undefined, 0, "false"].map((v) => ({ [key]: v })),
    ),
  ]);
});
test("approval envelope requires current approved snapshots and unique contexts", () => {
  rejectChanges((v) => m.isBeltTestApproval(v, ids.studio, ids.event), f.approval, [
    { items: [] },
    { items: [recipient, recipient] },
    { items: [recipient, { ...recipient, id: other }] },
    { items: [f.recipients.revoked] },
    { items: [{ ...recipient, event_id: other }] },
    { event_revision: 0 },
    { schedule_revision: 4 },
    { schedule_revision: 1 },
    { event_revision: "3" },
  ]);
  assert.ok(
    m.isBeltTestApproval(
      { ...f.approval, items: [{ ...recipient, revision: 1 }] },
      ids.studio,
      ids.event,
    ),
  );
});
test("metadata-only receipts validate original identity without inventing later CAS or pairs", () => {
  for (const [command, receipt] of Object.entries(f.receipts)) {
    const expected = identity(command);
    assert.ok(m.isBeltTestReceipt(receipt, expected));
    rejectChanges((v) => m.isBeltTestReceipt(v, expected), receipt, [
      { operation_id: other },
      { entity_id: other },
      { result: null },
      { result: [] },
      { state: ["committed"] },
      { command: [command] },
      { command: "belt_test.unknown" },
      { committed_at: "bad" },
      { entity_type: "workflow" },
    ]);
    assert.equal(m.isBeltTestReceipt(receipt, { ...expected, studioId: other }), false);
  }
  assert.ok(
    m.isBeltTestReceipt(
      f.receipts["belt_test.create"],
      identity("belt_test.create", { eventId: ids.event }),
    ),
  );
  assert.equal(
    m.isBeltTestReceipt(
      f.receipts["belt_test.create"],
      identity("belt_test.create", { eventId: other }),
    ),
    false,
  );
  assert.equal(
    m.isBeltTestReceipt(
      { ...f.receipts["belt_test.create"], result: event },
      identity("belt_test.create"),
    ),
    false,
  );
  assert.equal(
    m.isBeltTestReceipt(
      f.receipts["belt_test.revoke"],
      identity("belt_test.revoke", { recipientId: other }),
    ),
    false,
  );
  assert.equal(
    m.isBeltTestReceipt(
      f.receipts["belt_test.approve"],
      identity("belt_test.approve", { eventId: other }),
    ),
    false,
  );
  const historical = {
    ...f.receipts["belt_test.approve"],
    result: {
      ...f.approval,
      event_revision: 22,
      schedule_revision: 12,
      items: [{ ...recipient, approved_schedule_revision: 12, revision: 9 }],
    },
  };
  assert.ok(m.isBeltTestReceipt(historical, identity("belt_test.approve")));
  assert.equal(m.isBeltTestApproveResult(historical.result, event, f.requests.approve), false);
});
test("normalizers match serialized Unicode whitespace and count codepoints", () => {
  for (const sample of f.names)
    assert.equal(m.normalizeBeltTestName(sample.input), sample.normalized);
  assert.equal(m.normalizeBeltTestName("\u0085\u00a0Name\u3000"), "Name");
  assert.equal(m.normalizeBeltTestName("\ufeffName\ufeff"), "\ufeffName\ufeff");
  assert.equal(m.normalizeBeltTestName("A\u0085B"), "A\u0085B");
  assert.equal(m.normalizeBeltTestName("🥋".repeat(140)), "🥋".repeat(140));
  assert.throws(() => m.normalizeBeltTestName("🥋".repeat(141)), /Use valid belt-test fields/);
  assert.throws(() => m.normalizeBeltTestName("\u0085\u00a0"));
  assert.equal(m.normalizeBeltTestLocation("\u0085 room "), "\u0085 room ");
  assert.equal(m.normalizeBeltTestLocation("🥋".repeat(240)), "🥋".repeat(240));
  assert.throws(() => m.normalizeBeltTestLocation("🥋".repeat(241)));
  for (const bad of [null, [], {}, 0]) {
    assert.throws(() => m.normalizeBeltTestName(bad), /Use valid belt-test fields/);
    assert.throws(() => m.normalizeBeltTestLocation(bad), /Use valid belt-test fields/);
  }
});
test("create emits the complete canonical Pydantic body with detached schedule", () => {
  const input = freeze(fields({ name: "\u0085 Sample belt test \u00a0" }));
  const request = m.buildBeltTestCreate(ids.operation, input);
  assert.deepEqual(request, f.requests.create_defaults);
  assert.ok(m.isBeltTestCreateResult(f.events.create, ids.studio, request));
  assert.ok(
    m.isBeltTestCreateResult({ ...f.events.create, program_id: null }, ids.studio, request),
  );
  for (const change of [
    { status: ["draft"] },
    { status: "completed" },
    { ladderId: "preview-ladder" },
    { program_id: ids.program },
    { schedule: null },
  ])
    assert.throws(
      () => m.buildBeltTestCreate(ids.operation, fields(change)),
      /Use valid belt-test fields/,
    );
  for (const bad of [null, {}, [], { ...input, name: undefined }])
    assert.throws(() => m.buildBeltTestCreate(ids.operation, bad));
  rejectChanges((v) => m.isBeltTestCreateResult(v, ids.studio, request), f.events.create, [
    { name: "Other" },
    { status: "scheduled" },
    { ladder_id: other },
    { location: "Elsewhere" },
    { revision: 2 },
    { schedule_revision: 2 },
    { timezone: "UTC" },
    { starts_at: "2030-11-03T06:11:00Z" },
  ]);
});
test("accepted wire schedule keeps one microsecond, 24 hours and unavailable zones", () => {
  const one = {
    starts_at: "2030-01-01T01:00:00.123456+01:00",
    ends_at: "2030-01-01T01:00:00.123457+01:00",
    timezone: "Server/NewAlias",
  };
  const request = m.buildBeltTestCreate(ids.operation, fields({ schedule: one }));
  assert.equal(request.starts_at, "2030-01-01T00:00:00.123456Z");
  assert.equal(request.ends_at, "2030-01-01T00:00:00.123457Z");
  assert.deepEqual(
    m.buildBeltTestCreate(
      ids.operation,
      fields({
        schedule: {
          starts_at: request.starts_at,
          ends_at: request.ends_at,
          timezone: request.timezone,
        },
      }),
    ),
    request,
  );
  const day = { ...one, ends_at: "2030-01-02T01:00:00.123456+01:00" };
  assert.ok(m.buildBeltTestCreate(ids.operation, fields({ schedule: day })));
  assert.throws(() =>
    m.buildBeltTestCreate(
      ids.operation,
      fields({ schedule: { ...day, ends_at: "2030-01-02T01:00:00.123457+01:00" } }),
    ),
  );
  const saved = { ...event, ...one };
  assert.deepEqual(
    m.buildBeltTestUpdate(ids.operation, saved, { kind: "status", status: "canceled" }),
    f.requests.cancel_update,
  );
  assert.equal(
    m.isBeltTestEvent(
      { ...event, ...day, ends_at: "2030-01-02T01:00:00.123457+01:00" },
      ids.studio,
    ),
    false,
  );
});
test("details omit effective no-ops and include all schedule fields only on change", () => {
  assert.deepEqual(
    m.buildBeltTestUpdate(ids.operation, event, { kind: "details", name: " Changed " }),
    f.requests.name_update,
  );
  assert.deepEqual(
    m.buildBeltTestUpdate(ids.operation, event, {
      kind: "details",
      name: "Changed",
      location: event.location,
      ladderId: event.ladder_id,
      schedule: fields().schedule,
    }),
    f.requests.name_update,
  );
  for (const edit of [
    { kind: "details" },
    { kind: "details", name: ` ${event.name} ` },
    { kind: "details", location: event.location },
    { kind: "details", ladderId: event.ladder_id },
    { kind: "details", schedule: fields().schedule },
  ])
    assert.throws(
      () => m.buildBeltTestUpdate(ids.operation, event, edit),
      /Make a belt-test change/,
    );
  const schedule = { ...fields().schedule, timezone: "UTC" };
  assert.deepEqual(m.buildBeltTestUpdate(ids.operation, event, { kind: "details", schedule }), {
    operation_id: ids.operation,
    expected_revision: 3,
    ...schedule,
  });
  for (const edit of [
    null,
    {},
    { kind: ["details"] },
    { kind: "details", name: undefined },
    { kind: "details", ladderId: null },
    { kind: "details", schedule: {} },
    { kind: "details", status: "canceled" },
  ])
    assert.throws(() => m.buildBeltTestUpdate(ids.operation, event, edit));
});
test("status transitions and safe revision increments are exact", () => {
  for (const from of ["draft", "scheduled", "completed", "canceled"])
    for (const to of ["draft", "scheduled", "completed", "canceled"]) {
      const allowed =
        (from === "draft" && ["scheduled", "canceled"].includes(to)) ||
        (from === "scheduled" && ["completed", "canceled"].includes(to));
      const action = () =>
        m.buildBeltTestUpdate(
          ids.operation,
          { ...event, status: from },
          { kind: "status", status: to },
        );
      if (allowed) {
        assert.deepEqual(action(), {
          operation_id: ids.operation,
          expected_revision: 3,
          status: to,
        });
        assert.ok(
          m.isBeltTestUpdateResult(
            { ...event, status: to, revision: 4 },
            { ...event, status: from },
            action(),
          ),
        );
      } else assert.throws(action);
    }
  for (const status of ["completed", "canceled"])
    assert.throws(() =>
      m.buildBeltTestUpdate(
        ids.operation,
        { ...event, status },
        { kind: "details", name: "Changed" },
      ),
    );
  assert.throws(() =>
    m.buildBeltTestUpdate(
      ids.operation,
      { ...event, revision: Number.MAX_SAFE_INTEGER },
      { kind: "details", name: "Changed" },
    ),
  );
  assert.throws(() =>
    m.buildBeltTestUpdate(ids.operation, event, {
      kind: "status",
      status: "canceled",
      name: "Changed",
    }),
  );
});
test("direct updates enforce CAS, schedule revisions, unchanged fields and creation metadata", () => {
  const request = f.requests.name_update;
  assert.ok(m.isBeltTestUpdateResult(f.events.name_update, event, request));
  const locationRequest = m.buildBeltTestUpdate(ids.operation, event, {
    kind: "details",
    location: "New room",
  });
  assert.ok(m.isBeltTestUpdateResult(f.events.schedule_update, event, locationRequest));
  rejectChanges((v) => m.isBeltTestUpdateResult(v, event, request), f.events.name_update, [
    { revision: 5 },
    { schedule_revision: 3 },
    { name: "Wrong" },
    { status: "completed" },
    { location: "Wrong" },
    { program_id: null },
    { created_by: other },
    { created_at: event.updated_at },
    { ladder_id: other },
    { timezone: "UTC" },
    { id: other },
  ]);
  assert.equal(
    m.isBeltTestUpdateResult(
      { ...f.events.schedule_update, schedule_revision: 2 },
      event,
      locationRequest,
    ),
    false,
  );
  const ladderRequest = m.buildBeltTestUpdate(ids.operation, event, {
    kind: "details",
    ladderId: other,
  });
  assert.ok(
    m.isBeltTestUpdateResult(
      { ...event, ladder_id: other, program_id: null, revision: 4, schedule_revision: 3 },
      event,
      ladderRequest,
    ),
  );
  for (const bad of [
    { ...request, expected_revision: 2 },
    { ...request, starts_at: event.starts_at },
    { ...request, status: "canceled" },
    { ...request, name: event.name },
    { ...request, program_id: null },
    { ...request, name: undefined },
  ])
    assert.equal(m.isBeltTestUpdateResult(f.events.name_update, event, bad), false);
});
test("approve sends explicit detached pairs at 1..100, including same-student contexts", () => {
  const pairs = freeze(f.approval.items.map(pair));
  const request = m.buildBeltTestApprove(ids.operation, event, pairs);
  assert.deepEqual(request, f.requests.approve);
  assert.notEqual(request.recipients, pairs);
  assert.notEqual(request.recipients[0], pairs[0]);
  const hundred = Array.from({ length: 100 }, (_, n) => ({
    student_id: uid(n),
    student_program_membership_id: null,
  }));
  assert.equal(m.buildBeltTestApprove(ids.operation, event, hundred).recipients.length, 100);
  for (const bad of [
    [],
    [...hundred, pair(recipient)],
    [pairs[0], pairs[0]],
    [{ student_id: ids.student }],
    [{ ...pairs[0], extra: true }],
    Array(1),
  ])
    assert.throws(() => m.buildBeltTestApprove(ids.operation, event, bad));
  assert.throws(() => m.buildBeltTestApprove(ids.operation, f.events.draft, pairs));
  assert.ok(m.isBeltTestApproveResult(f.approval, event, request));
  assert.equal(
    m.isBeltTestApproveResult(f.approval, event, { ...request, recipients: Array(1) }),
    false,
  );
  assert.ok(
    m.isBeltTestApproveResult(
      { ...f.approval, items: f.approval.items.toReversed() },
      event,
      request,
    ),
  );
  for (const result of [
    { ...f.approval, event_revision: 4 },
    { ...f.approval, items: [recipient] },
    { ...f.approval, items: [recipient, { ...f.recipients.legacy, student_id: other }] },
  ])
    assert.equal(m.isBeltTestApproveResult(result, event, request), false);
});
test("revoke uses recipient revision and preserves every approval snapshot", () => {
  const request = m.buildBeltTestRevoke(ids.operation, event, recipient);
  assert.deepEqual(request, f.requests.revoke);
  assert.ok(m.isBeltTestRevokeResult(f.recipients.revoked, event, recipient, request));
  for (const parent of [f.events.completed, f.events.canceled])
    assert.deepEqual(m.buildBeltTestRevoke(ids.operation, parent, recipient), request);
  for (const bad of [
    { ...recipient, revision: Number.MAX_SAFE_INTEGER },
    { ...recipient, event_id: other },
    f.recipients.revoked,
  ])
    assert.throws(() => m.buildBeltTestRevoke(ids.operation, event, bad));
  rejectChanges(
    (v) => m.isBeltTestRevokeResult(v, event, recipient, request),
    f.recipients.revoked,
    [
      { state: "approved", revoked_at: null },
      { revision: 4 },
      { approved_schedule_revision: 3 },
      { student_id: other },
      { student_program_membership_id: null },
      { approved_current_rank_id: other },
      { approved_target_rank_id: other },
      { approved_by: other },
      { approved_at: event.created_at },
      { created_at: event.updated_at },
      { revoked_at: null },
    ],
  );
  assert.equal(
    m.isBeltTestRevokeResult(f.recipients.revoked, event, recipient, {
      ...request,
      expected_revision: event.revision,
    }),
    false,
  );
});
test("UUID case is one identity across target namespaces, body IDs, scopes and receipts", () => {
  const lower = letterIds(f),
    upper = letterIds(f, true),
    id = lower.ids,
    row = upper.events.scheduled;
  assert.notEqual(upper.ids.event, id.event);
  assert.equal(m.beltTestTargetKey({ kind: "draft", id: upper.ids.event }), `draft:${id.event}`);
  assert.notEqual(
    m.beltTestTargetKey({ kind: "draft", id: id.event }),
    m.beltTestTargetKey({ kind: "event", id: id.event }),
  );
  for (const bad of [
    null,
    { kind: "event", id: "preview-event" },
    { kind: ["event"], id: id.event },
  ]) {
    assert.equal(m.isBeltTestTarget(bad), false);
    assert.throws(() => m.beltTestTargetKey(bad));
  }
  const request = m.buildBeltTestCreate(
    upper.ids.operation,
    fields({ ladderId: upper.ids.ladder }),
  );
  assert.equal(request.operation_id, id.operation);
  assert.equal(request.ladder_id, id.ladder);
  assert.ok(m.isBeltTestEvent(row, id.studio, id.event));
  assert.ok(m.isBeltTestRecipient(upper.recipients.approved, id.studio, id.event, id.recipient));
  assert.throws(
    () => m.buildBeltTestUpdate(upper.ids.operation, row, { kind: "details", ladderId: id.ladder }),
    /Make a belt-test change/,
  );
  assert.equal(
    m.buildBeltTestUpdate(upper.ids.operation, row, { kind: "details", name: "Changed" })
      .operation_id,
    id.operation,
  );
  const approval = m.buildBeltTestApprove(upper.ids.operation, row, upper.approval.items.map(pair));
  assert.deepEqual(approval, lower.requests.approve);
  assert.equal(
    m.buildBeltTestRevoke(upper.ids.operation, row, upper.recipients.approved).operation_id,
    id.operation,
  );
  for (const [command, receipt] of Object.entries(upper.receipts))
    assert.ok(
      m.isBeltTestReceipt(receipt, {
        ...identity(command),
        operationId: id.operation,
        studioId: id.studio,
        eventId: id.event,
        ...(command === "belt_test.revoke" ? { recipientId: id.recipient } : {}),
      }),
    );
  assert.ok(
    m.isBeltTestCreateResult(upper.events.create, id.studio, lower.requests.create_defaults),
  );
  assert.ok(
    m.isBeltTestUpdateResult(
      upper.events.name_update,
      lower.events.scheduled,
      lower.requests.name_update,
    ),
  );
  assert.ok(
    m.isBeltTestApproveResult(upper.approval, lower.events.scheduled, lower.requests.approve),
  );
  assert.ok(
    m.isBeltTestRevokeResult(
      upper.recipients.revoked,
      lower.events.scheduled,
      lower.recipients.approved,
      lower.requests.revoke,
    ),
  );
  const snapshot = {
    ...lower.recipients.approved,
    approved_by: uid(77),
    approved_current_rank_id: uid(78),
  };
  assert.ok(
    m.isBeltTestRevokeResult(
      {
        ...upper.recipients.revoked,
        approved_by: uid(77).toUpperCase(),
        approved_current_rank_id: uid(78).toUpperCase(),
      },
      lower.events.scheduled,
      snapshot,
      lower.requests.revoke,
    ),
  );
  assert.ok(
    m.isBeltTestUpdateResult(
      { ...upper.events.name_update, created_by: uid(77).toUpperCase() },
      { ...lower.events.scheduled, created_by: uid(77) },
      lower.requests.name_update,
    ),
  );
  assert.throws(() =>
    m.buildBeltTestApprove(id.operation, row, [
      pair(lower.recipients.approved),
      pair(upper.recipients.approved),
    ]),
  );
  assert.equal(m.isBeltTestCandidates([lower.candidates[0], upper.candidates[0]]), false);
  assert.equal(
    m.isBeltTestEventPage({ ...f.event_page, items: [lower.events.scheduled, row] }, id.studio),
    false,
  );
  assert.equal(
    m.isBeltTestRecipientPage(
      {
        ...lower.recipient_page,
        items: [
          lower.recipients.approved,
          { ...upper.recipients.approved, student_program_membership_id: null },
        ],
      },
      id.studio,
      id.event,
    ),
    false,
  );
  assert.equal(
    m.isBeltTestApproval(
      {
        ...lower.approval,
        items: [lower.recipients.approved, { ...upper.recipients.approved, id: other }],
      },
      id.studio,
      id.event,
    ),
    false,
  );
});
test("builders and guards preserve caller objects and reject malformed operation IDs", () => {
  const before = clone(f),
    frozen = freeze(clone(f));
  m.buildBeltTestCreate(ids.operation, freeze(fields()));
  m.buildBeltTestUpdate(
    ids.operation,
    frozen.events.scheduled,
    freeze({ kind: "details", name: "Changed" }),
  );
  const request = m.buildBeltTestApprove(
    ids.operation,
    frozen.events.scheduled,
    freeze(frozen.approval.items.map(pair)),
  );
  request.recipients[0].student_id = other;
  m.buildBeltTestRevoke(ids.operation, frozen.events.scheduled, frozen.recipients.approved);
  for (const [command, receipt] of Object.entries(frozen.receipts))
    assert.ok(m.isBeltTestReceipt(receipt, freeze(identity(command))));
  assert.deepEqual(frozen, before);
  for (const bad of [
    null,
    undefined,
    1,
    [],
    {
      toString() {
        throw Error("coercion");
      },
    },
    "local-id",
  ]) {
    assert.throws(() => m.buildBeltTestCreate(bad, fields()), /Use valid belt-test fields/);
    assert.throws(
      () => m.buildBeltTestUpdate(bad, event, { kind: "status", status: "canceled" }),
      /Use valid belt-test fields/,
    );
    assert.throws(
      () => m.buildBeltTestApprove(bad, event, [pair(recipient)]),
      /Use valid belt-test fields/,
    );
    assert.throws(() => m.buildBeltTestRevoke(bad, event, recipient), /Use valid belt-test fields/);
  }
});

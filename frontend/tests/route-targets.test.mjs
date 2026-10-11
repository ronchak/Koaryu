import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildConsumedRouteHref,
  isRouteDateKey,
  isSameScheduleTarget,
  LEADS_TARGET_PARAMS,
  parseLeadsTarget,
  parseRouteRecordId,
  parseScheduleTarget,
  resolveScheduleTargetSession,
  SCHEDULE_TARGET_PARAMS,
} from "../src/lib/route-targets.ts";

const uuid = "abcdef01-2345-6789-abcd-ef0123456789";
const date = "2026-10-10";
const preview = { allowPreviewIds: true };

describe("route target dates", () => {
  it("accepts real calendar dates including leap days and year boundaries", () => {
    for (const value of [date, "2024-02-29", "2000-02-29", "1000-01-01", "9999-12-31"])
      assert.equal(isRouteDateKey(value), true, value);
  });

  it("rejects impossible, non-padded, short-year and missing dates", () => {
    for (const value of [
      "2026-02-30",
      "2026-02-29",
      "1900-02-29",
      "2026-04-31",
      "2026-13-01",
      "2026-00-01",
      "2026-01-00",
      "2026-01-32",
      "26-10-10",
      "0999-12-31",
      "2026-1-01",
      "2026-01-1",
      "2026-10-10T12:00:00",
      " 2026-10-10",
      "",
      null,
      undefined,
    ])
      assert.equal(isRouteDateKey(value), false, String(value));
  });
});

describe("route record ids", () => {
  it("normalizes UUID case in live and preview modes", () => {
    for (const options of [undefined, {}, preview])
      assert.equal(parseRouteRecordId(uuid.toUpperCase(), options), uuid);
  });

  it("accepts preview ids only when enabled and preserves their case", () => {
    for (const value of ["sess-1", "lead-1", "A_b-9", "0", "a".repeat(80)]) {
      assert.equal(parseRouteRecordId(value), null);
      assert.equal(parseRouteRecordId(value, { allowPreviewIds: false }), null);
      assert.equal(parseRouteRecordId(value, preview), value);
    }
  });

  it("rejects malformed ids, URL syntax, whitespace and overlong preview ids", () => {
    for (const value of [
      null,
      undefined,
      "",
      "-sess",
      "_lead",
      "a".repeat(81),
      "a/b",
      "a.b",
      "a b",
      "a?b",
      "a#b",
      "é",
      ` ${uuid}`,
      `${uuid} `,
    ]) {
      assert.equal(parseRouteRecordId(value), null, String(value));
      assert.equal(parseRouteRecordId(value, preview), null, String(value));
    }
  });
});

describe("schedule route targets", () => {
  it("reads a date and optional UUID from strings and URLSearchParams", () => {
    for (const search of [
      `?date=${date}&session=${uuid.toUpperCase()}`,
      new URLSearchParams({ date, session: uuid.toUpperCase() }),
    ])
      assert.deepEqual(parseScheduleTarget(search), { date, sessionId: uuid });
    assert.deepEqual(parseScheduleTarget(`date=${date}`), { date, sessionId: null });
    assert.deepEqual(parseScheduleTarget(`date=${date}&session=sess-1`, preview), {
      date,
      sessionId: "sess-1",
    });
  });

  it("requires exactly one valid date even when a session is valid", () => {
    for (const search of [
      "",
      `session=${uuid}`,
      `date=&session=${uuid}`,
      "date=2026-02-30",
      `date=${date}&date=${date}`,
      `date=${date}&date=2026-10-11`,
      "date=26-10-10",
    ])
      assert.equal(parseScheduleTarget(search), null, search);
  });

  it("drops invalid or repeated sessions while retaining the date", () => {
    for (const session of ["", "sess-1", "bad/id", `${uuid}&session=${uuid}`])
      assert.deepEqual(parseScheduleTarget(`date=${date}&session=${session}`), {
        date,
        sessionId: null,
      });
  });

  it("compares target values and treats absent targets as equal", () => {
    const target = { date, sessionId: uuid };
    assert.equal(isSameScheduleTarget(target, { ...target }), true);
    assert.equal(isSameScheduleTarget(null, undefined), true);
    assert.equal(isSameScheduleTarget(undefined, undefined), true);
    assert.equal(isSameScheduleTarget(target, null), false);
    assert.equal(isSameScheduleTarget(null, target), false);
    assert.equal(isSameScheduleTarget(target, { ...target, date: "2026-10-11" }), false);
    assert.equal(isSameScheduleTarget(target, { ...target, sessionId: null }), false);
  });
});

describe("leads route targets", () => {
  it("accepts overdue and today focus with or without a lead", () => {
    for (const focus of ["overdue", "today"]) {
      assert.deepEqual(parseLeadsTarget(`focus=${focus}`), { focus, leadId: null });
      assert.deepEqual(parseLeadsTarget(new URLSearchParams({ focus, lead: uuid.toUpperCase() })), {
        focus,
        leadId: uuid,
      });
    }
    assert.deepEqual(parseLeadsTarget(`lead=${uuid}`), { focus: null, leadId: uuid });
    assert.deepEqual(parseLeadsTarget("lead=lead-1", preview), { focus: null, leadId: "lead-1" });
  });

  it("rejects unknown and case-sensitive focus while retaining a valid lead", () => {
    for (const focus of [
      "unassigned",
      "Overdue",
      "TODAY",
      "today ",
      "",
      "overdue&focus=today",
      "today&focus=today",
    ]) {
      assert.equal(parseLeadsTarget(`focus=${focus}`), null, focus);
      assert.deepEqual(parseLeadsTarget(`focus=${focus}&lead=${uuid}`), {
        focus: null,
        leadId: uuid,
      });
    }
  });

  it("ignores invalid and repeated leads while retaining a valid focus", () => {
    for (const lead of ["", "lead-1", "bad/id", `${uuid}&lead=${uuid}`]) {
      assert.equal(parseLeadsTarget(`lead=${lead}`), null, lead);
      assert.deepEqual(parseLeadsTarget(`focus=today&lead=${lead}`), {
        focus: "today",
        leadId: null,
      });
    }
    assert.equal(parseLeadsTarget(""), null);
    assert.equal(parseLeadsTarget("other=value"), null);
  });
});

describe("schedule target resolution", () => {
  it("opens only the matching session on the linked date and preserves its object", () => {
    const session = { id: uuid.toUpperCase(), date, status: "scheduled", name: "Karate" };
    const outcome = resolveScheduleTargetSession({ date, sessionId: uuid }, [session]);
    assert.equal(outcome.kind, "open");
    assert.equal(outcome.session, session);
    assert.equal(
      resolveScheduleTargetSession({ date, sessionId: "sess-1" }, [
        { ...session, id: "sess-1", status: "completed" },
      ]).kind,
      "open",
    );
  });

  it("returns canceled without opening attendance", () => {
    const session = { id: uuid, date, status: "canceled" };
    assert.deepEqual(resolveScheduleTargetSession({ date, sessionId: uuid }, [session]), {
      kind: "canceled",
      session,
    });
  });

  it("returns missing for deleted, wrong-date, wrong-id and date-only targets", () => {
    const session = { id: uuid, date, status: "scheduled" };
    for (const sessions of [
      [],
      [{ ...session, date: "2026-10-11" }],
      [{ ...session, id: "other" }],
    ])
      assert.deepEqual(resolveScheduleTargetSession({ date, sessionId: uuid }, sessions), {
        kind: "missing",
      });
    assert.deepEqual(resolveScheduleTargetSession({ date, sessionId: null }, [session]), {
      kind: "missing",
    });
  });
});

describe("consumed route addresses", () => {
  it("removes only target params including duplicates and keeps other params and the hash", () => {
    assert.deepEqual(SCHEDULE_TARGET_PARAMS, ["date", "session"]);
    assert.deepEqual(LEADS_TARGET_PARAMS, ["focus", "lead"]);
    for (const [pathname, search, names] of [
      [
        "/schedule",
        `?date=${date}&session=${uuid}&date=${date}&keep=one&keep=two&focus=today`,
        SCHEDULE_TARGET_PARAMS,
      ],
      [
        "/leads",
        `?focus=today&lead=${uuid}&focus=overdue&keep=one&keep=two&date=${date}`,
        LEADS_TARGET_PARAMS,
      ],
    ]) {
      const href = buildConsumedRouteHref({ pathname, search, hash: "#details" }, names);
      const parsed = new URL(href, "http://localhost");
      assert.equal(parsed.pathname, pathname);
      assert.equal(parsed.hash, "#details");
      assert.deepEqual(parsed.searchParams.getAll("keep"), ["one", "two"]);
      for (const name of names) assert.equal(parsed.searchParams.has(name), false);
      assert.equal(
        parsed.searchParams.get(pathname === "/leads" ? "date" : "focus"),
        pathname === "/leads" ? date : "today",
      );
    }
  });

  it("omits an empty query and keeps a hash when the targets were the only params", () => {
    assert.equal(
      buildConsumedRouteHref(
        { pathname: "/schedule", search: `?date=${date}` },
        SCHEDULE_TARGET_PARAMS,
      ),
      "/schedule",
    );
    assert.equal(
      buildConsumedRouteHref(
        { pathname: "/leads", search: "?lead=", hash: "#queue" },
        LEADS_TARGET_PARAMS,
      ),
      "/leads#queue",
    );
  });

  it("returns null when there is nothing to remove and does not mutate its input", () => {
    const location = { pathname: "/schedule", search: "?other=value", hash: "#day" };
    assert.equal(buildConsumedRouteHref(location, SCHEDULE_TARGET_PARAMS), null);
    assert.deepEqual(location, { pathname: "/schedule", search: "?other=value", hash: "#day" });
    assert.equal(
      buildConsumedRouteHref({ pathname: "/leads", search: "" }, LEADS_TARGET_PARAMS),
      null,
    );
    assert.equal(buildConsumedRouteHref(location, []), null);
  });
});

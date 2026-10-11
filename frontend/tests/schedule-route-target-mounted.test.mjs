import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

const date = "2026-10-10";
const sessionId = "abcdef01-2345-6789-abcd-ef0123456789";
const session = (id = sessionId, extra = {}) => ({
  id,
  date,
  name: "Karate",
  start_time: "09:00",
  end_time: "10:00",
  program_id: null,
  status: "scheduled",
  attendance_count: 0,
  capacity: 10,
  ...extra,
});

function bundle() {
  const { add, modules } = createCommonJsPacker({
    "next/navigation": `exports.useSearchParams=()=>{const React=require('react'),f=window.fixture;const search=React.useSyncExternalStore(f.subscribe,()=>window.location.search);return React.useMemo(()=>new URLSearchParams(search),[search]);};`,
    "next/dynamic": `exports.__esModule=true;exports.default=()=>()=>null;`,
    "@/lib/store": `const React=require('react');function state(){const f=window.fixture;return React.useSyncExternalStore(f.subscribe,()=>f.state);}exports.useConfigStore=()=>state().config;exports.useStudioStore=()=>({identityReady:true,identityGeneration:1});exports.useScheduleStore=()=>state().schedule;exports.useProgramStore=()=>window.fixture.programs;exports.useStudentStore=()=>window.fixture.students;`,
    "@/lib/performance": `exports.markDashboardReadiness=()=>()=>{};`,
    "@/components/header": `exports.Header=({title,children})=>require('react').createElement('header',null,require('react').createElement('h1',null,title),children);`,
    "@/components/operations/operations-surface": `exports.OperationsSurface=({children})=>children;`,
    "@/components/schedule/class-form-modal": `exports.ClassFormModal=()=>null;`,
    "@/components/schedule/session-detail-modal": `exports.ScheduleSessionDetailModal=()=>null;`,
    "@/components/schedule/schedule-page-content": `const React=require('react'),real=require('@/components/schedule/schedule-page-content.tsx');exports.SchedulePageContent=props=>{window.fixture.controller=props;return React.createElement(real.SchedulePageContent,props);};`,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
  });
  const react = add("react"),
    dom = add("react-dom/client");
  const page = add("@/app/(dashboard)/schedule/page");
  const retained = add("@/lib/retained-state");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}const React=require(${react});require(${dom}).createRoot(document.getElementById('root')).render(React.createElement(require(${retained}).RetainedStateProvider,{scope:'schedule-route-test'},React.createElement(require(${page}).default)));})();`;
}

const source = bundle();
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function mount(
  t,
  {
    href = `/schedule?date=${date}&session=${sessionId}&keep=one&keep=two#day`,
    sessions = [session()],
    preview = false,
  } = {},
) {
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], "No browser runtime errors");
  });
  // All requests are intercepted. Only the synthetic loopback document is served.
  await page.route("**/*", (route) =>
    route.request().isNavigationRequest()
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto(`http://localhost${href}`);
  await page.evaluate(
    ({ sessions, preview }) => {
      const listeners = new Set(),
        noop = async () => {};
      const f = (window.fixture = { reads: [], attendanceReads: [], replacements: [] });
      f.subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      f.notify = () => listeners.forEach((listener) => listener());
      const replace = history.replaceState.bind(history);
      history.replaceState = (...args) => {
        f.replacements.push(args);
        replace(...args);
      };
      f.programs = { programs: [], programsLoaded: true, refreshPrograms: noop };
      f.students = {
        students: [],
        studentsLoaded: true,
        studentsMayBePartial: false,
        refreshStudents: noop,
      };
      f.state = {
        config: { businessDate: "2026-09-29", currentRole: "admin", isPreviewMode: preview },
        schedule: {
          sessions,
          attendance: [],
          templates: [],
          addSession: noop,
          addTemplate: noop,
          deleteSession: noop,
          toggleCheckIn: noop,
          refreshSessionAttendance: async (id) => {
            f.attendanceReads.push(id);
            return { committed: true };
          },
          refreshScheduleRange: (...args) =>
            new Promise((resolve, reject) => f.reads.push({ args, resolve, reject })),
        },
      };
      f.resolve = (index, loaded) => {
        f.state = { ...f.state, schedule: { ...f.state.schedule, sessions: loaded } };
        f.notify();
        f.reads[index].resolve(loaded);
      };
      f.link = (href) => {
        history.pushState(null, "", href);
        f.notify();
      };
    },
    { sessions, preview },
  );
  await page.addScriptTag({ content: source });
  await page.waitForFunction(() => fixture.reads.length === 1 && fixture.controller);
  return page;
}

const flush = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
async function resolveRange(page, index = 0, sessions = [session()]) {
  await page.evaluate(({ index, sessions }) => fixture.resolve(index, sessions), {
    index,
    sessions,
  });
  await page.waitForFunction(() => !fixture.controller.isRefreshingRange);
  await flush(page);
}
const state = (page) =>
  page.evaluate(() => ({
    view: fixture.controller.view,
    date: [
      fixture.controller.currentDate.getFullYear(),
      String(fixture.controller.currentDate.getMonth() + 1).padStart(2, "0"),
      String(fixture.controller.currentDate.getDate()).padStart(2, "0"),
    ].join("-"),
    selected: fixture.controller.selectedSession?.id ?? null,
    notice: fixture.controller.routeTargetNotice,
    replacements: fixture.replacements,
    href: location.pathname + location.search + location.hash,
  }));

test("Schedule target starts Day view on its date and requests that day first", async (t) => {
  const page = await mount(t);
  assert.equal((await state(page)).view, "day");
  assert.equal((await state(page)).date, date);
  assert.deepEqual(await page.evaluate(() => fixture.reads[0].args), [date, date, "materialize"]);
  assert.equal(
    (await state(page)).selected,
    null,
    "Attendance must wait for a successful range load",
  );
  assert.deepEqual((await state(page)).replacements, []);
  // The store contains a stale matching session; the authoritative range result owns the decision.
  await resolveRange(page, 0, [session(sessionId, { name: "Fresh Karate" })]);
  assert.equal((await state(page)).selected, sessionId);
  assert.equal(await page.evaluate(() => fixture.controller.selectedSession.name), "Fresh Karate");
  assert.deepEqual(await page.evaluate(() => fixture.attendanceReads), [sessionId]);
  assert.deepEqual((await state(page)).replacements, [
    [null, "", "/schedule?keep=one&keep=two#day"],
  ]);
});

test("Schedule without a target keeps the business-date Month view", async (t) => {
  const page = await mount(t, { href: "/schedule?keep=one#day" });
  assert.equal((await state(page)).view, "month");
  assert.equal((await state(page)).date, "2026-09-29");
  assert.deepEqual(await page.evaluate(() => fixture.reads[0].args), [
    "2026-08-30",
    "2026-10-10",
    "materialize",
  ]);
  await resolveRange(page);
  assert.equal((await state(page)).selected, null);
  assert.deepEqual((await state(page)).replacements, []);
});

test("date-only and invalid-session targets consume the URL before loading", async (t) => {
  for (const suffix of ["", "&session=bad/id"]) {
    const page = await mount(t, { href: `/schedule?date=${date}${suffix}&keep=one#day` });
    await page.waitForFunction(() => fixture.replacements.length === 1);
    assert.equal((await state(page)).view, "day");
    assert.equal((await state(page)).href, "/schedule?keep=one#day");
    assert.equal((await state(page)).selected, null);
    await resolveRange(page);
    assert.equal((await state(page)).selected, null);
    assert.equal((await state(page)).notice, null);
  }
});

test("invalid or repeated dates leave the Schedule URL untouched", async (t) => {
  for (const query of [
    `date=2026-02-30&session=${sessionId}`,
    `date=${date}&date=${date}`,
    `session=${sessionId}`,
  ]) {
    const page = await mount(t, { href: `/schedule?${query}#day` });
    await resolveRange(page);
    assert.equal((await state(page)).view, "month");
    assert.equal((await state(page)).href, `/schedule?${query}#day`);
    assert.deepEqual((await state(page)).replacements, []);
  }
});

for (const [label, loaded, notice] of [
  [
    "canceled",
    [session(sessionId, { status: "canceled" })],
    "Karate was canceled, so there is no attendance to take.",
  ],
  ["deleted", [], "That class is no longer on this day's schedule."],
  [
    "wrong-date",
    [session(sessionId, { date: "2026-10-11" })],
    "That class is no longer on this day's schedule.",
  ],
])
  test(`${label} target shows its exact dismissible notice without opening attendance`, async (t) => {
    const page = await mount(t);
    await resolveRange(page, 0, loaded);
    assert.equal((await state(page)).selected, null);
    assert.equal((await state(page)).notice, notice);
    await expect(page.getByText(notice, { exact: true })).toHaveCount(1);
    assert.deepEqual(await page.evaluate(() => fixture.attendanceReads), []);
    assert.equal((await state(page)).href, "/schedule?keep=one&keep=two#day");
    await page.evaluate(() => fixture.controller.onNavigate(1));
    await page.waitForFunction(() => fixture.reads.length === 2);
    assert.equal((await state(page)).notice, null);
    await resolveRange(page, 1, []);
    await page.evaluate(() => fixture.controller.onNavigate(-1));
    await page.waitForFunction(() => fixture.reads.length === 3);
    assert.equal(
      (await state(page)).notice,
      notice,
      "Notice remains associated with its original range",
    );
    await page.getByRole("button", { name: "Dismiss notification" }).click();
    assert.equal((await state(page)).notice, null);
    await resolveRange(page, 2, loaded);
    assert.equal((await state(page)).notice, null, "A dismissed settled target must not return");
  });

for (const recovery of ["Retry", "resume"])
  test(`failed load keeps its target until ${recovery} succeeds`, async (t) => {
    const page = await mount(t);
    await page.evaluate(() => fixture.reads[0].reject(new Error("Synthetic range failure")));
    await expect(page.getByRole("alert")).toContainText(
      "Could not load this calendar range. Please try again.",
    );
    assert.equal((await state(page)).selected, null);
    assert.deepEqual((await state(page)).replacements, []);
    if (recovery === "Retry")
      await page.getByRole("button", { name: "Retry", exact: true }).click();
    else await page.evaluate(() => window.dispatchEvent(new Event("koaryu:data-refresh")));
    await page.waitForFunction(() => fixture.reads.length === 2);
    await resolveRange(page, 1);
    assert.equal((await state(page)).selected, sessionId);
    assert.equal((await state(page)).notice, null);
    assert.equal((await state(page)).href, "/schedule?keep=one&keep=two#day");
  });

test("moving to another range before loading drops the target quietly", async (t) => {
  const page = await mount(t);
  await page.getByRole("button", { name: "Next day", exact: true }).click();
  await page.waitForFunction(() => fixture.reads.length === 2);
  await page.evaluate(
    ({ date, sessionId }) =>
      fixture.reads[0].resolve([{ id: sessionId, date, status: "scheduled" }]),
    { date, sessionId },
  );
  await flush(page);
  assert.equal(
    (await state(page)).selected,
    null,
    "An obsolete range completion cannot open attendance",
  );
  await resolveRange(page, 1, []);
  assert.equal((await state(page)).selected, null);
  assert.equal((await state(page)).notice, null);
  assert.equal((await state(page)).href, "/schedule?keep=one&keep=two#day");
  await page.evaluate(() => fixture.controller.onNavigate(-1));
  await page.waitForFunction(() => fixture.reads.length === 3);
  await resolveRange(page, 2);
  assert.equal((await state(page)).selected, null);
});

for (const action of ["another session", "Add class"])
  test(`opening ${action} before loading preserves the user's choice`, async (t) => {
    const other = session("other-session", { name: "Other class" });
    const page = await mount(t, { sessions: [session(), other] });
    await page.evaluate(
      (action) =>
        action === "Add class"
          ? fixture.controller.onOpenAddClass()
          : fixture.controller.onOpenSession(fixture.state.schedule.sessions[1]),
      action,
    );
    await flush(page);
    await resolveRange(page, 0, [session(), other]);
    assert.equal((await state(page)).selected, action === "Add class" ? null : other.id);
    assert.equal(
      await page.evaluate(() => fixture.controller.showAddClass),
      action === "Add class",
    );
    assert.equal((await state(page)).notice, null);
    assert.equal((await state(page)).href, "/schedule?keep=one&keep=two#day");
  });

test("a settled target opens once across close, resume and later range loads", async (t) => {
  const page = await mount(t);
  await resolveRange(page);
  await page.evaluate(() => fixture.controller.onCloseSelectedSession());
  await flush(page);
  await page.evaluate(() => window.dispatchEvent(new Event("koaryu:data-refresh")));
  await page.waitForFunction(() => fixture.reads.length === 2);
  await resolveRange(page, 1);
  assert.equal((await state(page)).selected, null);
  await page.evaluate(() => fixture.controller.onNavigate(1));
  await page.waitForFunction(() => fixture.reads.length === 3);
  await resolveRange(page, 2, []);
  await page.evaluate(() => fixture.controller.onNavigate(-1));
  await page.waitForFunction(() => fixture.reads.length === 4);
  await resolveRange(page, 3);
  assert.equal((await state(page)).selected, null);
  assert.deepEqual(await page.evaluate(() => fixture.attendanceReads), [sessionId]);
  assert.equal((await state(page)).replacements.length, 1);
});

test("a changed route target while mounted applies the new date and session", async (t) => {
  const page = await mount(t);
  await resolveRange(page);
  await page.evaluate(() => fixture.controller.onCloseSelectedSession());
  await flush(page);
  const next = session("12345678-1234-5678-abcd-123456789abc", { date: "2026-10-12" });
  await page.evaluate(
    (next) => fixture.link(`/schedule?date=${next.date}&session=${next.id}&keep=new#next`),
    next,
  );
  await page.waitForFunction(() => fixture.reads.length === 2);
  assert.equal((await state(page)).date, next.date);
  assert.equal((await state(page)).view, "day");
  assert.deepEqual(await page.evaluate(() => fixture.reads[1].args.slice(0, 2)), [
    next.date,
    next.date,
  ]);
  await resolveRange(page, 1, [next]);
  assert.equal((await state(page)).selected, next.id);
  assert.equal((await state(page)).href, "/schedule?keep=new#next");
});

test("Schedule page permits readable session ids only in preview mode", async (t) => {
  for (const preview of [false, true]) {
    const page = await mount(t, {
      href: `/schedule?date=${date}&session=sess-1`,
      sessions: [session("sess-1")],
      preview,
    });
    await resolveRange(page, 0, [session("sess-1")]);
    assert.equal((await state(page)).selected, preview ? "sess-1" : null);
    assert.equal((await state(page)).notice, null);
    assert.equal((await state(page)).href, "/schedule");
  }
});

test("a changed same-day session target opens after the previous target settled", async (t) => {
  const next = session("12345678-1234-5678-abcd-123456789abc", { name: "Second class" });
  const page = await mount(t, { sessions: [session(), next] });
  await resolveRange(page, 0, [session(), next]);
  await page.evaluate(() => fixture.controller.onCloseSelectedSession());
  await flush(page);
  await page.evaluate(
    ({ date, id }) => fixture.link(`/schedule?date=${date}&session=${id}&keep=new#same`),
    { date, id: next.id },
  );
  await flush(page);
  // The reader may reuse the successful day load or request a fresh one.
  if (await page.evaluate(() => fixture.reads.length > 1)) {
    await resolveRange(page, 1, [session(), next]);
  }
  assert.equal(
    (await state(page)).selected,
    next.id,
    "A changed session id on the same loaded date must apply; it must not wait forever for a range change",
  );
  assert.equal((await state(page)).href, "/schedule?keep=new#same");
});

test("opening and closing another session before loading permanently drops the target", async (t) => {
  const other = session("other-session", { name: "Other class" });
  const page = await mount(t, { sessions: [session(), other] });
  await page.evaluate(() => fixture.controller.onOpenSession(fixture.state.schedule.sessions[1]));
  await flush(page);
  await page.evaluate(() => fixture.controller.onCloseSelectedSession());
  await flush(page);
  await resolveRange(page, 0, [session(), other]);
  assert.equal(
    (await state(page)).selected,
    null,
    "Opening a class manually abandons the pending link even when that class is closed before the load settles",
  );
  assert.equal((await state(page)).notice, null);
  assert.equal((await state(page)).href, "/schedule?keep=one&keep=two#day");
});

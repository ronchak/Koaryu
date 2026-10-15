import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

// The Schedule page loads the month grid around its date for every view, paints
// from that read, and materializes recurring classes only when the read left
// placeholders, once per read, behind the painted calendar.

function bundle() {
  const { add, modules } = createCommonJsPacker({
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
    "./sliding-segmented-control.module.css": `module.exports={};`,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const controller = add("@/lib/schedule-page-controller");
  const section = add("@/components/schedule/schedule-page-section");
  const retained = add("@/lib/retained-state");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}const React=require(${react});
function Schedule(){const f=window.fixture;const state=React.useSyncExternalStore(f.subscribe,()=>f.state);const c=require(${controller}).useSchedulePageController({config:state.config,programsStore:f.programs,studentsStore:f.students,scheduleStore:state.schedule});f.controller=c.contentProps;return React.createElement(require(${section}).SchedulePageSection,c.contentProps);}
require(${dom}).createRoot(document.getElementById('root')).render(React.createElement(require(${retained}).RetainedStateProvider,{scope:'studio-a:1'},React.createElement(Schedule)));})();`;
}

const source = bundle();
// Business date 2026-09-29 (a Tuesday); its month grid is Aug 30 – Oct 10.
const WINDOW = ["2026-08-30", "2026-10-10"];
const NEXT_WINDOW = ["2026-09-27", "2026-11-07"];
const weeklyTemplate = {
  id: "tpl-tue",
  name: "Karate",
  day_of_week: 2,
  start_time: "18:00",
  end_time: "19:30",
  start_date: "2026-09-01",
  end_date: null,
  program_id: null,
  capacity: 10,
  is_active: true,
};
const generatedSession = (date) => ({
  id: `session-${date}`,
  template_id: "tpl-tue",
  name: "Karate",
  date,
  start_time: "18:00",
  end_time: "19:30",
  program_id: null,
  status: "scheduled",
  attendance_count: 0,
  capacity: 10,
});

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function mountSchedule({ role = "admin", sessions = [], templates = [] } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.abort());
  await page.setContent('<style>*{box-sizing:border-box}</style><div id="root"></div>');
  await page.evaluate(
    ({ role, sessions, templates }) => {
      const listeners = new Set();
      const noop = async () => {};
      const f = (window.fixture = { reads: [] });
      f.subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      f.notify = () => listeners.forEach((listener) => listener());
      f.programs = { programs: [], refreshPrograms: async () => [] };
      f.students = {
        students: [],
        studentsLoaded: true,
        studentsMayBePartial: false,
        refreshStudents: noop,
      };
      f.state = {
        config: { businessDate: "2026-09-29", currentRole: role },
        schedule: {
          sessions,
          attendance: [],
          templates,
          addSession: noop,
          addTemplate: noop,
          deleteSession: noop,
          refreshSessionAttendance: noop,
          toggleCheckIn: noop,
          refreshScheduleRange: (...args) =>
            new Promise((resolve, reject) => f.reads.push({ args, resolve, reject })),
        },
      };
      // The store commits a window's sessions before the range promise resolves.
      f.resolve = (index, loaded = f.state.schedule.sessions) => {
        f.state = { ...f.state, schedule: { ...f.state.schedule, sessions: loaded } };
        f.notify();
        f.reads[index].resolve(loaded);
      };
    },
    { role, sessions, templates },
  );
  await page.addScriptTag({ content: source });
  await page.waitForFunction(() => fixture.reads.length === 1);
  return { page, errors };
}

const settle = (page) => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 60)));
const readArgs = (page, index) => page.evaluate((index) => fixture.reads[index].args, index);
const readCount = (page) => page.evaluate(() => fixture.reads.length);
const flags = (page) =>
  page.evaluate(() => ({
    loaded: fixture.controller.hasLoadedRange,
    refreshing: fixture.controller.isRefreshingRange,
    error: fixture.controller.scheduleLoadError,
  }));

test("every view reads its month window once and steps inside it without a request", async () => {
  const { page, errors } = await mountSchedule({ sessions: [generatedSession("2026-09-29")] });
  try {
    assert.deepEqual(await readArgs(page, 0), [...WINDOW, "read"]);
    await page.evaluate(() => fixture.resolve(0));
    await page.waitForFunction(() => fixture.controller.hasLoadedRange);
    await page.waitForFunction(() => !fixture.controller.isRefreshingRange);

    // Day and Week views and their steps stay inside the loaded window, across
    // the month boundary at September 30 / October 1.
    await page.getByRole("button", { name: "Day", exact: true }).click();
    await expect(page.locator('[data-schedule-time-canvas="day"]')).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Open Karate/ })).toHaveCount(1);
    for (const name of ["Next day", "Next day", "Previous day", "Previous day", "Previous day"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await settle(page);
      assert.deepEqual(await flags(page), { loaded: true, refreshing: false, error: null });
    }
    await page.getByRole("button", { name: "Week", exact: true }).click();
    await page.getByRole("button", { name: "Next week", exact: true }).click();
    await settle(page);
    assert.equal(await readCount(page), 1, "no request inside the loaded window");
    assert.deepEqual(await flags(page), { loaded: true, refreshing: false, error: null });

    // A week past the window loads the grid around it, again as a read.
    await page.getByRole("button", { name: "Next week", exact: true }).click();
    await page.waitForFunction(() => fixture.reads.length === 2);
    assert.deepEqual(await readArgs(page, 1), [...NEXT_WINDOW, "read"]);
    assert.equal((await flags(page)).loaded, false);
    await page.evaluate(() => fixture.resolve(1));
    await page.waitForFunction(() => fixture.controller.hasLoadedRange);

    // Weeks the new window also covers step back without a request; the first
    // week outside it paints the retained earlier window while it re-reads.
    for (let step = 0; step < 2; step += 1) {
      await page.getByRole("button", { name: "Previous week", exact: true }).click();
      await settle(page);
      assert.equal(await readCount(page), 2);
    }
    await page.getByRole("button", { name: "Previous week", exact: true }).click();
    await page.waitForFunction(() => fixture.reads.length === 3);
    assert.deepEqual(await readArgs(page, 2), [...WINDOW, "read"]);
    assert.deepEqual(await flags(page), { loaded: true, refreshing: true, error: null });
    await page.evaluate(() => fixture.resolve(2));
    await page.waitForFunction(() => !fixture.controller.isRefreshingRange);
    assert.equal(await readCount(page), 3, "a window without placeholders never materializes");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("a window with ungenerated recurring slots paints, then materializes once per read", async () => {
  const { page, errors } = await mountSchedule({ templates: [weeklyTemplate] });
  try {
    await page.evaluate(() => fixture.resolve(0, []));
    await page.waitForFunction(() => fixture.reads.length === 2);
    assert.deepEqual(await readArgs(page, 1), [...WINDOW, "materialize"]);
    // The calendar is already painted, with the recurring placeholders, while the POST runs.
    assert.deepEqual(await flags(page), { loaded: true, refreshing: true, error: null });
    await expect(page.locator(".koaryu-skeleton-reveal")).toHaveCount(0);
    await expect(page.locator("[data-month-schedule-view]")).toHaveCount(1);
    await expect(page.getByLabel(/^Pending template slot: Karate/)).toHaveCount(6);

    const generated = [
      "2026-09-01",
      "2026-09-08",
      "2026-09-15",
      "2026-09-22",
      "2026-09-29",
      "2026-10-06",
    ];
    await page.evaluate(
      (dates) =>
        fixture.resolve(
          1,
          dates.map((date) => ({
            id: `session-${date}`,
            template_id: "tpl-tue",
            name: "Karate",
            date,
            start_time: "18:00",
            end_time: "19:30",
            program_id: null,
            status: "scheduled",
            attendance_count: 0,
            capacity: 10,
          })),
        ),
      generated,
    );
    await page.waitForFunction(() => !fixture.controller.isRefreshingRange);
    await expect(page.getByLabel(/^Pending template slot: Karate/)).toHaveCount(0);
    await expect(
      page.locator("[data-month-schedule-view] button", { hasText: "Karate" }),
    ).toHaveCount(6);
    await settle(page);
    assert.equal(await readCount(page), 2, "generated sessions fill every slot");

    // Retry reads again and reconsiders; a read that still leaves slots materializes again.
    await page.evaluate(() => fixture.controller.onRetryRange());
    await page.waitForFunction(() => fixture.reads.length === 3);
    assert.deepEqual(await readArgs(page, 2), [...WINDOW, "read"]);
    await page.evaluate(() => fixture.resolve(2, []));
    await page.waitForFunction(() => fixture.reads.length === 4);
    assert.deepEqual(await readArgs(page, 3), [...WINDOW, "materialize"]);
    // A failed materialization keeps the painted calendar and offers Retry.
    await page.evaluate(() => fixture.reads[3].reject(new Error("bulk lane busy")));
    await page.waitForFunction(() => !fixture.controller.isRefreshingRange);
    assert.deepEqual(await flags(page), {
      loaded: true,
      refreshing: false,
      error: "Recurring classes for this range could not be generated. Retry to load them.",
    });
    await expect(page.locator("[data-month-schedule-view]")).toHaveCount(1);
    await settle(page);
    assert.equal(await readCount(page), 4, "one materialization per read");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("staff who cannot manage the schedule only read, placeholders or not", async () => {
  const { page, errors } = await mountSchedule({ role: "instructor", templates: [weeklyTemplate] });
  try {
    await page.evaluate(() => fixture.resolve(0, []));
    await page.waitForFunction(() => fixture.controller.hasLoadedRange);
    await page.waitForFunction(() => !fixture.controller.isRefreshingRange);
    await settle(page);
    assert.equal(await readCount(page), 1);
    assert.deepEqual(await flags(page), { loaded: true, refreshing: false, error: null });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

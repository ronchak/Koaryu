import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

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
function Harness(){const [mounted,setMounted]=React.useState(true),[scope,setScope]=React.useState('studio-a:1');Object.assign(window.fixture,{setMounted,setScope});return React.createElement(require(${retained}).RetainedStateProvider,{scope},mounted?React.createElement(Schedule):null);}
require(${dom}).createRoot(document.getElementById('root')).render(React.createElement(Harness));})();`;
}

const source = bundle();
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function mountSchedule() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    const listeners = new Set();
    const noop = async () => {};
    const f = (window.fixture = { reads: [] });
    f.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    f.programs = { programs: [], refreshPrograms: noop };
    f.students = {
      students: [],
      studentsLoaded: true,
      studentsMayBePartial: false,
      refreshStudents: noop,
    };
    f.state = {
      config: { businessDate: "2026-09-29", currentRole: "admin" },
      schedule: {
        sessions: [
          {
            id: "class-a",
            name: "Karate",
            date: "2026-09-29",
            start_time: "09:00",
            end_time: "10:00",
            program_id: null,
            status: "scheduled",
            attendance_count: 0,
            capacity: 10,
          },
        ],
        attendance: [],
        templates: [],
        addSession: noop,
        addTemplate: noop,
        deleteSession: noop,
        refreshSessionAttendance: noop,
        toggleCheckIn: noop,
        refreshScheduleRange: (...args) =>
          new Promise((resolve, reject) => f.reads.push({ args, resolve, reject })),
      },
    };
  });
  await page.addScriptTag({ content: source });
  await page.waitForFunction(() => fixture.reads.length === 1);
  return { page, errors };
}

const settle = (page) => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
const pending = (page) => page.waitForFunction(() => !fixture.controller.hasLoadedRange);
const ready = (page) => page.waitForFunction(() => fixture.controller.hasLoadedRange);

test("Schedule reuses loaded ranges and totals on revisit and keeps them during retry and resume", async () => {
  const { page, errors } = await mountSchedule();
  try {
    await expect(page.getByRole("heading", { name: "Schedule", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Next month", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Week", exact: true })).toBeEnabled();
    await expect(page.locator(".koaryu-skeleton-reveal")).toHaveCount(1);
    await expect(page.locator("[data-month-schedule-day]")).toHaveCount(42);
    await expect(page.getByRole("button", { name: /^Open .*September/ })).toHaveCount(0);
    const cellClasses = await page
      .locator("[data-month-schedule-day]")
      .evaluateAll((cells) => cells.map((cell) => cell.className));
    const weekdayClasses = await page
      .getByText("Sun", { exact: true })
      .first()
      .locator("..")
      .getAttribute("class");

    await page.evaluate(() => fixture.reads[0].resolve());
    await ready(page);
    await expect(page.getByText("Karate", { exact: true })).toHaveCount(1);
    assert.deepEqual(
      await page
        .locator("[data-month-schedule-day]")
        .evaluateAll((cells) => cells.map((cell) => cell.className)),
      cellClasses,
    );
    assert.equal(
      await page.getByText("Sun", { exact: true }).first().locator("..").getAttribute("class"),
      weekdayClasses,
    );

    await page.evaluate(() => fixture.setMounted(false));
    await expect(page.locator("[data-month-schedule-view]")).toHaveCount(0);
    await page.evaluate(() => fixture.setMounted(true));
    await page.waitForFunction(() => fixture.reads.length === 2);
    await ready(page);
    await expect(page.locator(".koaryu-skeleton-reveal")).toHaveCount(0);
    await expect(page.getByText("Pending", { exact: true })).toHaveCount(0);
    const totals = page.locator("[data-schedule-register] > div > p:last-child");
    await expect(totals).toHaveText(["September 2026", "1", "0", "All programs"]);
    await page.evaluate(() => fixture.reads[1].reject(new Error("Refresh failed")));
    await expect(
      page.getByText("Could not load this calendar range. Please try again."),
    ).toHaveCount(1);
    await expect(page.getByText("Karate", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.waitForFunction(() => fixture.reads.length === 3);
    await expect(totals).toHaveText(["September 2026", "1", "0", "All programs"]);
    await page.evaluate(() => fixture.reads[2].resolve());
    await page.waitForFunction(() => !fixture.controller.isRefreshingRange);
    await page.evaluate(() => window.dispatchEvent(new Event("koaryu:data-refresh")));
    await page.waitForFunction(() => fixture.reads.length === 4);
    assert.equal(await page.evaluate(() => fixture.reads[3].args[2]), "read");
    await expect(page.locator(".koaryu-skeleton-reveal")).toHaveCount(0);
    await expect(totals).toHaveText(["September 2026", "1", "0", "All programs"]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("range readiness stays specific to each range and identity and ignores canceled reads", async () => {
  const { page, errors } = await mountSchedule();
  try {
    await page.getByRole("button", { name: "Next month", exact: true }).click();
    await page.waitForFunction(() => fixture.reads.length === 2);
    await page.evaluate(() => fixture.reads[0].resolve());
    await settle(page);
    await pending(page);
    await page.evaluate(() => fixture.reads[1].resolve());
    await ready(page);
    await page.getByRole("button", { name: "Previous month", exact: true }).click();
    await page.waitForFunction(() => fixture.reads.length === 3);
    // The canceled first request never marked September loaded.
    await pending(page);
    await page.evaluate(() => fixture.reads[2].resolve());
    await ready(page);
    await page.getByRole("button", { name: "Next month", exact: true }).click();
    await page.waitForFunction(() => fixture.reads.length === 4);
    await ready(page);
    await expect(page.locator(".koaryu-skeleton-reveal")).toHaveCount(0);

    await page.evaluate(() => fixture.setMounted(false));
    await expect(page.locator("[data-month-schedule-view]")).toHaveCount(0);
    await page.evaluate(() => {
      fixture.setScope("studio-b:2");
      fixture.setMounted(true);
    });
    await page.waitForFunction(() => fixture.reads.length === 5);
    await pending(page);
    await page.evaluate(() => fixture.reads[3].resolve());
    await settle(page);
    await pending(page);
    await expect(page.locator(".koaryu-skeleton-reveal")).toHaveCount(1);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("cold week and day use their time canvas and keep navigation controls available", async () => {
  const { page, errors } = await mountSchedule();
  try {
    for (const view of ["Week", "Day"]) {
      await page.getByRole("button", { name: view, exact: true }).click();
      await expect(page.locator(`[data-schedule-time-canvas="${view.toLowerCase()}"]`)).toHaveCount(
        1,
      );
      await expect(page.locator(".koaryu-skeleton-reveal")).toHaveCount(1);
      await expect(page.locator("[data-time-canvas-block]")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Jump to today" })).toBeEnabled();
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

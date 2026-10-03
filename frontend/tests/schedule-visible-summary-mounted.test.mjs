import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function bundle() {
  const { add, modules } = createCommonJsPacker({
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
    "./sliding-segmented-control.module.css": `module.exports={};`,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const section = add("@/components/schedule/schedule-page-section");
  const model = add("@/lib/schedule-page-model");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
    const React=require(${react}),{SchedulePageSection}=require(${section}),{navigateScheduleDate}=require(${model});
    function App(){
      const [currentDate,setDate]=React.useState(new Date(2026,8,29,12));
      const [view,setView]=React.useState('month'),[programFilter,setFilter]=React.useState('');
      const [sessions,setSessions]=React.useState(window.fixture.sessions);
      const [hasLoadedRange,setLoaded]=React.useState(true);
      Object.assign(window.fixture,{setDate:(value)=>setDate(new Date(...value)),setView,setSessions,setLoaded});
      return React.createElement(SchedulePageSection,{
        businessDate:'2026-09-29',canManageSchedule:false,currentDate,view,programFilter,sessions,
        templates:window.fixture.templates,programs:window.fixture.programs,hasLoadedRange,
        isRefreshingRange:false,scheduleLoadError:null,actionMessage:null,
        onNavigate:(direction)=>setDate(date=>navigateScheduleDate(date,view,direction)),
        onJumpToToday:()=>setDate(new Date(2026,8,29,12)),onViewChange:setView,
        onProgramFilterChange:setFilter,onSelectDate:setDate,onOpenSession:()=>{},onOpenAddClass:()=>{},
        onRetryRange:()=>{},onDismissScheduleLoadError:()=>{},onDismissActionMessage:()=>{}
      });
    }
    require(${dom}).createRoot(document.getElementById('root')).render(React.createElement(App));
  })();`;
}

async function assertSummary(page, scheduled, recurringSlots, label, scope = "All programs") {
  const register = page.getByRole("region", { name: "Visible schedule range" });
  const values = register.locator(":scope > div > p:last-child");
  await expect(values).toHaveText([label, String(scheduled), String(recurringSlots), scope]);
}

async function mount(browser, { parallelSeries = false } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    const session = (id, date, program_id, name) => ({
      id,
      date,
      program_id,
      name,
      start_time: "09:00",
      end_time: "10:00",
      status: "scheduled",
      attendance_count: 0,
      capacity: 12,
    });
    window.fixture = {
      sessions: [
        session("sept", "2026-09-29", "karate", "Karate"),
        {
          ...session("oct", "2026-10-06", "karate", "Karate"),
          template_id: "weekly",
          status: "cancelled",
        },
        session("other", "2026-10-08", "judo", "Judo"),
      ],
      templates: [
        {
          id: "weekly",
          program_id: "karate",
          name: "Karate",
          is_active: true,
          start_date: "2026-09-29",
          end_date: "2026-10-20",
          day_of_week: 2,
          start_time: "09:00",
          end_time: "10:00",
        },
      ],
      programs: [
        { id: "karate", name: "Karate", color_hex: "#123456" },
        { id: "judo", name: "Judo", color_hex: "#654321" },
      ],
    };
  });
  if (parallelSeries) {
    await page.evaluate(() => {
      const base = { ...fixture.templates[0], start_date: "2026-10-06", end_date: "2026-10-06" };
      fixture.templates = [base, { ...base, id: "parallel", program_id: "judo" }];
      fixture.sessions = [{ ...fixture.sessions[1], status: "scheduled" }];
    });
  }
  await page.addScriptTag({ content: bundle() });
  return { page, errors };
}

// Mount the real summary and both real grids with cached records from other dates.
// Navigation and program controls are real; external services are never contacted.
test("rendered calendar totals follow month, week, day and program navigation", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, errors } = await mount(browser);
    await assertSummary(page, 3, 0, "September 2026");
    await page.getByRole("button", { name: "Next month", exact: true }).click();
    await assertSummary(page, 3, 2, "October 2026");
    await page.getByLabel("Filter schedule by program").selectOption("karate");
    await assertSummary(page, 2, 2, "October 2026", "Karate");
    await page.getByRole("button", { name: "Next month", exact: true }).click();
    await assertSummary(page, 0, 0, "November 2026", "Karate");
    await expect(page.getByText("No scheduled classes", { exact: true })).toHaveCount(42);
    await page.getByLabel("Filter schedule by program").selectOption("");
    await assertSummary(page, 0, 0, "November 2026");

    await page.evaluate(() => fixture.setDate([2026, 10, 29, 12]));
    await page.getByRole("button", { name: "Week", exact: true }).click();
    await assertSummary(page, 0, 0, "November 29 – December 5, 2026");
    await expect(page.locator("[data-time-canvas-block]")).toHaveCount(0);
    await page.getByRole("button", { name: "Jump to today" }).click();
    await assertSummary(page, 1, 0, "September 27 – October 3, 2026");
    await page.getByRole("button", { name: "Next week", exact: true }).click();
    await assertSummary(page, 2, 0, "October 4 – October 10, 2026");
    await page.getByLabel("Filter schedule by program").selectOption("karate");
    await assertSummary(page, 1, 0, "October 4 – October 10, 2026", "Karate");
    await page.getByRole("button", { name: "Next week", exact: true }).click();
    await assertSummary(page, 0, 1, "October 11 – October 17, 2026", "Karate");
    await expect(page.locator('[data-time-canvas-block="template"]')).toHaveCount(1);

    await page.getByRole("button", { name: "Day", exact: true }).click();
    await assertSummary(page, 0, 1, "Tuesday, October 13, 2026", "Karate");
    await page.getByLabel("Filter schedule by program").selectOption("judo");
    await assertSummary(page, 0, 0, "Tuesday, October 13, 2026", "Judo");
    await page.getByLabel("Filter schedule by program").selectOption("");
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    await assertSummary(page, 0, 0, "Wednesday, October 14, 2026");
    await expect(page.locator("[data-time-canvas-block]")).toHaveCount(0);
    await page.evaluate(() => fixture.setLoaded(false));
    await assertSummary(page, "Pending", "Pending", "Wednesday, October 14, 2026");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("rendered recurring total matches cancellation and deletion behavior of the grid", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, errors } = await mount(browser);
    await page.evaluate(() => {
      fixture.setDate([2026, 9, 6, 12]);
      fixture.setView("day");
    });
    await assertSummary(page, 1, 0, "Tuesday, October 6, 2026");
    await expect(page.locator('[data-time-canvas-block="session"]')).toHaveCount(1);
    await page.evaluate(() =>
      fixture.setSessions(fixture.sessions.filter((row) => row.id !== "oct")),
    );
    await assertSummary(page, 0, 1, "Tuesday, October 6, 2026");
    await expect(page.locator('[data-time-canvas-block="template"]')).toHaveCount(1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("parallel series with identical names and times retain their own visible recurring slots", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, errors } = await mount(browser, { parallelSeries: true });
    await assertSummary(page, 1, 1, "September 2026");
    await expect(page.getByLabel("Pending template slot: Karate at 9:00 AM")).toHaveCount(1);

    await page.evaluate(() => fixture.setDate([2026, 9, 6, 12]));
    for (const [view, label] of [
      ["Week", "October 4 – October 10, 2026"],
      ["Day", "Tuesday, October 6, 2026"],
    ]) {
      await page.getByRole("button", { name: view, exact: true }).click();
      await assertSummary(page, 1, 1, label);
      await expect(page.locator('[data-time-canvas-visible="template:parallel"]')).toHaveCount(1);
      await expect(page.locator('[data-time-canvas-visible="session:oct"]')).toHaveCount(1);
      await page.getByLabel("Filter schedule by program").selectOption("karate");
      await assertSummary(page, 1, 0, label, "Karate");
      await page.getByLabel("Filter schedule by program").selectOption("judo");
      await assertSummary(page, 0, 1, label, "Judo");
      await page.getByLabel("Filter schedule by program").selectOption("");
      await assertSummary(page, 1, 1, label);
    }

    await page.evaluate(() => fixture.setSessions([]));
    await assertSummary(page, 0, 2, "Tuesday, October 6, 2026");
    await expect(page.locator('[data-time-canvas-block="template"]')).toHaveCount(2);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

// The real reports route and report model. The stores, readiness marker and page chrome
// are synthetic; each schedule range read settles when the test says.
function bundle() {
  const { add, modules } = createCommonJsPacker({
    "@/lib/store": `const React=require("react");const use=(pick)=>React.useSyncExternalStore(window.fixture.subscribe,()=>pick(window.fixture.state));exports.useConfigStore=()=>use((s)=>s.config);exports.useScheduleStore=()=>use((s)=>s.schedule);exports.useLeadStore=()=>window.fixture.leadStore;exports.useProgramStore=()=>window.fixture.programStore;exports.useStudioStore=()=>window.fixture.studioStore;`,
    "@/lib/performance": `exports.markDashboardReadiness=(_page,_generation,value)=>{window.fixture.readiness.push(value);};`,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
    "@/components/header": `const React=require("react");exports.Header=({title})=>React.createElement("h1",null,title);`,
    "@/components/operations/operations-surface": `const React=require("react");exports.OperationsSurface=({children})=>React.createElement("main",null,children);`,
    "@/components/dataset-readiness-panel": `const React=require("react");exports.DatasetReadinessErrorPanel=({error,onRetry})=>React.createElement("div",{"data-testid":"reports-error"},error,React.createElement("button",{onClick:onRetry},"Retry reports"));`,
    "@/components/programs/program-picker": `const React=require("react");exports.ProgramBadge=({fallback})=>React.createElement("span",null,fallback);`,
    "@/components/reports/reports-data-exports-panel": `exports.ReportsDataExportsPanel=()=>null;`,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const subject = add("@/app/(dashboard)/reports/page");
  const retained = add("@/lib/retained-state");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}const React=require(${react});function Harness(){const [mounted,setMounted]=React.useState(true),[scope,setScope]=React.useState('studio-a:1');Object.assign(window.fixture,{setMounted,setScope});return React.createElement(require(${retained}).RetainedStateProvider,{scope},mounted?React.createElement(require(${subject}).default):null);}require(${dom}).createRoot(document.getElementById('root')).render(React.createElement(Harness));})();`;
}

const source = bundle();
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

// The browser calendar is days ahead of the studio calendar, so a browser-derived
// window cannot pass for the studio window.
async function mountReports(businessDate) {
  const context = await browser.newContext({ timezoneId: "UTC" });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  await page.clock.setFixedTime(new Date("2026-10-05T12:00:00Z"));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.evaluate((initialBusinessDate) => {
    const listeners = new Set();
    const f = (window.fixture = { reads: [], readiness: [] });
    const notify = () => listeners.forEach((listener) => listener());
    f.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    // Like the real store, a settled range read merges its sessions into shared state.
    const refreshScheduleRange = (startDate, endDate, intent) =>
      new Promise((resolve, reject) => {
        f.reads.push({
          args: [startDate, endDate, intent],
          resolve: (sessions) => {
            const byId = new Map(f.state.schedule.sessions.map((s) => [s.id, s]));
            sessions.forEach((s) => byId.set(s.id, s));
            f.state = {
              ...f.state,
              schedule: { ...f.state.schedule, sessions: [...byId.values()] },
            };
            notify();
            resolve();
          },
          reject,
        });
      });
    f.state = {
      config: { businessDate: initialBusinessDate, isPreviewMode: false, token: "token-a" },
      schedule: { attendance: [], refreshScheduleRange, sessions: [] },
    };
    f.setBusinessDate = (businessDate) => {
      f.state = { ...f.state, config: { ...f.state.config, businessDate } };
      notify();
    };
    f.leadStore = {
      leads: [],
      leadsLoadError: null,
      leadsLoaded: true,
      refreshLeads: async () => {},
    };
    f.programStore = {
      programs: [],
      programsLoadError: null,
      programsLoaded: true,
      refreshPrograms: async () => {},
    };
    f.studioStore = { currentRole: "admin", identityGeneration: 1, identityReady: true };
  }, businessDate);
  await page.addScriptTag({ content: source });
  return { context, errors, page };
}

const session = (id, date) => ({
  id,
  template_id: null,
  program_id: null,
  name: `Class ${id}`,
  date,
  start_time: "16:00",
  end_time: "17:00",
  capacity: 10,
  attendance_count: 2,
  status: "scheduled",
  created_at: "2026-08-01T12:00:00.000Z",
  updated_at: "2026-08-01T12:00:00.000Z",
});

const firstWindowSessions = [session("aug-31", "2026-08-31"), session("sep-15", "2026-09-15")];
const secondWindowSessions = [session("sep-15", "2026-09-15"), session("sep-30", "2026-09-30")];

async function displayedReport(page) {
  const sheet = page.locator('[data-report-method-sheet="true"]');
  return {
    window: await sheet
      .getByText("Attendance window")
      .locator("xpath=following-sibling::p")
      .textContent(),
    asOf: await sheet.getByText("As of").locator("xpath=following-sibling::p").textContent(),
    sessions: await page.getByText(/^\d+ sessions$/).textContent(),
    classes: await page.locator("table tbody td:first-child").allTextContents(),
  };
}

const settle = (page) => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));

test("reports request and display the studio window, and follow a mounted studio-day rollover", async () => {
  const { context, errors, page } = await mountReports("2026-09-29");
  await page.waitForFunction(() => fixture.reads.length === 1);
  assert.deepEqual(await page.evaluate(() => fixture.reads[0].args), [
    "2026-08-31",
    "2026-09-29",
    "read",
  ]);
  await page.evaluate((sessions) => fixture.reads[0].resolve(sessions), firstWindowSessions);
  await expect(page.locator('[data-reports-loading="true"]')).toHaveCount(0);
  assert.deepEqual(await displayedReport(page), {
    window: "Aug 31 – Sep 29",
    asOf: "Sep 29",
    sessions: "2 sessions",
    classes: ["Class sep-15", "Class aug-31"],
  });

  await page.evaluate(() => fixture.setBusinessDate("2026-09-30"));
  await page.waitForFunction(() => fixture.reads.length === 2);
  assert.deepEqual(await page.evaluate(() => fixture.reads[1].args), [
    "2026-09-01",
    "2026-09-30",
    "read",
  ]);
  // Scope text can render immediately, but a new window cannot show incomplete figures.
  await page.locator('[data-reports-loading="true"]').waitFor();
  assert.equal(await page.getByRole("heading", { name: "Reports", exact: true }).count(), 1);
  assert.equal(
    await page
      .locator("table tbody td:first-child")
      .allTextContents()
      .then((cells) => cells.some((cell) => cell.includes("Class"))),
    false,
  );

  await page.evaluate((sessions) => fixture.reads[1].resolve(sessions), secondWindowSessions);
  await expect(page.locator('[data-reports-loading="true"]')).toHaveCount(0);
  assert.deepEqual(await displayedReport(page), {
    window: "Sep 1 – Sep 30",
    asOf: "Sep 30",
    sessions: "2 sessions",
    classes: ["Class sep-30", "Class sep-15"],
  });
  assert.equal(await page.evaluate(() => fixture.reads.length), 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test("an older range read settling after a rollover cannot replace the new window", async () => {
  const { context, errors, page } = await mountReports("2026-09-29");
  await page.waitForFunction(() => fixture.reads.length === 1);
  await page.evaluate(() => fixture.setBusinessDate("2026-09-30"));
  await page.waitForFunction(() => fixture.reads.length === 2);
  assert.deepEqual(await page.evaluate(() => fixture.reads.map((read) => read.args)), [
    ["2026-08-31", "2026-09-29", "read"],
    ["2026-09-01", "2026-09-30", "read"],
  ]);

  await page.evaluate((sessions) => fixture.reads[1].resolve(sessions), secondWindowSessions);
  await expect(page.locator('[data-reports-loading="true"]')).toHaveCount(0);
  // The older window's facts arrive late and must not enter the displayed window.
  await page.evaluate((sessions) => fixture.reads[0].resolve(sessions), firstWindowSessions);
  await settle(page);
  assert.deepEqual(await displayedReport(page), {
    window: "Sep 1 – Sep 30",
    asOf: "Sep 30",
    sessions: "2 sessions",
    classes: ["Class sep-30", "Class sep-15"],
  });
  assert.deepEqual(errors, []);
  await context.close();
});

test("an older range read failing after a rollover cannot replace new readiness", async () => {
  const { context, errors, page } = await mountReports("2026-09-29");
  await page.waitForFunction(() => fixture.reads.length === 1);
  await page.evaluate(() => fixture.setBusinessDate("2026-09-30"));
  await page.waitForFunction(() => fixture.reads.length === 2);
  await page.evaluate((sessions) => fixture.reads[1].resolve(sessions), secondWindowSessions);
  await expect(page.locator('[data-reports-loading="true"]')).toHaveCount(0);
  await page.evaluate(() => fixture.reads[0].reject(new Error("Stale range failed")));
  await settle(page);
  assert.equal(await page.getByTestId("reports-error").count(), 0);
  assert.equal((await displayedReport(page)).window, "Sep 1 – Sep 30");
  assert.equal(await page.evaluate(() => fixture.reads.length), 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test("reports retain their layout and data across remount, resume, failed refresh and retry", async () => {
  const { context, errors, page } = await mountReports("2026-09-29");
  await page.waitForFunction(() => fixture.reads.length === 1);
  const coldClasses = await page
    .locator("[data-report-figure-band], [data-report-section]")
    .evaluateAll((elements) => elements.map((element) => element.className));
  await expect(page.locator(".koaryu-skeleton-reveal")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toHaveCount(1);
  await page.evaluate((sessions) => fixture.reads[0].resolve(sessions), firstWindowSessions);
  await expect(page.locator('[data-reports-loading="true"]')).toHaveCount(0);
  assert.deepEqual(
    await page
      .locator("[data-report-figure-band], [data-report-section]")
      .evaluateAll((elements) => elements.map((element) => element.className)),
    coldClasses,
  );
  const original = await displayedReport(page);

  await page.evaluate(() => fixture.setMounted(false));
  await expect(page.locator("article")).toHaveCount(0);
  await page.evaluate(() => fixture.setMounted(true));
  await page.waitForFunction(() => fixture.reads.length === 2);
  await expect(page.locator(".koaryu-skeleton-reveal")).toHaveCount(0);
  assert.deepEqual(await displayedReport(page), original);
  assert.deepEqual(await page.evaluate(() => fixture.readiness.at(-1)), {
    useful: true,
    complete: false,
  });
  await page.evaluate(() => fixture.reads[1].reject(new Error("Refresh failed")));
  await page.getByTestId("reports-error").waitFor();
  assert.deepEqual(await displayedReport(page), original);

  await page.getByRole("button", { name: "Retry reports" }).click();
  await page.waitForFunction(() => fixture.reads.length === 3);
  assert.deepEqual(await displayedReport(page), original);
  await page.evaluate((sessions) => fixture.reads[2].resolve(sessions), firstWindowSessions);
  await expect(page.getByTestId("reports-error")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("koaryu:data-refresh")));
  await page.waitForFunction(() => fixture.reads.length === 4);
  assert.deepEqual(await displayedReport(page), original);
  await expect(page.locator('[data-reports-loading="true"]')).toHaveCount(0);

  await page.evaluate(() => fixture.setMounted(false));
  await expect(page.locator("article")).toHaveCount(0);
  await page.evaluate(() => {
    fixture.setScope("studio-b:2");
    fixture.setMounted(true);
  });
  await page.waitForFunction(() => fixture.reads.length === 5);
  await page.locator('[data-reports-loading="true"]').waitFor();
  // The pending old owner's reply cannot mark the new identity ready.
  await page.evaluate((sessions) => fixture.reads[3].resolve(sessions), firstWindowSessions);
  await settle(page);
  await expect(page.locator('[data-reports-loading="true"]')).toHaveCount(1);
  await page.evaluate((sessions) => fixture.reads[4].resolve(sessions), firstWindowSessions);
  await expect(page.locator('[data-reports-loading="true"]')).toHaveCount(0);
  assert.deepEqual(errors, []);
  await context.close();
});

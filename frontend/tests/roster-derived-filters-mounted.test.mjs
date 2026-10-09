import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

// Mount the real controller and roster UI with synthetic stores and no network.
function bundle(pagedRoster = true) {
  const cssModule = `exports.__esModule=true;exports.default=new Proxy({},{get:(_target,name)=>String(name)});`;
  const { add, modules } = createCommonJsPacker({
    "next/navigation": `const router={replace(){},push(){}};exports.useRouter=()=>router;exports.useSearchParams=()=>new URLSearchParams(window.location.search);`,
    "next/dynamic": `exports.__esModule=true;exports.default=()=>()=>null;`,
    "next/link": `exports.__esModule=true;exports.default=({children,href,prefetch,...props})=>require('react').createElement('a',{href:typeof href==='string'?href:href.pathname,...props},children);`,
    "@/lib/use-resume-refresh": `exports.useResumeRefresh=()=>{};`,
    "@/components/icons/martial-arts-belt": `exports.MartialArtsBelt=()=>null;`,
    "@/components/header": `exports.Header=({title})=>require('react').createElement('header',null,title);`,
    "@/components/programs/program-picker": `exports.ProgramBadge=({program,name})=>require('react').createElement('span',null,program?.name??name);`,
    "@/components/students/status-badge": `exports.StatusBadge=({status})=>require('react').createElement('span',null,status);`,
    "@/components/students/student-avatar": `exports.StudentAvatar=()=>null;`,
    "./belt-tracker.module.css": cssModule,
    "./records-loading.module.css": cssModule,
    "./sliding-segmented-control.module.css": cssModule,
    "./student-records.module.css": cssModule,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const controller = add("@/lib/students-page-controller");
  const content = add("@/components/students/student-roster-page-content");
  return `(()=>{const process={env:{NODE_ENV:'production',NEXT_PUBLIC_STUDENTS_PAGED_ROSTER:'${pagedRoster}'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}const React=require(${react});const f=window.fixture;function Roster(){const c=require(${controller}).useStudentsPageController({config:f.config,programsStore:f.programsStore,scheduleStore:f.scheduleStore,studentsStore:f.studentsStore,studioStore:f.studioStore});f.roster=c.contentProps;return React.createElement(require(${content}).StudentRosterPageContent,c.contentProps);}require(${dom}).createRoot(document.getElementById('root')).render(React.createElement(Roster));})();`;
}

const sources = { paged: bundle(), fallback: bundle(false) };
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function mount({ preview = true, paged = true, query = "" } = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://fixture.local/students${query}`;
  await page.route("**/*", (route) =>
    route.request().url() === url
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto(url);
  await page.evaluate((preview) => {
    const student = (id, first) => ({
      id,
      studio_id: "studio-a",
      legal_first_name: first,
      legal_last_name: "Lane",
      email: `${first.toLowerCase()}@example.invalid`,
      status: "active",
      membership_start_date: "2026-01-01",
      guardians: [],
      program_memberships: [],
      tags: [],
      created_at: "2026-01-01T00:00:00Z",
    });
    const students = [student("student-a", "Ari"), student("student-b", "Bo")];
    const f = (window.fixture = { pageReads: [], scheduleReads: [] });
    f.config = {
      businessDate: "2026-10-05",
      currentRole: "admin",
      isPreviewMode: preview,
      token: preview ? null : "synthetic-token",
    };
    f.programsStore = {
      programs: [],
      programsLoadError: null,
      programsLoaded: true,
      refreshPrograms: async () => {},
    };
    f.scheduleStore = {
      sessions: [{ id: "recent-class", date: "2026-10-04" }],
      attendance: [{ student_id: "student-b", session_id: "recent-class", status: "present" }],
      refreshScheduleRange: (...args) =>
        new Promise((resolve, reject) => f.scheduleReads.push({ args, resolve, reject })),
    };
    f.studioStore = { currentStudioId: "studio-a", identityGeneration: 1, currentUserId: "user-a" };
    f.studentsStore = {
      addStudent: async () => {},
      bulkAddTagsToStudents: async () => {},
      bulkUpdateStudentStatus: async () => {},
      deleteStudents: async () => {},
      listStudentsPage: async (query) => {
        f.pageReads.push(query);
        return {
          items: [students[0]],
          total: 1,
          page_ordinal: 1,
          has_next: false,
          has_previous: false,
          next_cursor: null,
          previous_cursor: null,
        };
      },
      refreshStudents: async () => {},
      students,
      studentsLastLoadedAt: Date.now(),
      studentsLoadError: null,
      studentsLoaded: true,
      studentsMayBePartial: false,
    };
  }, preview);
  await page.addScriptTag({ content: sources[paged ? "paged" : "fallback"] });
  await page.waitForFunction(() => Boolean(window.fixture.roster));
  return { page, errors };
}

for (const days of [14, 30, 90]) {
  test(`preview inactivity deep link (${days} days) renders seeded matches without remote reads`, async () => {
    const { page, errors } = await mount({ query: `?inactiveDays=${days}` });
    try {
      await page.waitForFunction(() => !window.fixture.roster.isInitialRosterLoading);
      assert.equal(await page.locator('[data-student-id="student-a"]').count(), 1);
      assert.equal(await page.locator('[data-student-id="student-b"]').count(), 0);
      assert.deepEqual(
        await page.evaluate(() => [fixture.pageReads.length, fixture.scheduleReads.length]),
        [0, 0],
      );
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

for (const preview of [true, false]) {
  test(`${preview ? "preview" : "live fallback"} search ignores surrounding whitespace`, async () => {
    const { page, errors } = await mount({ preview, paged: preview });
    try {
      await page.waitForFunction(() => !window.fixture.roster.isInitialRosterLoading);
      for (const search of ["Ari", " Ari", "Ari ", " Ari ", " ari@example.invalid "]) {
        await page.getByLabel("Search students").fill(search);
        await page.waitForFunction((search) => fixture.roster.search === search, search);
        assert.deepEqual(
          await page.evaluate(() => fixture.roster.filtered.map((row) => row.student.id)),
          ["student-a"],
          `Search ${JSON.stringify(search)} should keep the matching student`,
        );
        assert.equal(await page.locator('[data-student-id="student-a"]').count(), 1);
      }
      await page.getByLabel("Search students").fill("   ");
      await page.waitForFunction(() => fixture.roster.filtered.length === 2);
      assert.equal(await page.locator("[data-student-id]").count(), 2);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

test("live fallback inactivity waits for its schedule and recovers after a failed read", async () => {
  const { page, errors } = await mount({ preview: false, paged: false, query: "?inactiveDays=14" });
  try {
    await page.waitForFunction(() => fixture.scheduleReads.length === 1);
    assert.equal(await page.evaluate(() => fixture.roster.isInitialRosterLoading), true);
    assert.equal(await page.locator("[data-student-id]").count(), 0);
    await page.evaluate(() =>
      fixture.scheduleReads[0].reject(new Error("Synthetic schedule failure")),
    );
    await page.waitForFunction(
      () => fixture.roster.activeLoadError === "Synthetic schedule failure",
    );
    assert.equal(await page.evaluate(() => fixture.roster.isInitialRosterLoading), false);
    await page.evaluate(() => fixture.roster.onRetryRosterLoad());
    await page.waitForFunction(() => fixture.scheduleReads.length === 2);
    assert.equal(await page.evaluate(() => fixture.roster.isInitialRosterLoading), true);
    await page.evaluate(() => fixture.scheduleReads[1].resolve());
    await page.waitForFunction(() => !fixture.roster.isInitialRosterLoading);
    assert.equal(await page.evaluate(() => fixture.roster.activeLoadError), null);
    assert.equal(await page.locator('[data-student-id="student-a"]').count(), 1);
    assert.equal(await page.locator('[data-student-id="student-b"]').count(), 0);
    assert.equal(await page.evaluate(() => fixture.pageReads.length), 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("live paged inactivity remains server-owned with normalized search and no schedule dependency", async () => {
  const { page, errors } = await mount({ preview: false, query: "?inactiveDays=14&q=%20Ari%20" });
  try {
    await page.waitForFunction(() => !fixture.roster.isInitialRosterLoading);
    assert.equal(await page.locator('[data-student-id="student-a"]').count(), 1);
    assert.deepEqual(
      await page.evaluate(() => ({
        search: fixture.pageReads[0].search,
        inactivityDays: fixture.pageReads[0].inactivityDays,
        scheduleReads: fixture.scheduleReads.length,
        derived: fixture.roster.usesDerivedRosterFilters,
      })),
      { search: "Ari", inactivityDays: 14, scheduleReads: 0, derived: false },
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

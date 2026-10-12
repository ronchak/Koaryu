import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";
import {
  bundleWorkflowComposition,
  workflowCompositionCss,
} from "./helpers/workflow-composition-mounted.mjs";
import { buildStudentRows } from "../src/lib/students-page-model.ts";

// Synthetic stores/Auth/API; real owning components, controllers and owning CSS.
// The fixture has no dashboard navigation shell, provider traffic or customer data.
const viewports = [
  { width: 1440, height: 900 },
  { width: 1000, height: 614 },
  { width: 390, height: 844 },
];
const from = fileURLToPath(new URL("../src/app/globals.css", import.meta.url));
const globalCss = (await postcss([tailwind()]).process(await readFile(from, "utf8"), { from })).css;
const stubs = {};
let owningCss = "";
for (const [index, path] of [
  "ui/horizon",
  "schedule/horizon-parts",
  "students/student-records",
  "leads/leads-ledger",
  "dashboard-shell",
].entries()) {
  const source = await readFile(
    new URL(`../src/components/${path}.module.css`, import.meta.url),
    "utf8",
  );
  const classes = Object.fromEntries(
    [...source.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => [
      match[1],
      `refresh${index}_${match[1]}`,
    ]),
  );
  const stub = `module.exports=${JSON.stringify(classes)}`;
  stubs[`@/components/${path}.module.css`] = stub;
  stubs[`./${path.split("/").at(-1)}.module.css`] = stub;
  owningCss += source.replace(
    /:global\(([^)]+)\)|\.([a-zA-Z][\w-]*)/g,
    (_, global, local) => global ?? `.${classes[local]}`,
  );
}
const kitCss = (
  await readFile(new URL("../src/components/ui/horizon.module.css", import.meta.url), "utf8")
).replace(/:global\(([^)]+)\)/g, "$1");
const css = globalCss + owningCss;
const workflowCss = workflowCompositionCss + globalCss + kitCss + owningCss;
const packet = process.env.KOARYU_REFRESH_PACKET;
const phase = process.env.KOARYU_REFRESH_PHASE ?? "after";
const measurements = [];
let browser;
before(async () => {
  browser = await chromium.launch();
  if (packet) await mkdir(packet, { recursive: true });
});
after(async () => {
  await browser?.close();
  if (packet)
    await writeFile(`${packet}/${phase}-geometry.json`, JSON.stringify(measurements, null, 2));
});
const flush = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
async function mount(t, source, styles, viewport = viewports[0]) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    route.request().url() === "http://localhost/leads"
      ? route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<html data-theme="light"><meta charset="utf-8"><style>${styles}</style><main class="refresh4_shellRoot" data-surface="horizon" id="root"></main></html>`,
        })
      : route.abort(),
  );
  await page.goto("http://localhost/leads");
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], "Owning components must mount without browser errors");
  });
  await page.addScriptTag({ content: source });
  return page;
}
async function geometry(page, selectors) {
  await flush(page);
  return page.evaluate(
    (selectors) =>
      selectors.map((selector) => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { selector, x, y, width, height };
      }),
    selectors,
  );
}
async function capture(page, name, state) {
  if (packet)
    await page.screenshot({
      path: `${packet}/${phase}-${name}-${page.viewportSize().width}-${state}.png`,
    });
}

test("retained workflow refresh preserves list and template geometry", async (t) => {
  const results = [];
  for (const viewport of viewports) {
    const page = await mount(t, bundleWorkflowComposition(), workflowCss, viewport);
    const refresh = page.getByRole("button", { name: "Refresh list", exact: true });
    await expect(page.locator("[data-workflow-list] ul")).toBeVisible();
    await expect(page.locator("#workflow-templates article").first()).toBeVisible();
    const targets = ["[data-workflow-list] ul", "#workflow-templates"];
    await refresh.focus();
    const before = await geometry(page, targets);
    await capture(page, "automations", "ready");
    await page.evaluate(() => {
      window.fixture.hold.list = true;
    });
    await refresh.click();
    await expect(page.getByRole("status")).toHaveText("Loading workflows...");
    await expect(refresh).toBeDisabled();
    const workflowName = page.locator("[data-workflow-list] h3 button").first();
    await workflowName.focus();
    const during = await geometry(page, targets);
    await capture(page, "automations", "pending");
    assert.equal(await page.getByRole("status").ariaSnapshot(), "- status: Loading workflows...");
    await expect(page.locator("[data-workflow-list] li")).toHaveCount(1);
    const afterList = await page.evaluate(() => {
      const f = window.fixture;
      return f.owner().getSnapshot().list;
    });
    await page.evaluate((list) => window.fixture.readyHeld("list", list), afterList);
    await expect(refresh).toBeEnabled();
    await expect(page.getByRole("status")).toHaveCount(0);
    const after = await geometry(page, targets);
    await capture(page, "automations", "settled");
    await expect(workflowName).toBeFocused();
    const result = { kind: "automations", viewport, before, during, after };
    measurements.push(result);
    results.push(result);
  }
  for (const result of results) {
    assert.deepEqual(
      result.during,
      result.before,
      `retained refresh at ${result.viewport.width}px`,
    );
    assert.deepEqual(result.after, result.before);
  }
});

test("cold workflow loading keeps pending without false empty state", async (t) => {
  const page = await mount(t, bundleWorkflowComposition({ hold: { list: true } }), workflowCss);
  await expect(page.getByRole("status", { name: "" })).toHaveText("Loading workflows...");
  assert.ok((await page.getByRole("status").boundingBox()).height > 1);
  await expect(page.getByText("No saved workflows yet", { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.fixture.readyHeld("list", null, true));
  await expect(page.getByRole("alert")).toContainText(
    "This page of workflows could not be loaded.",
  );
  await expect(page.getByRole("button", { name: "Retry page", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry page", exact: true }).click();
  await page.evaluate(() =>
    window.fixture.readyHeld("list", { items: [], has_more: false, next_cursor: null }),
  );
  await expect(page.getByText("No saved workflows yet", { exact: true })).toBeVisible();
});

test("retained workflow refresh failure stays visible and retryable in dark theme", async (t) => {
  const page = await mount(t, bundleWorkflowComposition(), workflowCss);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect(page.locator("[data-workflow-list] ul")).toBeVisible();
  const targets = ["[data-workflow-list] ul", "#workflow-templates"];
  const before = await geometry(page, targets);
  await page.evaluate(() => {
    window.fixture.hold.list = true;
  });
  await page.getByRole("button", { name: "Refresh list", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Loading workflows...");
  assert.deepEqual(await geometry(page, targets), before);
  await capture(page, "automations-dark", "pending");
  await page.evaluate(() => window.fixture.readyHeld("list", null, true));
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "This page of workflows could not be loaded.",
  );
  await expect(page.locator("[data-workflow-list] li")).toHaveCount(1);
  await capture(page, "automations-dark", "error");
  await page.getByRole("button", { name: "Retry page", exact: true }).click();
  await page.evaluate(() =>
    window.fixture.readyHeld("list", window.fixture.owner().getSnapshot().list),
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  assert.deepEqual(await geometry(page, targets), before);
});

function presentationBundle() {
  const { add, modules } = createCommonJsPacker({
    ...stubs,
    "next/navigation": "exports.useRouter=()=>({push(){},prefetch(){}});",
    "next/dynamic": "module.exports=()=>()=>null;",
    "next/link": `module.exports=({children,href,prefetch,...props})=>require('react').createElement('a',{href,...props},children);`,
    "@/components/intent-prefetch-link": `exports.IntentPrefetchLink=({children,href,...props})=>require('react').createElement('a',{href,...props},children);`,
    "@/components/header": `exports.Header=({title,description,children})=>require('react').createElement('header',null,require('react').createElement('h1',null,title),description,children);`,
    "@/components/programs/program-picker": `exports.ProgramBadge=({program,name})=>require('react').createElement('span',null,program?.name??name);`,
    "@/components/students/student-avatar": "exports.StudentAvatar=()=>null;",
    "@/components/students/status-badge": `exports.StatusBadge=({status})=>require('react').createElement('span',null,status);`,
    "@/lib/store": `const React=require('react');const use=key=>React.useSyncExternalStore(fixture.subscribe,()=>fixture[key]);exports.useConfigStore=()=>use('config');exports.useProgramStore=()=>use('programs');exports.useStudioStore=()=>use('studio');exports.useLeadStore=()=>use('leads');`,
    "@/lib/api": `exports.api={get:async()=>[]};exports.CommandOutcomeUnknown=class CommandOutcomeUnknown extends Error{};`,
    "@/lib/performance":
      "exports.markDashboardReadiness=(_route,_generation,state)=>{fixture.readiness=state;return()=>{}};",
    "@/components/leads/add-lead-modal": "exports.AddLeadModal=()=>null;",
    "@/components/leads/lead-detail-modal": `exports.LeadDetailInspector=props=>{fixture.inspector=props;return require('react').createElement('aside',null,'Synthetic inspector');};`,
    "@/components/leads/lead-trial-appointments":
      "exports.LeadTrialAppointments=()=>null;exports.TrialAppointmentRecovery=()=>null;",
    "@/components/leads/lost-leads-section": "exports.LostLeadsSection=()=>null;",
    "refresh-fixture.tsx": `import React from 'react';
      import {StudentRosterPageContent} from '@/components/students/student-roster-page-content';
      import LeadsPage from '@/app/(dashboard)/leads/page';
      import {RetainedStateProvider} from '@/lib/retained-state';
      const f=window.fixture,noop=()=>{};
      const defaults={actionMessage:null,activeBulkPanel:null,activeLoadError:null,allSelected:false,bulkActionError:null,bulkStatus:'active',canCreateStudents:false,canManageRoster:true,deleteError:null,fullRosterRequested:false,hasActiveFilters:false,hasNextPage:false,hasPreviousPage:false,hasNewStudentFilter:false,inactivityByStudentId:new Map(),inactivityThreshold:null,isAdding:false,isAddingTags:false,isBulkCommandPending:false,isDeleting:false,isInitialRosterLoading:false,isNewStudentYtd:false,isPagedLoading:false,isRosterRefreshing:false,isUpdatingStatus:false,newStudentDays:null,newStudentStartDate:null,page:1,pageEnd:1,pageStart:1,pagedTotal:1,programFilter:'',programs:[],search:'',selectedCount:0,selectedIds:new Set(),showForm:false,sortDir:'asc',sortKey:'name',statusFilter:'',studentsCount:1,tagInput:'',totalPages:1,usesDerivedRosterFilters:true,visibleTotal:1};
      for(const key of ['AddStudent','AddStudentSubmit','AddTags','BulkStatusChange','BulkStatusUpdate','CancelDelete','CancelStatus','CancelTags','ClearFilters','CloseStudentForm','DeleteSelected','DismissActionMessage','DismissRosterQueryNotice','ImportCsv','NextPage','OpenStudent','PrefetchStudent','PreviousPage','ProgramFilterChange','RetryRosterLoad','SearchChange','Sort','StatusFilterChange','TagInputChange','ToggleBulkPanel','ToggleSelect','ToggleSelectAll'])defaults['on'+key]=()=>f.actions.push(key);
      export default function Fixture(){React.useSyncExternalStore(f.subscribe,()=>f.version);return f.kind==='students'?<StudentRosterPageContent {...defaults} {...f.input}/>:<RetainedStateProvider scope='synthetic-refresh'><LeadsPage/></RetainedStateProvider>;}`,
  });
  const react = add("react"),
    dom = add("react-dom/client"),
    app = add("refresh-fixture.tsx");
  return `(()=>{const process={env:{NODE_ENV:'production'}},modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
    const fixture=window.fixture={kind:'students',input:{filtered:[]},actions:[],version:0,listeners:new Set(),subscribe:cb=>{fixture.listeners.add(cb);return()=>fixture.listeners.delete(cb)},notify:()=>{fixture.version++;fixture.listeners.forEach(cb=>cb())}};
    const noop=async()=>{};
    fixture.config={currentRole:'admin',isPreviewMode:false,token:'synthetic-token',businessDate:'2026-10-10',studioTimezone:'America/Los_Angeles'};
    fixture.programs={programs:[],programsLoaded:true,programsLoadError:null,programsUsageLoadError:null,refreshPrograms:noop};
    fixture.studio={identityReady:true,identityGeneration:1,staffMembers:[],staffLoaded:false,staffLoadError:null,refreshStaff:async()=>{fixture.staffReads=(fixture.staffReads??0)+1}};
    fixture.leads={leadsLoaded:true,leadsLoadError:null,leads:[{id:'abcdef01-2345-6789-abcd-ef0123456789',first_name:'Synthetic',last_name:'Lead',stage:'inquiry',source:'website',follow_up_date:'2026-10-10',assigned_staff_id:null,created_at:'2026-09-01T00:00:00Z',is_minor:false}],leadCreate:{isCurrent:()=>true,status:'idle',locked:false,message:null},leadOperations:{views:new Map()},trialAppointments:{trialStorage:{isCurrent:()=>true},trialOperations:new Map()},addLead:noop,updateLead:noop,convertLeadToStudent:noop,followUpLead:noop,checkLeadCreateResult:noop,refreshLeads:noop};
    fixture.update=patch=>{Object.assign(fixture,patch);fixture.notify()};
    const React=require(${react}),root=require(${dom}).createRoot(document.getElementById('root'));root.render(React.createElement(require(${app}).default));})();`;
}
const presentationSource = presentationBundle();
const programs = [
  { id: "program-a", name: "Karate" },
  { id: "program-b", name: "Brazilian Jiu-Jitsu Core" },
];
const filtered = buildStudentRows(
  [
    {
      id: "student-a",
      legal_first_name: "Synthetic",
      legal_last_name: "Student",
      status: "active",
      guardians: [],
      tags: [],
      program_id: "program-a",
      membership_start_date: "2026-01-02",
    },
  ],
  programs,
  "2026-10-10",
);

test("roster background refresh preserves controls at responsive wrap boundaries", async (t) => {
  const page = await mount(t, presentationSource, css);
  const results = [];
  for (const width of [1440, 1220, 1180, 1000, 760, 641, 640, 560, 480, 390]) {
    await page.setViewportSize({ width, height: width === 1000 ? 614 : 900 });
    for (const active of [false, true])
      for (const withPrograms of [false, true]) {
        const input = {
          filtered,
          hasActiveFilters: active,
          search: active ? "Synthetic" : "",
          programs: withPrograms ? programs : [],
        };
        await page.evaluate((input) => fixture.update({ input }), input);
        await expect(page.locator('[data-student-id="student-a"]')).toBeVisible();
        const targets = [
          ".refresh2_rosterToolbar",
          "[aria-label='Search students']",
          "[data-student-id='student-a']",
        ];
        const before = await geometry(page, targets);
        await page.getByRole("textbox", { name: "Search students", exact: true }).focus();
        await page.evaluate(() =>
          fixture.update({ input: { ...fixture.input, isRosterRefreshing: true } }),
        );
        const during = await geometry(page, targets);
        const announcement = await page
          .getByText("Updating roster…", { exact: true })
          .ariaSnapshot();
        await expect(
          page.getByRole("textbox", { name: "Search students", exact: true }),
        ).toBeFocused();
        if (active)
          await expect(
            page.getByRole("button", { name: "Clear filters", exact: true }),
          ).toBeVisible();
        const result = {
          kind: "students",
          width,
          active,
          withPrograms,
          before,
          during,
          announcement,
        };
        measurements.push(result);
        results.push(result);
        await page.evaluate(() =>
          fixture.update({ input: { ...fixture.input, isRosterRefreshing: false } }),
        );
        assert.deepEqual(await geometry(page, targets), before);
        await expect(page.getByRole("status")).toHaveCount(0);
      }
  }
  for (const result of results) {
    assert.deepEqual(
      result.during,
      result.before,
      JSON.stringify({
        width: result.width,
        active: result.active,
        withPrograms: result.withPrograms,
      }),
    );
    assert.equal(result.announcement, "- status: Updating roster…");
  }
});

test("delayed staff assignment readiness preserves useful Leads geometry and announces loading", async (t) => {
  const results = [];
  for (const viewport of viewports) {
    const page = await mount(t, presentationSource, css, viewport);
    await page.evaluate(() => fixture.update({ kind: "leads" }));
    await expect(page.locator("[data-lead-id]")).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Loading staff assignments...");
    assert.equal(
      await page.getByRole("status").ariaSnapshot(),
      "- status: Loading staff assignments...",
    );
    const targets = [".refresh3_leadArea", "[data-lead-id]"];
    const pending = await geometry(page, targets);
    await page.getByRole("button", { name: "Add lead", exact: true }).focus();
    await page.locator("[data-lead-id]").click();
    assert.deepEqual(await page.evaluate(() => fixture.readiness), {
      useful: true,
      complete: false,
    });
    assert.equal(await page.evaluate(() => fixture.inspector.canManageLeads), true);
    await page.evaluate(() => fixture.inspector.onClose());
    await page.evaluate(() => fixture.update({ studio: { ...fixture.studio, staffLoaded: true } }));
    await expect(page.getByRole("status")).toHaveCount(0);
    const ready = await geometry(page, targets);
    await page.locator("[data-lead-id]").click();
    assert.deepEqual(await page.evaluate(() => fixture.readiness), {
      useful: true,
      complete: true,
    });
    assert.equal(await page.evaluate(() => fixture.inspector.canManageLeads), true);
    const result = { kind: "leads", viewport, pending, ready };
    measurements.push(result);
    results.push(result);
  }
  for (const result of results)
    assert.deepEqual(result.ready, result.pending, `staff readiness at ${result.viewport.width}px`);
});

test("cold Leads becomes useful while supplemental staff loading stays out of layout", async (t) => {
  const results = [];
  for (const viewport of viewports) {
    const page = await mount(t, presentationSource, css, viewport);
    await page.evaluate(() =>
      fixture.update({ kind: "leads", leads: { ...fixture.leads, leadsLoaded: false } }),
    );
    const placeholder = page.getByRole("status", {
      name: "Loading lead follow-up obligations",
      exact: true,
    });
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toHaveAttribute("aria-busy", "true");
    await expect(placeholder.locator("li")).toHaveCount(6);
    const staff = page.getByText("Loading staff assignments...", { exact: true });
    assert.equal(await staff.ariaSnapshot(), "- status: Loading staff assignments...");
    const cold = await geometry(page, [".refresh3_leadArea"]);
    await page.evaluate(() => fixture.update({ leads: { ...fixture.leads, leadsLoaded: true } }));
    await expect(page.locator("[data-lead-id]")).toBeVisible();
    await expect(placeholder).toHaveCount(0);
    const useful = await geometry(page, [".refresh3_leadArea"]);
    assert.deepEqual(await page.evaluate(() => fixture.readiness), {
      useful: true,
      complete: false,
    });
    assert.equal(await staff.ariaSnapshot(), "- status: Loading staff assignments...");
    await page.evaluate(() => fixture.update({ studio: { ...fixture.studio, staffLoaded: true } }));
    const complete = await geometry(page, [".refresh3_leadArea"]);
    const result = { kind: "leads-cold-to-useful", viewport, cold, useful, complete };
    measurements.push(result);
    results.push(result);
  }
  for (const result of results) {
    assert.equal(
      result.useful[0].y,
      result.cold[0].y,
      `cold-to-useful at ${result.viewport.width}px`,
    );
    assert.deepEqual(result.complete, result.useful);
  }
});

test("staff assignment failure stays visible and retryable", async (t) => {
  const page = await mount(t, presentationSource, css);
  await page.evaluate(() =>
    fixture.update({
      kind: "leads",
      studio: { ...fixture.studio, staffLoadError: "Synthetic staff failure" },
    }),
  );
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Staff assignments are unavailable. Synthetic staff failure",
  );
  await page.getByRole("button", { name: "Retry staff assignments", exact: true }).click();
  assert.equal(await page.evaluate(() => fixture.staffReads), 1);
  await expect(page.locator("[data-lead-id]")).toBeVisible();
  await page.locator("[data-lead-id]").click();
  assert.deepEqual(await page.evaluate(() => fixture.readiness), { useful: true, complete: false });
});

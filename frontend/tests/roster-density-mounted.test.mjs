import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { buildStudentRows } from "../src/lib/students-page-model.ts";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

const today = "2026-10-10";
const styles = (
  await Promise.all(
    ["students/student-records.module.css", "leads/leads-ledger.module.css"].map((path) =>
      readFile(new URL(`../src/components/${path}`, import.meta.url), "utf8"),
    ),
  )
).join("\n");

function bundle() {
  const { add, modules } = createCommonJsPacker({
    "next/dynamic": "exports.__esModule=true;exports.default=()=>()=>null;",
    "next/navigation": "exports.useRouter=()=>({push(){},prefetch(){}});",
    "next/link": `exports.__esModule=true;exports.default=({children,href,prefetch,...props})=>require('react').createElement('a',{href,...props},children);`,
    "@/components/intent-prefetch-link": `exports.IntentPrefetchLink=({children,href,...props})=>require('react').createElement('a',{href,...props},children);`,
    "@/components/programs/program-picker": `exports.ProgramBadge=({program,name})=>require('react').createElement('span',null,program?.name??name);`,
    "@/components/students/student-avatar": "exports.StudentAvatar=()=>null;",
    "@/components/students/status-badge": `exports.StatusBadge=({status})=>require('react').createElement('span',null,status);`,
    "lucide-react": "module.exports=new Proxy({},{get:()=>()=>null});",
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const roster = add("@/components/students/student-roster-page-content");
  const ledger = add("@/components/leads/lead-pipeline-board");
  const strip = add("@/components/leads/lead-stage-strip");
  return `(()=>{
    const process={env:{NODE_ENV:'production'}},modules=[${modules.join(",")}],cache={};
    function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
    const React=require(${react}),root=require(${dom}).createRoot(document.getElementById('root'));
    const Roster=require(${roster}).StudentRosterPageContent,Ledger=require(${ledger}).LeadPipelineBoard,Strip=require(${strip}).LeadStageStrip,noop=()=>{};
    function Students({input}){
      const [selectedIds,setSelectedIds]=React.useState(new Set());
      const filtered=input.filtered,allSelected=filtered.length>0&&filtered.every(row=>selectedIds.has(row.student.id));
      return React.createElement(Roster,{
        actionMessage:null,activeBulkPanel:null,activeLoadError:null,bulkActionError:null,bulkStatus:'active',deleteError:null,
        canCreateStudents:false,canManageRoster:true,filtered,programs:[],programFilter:'',search:'',statusFilter:'',sortKey:'name',sortDir:'asc',
        fullRosterRequested:false,hasActiveFilters:false,hasNextPage:false,hasPreviousPage:false,hasNewStudentFilter:false,
        inactivityThreshold:null,inactivityByStudentId:new Map(),isAdding:false,isAddingTags:false,isBulkCommandPending:false,isDeleting:false,
        isInitialRosterLoading:false,isNewStudentYtd:false,isPagedLoading:false,isRosterRefreshing:false,isUpdatingStatus:false,
        newStudentDays:null,newStudentStartDate:null,page:1,pageEnd:filtered.length,pageStart:1,pagedTotal:filtered.length,
        showForm:false,studentsCount:filtered.length,tagInput:'',totalPages:1,usesDerivedRosterFilters:true,visibleTotal:filtered.length,
        onAddStudent:noop,onAddStudentSubmit:noop,onAddTags:noop,onBulkStatusChange:noop,onBulkStatusUpdate:noop,onCancelDelete:noop,
        onCancelStatus:noop,onCancelTags:noop,onClearFilters:noop,onCloseStudentForm:noop,onDeleteSelected:noop,onDismissActionMessage:noop,
        onDismissRosterQueryNotice:()=>window.fixture.dismissed++,onImportCsv:noop,onNextPage:noop,onOpenStudent:noop,onPrefetchStudent:noop,
        onPreviousPage:noop,onProgramFilterChange:noop,onRetryRosterLoad:noop,onSearchChange:noop,onSort:noop,onStatusFilterChange:noop,
        onTagInputChange:noop,onToggleBulkPanel:noop,...input,selectedIds,selectedCount:selectedIds.size,allSelected,
        onToggleSelect:id=>setSelectedIds(previous=>{const next=new Set(previous);next.has(id)?next.delete(id):next.add(id);return next;}),
        onToggleSelectAll:()=>setSelectedIds(allSelected?new Set():new Set(filtered.map(row=>row.student.id)))
      });
    }
    function Leads({input}){
      const [focus,setFocus]=React.useState(null);
      return React.createElement('div',{className:'page'},
        React.createElement(Strip,{focus,onFocusChange:setFocus,leads:input.leads,today:input.today}),
        React.createElement(Ledger,{canConvertLeads:true,canManageLeads:true,pendingLeadIds:new Set(),recoveringLeadIds:new Set(),programById:new Map(),staffById:new Map(),selectedLeadId:null,onAddLead:noop,onSelectLead:noop,onKeyboardMoveLead:(lead,direction)=>window.fixture.moves.push([lead.id,direction]),...input,focus,onFocusChange:setFocus})
      );
    }
    let generation=0;
    window.fixture.render=(kind,input)=>root.render(React.createElement(kind==='students'?Students:Leads,{key:++generation,input}));
  })();`;
}

const source = bundle();
const programs = [
  { id: "bjj", name: "Brazilian Jiu-Jitsu Core", color_hex: "#555555" },
  { id: "karate", name: "Karate", color_hex: "#333333" },
];
const students = buildStudentRows(
  ["Ada", "Bea"].map((name) => ({
    id: name.toLowerCase(),
    legal_first_name: name,
    legal_last_name: "Student",
    preferred_name: null,
    date_of_birth: null,
    is_minor: name === "Ada",
    status: "active",
    email: `${name.toLowerCase()}@example.test`,
    phone: null,
    membership_start_date: "2026-01-02",
    program_id: "bjj",
    tags: name === "Ada" ? ["paid", "vip", "follow-up"] : [],
    guardians:
      name === "Ada" ? [{ first_name: "Demo", last_name: "Ali", is_primary_contact: true }] : [],
  })),
  programs,
  today,
);
const leads = [
  ["old", "inquiry", "2026-10-01"],
  ["today", "trial_scheduled", today],
  ["future", "trial_completed", "2026-10-11"],
  ["unset", "offer_sent", null],
  ["enrolled", "enrolled", "2026-10-01"],
].map(([id, stage, follow_up_date]) => ({
  id,
  first_name: id,
  last_name: "Lead",
  stage,
  follow_up_date,
  assigned_staff_id: id === "future" ? "owner" : null,
  source: "website",
  is_minor: false,
}));

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function mount(t, kind, input = {}, width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.abort());
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], "Mounted density components must not raise browser errors");
  });
  await page.setContent(`<style>*{box-sizing:border-box}${styles}</style><main id="root"></main>`);
  await page.evaluate(() => {
    window.fixture = { dismissed: 0, moves: [] };
  });
  await page.addScriptTag({ content: source });
  const props = kind === "students" ? { filtered: students, ...input } : { leads, today, ...input };
  await page.evaluate(({ kind, props }) => window.fixture.render(kind, props), { kind, props });
  await expect(page.locator(kind === "students" ? ".rosterSheet" : ".stageRail")).toBeVisible();
  return page;
}

test("roster merges its views into the sheet and renders no Roster eyebrow", async (t) => {
  const page = await mount(t, "students");
  await expect(page.getByRole("heading", { name: "Students", exact: true })).toBeVisible();
  await expect(page.locator("header .eyebrow")).toHaveCount(0);
  await expect(page.getByText("Roster", { exact: true })).toHaveCount(0);
  await expect(
    page.locator('.rosterSheet .rosterToolbar nav[aria-label="Roster views"]'),
  ).toHaveCount(1);
  await expect(page.getByRole("radiogroup", { name: "Filter by status" })).toBeVisible();
  await expect(page.getByPlaceholder("Search students", { exact: true })).toBeVisible();
});

test("program filter requires two current programs and excludes archived programs", async (t) => {
  const archived = { id: "old", name: "Archived program", archived_at: "2026-01-01" };
  const one = await mount(t, "students", { programs: [programs[0], archived] });
  await expect(one.getByRole("combobox", { name: "Filter by program" })).toHaveCount(0);
  const two = await mount(t, "students", { programs: [...programs, archived] });
  const select = two.getByRole("combobox", { name: "Filter by program" });
  await expect(select).toBeVisible();
  assert.deepEqual(await select.locator("option").allTextContents(), [
    "All programs",
    "Brazilian Jiu-Jitsu Core",
    "Karate",
  ]);
});

test("query lenses show the shorter notices, inactivity heading, and dismiss action", async (t) => {
  const page = await mount(t, "students", { inactivityThreshold: 14, hasActiveFilters: true });
  await expect(page.getByRole("columnheader", { name: "Not seen for", exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Inactive for" })).toHaveCount(0);
  await expect(
    page.getByText("Showing students not seen for 14+ days. Students on hold are left out.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Not seen 14+ days" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await page.getByRole("button", { name: /dismiss/i }).click();
  assert.equal(await page.evaluate(() => window.fixture.dismissed), 1);
  for (const isNewStudentYtd of [false, true]) {
    const joined = await mount(t, "students", {
      hasNewStudentFilter: true,
      isNewStudentYtd,
      newStudentDays: 30,
      newStudentStartDate: "2026-01-01",
    });
    await expect(
      joined.getByText(
        isNewStudentYtd
          ? "Showing students who joined this year, by membership start date."
          : "Showing students who joined in the last 30 days, by membership start date.",
        { exact: true },
      ),
    ).toBeVisible();
  }
});

test("rows show one tag with titled overflow and guardian without the Minor prefix", async (t) => {
  const page = await mount(t, "students");
  const row = page.locator('[data-student-id="ada"]');
  await expect(row.locator(".rosterTag")).toHaveText(["paid"]);
  await expect(row.getByText("+2", { exact: true })).toHaveAttribute("title", "vip, follow-up");
  await expect(row.locator(".studentGuardian")).toHaveText("Guardian Demo Ali");
  await expect(row.getByText(/Minor/)).toHaveCount(0);
  const noGuardian = { ...students[0], student: { ...students[0].student, guardians: [] } };
  const fallback = await mount(t, "students", { filtered: [noGuardian] });
  await expect(fallback.locator(".studentGuardian")).toHaveText("Minor");
});

test("phone selection band selects and deselects all after a first checkbox", async (t) => {
  const page = await mount(t, "students", {}, 600);
  const selectAll = page.getByRole("button", { name: "Select all visible students", exact: true });
  await expect(selectAll).toHaveCount(0);
  await page.locator('[data-student-id="ada"]').getByRole("checkbox").check();
  await expect(selectAll).toBeVisible();
  await expect(selectAll).toHaveText("Select all");
  await expect(page.locator(".selectionBand")).toContainText("1 selected");
  await selectAll.click();
  const deselectAll = page.getByRole("button", {
    name: "Deselect all visible students",
    exact: true,
  });
  await expect(deselectAll).toHaveText("Deselect all");
  await expect(page.locator("tbody input:checked")).toHaveCount(2);
  await deselectAll.click();
  await expect(page.locator(".selectionBand")).toHaveCount(0);
  await expect(page.locator("tbody input:checked")).toHaveCount(0);
});

test("roster changes from phone rows at 640 to table at 641 and reserves twelve loading rows", async (t) => {
  const page = await mount(t, "students", {}, 640);
  const row = page.locator('[data-student-id="ada"]');
  await expect(page.locator("thead")).toBeHidden();
  await expect(page.getByRole("combobox", { name: "Sort students by" })).toBeVisible();
  for (const cell of ["contact", "since", "open"])
    await expect(row.locator(`[data-cell="${cell}"]`)).toBeHidden();
  await page.setViewportSize({ width: 641, height: 1000 });
  await expect(page.locator("thead")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Sort students by" })).toBeHidden();
  await expect(row.locator('[data-cell="since"]')).toBeVisible();
  const loading = await mount(t, "students", { isInitialRosterLoading: true });
  await expect(loading.locator("tbody tr")).toHaveCount(12);
  await expect(loading.locator("[data-student-id]")).toHaveCount(0);
});

test("each of five lead strip tiles toggles its stage or No owner focus", async (t) => {
  const page = await mount(t, "leads");
  const rail = page.getByRole("list", { name: "Lead stages" });
  await expect(rail.locator("li")).toHaveCount(5);
  await expect(rail.getByRole("button", { name: /Enrolled/ })).toHaveCount(0);
  for (const [label, ids] of [
    ["Inquiry: 1 lead", ["old"]],
    ["Trial Scheduled: 1 lead", ["today"]],
    ["Trial Completed: 1 lead", ["future"]],
    ["Offer Sent: 1 lead", ["unset"]],
    ["No owner: 3 leads", ["old", "today", "unset"]],
  ]) {
    const tile = rail.getByRole("button", { name: label, exact: true });
    await expect(tile).toHaveAttribute("aria-pressed", "false");
    await tile.click();
    await expect(tile).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".stageRail [aria-pressed=true]")).toHaveCount(1);
    assert.deepEqual(
      await page
        .locator("[data-lead-id]")
        .evaluateAll((rows) => rows.map((row) => row.dataset.leadId)),
      ids,
    );
    if (label.startsWith("No owner"))
      await expect(page.getByRole("status")).toContainText("leads without an owner");
    await tile.click();
    await expect(tile).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("[data-lead-id]")).toHaveCount(5);
  }
});

test("four lead bands repeat due text only for Overdue and Upcoming and show No owner", async (t) => {
  const page = await mount(t, "leads");
  assert.deepEqual(await page.locator(".ageBand h2").allTextContents(), [
    "Overdue",
    "Due today",
    "Upcoming",
    "Nothing due",
  ]);
  await expect(page.locator('[data-age-band="overdue"] .leadDue')).toHaveText("9 days overdue");
  await expect(page.locator('[data-age-band="upcoming"] .leadDue')).toHaveText("Due tomorrow");
  for (const band of ["today", "unscheduled"]) {
    await expect(page.locator(`[data-age-band="${band}"] .leadDue`)).toHaveCount(0);
    await expect(page.locator(`[data-age-band="${band}"] .queueAction[data-due]`)).toHaveCount(0);
  }
  const owner = page.locator('[data-lead-id="old"]').locator("..").locator(".leadOwner");
  await expect(owner).toHaveText("No owner");
  await expect(owner).toBeVisible();
  await expect(page.getByText("Unassigned", { exact: true })).toHaveCount(0);
});

test("lead empty state uses the new plain copy", async (t) => {
  const page = await mount(t, "leads", { leads: [] });
  await expect(page.getByRole("heading", { name: "No open leads.", exact: true })).toBeVisible();
  await expect(
    page.getByText("New inquiries show up here, soonest follow-up first.", { exact: true }),
  ).toBeVisible();
});

test("desktop lead arrows stay quiet until focus and phones expose only Next", async (t) => {
  const page = await mount(t, "leads");
  const previous = page.getByRole("button", {
    name: "Move future Lead to the previous stage",
    exact: true,
  });
  const next = page.getByRole("button", {
    name: "Move future Lead to the next stage",
    exact: true,
  });
  await expect(previous).toBeVisible();
  await expect(next).toBeVisible();
  assert.equal(await next.evaluate((button) => getComputedStyle(button).opacity), "0.5");
  await previous.focus();
  await expect(next).toHaveCSS("opacity", "1");
  await previous.click();
  await next.click();
  assert.deepEqual(await page.evaluate(() => window.fixture.moves), [
    ["future", -1],
    ["future", 1],
  ]);
  await page.setViewportSize({ width: 600, height: 1000 });
  await expect(previous).toBeHidden();
  await expect(next).toBeVisible();
  await expect(next).toHaveCSS("width", "44px");
});

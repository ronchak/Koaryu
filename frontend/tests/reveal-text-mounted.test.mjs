import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { buildStudentRows } from "../src/lib/students-page-model.ts";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

const css = [
  "ui/reveal-text.module.css",
  "schedule/schedule.module.css",
  "students/student-records.module.css",
  "leads/leads-ledger.module.css",
]
  .map((path) =>
    readFileSync(new URL(`../src/components/${path}`, import.meta.url), "utf8").replace(
      /:global\(([^)]+)\)/g,
      "$1",
    ),
  )
  .join("\n");

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
  const reveal = add("@/components/ui/reveal-text");
  const schedule = add("@/components/schedule/schedule-page-section");
  const students = add("@/components/students/student-roster-sections");
  const leads = add("@/components/leads/lead-pipeline-board");
  return `(()=>{
    const process={env:{NODE_ENV:'production'}},modules=[${modules.join(",")}],cache={};
    function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
    const React=require(${react}),root=require(${dom}).createRoot(document.getElementById('root'));
    const RevealText=require(${reveal}).RevealText,noop=()=>{},f=window.fixture;
    function Unit({parent,as='span',text,width=40,rest=false}){
      return React.createElement(parent,{id:'parent',onClick:()=>f.opened.push('parent')},
        React.createElement(RevealText,{as,id:'text',className:'forcedCut',style:{width}},text),
        rest?React.createElement('span',{id:'rest'},'More'):null);
    }
    f.render=(kind,input)=>{
      let element;
      if(kind==='unit')element=React.createElement(Unit,input);
      if(kind==='schedule')element=React.createElement(require(${schedule}).SchedulePageSection,{
        businessDate:'2026-10-11',currentDate:new Date('2026-10-11T12:00:00Z'),view:'week',
        canManageSchedule:true,programFilter:'',templates:[],programs:[],hasLoadedRange:true,
        isRefreshingRange:false,scheduleLoadError:null,actionMessage:null,
        onNavigate:noop,onJumpToToday:noop,onProgramFilterChange:noop,onOpenAddClass:noop,
        onRetryRange:noop,onDismissScheduleLoadError:noop,onDismissActionMessage:noop,
        onViewChange:noop,onSelectDate:noop,onOpenSession:s=>f.opened.push(s.id),...input});
      if(kind==='students')element=React.createElement(require(${students}).StudentRosterTable,{
        allSelected:false,canManageRoster:false,handleSort:noop,inactivityByStudentId:new Map(),
        inactivityThreshold:null,isBulkCommandPending:false,programs:[],selectedIds:new Set(),
        sortDir:'asc',sortKey:'name',toggleSelect:noop,toggleSelectAll:noop,
        onOpenStudent:id=>f.opened.push(id),...input});
      if(kind==='leads')element=React.createElement(require(${leads}).LeadPipelineBoard,{
        canConvertLeads:false,canManageLeads:false,pendingLeadIds:new Set(),recoveringLeadIds:new Set(),
        programById:new Map(),selectedLeadId:null,today:'2026-10-11',
        staffById:new Map(input.staff.map(s=>[s.id,s])),onAddLead:noop,onKeyboardMoveLead:noop,
        onSelectLead:id=>f.opened.push(id),leads:input.leads});
      root.render(element);
    };
  })();`;
}

const source = bundle();
const longText = "Brazilian Jiu-Jitsu Fundamentals with the visiting instructor";
const forcedCss = `
  html,body{width:100%;margin:0}*{box-sizing:border-box}
  .relative{position:relative}.absolute{position:absolute}.inset-x-0{left:0;right:0}.grid{display:grid}
  #outside{position:fixed;right:0;top:0;width:40px;height:40px}
  #text{display:block;min-height:20px;margin:0}
  .forcedCut:not([data-open="true"]),
  [data-schedule-time-canvas="week"] .canvasTitle.reveal:not([data-open="true"]),
  .contactText:not([data-open="true"]),.leadOwner:not([data-open="true"]){
    display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;
    -webkit-line-clamp:unset;max-height:none;
  }
  [data-schedule-time-canvas="week"] .canvasTitle.reveal:not([data-open="true"]){width:40px}
  .contactText:not([data-open="true"]){width:100px}
  .leadOwner:not([data-open="true"]){width:80px;max-width:80px}
`;

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function mount(t, kind, input) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC" });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.abort());
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], "RevealText mounts must not raise browser errors");
  });
  await page.setContent(
    `<style>${css}\n${forcedCss}</style><main id="root"></main><div id="outside">Away</div>`,
  );
  await page.evaluate(() => {
    window.fixture = { opened: [] };
  });
  await page.addScriptTag({ content: source });
  await page.evaluate(({ kind, input }) => window.fixture.render(kind, input), { kind, input });
  await expect(page.locator("#root > *").first()).toBeVisible();
  return page;
}

const opened = (page) => page.evaluate(() => window.fixture.opened);
const folded = (text) => expect(text).not.toHaveAttribute("data-open", "true");

for (const [parent, as] of [
  ["button", "span"],
  ["div", "strong"],
  ["div", "p"],
]) {
  test(`cut ${as} text in a ${parent} toggles and folds on Escape without invoking its parent`, async (t) => {
    const page = await mount(t, "unit", { parent, as, text: longText });
    const text = page.locator("#text");
    const row = page.locator("#parent");
    await expect(text).toHaveAttribute("data-cut", "true");
    assert.equal(await text.evaluate((node) => node.tagName.toLowerCase()), as);
    const assertSemantics = async () => {
      await expect(text).toHaveText(longText);
      assert.equal(
        await row.textContent(),
        longText,
        "The full parent text must remain in the DOM",
      );
      for (const attribute of ["role", "tabindex", "aria-expanded"]) {
        assert.equal(await text.getAttribute(attribute), null, `${as} must not become a control`);
      }
      if (parent === "button") await expect(row).toHaveAccessibleName(longText);
    };
    await assertSemantics();
    await text.click();
    await expect(text).toHaveAttribute("data-open", "true");
    await assertSemantics();
    assert.deepEqual(await opened(page), [], "Revealing cut text must stop the parent action");
    await text.click();
    await folded(text);
    assert.deepEqual(await opened(page), [], "Folding cut text must stop the parent action");
    await text.click();
    await expect(text).toHaveAttribute("data-open", "true");
    await page.keyboard.press("Escape");
    await folded(text);
    await assertSemantics();
    assert.deepEqual(await opened(page), [], "Dismissal must not invoke the parent action");
  });

  test(`a click elsewhere folds open ${as} text in a ${parent} and still does its own thing`, async (t) => {
    const page = await mount(t, "unit", { parent, as, text: longText, rest: true });
    const text = page.locator("#text");
    await expect(text).toHaveAttribute("data-cut", "true");
    await text.click();
    await expect(text).toHaveAttribute("data-open", "true");
    await page.locator("#outside").click();
    await folded(text);
    assert.deepEqual(await opened(page), [], "A click outside the parent must not run it");
    await text.click();
    await expect(text).toHaveAttribute("data-open", "true");
    await page.locator("#rest").click();
    await folded(text);
    assert.deepEqual(
      await opened(page),
      ["parent"],
      "A click on the rest of the parent folds the text and runs the parent in the same click",
    );
  });

  test(`fitting ${as} text in a ${parent} leaves the parent click intact`, async (t) => {
    const page = await mount(t, "unit", { parent, as, text: "Mat", width: 200 });
    const text = page.locator("#text");
    assert.equal(await text.getAttribute("data-cut"), null);
    await text.click();
    await folded(text);
    assert.deepEqual(await opened(page), ["parent"]);
  });
}

test("Enter on the parent button activates it while its child text is cut or open", async (t) => {
  const page = await mount(t, "unit", { parent: "button", text: longText });
  const text = page.locator("#text");
  const button = page.getByRole("button", { name: longText, exact: true });
  await expect(text).toHaveAttribute("data-cut", "true");
  await button.focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await opened(page), ["parent"]);
  await folded(text);
  await text.click();
  await expect(text).toHaveAttribute("data-open", "true");
  await button.focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await opened(page), ["parent", "parent"]);
  await expect(button).toHaveAccessibleName(longText);
});

test("ResizeObserver updates whether closed text intercepts a click", async (t) => {
  const page = await mount(t, "unit", { parent: "button", text: longText });
  const text = page.locator("#text");
  await expect(text).toHaveAttribute("data-cut", "true");
  await text.evaluate((node) => (node.style.width = "1000px"));
  await expect(text).not.toHaveAttribute("data-cut", "true");
  await text.click();
  assert.deepEqual(await opened(page), ["parent"]);
  await text.evaluate((node) => (node.style.width = "40px"));
  await expect(text).toHaveAttribute("data-cut", "true");
  await text.click();
  await expect(text).toHaveAttribute("data-open", "true");
  assert.deepEqual(await opened(page), ["parent"]);
});

test("Schedule week reveals a cut block name in place and opens a fitting session", async (t) => {
  const sessions = [longText, "Mat"].map((name, index) => ({
    id: `session-${index}`,
    name,
    date: "2026-10-11",
    start_time: index ? "18:00" : "16:00",
    end_time: index ? "18:45" : "16:45",
    status: "scheduled",
    program_id: null,
    attendance_count: 3,
    capacity: 20,
  }));
  const page = await mount(t, "schedule", { sessions });
  const canvas = page.locator('[data-schedule-time-canvas="week"]');
  const cut = canvas.locator(".canvasTitle.reveal").filter({ hasText: longText });
  await expect(cut).toHaveAttribute("data-cut", "true");
  await cut.click();
  await expect(cut).toHaveAttribute("data-open", "true");
  assert.deepEqual(await opened(page), [], "Revealing a week name must not open the session modal");
  await expect(cut).toHaveText(longText);
  await cut.click();
  await folded(cut);
  assert.deepEqual(await opened(page), []);
  const fits = canvas.locator(".canvasTitle.reveal").filter({ hasText: /^Mat$/ });
  assert.equal(await fits.getAttribute("data-cut"), null);
  await fits.click();
  assert.deepEqual(await opened(page), ["session-1"], "A fitting name must still open its session");
});

test("Students table reveals a cut email without opening the student", async (t) => {
  const email = "avery.long.student.address@example.test";
  const filtered = buildStudentRows(
    [email, "a@b.co"].map((email, index) => ({
      id: `student-${index}`,
      legal_first_name: index ? "Bea" : "Ada",
      legal_last_name: "Student",
      preferred_name: null,
      date_of_birth: null,
      is_minor: false,
      status: "active",
      email,
      phone: null,
      membership_start_date: "2026-01-02",
      program_id: null,
      tags: [],
      guardians: [],
    })),
    [],
    "2026-10-11",
  );
  const page = await mount(t, "students", { filtered });
  const cut = page.locator('[data-student-id="student-0"] .contactText');
  await expect(cut).toHaveAttribute("data-cut", "true");
  assert.equal(await cut.textContent(), email, "The email's wbr must not change its text");
  await cut.click();
  await expect(cut).toHaveAttribute("data-open", "true");
  assert.deepEqual(await opened(page), [], "Revealing email must not call onOpenStudent");
  await cut.click();
  await folded(cut);
  assert.deepEqual(await opened(page), []);
  const fits = page.locator('[data-student-id="student-1"] .contactText');
  assert.equal(await fits.getAttribute("data-cut"), null);
  await fits.click();
  assert.deepEqual(await opened(page), ["student-1"]);
});

test("Leads queue reveals a cut owner above the stretched row button without selecting the lead", async (t) => {
  const owner = "Alexandra Longname, visiting instructor and follow-up owner";
  const leads = [0, 1].map((index) => ({
    id: `lead-${index}`,
    first_name: index ? "Bea" : "Ada",
    last_name: "Lead",
    stage: "inquiry",
    follow_up_date: "2026-10-11",
    assigned_staff_id: `staff-${index}`,
    source: "website",
    is_minor: false,
  }));
  const staff = [owner, "Jo"].map((full_name, index) => ({ id: `staff-${index}`, full_name }));
  const page = await mount(t, "leads", { leads, staff });
  const cut = page.locator(".leadOwner").filter({ hasText: owner });
  await expect(cut).toHaveAttribute("data-cut", "true");
  await cut.click();
  await expect(cut).toHaveAttribute("data-open", "true");
  assert.deepEqual(
    await opened(page),
    [],
    "The cut owner must receive the click above the row button",
  );
  await expect(cut).toHaveText(owner);
  await cut.click();
  await folded(cut);
  assert.deepEqual(await opened(page), []);
  const fits = page.locator(".leadOwner").filter({ hasText: /^Jo$/ });
  assert.equal(await fits.getAttribute("data-cut"), null);
  // Fitting owner text belongs to the row's stretched click target.
  const bounds = await fits.boundingBox();
  assert.ok(bounds);
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  assert.deepEqual(await opened(page), ["lead-1"]);
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

const leadId = "abcdef01-2345-6789-abcd-ef0123456789";
const otherId = "12345678-1234-5678-abcd-123456789abc";

// Shared by the browser and server render. No store action reaches external I/O.
function makeFixture({ loaded = true, preview = false } = {}) {
  const noop = async () => {};
  const listeners = new Set();
  const f = {
    selections: [],
    activityReads: [],
    renderFocuses: [],
    replacements: [],
    frames: new Map(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify() {
      listeners.forEach((listener) => listener());
    },
    programs: {
      programs: [],
      programsLoaded: true,
      programsLoadError: null,
      programsUsageLoadError: null,
      refreshPrograms: noop,
    },
    studio: {
      identityReady: true,
      identityGeneration: 1,
      staffMembers: [],
      staffLoaded: true,
      staffLoadError: null,
      refreshStaff: noop,
    },
    config: {
      currentRole: "admin",
      isPreviewMode: preview,
      token: "synthetic-token",
      businessDate: "2026-10-10",
      studioTimezone: "America/Los_Angeles",
    },
    state: {
      leadsLoaded: loaded,
      leadsLoadError: null,
      leads: [
        {
          id: "abcdef01-2345-6789-abcd-ef0123456789",
          first_name: "Overdue",
          last_name: "Lead",
          follow_up_date: "2026-10-09",
        },
        {
          id: "12345678-1234-5678-abcd-123456789abc",
          first_name: "Today",
          last_name: "Lead",
          follow_up_date: "2026-10-10",
        },
        { id: "lead-1", first_name: "Preview", last_name: "Lead", follow_up_date: "2026-10-11" },
      ].map((lead) => ({
        ...lead,
        stage: "inquiry",
        source: "website",
        assigned_staff_id: null,
        created_at: "2026-09-01T00:00:00Z",
        is_minor: false,
      })),
      leadCreate: { isCurrent: () => true, status: "idle", locked: false, message: null },
      leadOperations: { views: new Map() },
      trialAppointments: { trialStorage: { isCurrent: () => true }, trialOperations: new Map() },
      addLead: noop,
      updateLead: noop,
      convertLeadToStudent: noop,
      followUpLead: noop,
      checkLeadCreateResult: noop,
      refreshLeads: noop,
    },
  };
  return f;
}

function bundle({ server = false } = {}) {
  const { add, modules } = createCommonJsPacker({
    "next/navigation": `exports.useRouter=()=>({push(){}});`,
    "@/lib/store": `const React=require('react');exports.useConfigStore=()=>fixture.config;exports.useProgramStore=()=>fixture.programs;exports.useStudioStore=()=>fixture.studio;exports.useLeadStore=()=>React.useSyncExternalStore(fixture.subscribe,()=>fixture.state,()=>fixture.state);`,
    "@/lib/api": `exports.api={get:async(path)=>{fixture.activityReads.push(path);return [];}};exports.CommandOutcomeUnknown=class CommandOutcomeUnknown extends Error{};`,
    "@/lib/performance": `exports.markDashboardReadiness=()=>()=>{};`,
    "@/lib/leads-page-controller": `const real=require('@/lib/leads-page-controller.ts');exports.useLeadsPageController=options=>{const c=real.useLeadsPageController(options);return {...c,selectLead(id){fixture.selections.push(id);c.selectLead(id);}};};`,
    "@/components/header": `exports.Header=({title,children})=>require('react').createElement('header',null,require('react').createElement('h1',null,title),children);`,
    "@/components/leads/add-lead-modal": `exports.AddLeadModal=()=>null;`,
    "@/components/leads/lead-detail-modal": `exports.LeadDetailInspector=props=>{fixture.inspector=props;return require('react').createElement('aside',{'data-selected-lead':props.lead.id},props.lead.first_name,require('react').createElement('button',{onClick:props.onClose},'Close lead details'));};`,
    "@/components/leads/lead-trial-appointments": `exports.LeadTrialAppointments=()=>null;exports.TrialAppointmentRecovery=()=>null;`,
    "@/components/leads/lost-leads-section": `exports.LostLeadsSection=()=>null;`,
    "@/components/leads/lead-pipeline-board": `const React=require('react'),real=require('@/components/leads/lead-pipeline-board.tsx');exports.LeadLedgerLoadError=real.LeadLedgerLoadError;exports.LeadPipelineBoard=props=>{fixture.board=props;fixture.renderFocuses.push(props.focus);return React.createElement(real.LeadPipelineBoard,props);};`,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
  });
  const react = add("react");
  // The legacy static renderer avoids the streaming renderer's persistent MessageChannel.
  const dom = add(
    server
      ? "./node_modules/react-dom/cjs/react-dom-server-legacy.browser.production.js"
      : "react-dom/client",
  );
  const page = add("@/app/(dashboard)/leads/page");
  const retained = add("@/lib/retained-state");
  const runtime = `const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}const React=require(${react});const app=React.createElement(require(${retained}).RetainedStateProvider,{scope:'leads-route-test'},React.createElement(require(${page}).default));`;
  return server
    ? `${runtime}return require(${dom}).renderToStaticMarkup(app);`
    : `(()=>{const fixture=window.fixture;${runtime}require(${dom}).createRoot(document.getElementById('root')).render(app);})();`;
}

const source = bundle();
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});
const wait = (page, predicate) => page.waitForFunction(predicate, null, { polling: 10 });

async function mount(t, { href = "/leads", loaded = true, preview = false } = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], "No browser runtime errors");
  });
  await page.route("**/*", (route) =>
    route.request().isNavigationRequest()
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto(`http://localhost${href}`);
  await page.addScriptTag({
    content: `window.fixture=(${makeFixture.toString()})(${JSON.stringify({ loaded, preview })});`,
  });
  await page.evaluate(() => {
    const f = window.fixture;
    const replace = history.replaceState.bind(history);
    history.replaceState = (...args) => {
      f.replacements.push(args);
      replace(...args);
    };
    // Hold only animation frames; React commits continue through MessageChannel.
    let frameId = 0;
    window.requestAnimationFrame = (callback) => {
      const id = ++frameId;
      f.frames.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => f.frames.delete(id);
    f.frame = () => {
      const callbacks = [...f.frames.values()];
      f.frames.clear();
      callbacks.forEach((callback) => callback(performance.now()));
    };
    f.setLoaded = (value) => {
      f.state = { ...f.state, leadsLoaded: value };
      f.notify();
    };
    f.link = (href) => {
      history.pushState(null, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
  });
  await page.addScriptTag({ content: source });
  await expect(page.getByRole("heading", { name: "Leads", exact: true })).toHaveCount(1);
  return page;
}

const routeState = (page) =>
  page.evaluate(() => ({
    selected:
      document.querySelector("[data-selected-lead]")?.getAttribute("data-selected-lead") ?? null,
    selections: fixture.selections,
    frames: fixture.frames.size,
    replacements: fixture.replacements,
    href: location.pathname + location.search + location.hash,
  }));
async function runFrame(page) {
  await page.evaluate(() => fixture.frame());
  await wait(page, () => fixture.replacements.length > 0);
}

for (const focus of ["overdue", "today"])
  test(`${focus} focus applies on the first Leads render and consumes only target params`, async (t) => {
    const page = await mount(t, { href: `/leads?focus=${focus}&keep=one&keep=two#queue` });
    await wait(page, () => fixture.replacements.length === 1);
    assert.deepEqual(await page.evaluate(() => fixture.renderFocuses[0]), { kind: focus });
    assert.equal((await routeState(page)).href, "/leads?keep=one&keep=two#queue");
    assert.deepEqual((await routeState(page)).replacements, [
      [null, "", "/leads?keep=one&keep=two#queue"],
    ]);
    const rows = await page
      .locator("[data-lead-id]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-lead-id")));
    assert.deepEqual(rows, [focus === "overdue" ? leadId : otherId]);
    assert.deepEqual((await routeState(page)).selections, []);
  });

test("a lead target waits for leadsLoaded and one animation frame before selectLead", async (t) => {
  const page = await mount(t, {
    href: `/leads?lead=${leadId.toUpperCase()}&keep=one#queue`,
    loaded: false,
  });
  assert.equal((await routeState(page)).selected, null);
  assert.equal((await routeState(page)).frames, 0);
  assert.deepEqual((await routeState(page)).selections, []);
  assert.deepEqual((await routeState(page)).replacements, []);
  await page.evaluate(() => fixture.setLoaded(true));
  await wait(page, () => fixture.frames.size === 1);
  assert.equal(
    (await routeState(page)).selected,
    null,
    "The roster commit must precede lead opening",
  );
  assert.deepEqual(
    (await routeState(page)).replacements,
    [],
    "The URL must remain pending until the frame",
  );
  await runFrame(page);
  await expect(page.locator("[data-selected-lead]")).toHaveAttribute("data-selected-lead", leadId);
  assert.deepEqual((await routeState(page)).selections, [leadId]);
  assert.deepEqual(await page.evaluate(() => fixture.activityReads), [
    `/leads/${leadId}/activities`,
  ]);
  assert.equal((await routeState(page)).href, "/leads?keep=one#queue");
  await page.getByRole("button", { name: "Close lead details", exact: true }).click();
  await expect(page.locator("[data-selected-lead]")).toHaveCount(0);
  await page.evaluate(() => {
    fixture.setLoaded(false);
    fixture.setLoaded(true);
  });
  await wait(page, () => fixture.board && fixture.frames.size === 0);
  assert.deepEqual(
    (await routeState(page)).selections,
    [leadId],
    "A consumed lead must not reopen",
  );
});

test("combined focus and lead applies focus first and consumes both after opening", async (t) => {
  const page = await mount(t, { href: `/leads?focus=today&lead=${leadId}&keep=one#queue` });
  await wait(page, () => fixture.frames.size === 1);
  assert.deepEqual(await page.evaluate(() => fixture.renderFocuses[0]), { kind: "today" });
  assert.deepEqual((await routeState(page)).replacements, []);
  await runFrame(page);
  assert.deepEqual(
    (await routeState(page)).selections,
    [leadId],
    "A valid target outside the focus still opens",
  );
  assert.equal((await routeState(page)).href, "/leads?keep=one#queue");
});

test("an unknown lead id consumes its target without selecting anything", async (t) => {
  const unknown = "99999999-9999-9999-9999-999999999999";
  const page = await mount(t, { href: `/leads?lead=${unknown}&keep=one#queue` });
  await wait(page, () => fixture.frames.size === 1);
  await runFrame(page);
  assert.equal((await routeState(page)).selected, null);
  assert.deepEqual((await routeState(page)).selections, []);
  assert.deepEqual(await page.evaluate(() => fixture.activityReads), []);
  assert.equal((await routeState(page)).href, "/leads?keep=one#queue");
});

test("an already-selected lead is not replaced by a pending route target", async (t) => {
  const page = await mount(t, { href: `/leads?lead=${leadId}` });
  await wait(page, () => fixture.frames.size === 1 && fixture.board);
  await page.locator(`[data-lead-id="${otherId}"]`).click();
  await expect(page.locator("[data-selected-lead]")).toHaveAttribute("data-selected-lead", otherId);
  await runFrame(page);
  assert.equal((await routeState(page)).selected, otherId);
  assert.deepEqual((await routeState(page)).selections, [otherId]);
  assert.equal((await routeState(page)).href, "/leads");
});

test("unknown, repeated and case-mismatched focuses leave the Leads URL untouched", async (t) => {
  for (const query of [
    "focus=unassigned",
    "focus=Overdue",
    "focus=TODAY",
    "focus=today&focus=today",
  ]) {
    const page = await mount(t, { href: `/leads?${query}&keep=one#queue` });
    await wait(page, () => fixture.board);
    assert.equal(await page.evaluate(() => fixture.renderFocuses[0]), null);
    assert.deepEqual((await routeState(page)).replacements, []);
    assert.deepEqual((await routeState(page)).selections, []);
    assert.equal((await routeState(page)).href, `/leads?${query}&keep=one#queue`);
  }
});

test("unknown focus with a valid lead opens only the lead", async (t) => {
  const page = await mount(t, { href: `/leads?focus=unassigned&lead=${leadId}` });
  await wait(page, () => fixture.frames.size === 1);
  assert.equal(await page.evaluate(() => fixture.renderFocuses[0]), null);
  await runFrame(page);
  assert.deepEqual((await routeState(page)).selections, [leadId]);
  assert.equal((await routeState(page)).href, "/leads");
});

test("Leads reads targets only while the pathname is exactly /leads", async (t) => {
  for (const pathname of ["/dashboard", "/leads/other", "/leads/"]) {
    const href = `${pathname}?focus=today&lead=${leadId}#queue`;
    const page = await mount(t, { href });
    await wait(page, () => fixture.board);
    assert.equal(await page.evaluate(() => fixture.renderFocuses[0]), null);
    assert.equal((await routeState(page)).frames, 0);
    assert.deepEqual((await routeState(page)).selections, []);
    assert.deepEqual((await routeState(page)).replacements, []);
    assert.equal((await routeState(page)).href, href);
  }
});

test("a new Leads link while mounted applies its focus and opens its lead", async (t) => {
  const page = await mount(t);
  await wait(page, () => fixture.board);
  await page.evaluate(
    (leadId) => fixture.link(`/leads?focus=overdue&lead=${leadId}#queue`),
    leadId,
  );
  await wait(page, () => fixture.frames.size === 1);
  assert.deepEqual(await page.evaluate(() => fixture.board.focus), { kind: "overdue" });
  await runFrame(page);
  assert.deepEqual((await routeState(page)).selections, [leadId]);
  assert.equal((await routeState(page)).href, "/leads#queue");
});

test("Leads page accepts readable lead ids only in preview mode", async (t) => {
  for (const preview of [false, true]) {
    const page = await mount(t, { href: "/leads?lead=lead-1", preview });
    await wait(page, () => fixture.board);
    if (preview) {
      await wait(page, () => fixture.frames.size === 1);
      await runFrame(page);
      assert.deepEqual((await routeState(page)).selections, ["lead-1"]);
      assert.equal((await routeState(page)).selected, "lead-1");
      assert.equal((await routeState(page)).href, "/leads");
    } else {
      assert.deepEqual((await routeState(page)).selections, []);
      assert.deepEqual((await routeState(page)).replacements, []);
      assert.equal((await routeState(page)).href, "/leads?lead=lead-1");
    }
  }
});

test("Leads renderToStaticMarkup works without a target or browser globals", () => {
  assert.equal(typeof window, "undefined");
  const fixture = makeFixture();
  const html = new Function("fixture", bundle({ server: true }))(fixture);
  assert.match(html, /<h1>Leads<\/h1>/);
  assert.match(html, /data-lead-id=/);
  assert.deepEqual(fixture.renderFocuses, [null]);
  assert.deepEqual(fixture.selections, []);
  assert.deepEqual(fixture.activityReads, []);
});

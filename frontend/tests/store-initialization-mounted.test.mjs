import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { chromium } from "@playwright/test";

// Mount the real provider and action hooks in Chromium. Only external I/O is replaced.
// A tiny CommonJS packer avoids adding a second frontend build or test runtime.
const require = createRequire(import.meta.url);
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function bundle(mode, { preview = false, layout = false, leadsPage = false, programsSection = false } = {}) {
  if (!["production", "development"].includes(mode) || typeof preview !== "boolean") throw new Error("Unsupported fixture environment");
  const modules = [];
  const ids = new Map();
  const stubs = {
    "next/navigation": `exports.usePathname=()=>'/dashboard'; const router={replace(path){(window.fixture.redirects??=[]).push(path)}}; exports.useRouter=()=>router;`,
    "@/components/loading-screen": `exports.LoadingScreen=()=>null;`,
    "@/lib/supabase/client": `exports.createClient=()=>window.fixture.supabase;`,
    "@/lib/api": `class ApiError extends Error { constructor(message,status,detail){super(message);this.status=status;this.detail=detail;} } exports.ApiError=ApiError; exports.api=window.fixture.api; exports.isSubscriptionRequiredError=e=>e.status===402; exports.isStaffArchivedError=e=>e.status===403&&/archived/i.test(e.message);`,
    "@/lib/performance": `exports.markPerformance=()=>{};exports.measurePerformance=()=>{};exports.markDashboardReadiness=(route,generation,state)=>{window.fixture.readiness?.push(state);return ()=>{};};`,
    ...(leadsPage ? {
      "@/components/header": `exports.Header=()=>null;`,
      "@/components/leads/lead-ledger-loading": `exports.LeadLedgerLoading=()=>null;`,
      "@/components/leads/add-lead-modal": `exports.AddLeadModal=()=>null;`,
      "@/components/leads/lead-detail-modal": `exports.LeadDetailInspector=()=>null;`,
      "@/components/leads/lead-pipeline-board": `exports.LeadPipelineBoard=()=>null;exports.LeadLedgerLoadError=()=>null;`,
      "@/components/leads/lost-leads-section": `exports.LostLeadsSection=()=>null;`,
      "@/components/leads/leads-ledger.module.css": `module.exports={};`,
      "@/components/ui/button": `exports.Button=({children,onClick})=>require('react').createElement('button',{onClick},children);`,
      "@/components/ui/dismissible-notice": `exports.DismissibleNotice=({children})=>children;`,
      "lucide-react": `exports.UserPlus=()=>null;`,
    } : {}),
    ...(programsSection ? {
      "@/components/ui/input": `exports.Input=()=>null;`,
      "@/components/ui/button": `exports.Button=({children,onClick})=>require('react').createElement('button',{onClick},children);`,
      "@/components/ui/dismissible-notice": `exports.DismissibleNotice=({children})=>children;`,
      "lucide-react": `for (const name of ['Archive','Check','Plus','RefreshCw','RotateCcw','Save','Settings2','UserPlus']) exports[name]=()=>null;`,
    } : {}),
    ...(preview || layout ? {
      "@/components/dashboard-shell.module.css": `module.exports={};`,
      "@/components/theme-provider": `exports.useTheme=()=>({navigationPlacement:'side'});`,
      "@/components/dashboard-route-transition": `exports.DashboardRouteTransition=({children})=>children;`,
      "@/components/dashboard-shell": `exports.DashboardSlugBand=()=>null;`,
      "@/components/dashboard-shell-readiness": `exports.DashboardShellReadiness=({identityReady})=>{window.fixture.identityObservations.push(identityReady);return null;};`,
      "@/components/dashboard-identity-skeleton": `exports.DashboardIdentitySkeleton=()=>require('react').createElement('div',{'data-preview-gate':'pending'});`,
      "@/components/account/legal-name-blocking-screen": `exports.LegalNameBlockingScreen=()=>require('react').createElement('div',{'data-preview-gate':'legal-name'});`,
      "@/components/sidebar": `exports.Sidebar=()=>require('react').createElement('nav',{'data-preview-sidebar':'ready'});`,
    } : {}),
  };
  function add(specifier, parent = resolve(frontend, "entry.js")) {
    let key = specifier;
    if (!(key in stubs)) {
      if (specifier.startsWith("@/")) key = resolve(frontend, "src", specifier.slice(2));
      else if (specifier.startsWith(".")) key = resolve(dirname(parent), specifier);
      else key = require.resolve(specifier, { paths: [dirname(parent)] });
      if (!existsSync(key)) key = [".ts", ".tsx", ".js"].map(ext => key + ext).find(existsSync);
      if (!key) throw new Error(`Cannot resolve ${specifier} from ${parent}`);
    }
    if (ids.has(key)) return ids.get(key);
    const id = modules.length;
    ids.set(key, id);
    modules.push("");
    let source = stubs[key] ?? readFileSync(key, "utf8");
    if (/\.tsx?$/.test(key)) source = ts.transpileModule(source, { compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    }}).outputText;
    source = source.replace(/require\(["']([^"']+)["']\)/g, (_, dependency) => `require(${add(dependency, key)})`);
    modules[id] = `function(module,exports,require){${source}\n}`;
    return id;
  }
  const react = add("react");
  const dom = add("react-dom/client");
  const store = add("@/lib/store");
  const leads = leadsPage ? add("@/app/(dashboard)/leads/page") : null;
  const programs = programsSection ? add("@/components/settings/programs-section") : null;
  const provider = preview || layout ? `require(${add("@/app/(dashboard)/layout")}).default` : "StoreProvider";
  return `(()=>{const process={env:{NODE_ENV:${mode === "development" ? '"development"' : '"production"'},NEXT_PUBLIC_PREVIEW_MODE:${preview ? '"true"' : '"false"'}}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react});const {StoreProvider,useStore}=require(${store});function Observer(){const store=useStore();window.fixture.store=store;React.useEffect(()=>{window.fixture.observations.push({role:store.currentRole,ready:store.staffProfilesAvailable,user:store.currentUserId,studio:store.currentStudioId});});return React.createElement('output',null,store.staffProfilesAvailable?'ready':'pending');}window.fixture.root=require(${dom}).createRoot(document.getElementById('root'));window.fixture.root.render(React.createElement(${mode === "development" ? "React.StrictMode" : "React.Fragment"},null,React.createElement(${provider},null,React.createElement(Observer),${leads === null ? "null" : `React.createElement(require(${leads}).default)`},${programs === null ? "null" : `React.createElement(require(${programs}).ProgramsSection)`})));})();`;
}

for (const mode of ["production", "development"]) {
  test(`mounted initialization stays stable after role commit (${mode})`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("http://fixture.local/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
      await page.goto("http://fixture.local/");
      await page.evaluate(() => {
        const listeners = new Set();
        const fixture = window.fixture = {
          requests: [], observations: [], bootstrapWaiters: [], holdBootstrap: false,
          programWaiters: [], holdPrograms: false, scheduleWaiters: [], holdSchedule: false,
          attendanceRows: [], attendanceWaiters: [], holdAttendance: false,
          session: { access_token: "fixture-token-a", user: { id: "user-a", email: "a@example.test", user_metadata: {} } },
          maxListeners: 0, listeners,
        };
        fixture.emit = (event, session) => { fixture.session = session; for (const listener of listeners) listener(event, session); };
        fixture.supabase = { auth: {
          getSession: async () => { const session=fixture.session; await new Promise(resolve => setTimeout(resolve,0)); return {data:{session}}; },
          onAuthStateChange: callback => { listeners.add(callback); queueMicrotask(() => { if (listeners.has(callback)) callback("INITIAL_SESSION", fixture.session); }); fixture.maxListeners = Math.max(fixture.maxListeners,listeners.size); return {data:{subscription:{unsubscribe:()=>listeners.delete(callback)}}}; },
        }};
        fixture.api = {
          get: async (path, token) => {
            fixture.requests.push({path, token});
            if (path === "/dashboard/bootstrap") {
              const session = fixture.session;
              const studioId = fixture.studioOverride ?? `studio-${session.user.id}`;
              if (fixture.holdBootstrap) await new Promise(resolve => fixture.bootstrapWaiters.push(resolve));
              if (fixture.bootstrapError) throw Object.assign(new Error(fixture.bootstrapError.message), {status:fixture.bootstrapError.status});
              return {auth:{membership_status:"active",studio_id:studioId,role:"admin",staff_profiles_available:true,user:session.user},studio_name:`Studio ${session.user.id}`,students:[],programs:[],leads:[],belt_ladders:[],primary_belt_ladder:null,summary:{studio_id:studioId}};
            }
            if (path.startsWith("/schedule/window")) {
              const date = new URL(path, "http://fixture.local").searchParams.get("start_date");
              const snapshot = {sessions:[{id:`session-${date}`,date,name:`Class ${date}`,start_time:"09:00",end_time:"10:00",attendance_count:fixture.attendanceRows.filter(row => row.session_id===`session-${date}`).length}],templates:[],attendance:fixture.attendanceRows.filter(row => row.session_id===`session-${date}`)};
              if (fixture.holdSchedule) await new Promise(resolve => fixture.scheduleWaiters.push(resolve));
              return snapshot;
            }
            if (path.startsWith("/programs")) {
              if (fixture.holdPrograms) await new Promise(resolve => fixture.programWaiters.push(resolve));
              return [];
            }
            throw new Error(`Unexpected request ${path}`);
          },
        };
        fixture.api.post = async (path, body, token) => {
          if (path === "/schedule/attendance") {
            fixture.requests.push({path,token});
            if (fixture.holdAttendance) await new Promise(resolve => fixture.attendanceWaiters.push(resolve));
            const record = {...body,id:"attendance-persisted",studio_id:"fixture-studio",checked_in_at:"2026-09-04T12:00:00Z",is_cross_program:false,counts_toward_eligibility:true};
            fixture.attendanceRows.push(record);
            return record;
          }
          return fixture.api.get(path, token);
        };
      });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addScriptTag({ content: bundle(mode) });
      await page.waitForFunction(() => window.fixture.store?.staffProfilesAvailable === true);
      // Let React flush any effect caused by committing the authoritative role.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const initial = await page.evaluate(() => ({requests:window.fixture.requests,observations:window.fixture.observations, listeners:window.fixture.listeners.size,max:window.fixture.maxListeners}));
      assert.deepEqual(errors, []);
      assert.equal(initial.requests.filter(r => r.path === "/dashboard/bootstrap").length, 1, "role commit must not bootstrap a second time");
      assert.equal(initial.listeners, 1);
      assert.equal(initial.max, 1);
      const firstReady = initial.observations.findIndex(o => o.ready);
      assert.ok(firstReady >= 0);
      assert.ok(initial.observations.slice(firstReady).every(o => o.ready), "role commit cannot reset identity readiness");
      assert.equal(initial.requests.filter(r => r.path.startsWith("/programs")).length, 0, "metadata bootstrap must not globally enrich program usage");
      await page.evaluate(() => fixture.emit("TOKEN_REFRESHED", {...fixture.session,access_token:"fixture-token-renewed"}));
      await page.waitForFunction(() => fixture.store.token === "fixture-token-renewed");
      assert.equal(await page.evaluate(() => fixture.requests.filter(r => r.path === "/dashboard/bootstrap").length), 1);
      await page.evaluate(() => fixture.emit("SIGNED_OUT", null));
      await page.waitForFunction(() => fixture.redirects.includes("/login"));
      await page.waitForFunction(() => fixture.store.currentRole === null && fixture.store.currentStudioId === null);
      await page.evaluate(() => fixture.emit("SIGNED_IN", {access_token:"fixture-token-b",user:{id:"user-b",email:"b@example.test",user_metadata:{}}}));
      await page.waitForFunction(() => fixture.store.currentStudioId === "studio-user-b");
      assert.equal(await page.evaluate(() => fixture.requests.filter(r => r.path === "/dashboard/bootstrap").length), 2);
      await page.evaluate(() => {fixture.holdBootstrap=true;fixture.emit("SIGNED_IN", {access_token:"fixture-token-c",user:{id:"user-c",email:"c@example.test",user_metadata:{}}});});
      await page.waitForFunction(() => fixture.bootstrapWaiters.length === 1);
      await page.evaluate(() => {fixture.holdBootstrap=false;fixture.emit("SIGNED_IN", {access_token:"fixture-token-d",user:{id:"user-d",email:"d@example.test",user_metadata:{}}});});
      await page.waitForFunction(() => fixture.store.currentStudioId === "studio-user-d");
      await page.evaluate(() => {for (const resolve of fixture.bootstrapWaiters) resolve();});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => fixture.store.currentStudioId), "studio-user-d", "superseded bootstrap must never commit");
      // Program usage in flight for a previous identity generation cannot absorb a new read.
      await page.evaluate(() => {
        fixture.holdPrograms = true;
        fixture.oldPrograms = fixture.store.refreshPrograms({includeArchived:true});
      });
      await page.waitForFunction(() => fixture.programWaiters.length === 1);
      await page.evaluate(() => {fixture.studioOverride="studio-changed";fixture.emit("USER_UPDATED", fixture.session);});
      await page.waitForFunction(() => fixture.store.staffProfilesAvailable && fixture.store.currentStudioId === "studio-changed" && !fixture.store.programsUsageLoaded);
      await page.evaluate(() => {
        fixture.newPrograms = fixture.store.refreshPrograms({includeArchived:true});
      });
      await page.waitForFunction(() => fixture.programWaiters.length === 2);
      await page.evaluate(async () => {fixture.programWaiters[0]();await fixture.oldPrograms;});
      assert.equal(await page.evaluate(() => fixture.store.programsUsageLoaded), false);
      await page.evaluate(async () => {fixture.programWaiters[1]();await fixture.newPrograms;});
      await page.waitForFunction(() => fixture.store.programsUsageLoaded);

      // Equivalent window requests share the existing reconciliation owner.
      const windowsBefore = await page.evaluate(() => fixture.requests.filter(r => r.path.startsWith("/schedule/window")).length);
      await page.evaluate(async () => {
        await Promise.all([
          fixture.store.refreshScheduleRange("2026-10-01", "2026-10-07", "materialize"),
          fixture.store.refreshScheduleRange("2026-10-01", "2026-10-07", "materialize"),
        ]);
      });
      assert.equal(await page.evaluate(() => fixture.requests.filter(r => r.path.startsWith("/schedule/window")).length), windowsBefore + 1);
      assert.equal(await page.evaluate(() => fixture.store.sessions.some(s => s.id === "session-2026-10-01")), true);
      await page.evaluate(() => {
        fixture.holdSchedule = true;
        fixture.oldRange = fixture.store.refreshScheduleRange("2026-11-01", "2026-11-07", "materialize").catch(error => error.message);
      });
      await page.waitForFunction(() => fixture.scheduleWaiters.length === 1);
      await page.evaluate(() => {
        fixture.newRange = fixture.store.refreshScheduleRange("2026-12-01", "2026-12-07", "materialize");
        fixture.holdSchedule = false;
        fixture.scheduleWaiters[0]();
      });
      const staleRange = await page.evaluate(async () => {await fixture.newRange;return fixture.oldRange;});
      assert.match(staleRange, /superseded/);
      await page.waitForFunction(() => fixture.store.sessions.some(s => s.id === "session-2026-12-01"));
      assert.equal(await page.evaluate(() => fixture.store.sessions.some(s => s.id === "session-2026-11-01")), false);
      // A range read that began before attendance changed cannot roll back that mutation.
      await page.evaluate(() => {
        fixture.holdSchedule = true;
        fixture.holdAttendance = true;
        fixture.attendanceRaceRange = fixture.store.refreshScheduleRange("2026-12-01", "2026-12-07", "materialize").catch(error => error.message);
      });
      await page.waitForFunction(() => fixture.scheduleWaiters.length === 2);
      await page.evaluate(() => {
        fixture.attendanceMutation = fixture.store.toggleCheckIn("session-2026-12-01", "student-fixture", "Fixture Student");
        fixture.afterAttendanceRange = fixture.store.refreshScheduleRange("2027-01-01", "2027-01-07", "materialize");
      });
      await page.waitForFunction(() => fixture.attendanceWaiters.length === 1);
      await page.evaluate(() => {fixture.holdSchedule=false;fixture.scheduleWaiters[1]();});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => fixture.requests.some(r => r.path.includes("start_date=2027-01-01"))), false, "range waits for attendance mutation settlement");
      await page.evaluate(async () => {
        fixture.attendanceWaiters[0]();
        await Promise.all([fixture.attendanceMutation, fixture.afterAttendanceRange, fixture.attendanceRaceRange]);
      });
      await page.waitForFunction(() => fixture.store.attendance.some(row => row.id === "attendance-persisted"));
      assert.equal(await page.evaluate(() => fixture.store.sessions.some(row => row.id === "session-2027-01-01")), true);
      assert.equal(await page.evaluate(() => fixture.store.sessions.find(row => row.id === "session-2026-12-01")?.attendance_count), 1, "refreshing another window preserves the changed attendance count");
      // Generic outages never fan out into the legacy loading architecture.
      for (const failure of [{status:503,message:"Unavailable"}, {status:404,message:"Business record missing"}, {message:"Request timed out"}]) {
        const before = await page.evaluate(() => fixture.requests.length);
        await page.evaluate(failure => {fixture.bootstrapError=failure;fixture.store.retryInitialization();}, failure);
        await page.waitForFunction(() => Boolean(fixture.store.identityLoadError));
        assert.deepEqual(await page.evaluate(before => fixture.requests.slice(before).map(r => r.path), before), ["/dashboard/bootstrap"]);
        await page.evaluate(() => {fixture.bootstrapError=null;fixture.store.retryInitialization();});
        await page.waitForFunction(() => fixture.store.staffProfilesAvailable && !fixture.store.identityLoadError);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      await page.evaluate(() => fixture.root.unmount());
      assert.equal(await page.evaluate(() => fixture.listeners.size), 0);
    } finally { await browser.close(); }
  });
}

for (const mode of ["production", "development"]) {
  test(`preview hydration opens the real Dashboard layout identity gate (${mode})`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("http://fixture.local/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
      await page.goto("http://fixture.local/");
      await page.evaluate(() => {
        window.fixture = { observations: [], identityObservations: [], supabase: {}, api: {} };
      });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addScriptTag({ content: bundle(mode, {preview:true}) });
      await page.waitForFunction(() => fixture.store?.staffProfilesAvailable, undefined, {timeout:3000});
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(() => [fixture.store.legalFirstName, fixture.store.legalLastName]), ["Demo", "User"]);
      assert.equal(await page.locator('[data-preview-sidebar="ready"]').count(), 1);
      assert.equal(await page.locator('[data-preview-gate]').count(), 0);
      const observations = await page.evaluate(() => fixture.identityObservations);
      assert.equal(observations[0], false, "preview stays neutral before hydration");
      assert.equal(observations.at(-1), true);
      await page.evaluate(() => fixture.store.updateUserLegalName("Preview", "Owner"));
      await page.waitForFunction(() => fixture.store.legalFirstName === "Preview");
      assert.equal(await page.locator('[data-preview-sidebar="ready"]').count(), 1);
      await page.evaluate(() => fixture.root.unmount());
    } finally { await browser.close(); }
  });
}

test("authoritative old-schema identity opens Dashboard without requiring legal-name capability", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("http://fixture.local/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto("http://fixture.local/");
    await page.evaluate(() => {
      const user = {id:"legacy-fixture-user",email:"legacy@example.test",full_name:"Legacy User"};
      const session = {access_token:"legacy-fixture-token",user};
      window.fixture = {observations:[],identityObservations:[],supabase:{auth:{
        getSession:async()=>({data:{session}}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),
      }},api:{get:async(path)=>{
        if(path==="/dashboard/bootstrap") {
          await new Promise(resolve=>{fixture.releaseBootstrap=resolve;});
          return {auth:{user,membership_status:"active",role:"admin",studio_id:"legacy-fixture-studio",staff_profiles_available:false},students:[],programs:[],leads:[],belt_ladders:[],primary_belt_ladder:null,summary:{studio_id:"legacy-fixture-studio"}};
        }
        if(path.startsWith("/schedule/window")) return {sessions:[],templates:[],attendance:[]};
        throw new Error(`Unexpected fixture read ${path}`);
      }}};
    });
    await page.addScriptTag({content:bundle("production", {layout:true})});
    await page.waitForFunction(()=>Boolean(fixture.releaseBootstrap));
    assert.equal(await page.locator('[data-preview-gate="pending"]').count(), 1);
    assert.equal(await page.locator('[data-preview-sidebar="ready"]').count(), 0);
    await page.evaluate(()=>fixture.releaseBootstrap());
    await page.waitForFunction(()=>fixture.store?.identityReady, undefined, {timeout:3000});
    assert.equal(await page.evaluate(()=>fixture.store.staffProfilesAvailable), false);
    assert.equal(await page.locator('[data-preview-gate]').count(), 0);
    assert.equal(await page.locator('[data-preview-sidebar="ready"]').count(), 1);
    await page.evaluate(()=>fixture.root.unmount());
  } finally { await browser.close(); }
});

for (const role of ["admin", "front_desk"]) {
  test(`mounted fresh Leads completes only its accessible datasets (${role})`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("http://fixture.local/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
      await page.goto("http://fixture.local/");
      await page.evaluate((role) => {
        const user = { id: "leads-user", email: "leads@example.test", user_metadata: {} };
        const fixture = window.fixture = { requests: [], observations: [], readiness: [], staffWaiters: [], role, failStaff: true };
        fixture.supabase = { auth: {
          getSession: async () => ({ data: { session: { access_token: "leads-token", user } } }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        } };
        fixture.api = { get: async path => {
          fixture.requests.push(path);
          if (path === "/dashboard/bootstrap") return {
            auth: { membership_status: "active", studio_id: "leads-studio", role, staff_profiles_available: true, user },
            studio_name: "Leads studio", students: [], programs: [], leads: [], belt_ladders: [], primary_belt_ladder: null,
          };
          if (path.startsWith("/schedule/window")) return { sessions: [], templates: [], attendance: [] };
          if (path.startsWith("/staff")) {
            if (role !== "admin") throw new Error("Non-admin staff read is forbidden");
            await new Promise(resolve => fixture.staffWaiters.push(resolve));
            if (fixture.failStaff) throw new Error("Staff request failed");
            return [];
          }
          throw new Error(`Unexpected request ${path}`);
        } };
      }, role);
      await page.addScriptTag({ content: bundle("production", { leadsPage: true }) });
      await page.waitForFunction(() => fixture.readiness.some(state => state.useful));
      if (role === "admin") {
        await page.waitForFunction(() => fixture.staffWaiters.length === 1, null, { timeout: 3000 });
        assert.equal(await page.evaluate(() => fixture.readiness.at(-1).complete), false, "staff cannot block useful lead content, but complete waits for it");
        await page.evaluate(() => fixture.staffWaiters.shift()());
        await page.getByRole("button", { name: "Retry staff assignments" }).waitFor();
        assert.equal(await page.evaluate(() => fixture.readiness.at(-1).complete), false, "staff failure is not complete data");
        await page.evaluate(() => { fixture.failStaff = false; });
        await page.getByRole("button", { name: "Retry staff assignments" }).click();
        await page.waitForFunction(() => fixture.staffWaiters.length === 1);
        await page.evaluate(() => fixture.staffWaiters.shift()());
      }
      await page.waitForFunction(() => fixture.readiness.at(-1)?.complete, null, { timeout: 3000 });
      assert.equal(await page.evaluate(() => fixture.requests.filter(path => path.startsWith("/staff")).length), role === "admin" ? 2 : 0);
    } finally { await browser.close(); }
  });
}

for (const outcome of ["success", "failure"]) {
  test(`mounted route-owned staff, program and summary reads recover after token rotation (${outcome})`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("http://fixture.local/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
      await page.goto("http://fixture.local/");
      await page.evaluate(outcome => {
        const user = { id: "route-user", email: "route@example.test", user_metadata: {} };
        const session = { access_token: "route-old-token", user };
        const fixture = window.fixture = { observations: [], readiness: [], requests: [], waiters: [], listeners: new Set(), session };
        fixture.emit = (event, session) => { fixture.session = session; for (const listener of fixture.listeners) listener(event, session); };
        fixture.supabase = { auth: {
          getSession: async () => ({ data: { session: fixture.session } }),
          onAuthStateChange: callback => { fixture.listeners.add(callback); return { data: { subscription: { unsubscribe: () => fixture.listeners.delete(callback) } } }; },
        } };
        fixture.api = { get: async (path, token) => {
          fixture.requests.push({ path, token });
          if (path === "/dashboard/bootstrap") return {
            auth: { membership_status: "active", studio_id: "route-studio", role: "admin", staff_profiles_available: true, user },
            students: [], programs: [], leads: [], belt_ladders: [], primary_belt_ladder: null,
          };
          if (path.startsWith("/schedule/window")) return { sessions: [], templates: [], attendance: [] };
          if (path.startsWith("/staff") || path.startsWith("/programs") || path === "/dashboard/summary") {
            if (token === "route-old-token") {
              await new Promise(resolve => fixture.waiters.push(resolve));
              if (outcome === "failure") throw new Error("Expired token");
              return path === "/dashboard/summary" ? { auth: { studio_id: "route-studio" }, marker: "obsolete" } : [{ id: "obsolete-row", name: "Obsolete" }];
            }
            return path === "/dashboard/summary" ? { auth: { studio_id: "route-studio" }, marker: "current" } : [];
          }
          throw new Error(`Unexpected request ${path}`);
        } };
      }, outcome);
      await page.addScriptTag({ content: bundle("production", { leadsPage: true, programsSection: true }) });
      await page.waitForFunction(() => fixture.waiters.length === 3);
      const generation = await page.evaluate(() => fixture.store.identityGeneration);
      await page.evaluate(() => {
        fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "route-new-token" });
        for (const resolve of fixture.waiters) resolve();
      });
      await page.waitForFunction(() => fixture.store.staffLoaded && fixture.store.programsUsageLoaded && fixture.store.dashboardSummaryLoaded && fixture.readiness.at(-1)?.complete);
      assert.equal(await page.evaluate(() => fixture.store.identityGeneration), generation, "token rotation must preserve identity and shell");
      assert.deepEqual(await page.evaluate(() => [fixture.store.staffMembers, fixture.store.programs]), [[], []], "obsolete results never commit");
      assert.deepEqual(await page.evaluate(() => [fixture.store.staffLoadError, fixture.store.programsUsageLoadError]), [null, null]);
      assert.equal(await page.evaluate(() => fixture.requests.filter(r => r.path === "/dashboard/bootstrap").length), 1);
      assert.deepEqual(await page.evaluate(() => fixture.requests.filter(r => r.path.startsWith("/staff")).map(r => r.token)), ["route-old-token", "route-new-token"]);
      assert.deepEqual(await page.evaluate(() => fixture.requests.filter(r => r.path.startsWith("/programs")).map(r => r.token)), ["route-old-token", "route-new-token"]);
      assert.equal(await page.evaluate(() => fixture.store.dashboardSummary?.marker), "current");
      assert.deepEqual(await page.evaluate(() => fixture.requests.filter(r => r.path === "/dashboard/summary").map(r => r.token)), ["route-old-token", "route-new-token"]);
      await page.evaluate(() => fixture.root.unmount());
    } finally { await browser.close(); }
  });
}

for (const event of ["INITIAL_SESSION", "SIGNED_OUT"]) {
  test(`mounted Dashboard redirects after null ${event} and discards pending identity reads`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("http://fixture.local/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
      await page.goto("http://fixture.local/");
      await page.evaluate(event => {
        const user = { id: "signed-out-user", email: "out@example.test", user_metadata: {} };
        const session = { access_token: "signed-out-token", user };
        const fixture = window.fixture = { observations: [], identityObservations: [], redirects: [], requests: [], listeners: new Set(), waiters: [] };
        fixture.emit = () => { for (const listener of fixture.listeners) listener(event, null); };
        fixture.supabase = { auth: {
          getSession: async () => { if (event === "INITIAL_SESSION") await new Promise(resolve => fixture.waiters.push(resolve)); return { data: { session } }; },
          onAuthStateChange: callback => { fixture.listeners.add(callback); return { data: { subscription: { unsubscribe: () => fixture.listeners.delete(callback) } } }; },
        } };
        fixture.api = { get: async path => {
          fixture.requests.push(path);
          if (path === "/dashboard/bootstrap") {
            await new Promise(resolve => fixture.waiters.push(resolve));
            return { auth: { membership_status: "active", studio_id: "old-studio", role: "admin", staff_profiles_available: true, user }, students: [], programs: [], leads: [], belt_ladders: [], primary_belt_ladder: null, summary: { studio_id: "old-studio" } };
          }
          throw new Error(`Unexpected request ${path}`);
        } };
      }, event);
      await page.addScriptTag({ content: bundle("production", { layout: true }) });
      await page.waitForFunction(() => fixture.waiters.length === 1);
      await page.evaluate(() => fixture.emit());
      await page.waitForFunction(() => fixture.redirects.includes("/login"), null, { timeout: 3000 });
      await page.evaluate(() => { for (const resolve of fixture.waiters) resolve(); });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('[data-preview-sidebar="ready"]').count(), 0);
      assert.ok((await page.evaluate(() => fixture.identityObservations)).every(ready => !ready));
      if (event === "INITIAL_SESSION") assert.deepEqual(await page.evaluate(() => fixture.requests), []);
      await page.evaluate(() => fixture.root.unmount());
    } finally { await browser.close(); }
  });
}

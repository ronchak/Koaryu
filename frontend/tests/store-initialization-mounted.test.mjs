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
function bundle(mode, { preview = false, layout = false, leadsPage = false, programsSection = false, subscriptionPage = false, scheduleController = false, dashboardController = false, beltPage = false } = {}) {
  if (!["production", "development"].includes(mode) || typeof preview !== "boolean") throw new Error("Unsupported fixture environment");
  const modules = [];
  const ids = new Map();
  const stubs = {
    "next/navigation": `exports.usePathname=()=>'/dashboard'; const router={replace(path){(window.fixture.redirects??=[]).push(path)}}; exports.useRouter=()=>router;`,
    "@/components/loading-screen": `exports.LoadingScreen=()=>null;`,
    "@/lib/supabase/client": `exports.createClient=()=>window.fixture.supabase;`,
    "@/lib/api": `class ApiError extends Error { constructor(message,status,detail){super(message);this.status=status;this.detail=detail;} } exports.ApiError=ApiError; exports.api=window.fixture.api; exports.isSubscriptionRequiredError=e=>e.status===402; exports.isStaffArchivedError=e=>e.status===403&&/archived/i.test(e.message);`,
    "@/lib/performance": `exports.markPerformance=name=>{window.fixture.marks?.push(name);};exports.measurePerformance=()=>{};exports.markDashboardReadiness=(route,generation,state)=>{window.fixture.readiness?.push(state);return ()=>{};};`,
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
    ...(subscriptionPage ? {
      "@/components/header": `exports.Header=()=>null;`,
      "@/components/operations/operations-surface": `exports.OperationsSurface=({children})=>require('react').createElement('section',{'data-recovery-page':'true'},children);`,
      "@/components/ui/button": `exports.Button=({children,onClick,disabled})=>require('react').createElement('button',{onClick,disabled},children);`,
      "@/components/logo": `exports.Logo=()=>null;`,
      "@/components/dashboard-loading-skeleton": `exports.DashboardLoadingSkeleton=()=>require('react').createElement('div',{'data-preview-gate':'pending'});`,
      "./dashboard-shell.module.css": `module.exports={};`,
      "lucide-react": `for (const name of ['ArrowUpRight','CheckCircle2','CreditCard','Loader2','ShieldCheck']) exports[name]=()=>null;`,
    } : {}),
    ...(beltPage ? {
      "@/components/belt-tracker/belt-tracker-dialogs": `exports.BeltTrackerDialogs=()=>null;`,
      "@/components/belt-tracker/belt-tracker-shell": `exports.BeltTrackerShell=({children})=>children;`,
      "@/components/belt-tracker/eligibility-panel": `exports.EligibilityPanel=()=>null;`,
      "@/components/belt-tracker/rank-plan-panel": `exports.RankPlanPanel=()=>null;`,
      "@/lib/belt-tracker-page-controller": `exports.useBeltTrackerPageController=()=>({shellProps:{},eligibilityPanelProps:{},rankPlanPanelProps:{},dialogsProps:{},tab:'eligibility'});`,
    } : {}),
    ...(preview || layout ? {
      "@/components/dashboard-shell.module.css": `module.exports={};`,
      "@/components/theme-provider": `exports.useTheme=()=>({navigationPlacement:'side'});`,
      "@/components/dashboard-route-transition": `exports.DashboardRouteTransition=({children})=>children;`,
      "@/components/dashboard-shell": `exports.DashboardSlugBand=()=>null;`,
      "@/components/dashboard-shell-readiness": `exports.DashboardShellReadiness=({identityReady})=>{window.fixture.store=require("@/lib/store").useStore();window.fixture.identityObservations.push(identityReady);return null;};`,
      ...(subscriptionPage ? {} : {
        "@/components/dashboard-identity-skeleton": `exports.DashboardIdentitySkeleton=()=>require('react').createElement('div',{'data-preview-gate':'pending'});`,
      }),
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
  const subscription = subscriptionPage ? add("@/app/(dashboard)/subscription-required/page") : null;
  const schedule = scheduleController ? add("@/lib/schedule-page-controller") : null;
  const scheduleObserver = schedule === null ? "" : `function ScheduleObserver(){const store=useStore();const controller=require(${schedule}).useSchedulePageController({config:store,programsStore:store,scheduleStore:store,studentsStore:store});window.fixture.controller=controller.contentProps;return React.createElement('output',{'data-schedule-state':controller.contentProps.hasLoadedRange?'ready':controller.contentProps.scheduleLoadError?'error':'loading'});}function ScheduleMount(){const [mounted,setMounted]=React.useState(false);window.fixture.mountSchedule=()=>setMounted(true);window.fixture.unmountSchedule=()=>setMounted(false);return mounted?React.createElement(ScheduleObserver):null;}`;
  const dashboard = dashboardController ? add("@/lib/dashboard-page-controller") : null;
  const belt = beltPage ? add("@/app/(dashboard)/belt-tracker/page") : null;
  const dashboardObserver = dashboard === null ? "" : `function DashboardObserver(){const store=useStore();window.fixture.dashboard=require(${dashboard}).useDashboardPageController({config:store,beltStore:store,dashboardStore:store,leadStore:store,programsStore:store,scheduleStore:store,studentsStore:store,studioStore:store}).contentProps;return null;}`;
  const provider = preview || layout ? `require(${add("@/app/(dashboard)/layout")}).default` : "StoreProvider";
  return `(()=>{const process={env:{NODE_ENV:${mode === "development" ? '"development"' : '"production"'},NEXT_PUBLIC_PREVIEW_MODE:${preview ? '"true"' : '"false"'}}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react});const {StoreProvider,useStore}=require(${store});${scheduleObserver}${dashboardObserver}function Observer(){const store=useStore();window.fixture.store=store;React.useEffect(()=>{window.fixture.observations.push({role:store.currentRole,ready:store.staffProfilesAvailable,user:store.currentUserId,studio:store.currentStudioId});});return React.createElement('output',null,store.staffProfilesAvailable?'ready':'pending');}window.fixture.root=require(${dom}).createRoot(document.getElementById('root'));window.fixture.root.render(React.createElement(${mode === "development" ? "React.StrictMode" : "React.Fragment"},null,React.createElement(${provider},null,React.createElement(Observer),${leads === null ? "null" : `React.createElement(require(${leads}).default)`},${programs === null ? "null" : `React.createElement(require(${programs}).ProgramsSection)`},${subscription === null ? "null" : `React.createElement(require(${subscription}).default)`},${schedule === null ? "null" : "React.createElement(ScheduleMount)"},${dashboard === null ? "null" : "React.createElement(DashboardObserver)"},${belt === null ? "null" : `React.createElement(require(${belt}).default)`})));})();`;
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
            if (path === "/dashboard/bootstrap?allow_partial=true") {
              const session = fixture.session;
              const studioId = fixture.studioOverride ?? `studio-${session.user.id}`;
              if (fixture.holdBootstrap) await new Promise(resolve => fixture.bootstrapWaiters.push(resolve));
              if (fixture.bootstrapError) throw Object.assign(new Error(fixture.bootstrapError.message), {status:fixture.bootstrapError.status});
              return {auth:{membership_status:"active",studio_id:studioId,role:"admin",staff_profiles_available:true,user:session.user},studio_name:`Studio ${session.user.id}`,students:[],programs:[],leads:[],belt_ladders:[],primary_belt_ladder:null,summary:{studio_id:studioId}};
            }
            if (path.startsWith("/schedule/window")) {
              const date = new URL(path, "http://fixture.local").searchParams.get("start_date");
              const snapshot = {sessions:[{id:`session-${date}`,date,name:`Class ${date} ${token}`,start_time:"09:00",end_time:"10:00",attendance_count:fixture.attendanceRows.filter(row => row.session_id===`session-${date}`).length}],templates:[],attendance:fixture.attendanceRows.filter(row => row.session_id===`session-${date}`)};
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
      await page.addScriptTag({ content: bundle(mode, {scheduleController:true}) });
      await page.waitForFunction(() => window.fixture.store?.staffProfilesAvailable === true);
      // Let React flush any effect caused by committing the authoritative role.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const initial = await page.evaluate(() => ({requests:window.fixture.requests,observations:window.fixture.observations, listeners:window.fixture.listeners.size,max:window.fixture.maxListeners}));
      assert.deepEqual(errors, []);
      assert.equal(initial.requests.filter(r => r.path === "/dashboard/bootstrap?allow_partial=true").length, 1, "role commit must not bootstrap a second time");
      assert.equal(initial.listeners, 1);
      assert.equal(initial.max, 1);
      const firstReady = initial.observations.findIndex(o => o.ready);
      assert.ok(firstReady >= 0);
      assert.ok(initial.observations.slice(firstReady).every(o => o.ready), "role commit cannot reset identity readiness");
      assert.equal(initial.requests.filter(r => r.path.startsWith("/programs")).length, 0, "metadata bootstrap must not globally enrich program usage");
      await page.evaluate(() => fixture.emit("TOKEN_REFRESHED", {...fixture.session,access_token:"fixture-token-renewed"}));
      await page.waitForFunction(() => fixture.store.token === "fixture-token-renewed");
      assert.equal(await page.evaluate(() => fixture.requests.filter(r => r.path === "/dashboard/bootstrap?allow_partial=true").length), 1);
      await page.evaluate(() => fixture.emit("SIGNED_OUT", null));
      await page.waitForFunction(() => fixture.redirects.includes("/login"));
      await page.waitForFunction(() => fixture.store.currentRole === null && fixture.store.currentStudioId === null);
      await page.evaluate(() => fixture.emit("SIGNED_IN", {access_token:"fixture-token-b",user:{id:"user-b",email:"b@example.test",user_metadata:{}}}));
      await page.waitForFunction(() => fixture.store.currentStudioId === "studio-user-b");
      assert.equal(await page.evaluate(() => fixture.requests.filter(r => r.path === "/dashboard/bootstrap?allow_partial=true").length), 2);
      await page.evaluate(() => {fixture.holdBootstrap=true;fixture.emit("SIGNED_IN", {access_token:"fixture-token-c",user:{id:"user-c",email:"c@example.test",user_metadata:{}}});});
      await page.waitForFunction(() => fixture.bootstrapWaiters.length === 1);
      await page.evaluate(() => {fixture.holdBootstrap=false;fixture.emit("SIGNED_IN", {access_token:"fixture-token-d",user:{id:"user-d",email:"d@example.test",user_metadata:{}}});});
      await page.waitForFunction(() => fixture.store.currentStudioId === "studio-user-d");
      assert.equal(await page.evaluate(() => fixture.store.leadsLoaded), true, "a fresh identity scope still accepts its initial lead snapshot");
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
      // The actual calendar controller must accept its initial range after renewal.
      await page.evaluate(() => {
        fixture.scheduleWaiters = [];
        fixture.holdSchedule = true;
        fixture.mountSchedule();
      });
      await page.waitForFunction(() => fixture.scheduleWaiters.length === 1);
      assert.equal(await page.locator('[data-schedule-state="loading"]').count(), 1);
      await page.evaluate(() => {
        fixture.emit("TOKEN_REFRESHED", {...fixture.session,access_token:"calendar-initial-renewal"});
        fixture.holdSchedule = false;
        fixture.scheduleWaiters[0]();
      });
      await page.waitForFunction(() => fixture.controller.hasLoadedRange && !fixture.controller.isRefreshingRange, undefined, {timeout:3000});
      assert.equal(await page.locator('[data-schedule-state="ready"]').count(), 1);
      assert.equal(await page.evaluate(() => fixture.controller.scheduleLoadError), null);
      assert.equal(await page.evaluate(() => fixture.requests.at(-1).path.startsWith("/schedule/window/materialize") && fixture.requests.at(-1).token === "calendar-initial-renewal"), true, "renewal preserves calendar materialization intent");

      // Navigation, token renewal, and a pending attendance write share one queue.
      const attendanceWritesBefore = await page.evaluate(() => fixture.requests.filter(r => r.path === "/schedule/attendance").length);
      await page.evaluate(() => {
        fixture.scheduleWaiters = [];
        fixture.attendanceWaiters = [];
        fixture.holdSchedule = true;
        fixture.holdAttendance = true;
        fixture.controller.onNavigate(1);
      });
      await page.waitForFunction(() => fixture.scheduleWaiters.length === 1);
      const navigationDate = await page.evaluate(() => new URL(fixture.requests.at(-1).path, "http://fixture.local").searchParams.get("start_date"));
      await page.evaluate(date => {
        fixture.renewalAttendance = fixture.store.toggleCheckIn(`session-${date}`, "renewal-student", "Renewal Student");
        fixture.emit("TOKEN_REFRESHED", {...fixture.session,access_token:"calendar-navigation-renewal"});
        fixture.holdSchedule = false;
        fixture.scheduleWaiters[0]();
      }, navigationDate);
      await page.waitForFunction(() => fixture.attendanceWaiters.length === 1);
      const pendingWindowCount = await page.evaluate(() => fixture.requests.filter(r => r.path.startsWith("/schedule/window")).length);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => fixture.controller.hasLoadedRange), false, "an unsettled attendance write cannot open the range");
      assert.equal(await page.evaluate(() => fixture.requests.filter(r => r.path.startsWith("/schedule/window")).length), pendingWindowCount);
      await page.evaluate(async () => { fixture.holdAttendance = false; fixture.attendanceWaiters[0](); await fixture.renewalAttendance; });
      await page.waitForFunction(() => fixture.controller.hasLoadedRange && !fixture.controller.isRefreshingRange, undefined, {timeout:3000});
      assert.deepEqual(await page.evaluate(date => {
        const session = fixture.store.sessions.find(row => row.id === `session-${date}`);
        return [session.attendance_count, session.name, fixture.controller.scheduleLoadError];
      }, navigationDate), [1, `Class ${navigationDate} calendar-navigation-renewal`, null]);
      assert.equal(await page.evaluate(() => fixture.requests.filter(r => r.path === "/schedule/attendance").length), attendanceWritesBefore + 1, "attendance writes are never replayed after token renewal");

      // Renewing auth cannot let an older caller claim a newly selected window.
      await page.evaluate(() => {
        fixture.scheduleWaiters = [];
        fixture.holdSchedule = true;
        fixture.controller.onNavigate(1);
      });
      await page.waitForFunction(() => fixture.scheduleWaiters.length === 1);
      const abandonedDate = await page.evaluate(() => new URL(fixture.requests.at(-1).path, "http://fixture.local").searchParams.get("start_date"));
      await page.evaluate(() => {
        fixture.emit("TOKEN_REFRESHED", {...fixture.session,access_token:"calendar-new-range-renewal"});
        fixture.controller.onNavigate(1);
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(() => { fixture.holdSchedule = false; fixture.scheduleWaiters[0](); });
      await page.waitForFunction(() => fixture.controller.hasLoadedRange && !fixture.controller.isRefreshingRange, undefined, {timeout:3000});
      assert.equal(await page.evaluate(date => fixture.store.sessions.some(row => row.date === date), abandonedDate), false, "the abandoned transport snapshot cannot replace the latest selected range");
      assert.equal(await page.evaluate(() => fixture.controller.scheduleLoadError), null);
      await page.evaluate(() => fixture.unmountSchedule());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

      // Repeated token changes exhaust the caller's bounded retry budget.
      await page.evaluate(() => {
        fixture.renewalAttempts = 0;
        fixture.originalScheduleGet = fixture.api.get;
        fixture.api.get = async (path, token) => {
          if (path.startsWith("/schedule/window/materialize") && fixture.renewalAttempts < 3) {
            fixture.renewalAttempts += 1;
            fixture.emit("TOKEN_REFRESHED", {...fixture.session,access_token:`bounded-renewal-${fixture.renewalAttempts}`});
          }
          return fixture.originalScheduleGet(path, token);
        };
        fixture.store.refreshScheduleRange("2028-01-01", "2028-01-07", "materialize").then(
          () => { fixture.boundedRangeResult = "unexpected success"; },
          error => { fixture.boundedRangeResult = error.message; }
        );
      });
      await page.waitForFunction(() => fixture.boundedRangeResult, undefined, {timeout:3000});
      assert.match(await page.evaluate(() => fixture.boundedRangeResult), /superseded/);
      assert.equal(await page.evaluate(() => fixture.renewalAttempts), 3);
      await page.evaluate(() => { fixture.api.get = fixture.originalScheduleGet; });
      await page.evaluate(() => {
        fixture.scheduleWaiters = [];
        fixture.holdSchedule = true;
        fixture.store.refreshScheduleRange("2029-01-01", "2029-01-07", "materialize").then(
          () => { fixture.oldIdentityRangeResult = "unexpected success"; },
          error => { fixture.oldIdentityRangeResult = error.message; }
        );
      });
      await page.waitForFunction(() => fixture.scheduleWaiters.length === 1);
      await page.evaluate(() => {
        fixture.emit("TOKEN_REFRESHED", {...fixture.session,access_token:"calendar-before-identity-change"});
        fixture.studioOverride = "studio-calendar-replacement";
        fixture.emit("USER_UPDATED", fixture.session);
      });
      await page.waitForFunction(() => fixture.store.staffProfilesAvailable && fixture.store.currentStudioId === "studio-calendar-replacement");
      await page.evaluate(() => { fixture.holdSchedule = false; fixture.scheduleWaiters[0](); });
      await page.waitForFunction(() => fixture.oldIdentityRangeResult, undefined, {timeout:3000});
      assert.match(await page.evaluate(() => fixture.oldIdentityRangeResult), /superseded/);
      assert.equal(await page.evaluate(() => fixture.store.sessions.some(row => row.date === "2029-01-01")), false, "token renewal never authorizes a caller to survive a studio identity reset");
      // Generic outages never fan out into the legacy loading architecture.
      for (const failure of [{status:503,message:"Unavailable"}, {status:404,message:"Business record missing"}, {message:"Request timed out"}]) {
        const before = await page.evaluate(() => fixture.requests.length);
        await page.evaluate(failure => {fixture.bootstrapError=failure;fixture.store.retryInitialization();}, failure);
        await page.waitForFunction(() => Boolean(fixture.store.identityLoadError));
        assert.deepEqual(await page.evaluate(before => fixture.requests.slice(before).map(r => r.path), before), ["/dashboard/bootstrap?allow_partial=true"]);
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
        if(path==="/dashboard/bootstrap?allow_partial=true") {
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
          if (path === "/dashboard/bootstrap?allow_partial=true") return {
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
        const fixture = window.fixture = { observations: [], readiness: [], marks: [], requests: [], waiters: [], listeners: new Set(), session };
        fixture.emit = (event, session) => { fixture.session = session; for (const listener of fixture.listeners) listener(event, session); };
        fixture.supabase = { auth: {
          getSession: async () => ({ data: { session: fixture.session } }),
          onAuthStateChange: callback => { fixture.listeners.add(callback); return { data: { subscription: { unsubscribe: () => fixture.listeners.delete(callback) } } }; },
        } };
        fixture.api = { get: async (path, token) => {
          fixture.requests.push({ path, token });
          if (path === "/dashboard/bootstrap?allow_partial=true") return {
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
      assert.equal(await page.evaluate(() => fixture.requests.filter(r => r.path === "/dashboard/bootstrap?allow_partial=true").length), 1);
      assert.deepEqual(await page.evaluate(() => fixture.requests.filter(r => r.path.startsWith("/staff")).map(r => r.token)), ["route-old-token", "route-new-token"]);
      assert.deepEqual(await page.evaluate(() => fixture.requests.filter(r => r.path.startsWith("/programs")).map(r => r.token)), ["route-old-token", "route-new-token"]);
      assert.equal(await page.evaluate(() => fixture.store.dashboardSummary?.marker), "current");
      assert.equal(await page.evaluate(() => fixture.marks.filter(name => name === "dashboard.summary_started").length), 1, "summary timing includes every auth replay");
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
        const fixture = window.fixture = { observations: [], identityObservations: [], redirects: [], requests: [], listeners: new Set(), waiters: [], sessionReads: 0 };
        fixture.emit = () => { for (const listener of fixture.listeners) listener(event, null); };
        fixture.supabase = { auth: {
          getSession: async () => { fixture.sessionReads += 1; if (event === "INITIAL_SESSION") { if (fixture.sessionReads > 1) return { data: { session: null }, error: null }; await new Promise(resolve => fixture.waiters.push(resolve)); } return { data: { session }, error: null }; },
          onAuthStateChange: callback => { fixture.listeners.add(callback); return { data: { subscription: { unsubscribe: () => fixture.listeners.delete(callback) } } }; },
        } };
        fixture.api = { get: async path => {
          fixture.requests.push(path);
          if (path === "/dashboard/bootstrap?allow_partial=true") {
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

for (const legalNamePresent of [true, false]) {
  test(`subscription denial preserves verified identity and legal-name constraints (${legalNamePresent})`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("http://fixture.local/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
      await page.goto("http://fixture.local/");
      await page.evaluate(legalNamePresent => {
        const user = { id: "recovery-user", email: "recovery@example.test", legal_first_name: legalNamePresent ? "Recovery" : null, legal_last_name: legalNamePresent ? "User" : null };
        const session = { access_token: "recovery-token", user };
        const profile = { user, membership_status: "active", studio_id: "recovery-studio", role: "admin", staff_profiles_available: true };
        const fixture = window.fixture = { observations: [], identityObservations: [], requests: [], waiters: [] };
        fixture.supabase = { auth: {
          getSession: async () => ({ data: { session } }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        } };
        fixture.api = { get: async path => {
          fixture.requests.push(path);
          if (path === "/dashboard/bootstrap?allow_partial=true") return { auth: profile, students: [], programs: [], leads: [], belt_ladders: [], primary_belt_ladder: null, summary: { auth: profile } };
          if (path.startsWith("/schedule/window")) return { sessions: [], templates: [], attendance: [] };
          if (path === "/auth/me") return profile;
          if (path === "/platform-billing/status") return { status: "canceled", comped: false, monthly_price_cents: 2700, currency: "usd" };
          if (path === "/billing/system/status") return { mutation_capabilities: { core_subscription: true } };
          if (path.startsWith("/staff") || path.startsWith("/programs")) {
            await new Promise(resolve => fixture.waiters.push(resolve));
            return [{ id: "late-obsolete-data", name: "Obsolete" }];
          }
          throw new Error(`Unexpected request ${path}`);
        } };
      }, legalNamePresent);
      await page.addScriptTag({ content: bundle("production", { layout: true, subscriptionPage: true }) });
      await page.waitForFunction(() => fixture.store?.identityReady);
      await page.evaluate(() => { fixture.staffRead = fixture.store.refreshStaff(); fixture.programRead = fixture.store.refreshPrograms(); });
      await page.waitForFunction(() => fixture.waiters.length === 2);
      await page.evaluate(() => fixture.store.markSubscriptionRequired());
      await page.waitForFunction(() => fixture.redirects?.includes("/subscription-required"));
      assert.deepEqual(await page.evaluate(() => [fixture.store.identityReady, fixture.store.staffProfilesAvailable, fixture.store.currentRole]), [true, true, "admin"]);
      assert.equal(await page.locator('[data-preview-gate="pending"]').count(), 0);
      if (legalNamePresent) {
        await page.locator('[data-recovery-page="true"]').waitFor();
        assert.equal(await page.locator('[data-preview-sidebar="ready"]').count(), 1);
      } else {
        assert.equal(await page.locator('[data-preview-gate="legal-name"]').count(), 1);
        assert.equal(await page.locator('[data-recovery-page="true"]').count(), 0);
      }
      await page.evaluate(async () => { for (const resolve of fixture.waiters) resolve(); await Promise.all([fixture.staffRead, fixture.programRead]); });
      assert.deepEqual(await page.evaluate(() => [fixture.store.staffMembers, fixture.store.programs]), [[], []]);
      assert.equal(await page.evaluate(() => fixture.requests.filter(path => path.startsWith("/staff") || path.startsWith("/programs")).length), 2, "revoked reads cannot replay or commit");
      await page.evaluate(() => fixture.root.unmount());
    } finally { await browser.close(); }
  });
}

test("unknown identity after bootstrap402 renders a retryable error and recovers after profile verification", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("http://fixture.local/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto("http://fixture.local/");
    await page.evaluate(() => {
      const user = { id: "unknown-recovery-user", email: "unknown@example.test", legal_first_name: "Verified", legal_last_name: "User" };
      const session = { access_token: "unknown-recovery-token", user };
      const profile = { user, membership_status: "active", studio_id: "unknown-recovery-studio", role: "admin", staff_profiles_available: true };
      const fixture = window.fixture = { observations: [], identityObservations: [], requests: [], failProfile: true };
      fixture.supabase = { auth: {
        getSession: async () => ({ data: { session } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      } };
      fixture.api = { get: async path => {
        fixture.requests.push(path);
        if (path === "/dashboard/bootstrap?allow_partial=true") throw Object.assign(new Error("Subscription required"), { status: 402 });
        if (path === "/auth/me") { if (fixture.failProfile) throw new Error("Profile unavailable"); return profile; }
        if (path === "/platform-billing/status") return { status: "canceled", comped: false, monthly_price_cents: 2700, currency: "usd" };
        if (path === "/billing/system/status") return { mutation_capabilities: { core_subscription: true } };
        throw new Error(`Unexpected request ${path}`);
      } };
    });
    await page.addScriptTag({ content: bundle("production", { layout: true, subscriptionPage: true }) });
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").textContent(), /account and studio access could not be verified/);
    assert.equal(await page.evaluate(() => fixture.store.identityReady), false);
    assert.equal(await page.locator('[data-recovery-page="true"]').count(), 0);
    assert.equal(await page.locator('[data-preview-sidebar="ready"]').count(), 0);
    await page.evaluate(() => { fixture.failProfile = false; });
    await page.getByRole("button", { name: "Retry workspace" }).click();
    await page.locator('[data-recovery-page="true"]').waitFor();
    assert.equal(await page.evaluate(() => fixture.store.identityReady), true);
    assert.equal(await page.evaluate(() => fixture.store.identityLoadError), null);
    assert.equal(await page.evaluate(() => fixture.requests.filter(path => path === "/dashboard/bootstrap?allow_partial=true").length), 2);
    await page.evaluate(() => fixture.root.unmount());
  } finally { await browser.close(); }
});

for (const sessionFailure of ["returned", "thrown"]) {
  test(`SDK session refresh outage stays retryable despite null INITIAL_SESSION (${sessionFailure})`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("http://fixture.local/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
      await page.goto("http://fixture.local/");
      await page.evaluate(sessionFailure => {
        const user = { id: "refresh-outage-user", email: "refresh@example.test", legal_first_name: "Refresh", legal_last_name: "User" };
        const session = { access_token: "refresh-outage-token", user };
        const profile = { user, membership_status: "active", studio_id: "refresh-outage-studio", role: "admin", staff_profiles_available: true };
        const fixture = window.fixture = { observations: [], identityObservations: [], requests: [], listeners: new Set(), failSession: true, sessionReads: 0 };
        document.cookie = "koaryu-active-studio=refresh-outage-studio; path=/";
        localStorage.setItem("fixture-sdk-session", "retained");
        fixture.supabase = { auth: {
          getSession: async () => {
            fixture.sessionReads += 1;
            if (fixture.failSession) {
              const error = Object.assign(new Error("Refresh service unavailable"), { name: "AuthRetryableFetchError", status: 503 });
              if (sessionFailure === "thrown") throw error;
              return { data: { session: null }, error };
            }
            return { data: { session }, error: null };
          },
          onAuthStateChange: callback => {
            fixture.listeners.add(callback);
            // auth-js _emitInitialSession reports null on __loadSession errors,
            // while retryable refresh failures retain the stored SDK session.
            queueMicrotask(() => { if (fixture.listeners.has(callback) && (sessionFailure === "returned" || !fixture.failSession)) callback("INITIAL_SESSION", fixture.failSession ? null : session); });
            return { data: { subscription: { unsubscribe: () => fixture.listeners.delete(callback) } } };
          },
        } };
        fixture.api = { get: async path => {
          fixture.requests.push(path);
          if (path === "/dashboard/bootstrap?allow_partial=true") return { auth: profile, students: [], programs: [], leads: [], belt_ladders: [], primary_belt_ladder: null, summary: { auth: profile } };
          if (path.startsWith("/schedule/window")) return { sessions: [], templates: [], attendance: [] };
          if (path === "/auth/me") return profile;
          if (path === "/platform-billing/status") return { status: "canceled", comped: false, monthly_price_cents: 2700, currency: "usd" };
          if (path === "/billing/system/status") return { mutation_capabilities: { core_subscription: true } };
          throw new Error(`Unexpected request ${path}`);
        } };
      }, sessionFailure);
      await page.addScriptTag({ content: bundle("production", { layout: true, subscriptionPage: true }) });
      await page.getByRole("alert").waitFor();
      assert.match(await page.getByRole("alert").textContent(), /session could not be checked/);
      assert.equal(await page.evaluate(() => fixture.store.identityReady), false);
      assert.equal(await page.locator('[data-preview-sidebar="ready"]').count(), 0);
      assert.deepEqual(await page.evaluate(() => fixture.redirects ?? []), [], "a retryable session error is not sign-out");
      assert.deepEqual(await page.evaluate(() => fixture.requests), [], "unverified identity must not fetch protected datasets");
      assert.equal(await page.evaluate(() => fixture.sessionReads), sessionFailure === "returned" ? 2 : 1, "only null INITIAL_SESSION requires one bounded confirmation probe");
      assert.equal(await page.evaluate(() => localStorage.getItem("fixture-sdk-session")), "retained");
      assert.match(await page.evaluate(() => document.cookie), /koaryu-active-studio=refresh-outage-studio/);
      await page.evaluate(() => { fixture.failSession = false; });
      await page.getByRole("button", { name: "Retry workspace" }).click();
      await page.locator('[data-preview-sidebar="ready"]').waitFor({ state: "attached" });
      assert.equal(await page.evaluate(() => fixture.store.identityReady), true);
      assert.equal(await page.evaluate(() => fixture.store.identityLoadError), null);
      assert.equal(await page.evaluate(() => fixture.requests.filter(path => path === "/dashboard/bootstrap?allow_partial=true").length), 1);
      await page.evaluate(() => { fixture.failSession = true; fixture.store.retryInitialization(); });
      await page.getByRole("alert").waitFor();
      assert.deepEqual(await page.evaluate(() => [fixture.store.identityReady, fixture.store.currentUserId, fixture.store.token]), [false, "", null], "an outage on recheck hides the prior identity and invalidates app requests");
      assert.equal(await page.locator('[data-preview-sidebar="ready"]').count(), 0);
      assert.deepEqual(await page.evaluate(() => fixture.redirects ?? []), []);
      assert.equal(await page.evaluate(() => localStorage.getItem("fixture-sdk-session")), "retained");
      assert.match(await page.evaluate(() => document.cookie), /koaryu-active-studio=refresh-outage-studio/);
      await page.evaluate(() => fixture.root.unmount());
    } finally { await browser.close(); }
  });
}

for (const failedDataset of ["leads", "students", "programs", "belts", "studio"]) {
  test(`partial bootstrap keeps useful routes open when ${failedDataset} fails`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("http://fixture.local/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
      await page.goto("http://fixture.local/");
      await page.evaluate(failedDataset => {
        const user = { id: "partial-user", email: "partial@example.test", legal_first_name: "Partial", legal_last_name: "User" };
        const session = { access_token: "partial-token", user };
        const profile = { user, membership_status: "active", studio_id: "partial-studio", role: "admin", staff_profiles_available: true };
        const student = { id: "healthy-student", legal_first_name: "Healthy", legal_last_name: "Student", status: "active", tags: [], created_at: "2026-09-01", updated_at: "2026-09-01", program_memberships: [] };
        const fixture = window.fixture = { observations: [], identityObservations: [], requests: [], failedDataset, programsRetryFails: true };
        fixture.supabase = { auth: {
          getSession: async () => ({ data: { session }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        } };
        fixture.api = { get: async path => {
          fixture.requests.push(path);
          if (path === "/dashboard/bootstrap?allow_partial=true") return {
            auth: profile, studio_name: fixture.failedDataset === "studio" ? null : "Healthy studio",
            students: fixture.failedDataset === "students" ? [] : [student],
            students_total: fixture.failedDataset === "students" ? null : 1,
            students_may_be_partial: fixture.failedDataset === "students",
            programs: fixture.failedDataset === "programs" ? [] : [{ id: "healthy-program", name: "Healthy program", sort_order: 0, is_system: false }],
            leads: [], belt_ladders: [], primary_belt_ladder: null,
            dataset_errors: fixture.failedDataset ? { [fixture.failedDataset]: `${fixture.failedDataset} projection failed. Please retry.` } : {},
          };
          if (path === "/dashboard/summary") throw new Error("Summary unavailable");
          if (path.startsWith("/schedule/window")) return { sessions: [], templates: [], attendance: [] };
          if (path.startsWith("/programs?")) {
            if (fixture.programsRetryFails) throw new Error("Programs retry unavailable");
            return [{ id: "healthy-program", name: "Healthy program", sort_order: 0, is_system: false }];
          }
          throw new Error(`Unexpected dataset fallback ${path}`);
        } };
      }, failedDataset);
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addScriptTag({ content: bundle("production", { layout: true, dashboardController: true, beltPage: failedDataset === "belts" || failedDataset === "programs" }) });
      await page.waitForFunction(() => fixture.dashboard && fixture.store.dashboardSummaryLoaded);
      assert.deepEqual(errors, []);
      assert.equal(await page.locator('[data-preview-sidebar="ready"]').count(), 1);
      assert.equal(await page.evaluate(() => fixture.store.identityReady), true);
      assert.equal(await page.evaluate(() => fixture.store.identityLoadError), null);
      assert.equal(await page.evaluate(() => fixture.dashboard.isInitialDashboardLoading), false);
      assert.equal(await page.evaluate(() => fixture.store.studentsLoaded), failedDataset !== "students");
      assert.equal(await page.evaluate(() => fixture.store.leadsLoaded), failedDataset !== "leads");
      assert.equal(await page.evaluate(() => fixture.store.programsLoaded), failedDataset !== "programs");
      assert.deepEqual(await page.evaluate(() => fixture.requests.filter(path => !path.startsWith("/schedule/window")).sort()), ["/dashboard/bootstrap?allow_partial=true", "/dashboard/summary"], "a partial response cannot trigger legacy dataset fan-out");
      if (failedDataset === "students") {
        assert.equal(await page.evaluate(() => fixture.dashboard.widgetViewModels.student_pulse.state), "error");
        assert.equal(await page.evaluate(() => fixture.dashboard.widgetViewModels.student_pulse.metric), undefined, "failed roster is not zero active students");
      } else {
        assert.equal(await page.evaluate(() => fixture.dashboard.widgetViewModels.student_pulse.metric), "1");
      }
      if (failedDataset === "leads") {
        assert.equal(await page.evaluate(() => fixture.dashboard.widgetViewModels.lead_follow_ups.state), "error");
        assert.equal(await page.evaluate(() => fixture.dashboard.widgetViewModels.lead_follow_ups.metric), undefined);
      }
      if (failedDataset === "belts" || failedDataset === "programs") {
        await page.getByRole("button", { name: "Retry belt plans" }).waitFor();
      }
      if (failedDataset === "belts") {
        assert.equal(await page.evaluate(() => fixture.dashboard.widgetViewModels.promotions_due.state), "error");
        assert.equal(await page.evaluate(() => fixture.dashboard.widgetViewModels.promotions_due.metric), undefined);
        assert.equal(await page.evaluate(() => fixture.dashboard.widgetViewModels.setup_progress.state), "error");
      }
      if (failedDataset === "studio") {
        assert.equal(await page.evaluate(() => fixture.store.studioName), "");
        await page.getByRole("button", { name: "Retry studio details" }).waitFor();
      }
      if (failedDataset === "programs" || failedDataset === "leads") {
        await page.evaluate(() => fixture.store.refreshPrograms().catch(() => undefined));
        assert.equal(await page.evaluate(() => fixture.store.programsLoadError), failedDataset === "programs" ? "Programs retry unavailable" : null);
        assert.equal(await page.evaluate(() => fixture.store.programsUsageLoadError), "Programs retry unavailable");
        assert.equal(await page.evaluate(() => fixture.store.programsLoaded), failedDataset !== "programs");
        assert.equal(await page.getByRole("button", { name: "Retry programs", exact: true }).count(), failedDataset === "programs" ? 1 : 0, "usage-only failures stay out of the global metadata warning");
        if (failedDataset === "programs") {
          await page.evaluate(() => { fixture.programsRetryFails = false; });
          await page.getByRole("button", { name: "Retry programs", exact: true }).click();
          await page.waitForFunction(() => fixture.store.programsLoaded && !fixture.store.programsLoadError);
          assert.equal(await page.getByRole("button", { name: "Retry programs", exact: true }).count(), 0);
        }
      }
      await page.evaluate(() => { fixture.failedDataset = null; fixture.store.retryInitialization(); });
      await page.waitForFunction(() => fixture.requests.filter(path => path === "/dashboard/bootstrap?allow_partial=true").length === 2 && fixture.store.identityReady && fixture.store.studentsLoaded && fixture.store.programsLoaded && fixture.store.leadsLoaded && !fixture.store.studioLoadError && !fixture.store.beltLaddersLoadError);
      assert.equal(await page.evaluate(() => fixture.requests.filter(path => path === "/dashboard/bootstrap?allow_partial=true").length), 2);
      await page.evaluate(() => fixture.root.unmount());
    } finally { await browser.close(); }
  });
}

for (const operation of ["add", "update", "delete", "convert"]) {
  for (const mutationStart of ["before-retry", "during-retry"]) {
    for (const mutationFinish of ["before-bootstrap", "after-bootstrap"]) {
      test(`bootstrap preserves ${operation} begun ${mutationStart} and settled ${mutationFinish}`, async () => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.route("http://fixture.local/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
          await page.goto("http://fixture.local/");
          await page.evaluate(operation => {
            const user = { id: "lead-race-user", email: "lead-race@example.test", legal_first_name: "Lead", legal_last_name: "Owner" };
            const session = { access_token: "lead-race-token", user };
            const profile = { user, membership_status: "active", studio_id: "lead-race-studio", role: "admin", staff_profiles_available: true };
            const initialLead = { id: "existing-lead", first_name: "Original", last_name: "Lead", stage: "new", converted_student_id: null };
            const fixture = window.fixture = { observations: [], identityObservations: [], initialLead, dbLeads: [initialLead], requests: [], holdBootstrap: false, bootstrapCalls: 0, mutationCalls: 0 };
            fixture.supabase = { auth: {
              getSession: async () => ({ data: { session }, error: null }),
              onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            } };
            fixture.api = { get: async path => {
              fixture.requests.push(path);
              if (path === "/dashboard/bootstrap?allow_partial=true") {
                fixture.bootstrapCalls += 1;
                const leads = structuredClone(fixture.dbLeads);
                if (fixture.holdBootstrap) await new Promise(resolve => { fixture.releaseBootstrap = resolve; });
                return { auth: profile, studio_name: "Lead race studio", leads, students: [], programs: [], belt_ladders: [], primary_belt_ladder: null, summary: { auth: profile } };
              }
              if (path.startsWith("/schedule/window")) return { sessions: [], templates: [], attendance: [] };
              if (path.startsWith("/students")) return { items: [{ id: "converted-student", legal_first_name: "Converted", legal_last_name: "Student", status: "active" }], total: 1, page_size: 200 };
              if (path === "/leads") throw new Error("Leads refresh failed");
              throw new Error(`Unexpected request ${path}`);
            } };
            fixture.mutate = async () => {
              fixture.mutationCalls += 1;
              let result;
              if (operation === "add") {
                result = { ...initialLead, id: "created-lead", first_name: "Created" };
                fixture.dbLeads = [result, ...fixture.dbLeads];
              } else if (operation === "delete") {
                fixture.dbLeads = [];
              } else {
                result = { ...initialLead, first_name: "Changed", ...(operation === "convert" ? { stage: "enrolled", converted_student_id: "converted-student" } : {}) };
                fixture.dbLeads = [result];
              }
              await new Promise(resolve => { fixture.releaseMutation = resolve; });
              return result;
            };
            fixture.api.post = fixture.mutate;
            fixture.api.patch = fixture.mutate;
            fixture.api.delete = fixture.mutate;
            fixture.startMutation = () => {
              fixture.mutation = operation === "add" ? fixture.store.addLead({ first_name: "Created" })
                : operation === "update" ? fixture.store.updateLead("existing-lead", { first_name: "Changed" })
                : operation === "delete" ? fixture.store.deleteLead("existing-lead")
                : fixture.store.convertLeadToStudent("existing-lead");
            };
          }, operation);
          await page.addScriptTag({ content: bundle("production", { layout: true }) });
          await page.waitForFunction(() => fixture.store?.identityReady && fixture.store.leadsLoaded);
          if (mutationStart === "before-retry") {
            await page.evaluate(() => fixture.startMutation());
            await page.waitForFunction(() => fixture.mutationCalls === 1);
          }
          await page.evaluate(() => { fixture.holdBootstrap = true; fixture.store.retryInitialization(); });
          await page.waitForFunction(() => fixture.bootstrapCalls === 2 && Boolean(fixture.releaseBootstrap));
          if (mutationStart === "during-retry") {
            await page.evaluate(() => fixture.startMutation());
            await page.waitForFunction(() => fixture.mutationCalls === 1);
          }
          if (mutationFinish === "before-bootstrap") {
            await page.evaluate(async () => { fixture.releaseMutation(); await fixture.mutation; });
            await page.waitForFunction(() => JSON.stringify(fixture.store.leads) === JSON.stringify(fixture.dbLeads));
            await page.evaluate(() => fixture.releaseBootstrap());
          } else {
            await page.evaluate(() => fixture.releaseBootstrap());
            await page.waitForFunction(() => fixture.store.identityReady);
            assert.deepEqual(await page.evaluate(() => fixture.store.leads), [await page.evaluate(() => fixture.initialLead)], "a pending mutation excludes the bootstrap snapshot even if the server already committed it");
            await page.evaluate(async () => { fixture.releaseMutation(); await fixture.mutation; });
          }
          await page.waitForFunction(() => fixture.store.identityReady && JSON.stringify(fixture.store.leads) === JSON.stringify(fixture.dbLeads));
          assert.equal(await page.evaluate(() => fixture.store.leadsLoaded), true);
          assert.equal(await page.evaluate(() => fixture.store.leadsLoadError), null);
          assert.equal(await page.evaluate(() => fixture.mutationCalls), 1, "bootstrap cannot cancel or replay successful writes");
          if (operation === "convert") {
            assert.equal(await page.evaluate(() => fixture.store.leads[0]?.converted_student_id), "converted-student");
            assert.equal(await page.evaluate(() => fixture.store.students.some(student => student.id === "converted-student")), true, "student revision protection survives the lead guard");
          }
          if (operation === "update" && mutationStart === "before-retry" && mutationFinish === "before-bootstrap") {
            const message = await page.evaluate(async () => {
              fixture.api.patch = async () => { throw new Error("Lead write failed"); };
              return fixture.store.updateLead("existing-lead", { first_name: "Rejected" }).catch(error => error.message);
            });
            assert.equal(message, "Lead write failed", "failed writes must settle their pending scope before the next retry");
          }
          await page.evaluate(() => fixture.store.refreshLeads().catch(() => undefined));
          await page.waitForFunction(() => fixture.store.leadsLoadError === "Leads refresh failed" && !fixture.store.leadsLoaded);
          await page.evaluate(() => { fixture.holdBootstrap = false; fixture.store.retryInitialization(); });
          await page.waitForFunction(() => fixture.bootstrapCalls === 3 && fixture.store.identityReady && fixture.store.leadsLoaded && !fixture.store.leadsLoadError);
          assert.deepEqual(await page.evaluate(() => fixture.store.leads), await page.evaluate(() => fixture.dbLeads), "an uncontested retry still restores the complete dataset");
          await page.evaluate(() => fixture.root.unmount());
        } finally { await browser.close(); }
      });
    }
  }
}

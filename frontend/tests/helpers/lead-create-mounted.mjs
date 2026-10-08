import { createCommonJsPacker } from "./store-browser-harness.mjs";

export function bundleLeadCreateFixture(preview = false, { realControls = false } = {}) {
  const stubs = {
    "next/navigation": `const router={replace(p){window.f.redirects.push(p)},push(p){window.f.redirects.push(p)}};exports.useRouter=()=>router;exports.usePathname=()=>'/leads';exports.useParams=()=>({});exports.useSearchParams=()=>new URLSearchParams();`,
    "@/lib/supabase/client": `exports.createClient=()=>window.f.supabase;`,
    "@/lib/api": `class ApiError extends Error{constructor(message,status,detail){super(message);this.status=status;this.detail=detail;}}exports.ApiError=ApiError;window.f.ApiError=ApiError;exports.CommandOutcomeUnknown=require("@/lib/command-outcome").CommandOutcomeUnknown;window.f.Unknown=exports.CommandOutcomeUnknown;exports.api=window.f.api;exports.isSubscriptionRequiredError=e=>e?.status===402;exports.isStaffArchivedError=()=>false;`,
    "@/lib/performance": `exports.markPerformance=()=>{};exports.measurePerformance=()=>{};exports.startStudentPagePerformanceSpan=()=>({finish(){}});exports.markDashboardReadiness=()=>()=>{};`,
    "@/components/header": `exports.Header=({children})=>require('react').createElement('header',null,children);`,
    ...(!realControls
      ? {
          "@/components/programs/program-picker": `exports.ProgramBadge=()=>null;exports.ProgramPicker=()=>null;`,
          "@/components/ui/modal-frame": `exports.ModalFrame=({children})=>children;`,
        }
      : {}),
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
    "./leads-ledger.module.css": `module.exports={};`,
    "@/components/leads/leads-ledger.module.css": `module.exports={};`,
  };
  const { add, modules } = createCommonJsPacker(stubs);
  const react = add("react");
  const dom = add("react-dom/client");
  const store = add("@/lib/store");
  const page = add("@/app/(dashboard)/leads/page");
  return `(()=>{const process={env:{NODE_ENV:'production',NEXT_PUBLIC_PREVIEW_MODE:${JSON.stringify(String(preview))}}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
const React=require(${react});const {StoreProvider,useStore}=require(${store});const LeadsPage=require(${page}).default;
function Observer(){window.f.store=useStore();return null;}
function PageMount(){const [shown,setShown]=React.useState(true);window.f.showPage=setShown;return shown?React.createElement(LeadsPage):null;}
window.f.root=require(${dom}).createRoot(document.getElementById('root'));
function ProviderMount(){const [shown,setShown]=React.useState(true);window.f.showProvider=setShown;return shown?React.createElement(StoreProvider,null,React.createElement(Observer),React.createElement(PageMount)):null;}window.f.root.render(React.createElement(ProviderMount));})();`;
}

export const flushLeadCreate = (p) =>
  p.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
export async function mountLeadCreateFixture(
  browser,
  { role = "admin", preview = false, journal = null, programs = [], realControls = false } = {},
) {
  const p = await browser.newPage();
  await p.route("**/*", (r) =>
    r.request().url() === "http://localhost/"
      ? r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : r.abort(),
  );
  await p.goto("http://localhost/");
  await p.evaluate(
    ({ role, journal, programs }) => {
      const f = (window.f = { redirects: [], reads: [], writes: [], rowReads: [], programs });
      f.rows = ["a", "b"].map((id) => ({
        id,
        studio_id: "20000000-0000-4000-8000-000000000001",
        first_name: id.toUpperCase(),
        last_name: "Lead",
        stage: "inquiry",
        source: "website",
        follow_up_date: "2020-01-01",
        assigned_staff_id: null,
        converted_student_id: null,
        created_at: "2020-01-01T00:00:00Z",
        is_minor: false,
      }));
      f.session = {
        access_token: "token-1",
        user: { id: "10000000-0000-4000-8000-000000000001", email: "a@example.test" },
      };
      f.auth = {
        user: {
          id: "10000000-0000-4000-8000-000000000001",
          email: "a@example.test",
          legal_first_name: "A",
          legal_last_name: "Owner",
        },
        studio_id: "20000000-0000-4000-8000-000000000001",
        membership_status: "active",
        role,
        staff_profiles_available: true,
      };
      f.summary = {
        auth: f.auth,
        generated_at: "2020-01-01T00:00:00Z",
        students: {
          total_students: 0,
          active_students: 0,
          trialing_students: 0,
          on_hold_students: 0,
        },
        leads: { active_leads: 2, enrolled_leads: 0, due_today_leads: 0 },
        schedule: { today_sessions: 0 },
        belts: { belt_count: 0, tip_count: 0 },
        inactivity: { watch_14: 0, watch_30: 0, watch_90: 0 },
        new_students: { new_14: 0, new_30: 0, new_90: 0, new_year_to_date: 0 },
        operational: {
          attendance_with_capacity: 0,
          total_capacity: 0,
          sessions_tracked: 0,
          sessions_with_capacity: 0,
          average_attendance: 0,
        },
        churn: { inactive_students: 0, canceled_students: 0, churn_marked_students: 0 },
        test_readiness: { available: false },
        billing: { can_view_billing: true },
        setup: {
          has_programs: false,
          has_students: false,
          has_belt_system: false,
          has_weekly_classes: false,
        },
        recent_students: [],
        actions: [],
      };
      const authListeners = new Set();
      f.emit = (event, session) => {
        f.session = session;
        for (const listener of [...authListeners]) listener(event, session);
      };
      f.supabase = {
        auth: {
          getSession: async () => ({ data: { session: f.session } }),
          onAuthStateChange: (cb) => {
            authListeners.add(cb);
            return {
              data: {
                subscription: {
                  unsubscribe() {
                    authListeners.delete(cb);
                  },
                },
              },
            };
          },
        },
      };
      if (journal) sessionStorage.setItem("koaryu-lead-create-operations-v1", journal);
      const copy = () => f.rows.map((row) => ({ ...row }));
      f.api = {
        get: async (path, token) => {
          f.reads.push({ path, token });
          if (path.startsWith("/automations/operations/")) {
            const operation = path.split("/").at(-1),
              receipt = f.createReceipts[operation];
            if (!receipt) throw new f.ApiError("Receipt not found", 404);
            return structuredClone(receipt);
          }
          if (path === "/dashboard/workspace")
            return { auth: f.auth, studio: { name: "Synthetic Studio", timezone: "UTC" } };
          if (path.startsWith("/dashboard/bootstrap"))
            return {
              auth: f.auth,
              studio_name: "Synthetic Studio",
              students: [],
              students_may_be_partial: false,
              leads: copy(),
              programs: f.programs,
              belt_ladders: [],
              primary_belt_ladder: null,
              summary: f.summary,
            };
          if (path.startsWith("/dashboard/summary")) return f.summary;
          if (path.startsWith("/programs")) return f.programs;
          if (path.startsWith("/staff")) return [];
          if (path === "/leads") return copy();
          if (/^\/leads\/[^/]+\/activities$/.test(path)) return [];
          if (/^\/leads\/[^/]+$/.test(path))
            return new Promise((resolve, reject) =>
              f.rowReads.push({ path, token, resolve, reject }),
            );
          throw Error(`Unexpected read ${path}`);
        },
        post: (path, body, token) =>
          path.startsWith("/schedule/window")
            ? Promise.resolve({ sessions: [], attendance: [], templates: [] })
            : f.write("post", path, body, token),
        patch: (path, body, token) => f.write("patch", path, body, token),
      };
      // Bodies are recorded as sent so retries can be compared byte for byte.
      f.write = (method, path, body, token) =>
        new Promise((resolve, reject) =>
          f.writes.push({ method, path, body: JSON.stringify(body), token, resolve, reject }),
        );
      // The synthetic server applies a command once, then replays its receipt.
      f.receipts = {};
      f.createReceipts = {};
      f.createdRow = (changes = {}) => ({
        id: "30000000-0000-4000-8000-000000000001",
        studio_id: f.auth.studio_id,
        first_name: "Synthetic",
        last_name: "Lead",
        stage: "inquiry",
        source: "walk_in",
        is_minor: false,
        created_at: "2026-10-05T00:00:00Z",
        updated_at: "2026-10-05T00:01:00Z",
        ...changes,
      });
      f.commitCreate = (index, { lose = false, missing = false, denial = null } = {}) => {
        const w = f.writes[index],
          body = JSON.parse(w.body),
          result = f.createdRow();
        f.createReceipts[body.operation_id] = {
          operation_id: body.operation_id,
          command: "lead.create",
          state: "committed",
          entity_type: "lead",
          entity_id: result.id,
          result,
          committed_at: "2026-10-05T00:00:00Z",
        };
        if (!missing) f.rows = [f.createdRow({ first_name: "Current" }), ...f.rows];
        if (denial) w.reject(new f.ApiError("Expired provider token", denial));
        else if (lose) w.reject(new f.Unknown());
        else w.resolve(result);
      };
      f.confirm = (index, overrides = {}) => {
        const w = f.writes[index];
        const id = w.path.split("/")[2];
        const body = JSON.parse(w.body);
        let row;
        if (w.path.endsWith("/follow-up")) {
          row = f.receipts[body.operation_id];
          if (!row) {
            const current = f.rows.find((item) => item.id === id);
            row = { ...current, stage: body.next_stage ?? current.stage, follow_up_date: null };
            if (row.stage === "enrolled") row.converted_student_id = `student-${id}`;
            f.receipts[body.operation_id] = row;
            f.rows = f.rows.map((item) => (item.id === id ? row : item));
          }
        } else if (w.path.endsWith("/convert")) {
          row = {
            ...f.rows.find((item) => item.id === id),
            stage: "enrolled",
            converted_student_id: `student-${id}`,
          };
          f.rows = f.rows.map((item) => (item.id === id ? row : item));
        } else {
          row = { ...f.rows.find((item) => item.id === id), ...body };
          f.rows = f.rows.map((item) => (item.id === id ? row : item));
        }
        w.resolve({ ...row, ...overrides });
      };
      f.lose = (index) => f.writes[index].reject(new f.Unknown());
      f.refuse = (index) =>
        f.writes[index].reject(new f.ApiError("The studio is being updated.", 409));
      f.readRow = (index) => {
        const r = f.rowReads[index];
        const row = f.rows.find((item) => `/leads/${item.id}` === r.path);
        if (row) r.resolve({ ...row });
        else r.reject(new f.ApiError("Lead not found", 404));
      };
      f.failRowRead = (index) => f.rowReads[index].reject(new f.ApiError("Upstream failed", 503));
      f.stored = (id) => f.store.leads.find((lead) => lead.id === id) ?? null;
    },
    { role, journal, programs },
  );
  await p.addScriptTag({ content: bundleLeadCreateFixture(preview, { realControls }) });
  await p.waitForFunction(() => window.f.store?.identityReady && window.f.store.leadsLoaded);
  if (!preview && ["admin", "front_desk"].includes(role))
    await p.waitForFunction(() => window.f.store.leadCreate.isCurrent());
  return p;
}

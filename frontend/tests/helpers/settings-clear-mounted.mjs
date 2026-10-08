import { createCommonJsPacker } from "./store-browser-harness.mjs";
import { mountLeadCreateFixture, flushLeadCreate } from "./lead-create-mounted.mjs";
export const flush = flushLeadCreate;
export const effects = {
  workflows_paused: 1,
  workflow_runs_cancelled: 2,
  workflow_cancellation_intents_added: 3,
  attendance_deliveries_cancelled: 4,
  belt_test_events_deleted: 5,
  belt_test_recipients_deleted: 6,
  sending_attempts_preserved: 7,
  unknown_attempts_preserved: 8,
  attendance_rule_paused: true,
};
export function response(automation = effects) {
  return {
    studio_name: "Completed studio",
    automation,
    counts: { students: 10, leads: 11, belt_ranks: 12, class_sessions: 13, attendance_records: 14 },
    students: [],
    leads: [],
    programs: [],
    belt_ladders: [],
    primary_belt_ladder: null,
    eligibility: [],
    templates: [],
    sessions: [],
    attendance: [],
  };
}
export async function mountSettings(browser, { preview = false, holdCapability = false } = {}) {
  const scripts = [];
  const capture = {
    route: async () => {},
    goto: async () => {},
    waitForFunction: async () => {},
    addScriptTag: async () => {},
    evaluate: async (fn, arg) => scripts.push(`(${fn.toString()})(${JSON.stringify(arg)});`),
  };
  await mountLeadCreateFixture({ newPage: async () => capture }, { preview });
  scripts.push(`f.capabilities=[];f.dataWrites=[];
const originalGet=f.api.get;f.api.get=async(path,token)=>{if(path==='/demo/capabilities'){const read={token};f.capabilities.push(read);return ${holdCapability ? "new Promise(resolve=>read.resolve=resolve)" : "{enabled:true}"};}return originalGet(path,token);};
f.api.post=(path,body,token,options)=>new Promise((resolve,reject)=>f.dataWrites.push({method:'POST',path,body,token,options,resolve,reject}));
f.api.delete=(path,token,options)=>new Promise((resolve,reject)=>f.dataWrites.push({method:'DELETE',path,token,options,resolve,reject}));`);
  const stubs = {
    "next/navigation": `exports.usePathname=()=>'/settings';exports.useSearchParams=()=>new URLSearchParams();const router={push:p=>f.redirects.push(p),replace:p=>f.redirects.push(p)};exports.useRouter=()=>router;`,
    "@/lib/supabase/client": `exports.createClient=()=>f.supabase;`,
    "@/lib/api": `class ApiError extends Error{constructor(message,status,detail){super(message);this.status=status;this.detail=detail;}}exports.ApiError=ApiError;f.ApiError=ApiError;exports.api=f.api;exports.isSubscriptionRequiredError=e=>e?.status===402;exports.isStaffArchivedError=()=>false;`,
    "@/lib/performance": `exports.markPerformance=()=>{};exports.measurePerformance=()=>{};exports.startStudentPagePerformanceSpan=()=>({finish(){}});exports.markDashboardReadiness=()=>()=>{};`,
    "@/components/header": `exports.Header=()=>null;`,
    "@/components/settings/programs-section": `exports.ProgramsSection=()=>null;`,
    "@/components/settings/staff-roles-section": `exports.StaffRolesSection=()=>null;`,
    "@/components/operations/operations-surface": `exports.OperationsSurface=({children})=>children;exports.OperationsIndex=()=>null;`,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
  };
  const { add, modules } = createCommonJsPacker(stubs);
  const react = add("react"),
    dom = add("react-dom/client"),
    store = add("@/lib/store"),
    page = add("@/app/(dashboard)/settings/page");
  scripts.push(`(()=>{const process={env:{NODE_ENV:'production',NEXT_PUBLIC_PREVIEW_MODE:${JSON.stringify(String(preview))}}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
const React=require(${react}),{StoreProvider,useStore}=require(${store}),Page=require(${page}).default;
function Observer(){f.store=useStore();return null;}function Mount(){const[shown,setShown]=React.useState(true);f.showPage=setShown;return shown?React.createElement(Page):null;}
f.root=require(${dom}).createRoot(document.getElementById('root'));f.root.render(React.createElement(StoreProvider,null,React.createElement(Observer),React.createElement(Mount)));})();`);
  const p = await browser.newPage();
  p.setDefaultTimeout(7000);
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.route("**/*", (r) =>
    r.request().url() === "http://localhost/"
      ? r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : r.abort(),
  );
  await p.goto("http://localhost/");
  await p.addScriptTag({ content: scripts.join("\n") });
  await p.waitForFunction(() => f.store?.identityReady);
  await flush(p);
  return { p, errors };
}

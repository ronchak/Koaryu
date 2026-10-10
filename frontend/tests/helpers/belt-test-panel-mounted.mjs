import { readFileSync } from "node:fs";
import { createCommonJsPacker } from "./store-browser-harness.mjs";
import { mountLeadCreateFixture, flushLeadCreate } from "./lead-create-mounted.mjs";
import { fixture, DRAFT, STUDIO, USER, KEY } from "./belt-test-mounted.mjs";
export { fixture, DRAFT, STUDIO, USER, KEY };
export const flush = flushLeadCreate;
export const EVENT = fixture.ids.event;
export const OTHER = "aaaaaaaa-0000-4000-8000-000000000002";
export const eventRoute = `/belt-tests?event=${EVENT}`;

export function installBeltPanel({ fixture, STUDIO, route, options }) {
  const f = window.f;
  f.route = route;
  const copyStudio = (value) =>
    Array.isArray(value)
      ? value.map(copyStudio)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
              key,
              key === "studio_id" ? STUDIO : copyStudio(child),
            ]),
          )
        : value;
  f.source = copyStudio(fixture);
  f.events = (options.events ?? [f.source.events.scheduled]).map((row) => ({
    ...row,
    studio_id: STUDIO,
  }));
  f.recipients = (options.recipients ?? [f.source.recipients.approved]).map((row) => ({
    ...row,
    studio_id: STUDIO,
  }));
  f.candidates = options.candidates ?? f.source.candidates;
  f.programs = options.programs ?? [
    { id: fixture.ids.program, studio_id: STUDIO, name: "Sample program", archived_at: null },
  ];
  f.ladders = options.ladders ?? [
    {
      id: fixture.ids.ladder,
      studio_id: STUDIO,
      name: "Sample plan",
      program_id: fixture.ids.program,
      ranks: [
        {
          id: fixture.ids.rank,
          name: "Sample next rank",
          display_order: 1,
          min_classes: 10,
          min_months: 1,
        },
      ],
      sub_rank_term: "tip",
    },
  ];
  f.beltReads = [];
  f.held = [];
  f.beltReceipts = {};
  f.failures = options.failures ?? {};
  f.holds = options.holds ?? [];
  const original = f.api.get;
  f.api.get = async (path, token) => {
    if (
      !path.startsWith("/belt-tests") &&
      !path.startsWith("/automations/operations/") &&
      !path.startsWith("/programs") &&
      path !== "/belts/ladders"
    )
      return original(path, token);
    f.beltReads.push({ path, token });
    const read = () => {
      if (f.failures[path])
        throw new f.ApiError("Synthetic private provider detail", f.failures[path]);
      if (path === "/belts/ladders") return structuredClone(f.ladders);
      if (path.startsWith("/programs")) return structuredClone(f.programs);
      if (path.startsWith("/automations/operations/")) {
        const receipt = f.beltReceipts[path.split("/").at(-1)];
        if (!receipt) throw new f.ApiError("Missing receipt", 404);
        return structuredClone(receipt);
      }
      if (path.startsWith("/belt-tests?"))
        return structuredClone(
          f.eventPages?.[path] ?? {
            items: f.events.slice(0, 50),
            next_cursor: null,
            has_more: false,
          },
        );
      const id = path.split("/")[2],
        event = f.events.find((row) => row.id === id);
      if (!event) throw new f.ApiError("Missing event", 404);
      if (path.endsWith("/candidates")) return structuredClone(f.candidates);
      if (path.includes("/recipients?"))
        return structuredClone(
          f.recipientPages?.[path] ?? {
            items: f.recipients.filter((row) => row.event_id === id).slice(0, 50),
            next_cursor: null,
            has_more: false,
          },
        );
      if (path.includes("/recipients/")) {
        if (f.nullRecipient) return null;
        const recipient = f.recipients.find((row) => row.id === path.split("/").at(-1));
        if (!recipient) throw new f.ApiError("Missing recipient", 404);
        return structuredClone(recipient);
      }
      return f.nullEvent ? null : structuredClone(event);
    };
    if (f.holds.some((part) => path.includes(part)))
      return new Promise((resolve, reject) =>
        f.held.push({
          path,
          finish() {
            try {
              resolve(read());
            } catch (error) {
              reject(error);
            }
          },
        }),
      );
    return read();
  };
  f.finishReads = () => {
    for (const row of f.held.splice(0)) row.finish();
  };
  if (options.unverified)
    f.supabase.auth.getSession = () =>
      new Promise((resolve) => {
        f.finishIdentity = () => resolve({ data: { session: f.session } });
      });
  f.commitBelt = (
    index,
    { lose = false, missingParent = false, missingChild = false, reapprove = false } = {},
  ) => {
    const write = f.writes[index],
      body = JSON.parse(write.body),
      id = write.path.split("/")[2];
    const current = f.events.find((row) => row.id === id);
    let result, command;
    if (write.path === "/belt-tests") {
      command = "belt_test.create";
      const fields = { ...body };
      delete fields.operation_id;
      const ladder = f.ladders.find((row) => row.id === fields.ladder_id);
      result = {
        ...f.source.events.create,
        ...fields,
        studio_id: STUDIO,
        id: options.createdId ?? fixture.ids.event,
        program_id: ladder?.program_id ?? null,
        revision: 1,
        schedule_revision: 1,
      };
      f.events = [result, ...f.events.filter((row) => row.id !== result.id)];
    } else if (write.path.endsWith("/approve")) {
      command = "belt_test.approve";
      const rows = body.recipients.map((pair, index) => {
        const old = f.recipients.find(
          (row) =>
            row.student_id === pair.student_id &&
            row.student_program_membership_id === pair.student_program_membership_id,
        );
        return {
          ...f.source.recipients.approved,
          ...old,
          ...pair,
          event_id: id,
          approved_schedule_revision: current.schedule_revision,
          id: old?.id ?? `bbbbbbbb-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          state: "approved",
          revision: (old?.revision ?? 0) + 1,
          revoked_at: null,
        };
      });
      result = {
        items: rows,
        event_revision: current.revision,
        schedule_revision: current.schedule_revision,
      };
      f.recipients = [
        ...rows,
        ...f.recipients.filter((row) => !rows.some((item) => item.id === row.id)),
      ];
    } else if (write.path.endsWith("/revoke")) {
      command = "belt_test.revoke";
      const child = f.recipients.find((row) => row.id === write.path.split("/")[4]);
      result = {
        ...child,
        state: "revoked",
        revision: body.expected_revision + 1,
        revoked_at: "2026-10-05T02:00:00Z",
        updated_at: "2026-10-05T02:00:00Z",
      };
      f.recipients = f.recipients.map((row) =>
        row.id === child.id
          ? reapprove
            ? { ...result, state: "approved", revision: result.revision + 1, revoked_at: null }
            : result
          : row,
      );
      if (missingChild) f.recipients = f.recipients.filter((row) => row.id !== child.id);
    } else {
      command = "belt_test.update";
      const { expected_revision, ...fields } = body;
      delete fields.operation_id;
      const changedSchedule = ["starts_at", "ends_at", "timezone", "location", "ladder_id"].some(
        (field) => field in fields && fields[field] !== current[field],
      );
      result = {
        ...current,
        ...fields,
        revision: expected_revision + 1,
        schedule_revision: current.schedule_revision + Number(changedSchedule),
      };
      if (fields.ladder_id)
        result.program_id =
          f.ladders.find((row) => row.id === fields.ladder_id)?.program_id ?? null;
      f.events = f.events.map((row) => (row.id === id ? result : row));
    }
    f.beltReceipts[body.operation_id] = {
      operation_id: body.operation_id,
      command,
      state: "committed",
      entity_type: command === "belt_test.revoke" ? "belt_test_recipient" : "belt_test",
      entity_id: command === "belt_test.approve" ? id : result.id,
      result,
      committed_at: "2026-10-05T02:00:00Z",
    };
    if (missingParent) f.events = f.events.filter((row) => row.id !== (id ?? result.id));
    if (lose) write.reject(new f.Unknown());
    else write.resolve(structuredClone(result));
  };
  f.resetBeltResource = async () => {
    f.api.delete = async () => ({
      studio_name: "Cleared",
      automation: {
        workflows_paused: 0,
        workflow_runs_cancelled: 0,
        workflow_cancellation_intents_added: 0,
        attendance_deliveries_cancelled: 0,
        belt_test_events_deleted: 0,
        belt_test_recipients_deleted: 0,
        sending_attempts_preserved: 0,
        unknown_attempts_preserved: 0,
        attendance_rule_paused: false,
      },
    });
    await f.store.clearStudioData();
  };
}

export async function buildBeltPanelFixture({
  role = "admin",
  preview = false,
  route = "/belt-tests",
  strict = false,
  ...options
} = {}) {
  const scripts = [];
  const capture = {
    route: async () => {},
    goto: async () => {},
    waitForFunction: async () => {},
    addScriptTag: async () => {},
    evaluate: async (fn, arg) => scripts.push(`(${fn.toString()})(${JSON.stringify(arg)});`),
  };
  await mountLeadCreateFixture({ newPage: async () => capture }, { role, preview });
  scripts.push(
    `(${installBeltPanel.toString()})(${JSON.stringify({ fixture, STUDIO, route, options })});`,
  );
  const css = `module.exports={__esModule:true,default:new Proxy({},{get:(_target,name)=>String(name)})};`;
  const stubs = {
    "next/navigation": `const subscribe=fn=>{window.addEventListener('belt:route',fn);return()=>window.removeEventListener('belt:route',fn)};exports.usePathname=()=>require('react').useSyncExternalStore(subscribe,()=>f.route.split('?')[0]);const router={push:route=>f.navigate(route),replace:route=>f.navigate(route)};exports.useRouter=()=>router;exports.useSearchParams=()=>new URLSearchParams(f.route.split('?')[1]);exports.notFound=()=>{throw Error('Not found')};`,
    "next/link": `exports.__esModule=true;exports.default=({href,children,...props})=>require('react').createElement('a',{href,...props},children);`,
    "@/lib/supabase/client": `exports.createClient=()=>window.f.supabase;`,
    "@/lib/api": `class ApiError extends Error{constructor(message,status,detail){super(message);this.status=status;this.detail=detail;}}exports.ApiError=ApiError;window.f.ApiError=ApiError;exports.CommandOutcomeUnknown=require("@/lib/command-outcome").CommandOutcomeUnknown;window.f.Unknown=exports.CommandOutcomeUnknown;exports.api=window.f.api;exports.isSubscriptionRequiredError=e=>e?.status===402;exports.isStaffArchivedError=()=>false;`,
    "@/lib/performance": `exports.markPerformance=()=>{};exports.measurePerformance=()=>{};exports.startStudentPagePerformanceSpan=()=>({finish(){}});exports.markDashboardReadiness=()=>()=>{};`,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
    "@/components/leads/leads-ledger.module.css": css,
    "@/components/belt-tracker/belt-tracker.module.css": css,
    "./belt-tests.module.css": css,
  };
  const { add, modules } = createCommonJsPacker(stubs),
    react = add("react"),
    dom = add("react-dom/client"),
    store = add("@/lib/store"),
    page = add("@/app/(dashboard)/belt-tests/page"),
    retained = add("@/lib/retained-state");
  scripts.push(`(()=>{const process={env:{NODE_ENV:${JSON.stringify(strict ? "development" : "production")},NEXT_PUBLIC_PREVIEW_MODE:${JSON.stringify(String(preview))}}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
const React=require(${react}),{StoreProvider,useStore}=require(${store}),Page=require(${page}).default;
f.renderPage=Page;function Observer(){f.store=useStore();return null;}
function PageMount(){const[route,setRoute]=React.useState(f.route),[page,setPage]=React.useState(null),[shown,setShown]=React.useState(true);f.showPage=setShown;f.navigate=next=>{f.route=next;f.redirects.push(next);history.replaceState(null,'',next);setRoute(next);window.dispatchEvent(new Event('belt:route'));};React.useEffect(()=>{let active=true;const params={};for(const[key,value]of new URLSearchParams(route.split('?')[1]))params[key]=key in params?[...Array.isArray(params[key])?params[key]:[params[key]],value]:value;Page({searchParams:Promise.resolve(params)}).then(result=>{if(active)setPage(result)}).catch(error=>{if(active)setPage(React.createElement('p',{role:'alert'},error.message))});return()=>{active=false}},[route]);return shown?page:null;}
function RetainedPages(){const state=useStore();return React.createElement(require(${retained}).RetainedStateProvider,{scope:JSON.stringify([state.currentUserId,state.currentStudioId,state.identityGeneration])},React.createElement(PageMount));}
function ProviderMount(){const[shown,setShown]=React.useState(true);f.showProvider=setShown;return shown?React.createElement(StoreProvider,null,React.createElement(Observer),React.createElement(RetainedPages)):null;}
f.root=require(${dom}).createRoot(document.getElementById('root'));f.root.render(${strict ? "React.createElement(React.StrictMode,null,React.createElement(ProviderMount))" : "React.createElement(ProviderMount)"});})();`);
  return scripts.join("\n");
}

export async function mountBeltPanel(browser, { journal, ...options } = {}) {
  const context = await browser.newContext(),
    errors = [];
  try {
    await context.addInitScript(
      ({ KEY, journal }) => {
        if (journal !== undefined) sessionStorage.setItem(KEY, journal);
        window.beltStorageReads = 0;
        window.beltStorageWrites = 0;
        const get = Storage.prototype.getItem,
          set = Storage.prototype.setItem;
        Storage.prototype.getItem = function (key) {
          if (key === KEY) window.beltStorageReads++;
          return get.call(this, key);
        };
        Storage.prototype.setItem = function (key, value) {
          if (key === KEY) window.beltStorageWrites++;
          return set.call(this, key, value);
        };
      },
      { KEY, journal },
    );
    const p = await context.newPage();
    p.on("pageerror", (error) => errors.push(error.message));
    p.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await p.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
    );
    await p.goto("http://localhost/belt-tests");
    await p.addScriptTag({ content: await buildBeltPanelFixture(options) });
    await p.waitForFunction(() => f.store && (f.store.identityReady || f.finishIdentity));
    await flush(p);
    return { p, errors, close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}
export async function fillBeltSchedule(
  p,
  {
    startDate = "2030-01-02",
    endDate = startDate,
    startTime = "12:00",
    endTime = "13:00",
    timezone = "UTC",
  } = {},
) {
  for (const [label, value] of Object.entries({
    "Start date": startDate,
    "End date": endDate,
    "Start time": startTime,
    "End time": endTime,
    Timezone: timezone,
  }))
    await p.getByLabel(label, { exact: true }).fill(value);
  await flush(p);
}
export async function commit(p, options = {}, index) {
  await p.waitForFunction(() => f.writes.length > 0);
  await p.evaluate(({ options, index }) => f.commitBelt(index ?? f.writes.length - 1, options), {
    options,
    index,
  });
  await flush(p);
}
export const sourceHash = () =>
  readFileSync(
    new URL("../../src/components/belt-tests/belt-test-workspace.tsx", import.meta.url),
    "utf8",
  );

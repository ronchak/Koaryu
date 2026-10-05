import { mountLeadCreateFixture, flushLeadCreate } from "./lead-create-mounted.mjs";
export const USER = "10000000-0000-4000-8000-000000000001";
export const STUDIO = "20000000-0000-4000-8000-000000000001";
export const LEAD = "30000000-0000-4000-8000-000000000001";
export const APPT = "40000000-0000-4000-8000-000000000001";
export const OP = "60000000-0000-4000-8000-000000000001";
export const KEY = "koaryu-trial-appointment-operations-v1";
export const flush = flushLeadCreate;
export const marker = {
  command: "trial.create",
  operation_id: OP,
  owner_user_id: USER,
  owner_studio_id: STUDIO,
  lead_id: LEAD,
};
export async function mountTrialFixture(
  browser,
  { role = "admin", preview = false, journal } = {},
) {
  const context = await browser.newContext();
  await context.addInitScript(
    ({ key, journal }) => {
      if (journal !== undefined) sessionStorage.setItem(key, journal);
      window.trialStorageReads = 0;
      const getItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (name) {
        if (name === key) window.trialStorageReads++;
        return getItem.call(this, name);
      };
    },
    { key: KEY, journal },
  );
  let p;
  try {
    p = await mountLeadCreateFixture({ newPage: () => context.newPage() }, { role, preview });
    await p.evaluate(
      ({ LEAD, APPT, OP, STUDIO }) => {
        f.trialLead = LEAD;
        f.trialId = APPT;
        f.trialReads = [];
        f.rows = [f.createdRow({ id: LEAD, stage: "inquiry" })];
        f.trialRow = (changes) => ({
          id: APPT,
          studio_id: STUDIO,
          lead_id: LEAD,
          program_id: null,
          starts_at: "2026-10-05T09:00:00.123456Z",
          ends_at: "2026-10-05T10:00:00.123457Z",
          timezone: "Server/NewAlias",
          location: "Sample room",
          status: "scheduled",
          revision: 1,
          created_by: null,
          created_at: "2026-10-01T00:00:00Z",
          updated_at: "2026-10-01T00:00:00Z",
          ...changes,
        });
        f.trialReceipt = (operation = OP, changes = {}) => ({
          operation_id: operation,
          command: "trial.create",
          state: "committed",
          entity_type: "trial_appointment",
          entity_id: APPT,
          committed_at: "2026-10-01T00:00:00Z",
          result: f.trialRow(),
          ...changes,
        });
        const get = f.api.get;
        f.api.get = (path, token) => {
          if (path.includes("trial-appointments") || path.startsWith("/automations/operations/"))
            return new Promise((resolve, reject) =>
              f.trialReads.push({ path, token, resolve, reject }),
            );
          return get(path, token);
        };
        f.trialFields = {
          schedule: {
            starts_at: "2030-01-01T12:00:00Z",
            ends_at: "2030-01-01T13:00:00Z",
            timezone: "UTC",
          },
          location: "Sample room",
          program: { mode: "none" },
        };
        f.createTrial = () => {
          f.trialPromise = f.store.trialAppointments
            .createTrialAppointment(LEAD, f.trialFields)
            .catch((error) => {
              f.trialError = error.message;
            });
        };
        f.checkTrial = () => {
          f.trialPromise = f.store.trialAppointments
            .checkTrialAppointmentResult(LEAD)
            .catch((error) => {
              f.trialError = error.message;
            });
        };
        f.viewTrial = () => f.store.trialAppointments.trialOperations.get(LEAD);
      },
      { LEAD, APPT, OP, STUDIO },
    );
    if (!preview) await p.evaluate(() => f.store.refreshLeads());
    await flush(p);
    return { p, close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}
export async function resolveTrialCurrent(p, index = 0) {
  await p.waitForFunction((index) => f.trialReads.length > index, index);
  await p.evaluate((index) => f.trialReads[index].resolve(f.trialRow()), index);
  await p.waitForFunction(() => f.rowReads.length > 0);
  await p.evaluate(() => f.readRow(f.rowReads.length - 1));
  await p.evaluate(() => f.trialPromise);
  await flush(p);
}

export async function mountDriftingTrialPreview(browser) {
  const { createCommonJsPacker } = await import("./store-browser-harness.mjs");
  const { add, modules } = createCommonJsPacker({
    "@/lib/api": `exports.ApiError=class ApiError extends Error{};exports.api=new Proxy({},{get(){throw Error('Unexpected preview API');}});`,
    "@/lib/access-identity": `exports.captureAccessIdentity=()=>{throw Error('Unexpected preview authority')};exports.invalidateAccessIdentity=()=>{};`,
    "@/lib/studio-state-cookie": `exports.getActiveStudioIdCookie=()=>null;`,
  });
  const react = add("react"),
    dom = add("react-dom/client"),
    actions = add("@/lib/store-lead-actions"),
    resource = add("@/lib/store-resource-scope");
  const p = await browser.newPage();
  try {
    await p.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
    );
    await p.goto("http://localhost/");
    await p.addScriptTag({
      content: `(()=>{const process={env:{NODE_ENV:'production'}},modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
const React=require(${react});window.f={};function App(){const [count,setCount]=React.useState(0);const leadsRef=React.useRef([{id:'local-lead',program_id:null}]),studentsRef=React.useRef([]),scopeRef=React.useRef(require(${resource}).createResourceScope());f.rerender=()=>setCount(n=>n+1);f.actions=require(${actions}).useStoreLeadActions({leadsRef,studentsRef,leadMutationScopeRef:scopeRef,businessDateRef:{current:'2030-01-01'},beginLeadMutation:()=>()=>{},beginLiveAuthRequest:()=>{throw Error('Unexpected live auth')},beltLaddersRef:{current:[]},beltRanksRef:{current:[]},isPreviewMode:true,programsRef:{current:[{id:'program-local',archived_at:null}]},persistLeads:()=>{},persistStudents:()=>{},onStudentMutation:()=>{},refreshStudents:async()=>[],setLeads:()=>{},setLeadsLoaded:()=>{},setLeadsLoadError:()=>{}});return React.createElement('output',null,'ready '+count)}f.root=require(${dom}).createRoot(document.getElementById('root'));f.root.render(React.createElement(App));})();`,
    });
    await p.getByText("ready 0", { exact: true }).waitFor();
    return p;
  } catch (error) {
    await p.close();
    throw error;
  }
}

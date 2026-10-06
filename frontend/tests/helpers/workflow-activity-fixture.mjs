import { readFileSync } from "node:fs";
import { register } from "node:module";
import { createCommonJsPacker } from "./store-browser-harness.mjs";
import {
  fixture as workspaceFixture,
  detail,
  catalog,
  ids as workspaceIds,
} from "./workflow-workspace-fixture.mjs";
register("./path-alias-loader.mjs", import.meta.url);
export const { createWorkflowWorkspace } =
  await import("../../src/lib/automation-workflow-workspace-controller.ts");
export const { ApiError, CommandOutcomeUnknown } = await import("../../src/lib/api.ts");
export { deferred, tick } from "./workflow-workspace-fixture.mjs";
export const specimen = JSON.parse(
  readFileSync(new URL("../fixtures/workflow-activity-contracts.json", import.meta.url), "utf8"),
);
export const clone = (value) => structuredClone(value);
export const ids = {
  ...specimen.ids,
  user: workspaceIds.user,
  other: workspaceIds.other,
  draft: workspaceIds.draft,
};
export const scope = { userId: ids.user, studioId: ids.studio, role: "admin" };
export const graph = () => clone(specimen.test_request.graph);
export const nodeId = specimen.test_request.email_node_id;
export const runTarget = { kind: "run", workflowId: ids.workflow, runId: ids.run };
export const testTarget = { kind: "test", workflowId: ids.workflow };
export const key = (target) =>
  target.kind === "run" ? `run:${target.workflowId}:${target.runId}` : `test:${target.workflowId}`;
export const marker = (patch = {}) => ({
  operation_id: ids.operation,
  command: "test_email.create",
  owner_user_id: ids.user,
  owner_studio_id: ids.studio,
  target: testTarget,
  email_node_id: nodeId,
  ...patch,
});
export const delivery = (state = "queued", operationId = ids.operation) => ({
  ...clone(specimen.deliveries.find((value) => value.state === state)),
  operation_id: operationId,
});
export const receipt = (operationId = ids.operation, command = "test_email.create") => {
  const result = clone(command === "run.cancel" ? specimen.receipts[0] : specimen.receipts.at(-1));
  result.operation_id = operationId;
  if (command === "test_email.create") result.result.operation_id = operationId;
  return result;
};
export const workflowDetail = (id = ids.workflow, draftGraph = graph()) =>
  detail({ id, draft_graph: draftGraph, draft_layout: { positions: {} } });
export const activityCatalog = {
  ...clone(catalog),
  delivery_status: {
    mode: "test",
    configured: true,
    can_enable: true,
    sender: "samples@example.com",
    test_recipient: "admin@example.com",
    reason: null,
  },
  capabilities: { can_start: false, can_test_email: true, disabled_reason: null },
};
export const JOURNAL = "koaryu-workflow-activity-v1";
export const markers = (f) => JSON.parse(f.saved.get(JOURNAL) ?? '{"entries":[]}').entries;
export const operation = (w, target = testTarget) =>
  w.activity.getSnapshot().operations.get(key(target));
export function fixture() {
  const f = workspaceFixture(),
    calls = [],
    writes = [];
  f.setStudio(ids.studio);
  let allocations = 0;
  const set = f.storage.setItem;
  f.storage.setItem = (key, value) => {
    writes.push({ key, value });
    set(key, value);
  };
  const responses = {
    simulate: () => clone(specimen.simulations[0].response),
    listRuns: () => clone(specimen.page),
    getRun: () => clone(specimen.cancellation.result),
    cancelRun: () => clone(specimen.cancellation.result),
    sendTestEmail: (_workflow, body) => delivery("queued", body.operation_id),
    getOperation: (identity) => receipt(identity.operationId, identity.command),
    getTestDelivery: (identity) => delivery("accepted", identity.operationId),
  };
  const activityApi = Object.fromEntries(
    Object.keys(responses).map((name) => [
      name,
      async (...args) => {
        calls.push({ name, args });
        return responses[name](...args);
      },
    ]),
  );
  f.api.catalog = async () => clone(activityCatalog);
  f.api.detail = async (id) => workflowDetail(id);
  f.dependencies.activityApi = activityApi;
  f.dependencies.uuid = () =>
    ++allocations === 1
      ? ids.operation
      : `60000000-0000-4000-8000-${String(allocations).padStart(12, "0")}`;
  return {
    ...f,
    calls,
    writes,
    responses,
    activityApi,
    get allocations() {
      return allocations;
    },
  };
}
export function workspace(f, owner = scope) {
  return createWorkflowWorkspace({ mode: "live", owner, token: "token-1" }, f.dependencies);
}
export async function opened(f, draftGraph = graph()) {
  f.api.detail = async (id) => workflowDetail(id, draftGraph);
  const w = workspace(f);
  await w.loadCatalog();
  await w.openWorkflow(ids.workflow);
  return w;
}
export function bundleActivity() {
  const { add, modules } = createCommonJsPacker({
    "@/lib/supabase/client": `exports.createClient=()=>({auth:{onAuthStateChange(callback){window.fixture.auth.add(callback);return {data:{subscription:{unsubscribe(){window.fixture.auth.delete(callback)}}}}}}});`,
    "./api.ts": `module.exports=require('@/lib/api');`,
    "@/lib/api": `class ApiError extends Error {constructor(message,status){super(message);this.status=status}};exports.ApiError=ApiError;window.fixture.ApiError=ApiError;exports.CommandOutcomeUnknown=require('@/lib/command-outcome').CommandOutcomeUnknown;exports.api={get:async(path,token)=>{const f=window.fixture;f.reads.push({path,token});if(path.endsWith('/catalog'))return structuredClone(f.catalog);if(path.includes('/operations/'))return structuredClone(f.receipt);if(path.includes('/test-deliveries/'))return structuredClone(f.delivery);return structuredClone(f.detail)},post:(path,body,token)=>new Promise((resolve,reject)=>window.fixture.requests.push({path,body,token,resolve,reject}))};`,
    "workflow-activity-consumer.tsx": `
      const React=require('react');
      const {getBrowserWorkflowWorkspace}=require('@/lib/automation-workflow-workspace-controller');
      const {publishAccessIdentity,invalidateAccessIdentity}=require('@/lib/access-identity');
      const {setActiveStudioIdCookie}=require('@/lib/studio-state-cookie');
      const f=window.fixture;
      f.publish=(patch={})=>{f.profile={...f.profile,...patch};publishAccessIdentity(f.profile,patch.accessAllowed??true)};
      f.invalidate=invalidateAccessIdentity;f.cookie=setActiveStudioIdCookie;
      f.cookie(f.scope.studioId);f.publish();
      module.exports=function Consumer(){
        const [workspace]=React.useState(()=>getBrowserWorkflowWorkspace({mode:'live',owner:f.scope,token:f.token}));
        const snapshot=React.useSyncExternalStore(workspace.activity.subscribe,workspace.activity.getSnapshot,workspace.activity.getSnapshot);
        f.renders++;
        React.useEffect(()=>{f.workspace=workspace;f.ready=(async()=>{await workspace.loadCatalog();if(!workspace.getSnapshot().editor)await workspace.openWorkflow(f.detail.id)})();},[workspace]);
        return React.createElement('output',{'data-activity':true},JSON.stringify({operations:[...snapshot.operations.values()].map(({isCurrent,...value})=>value),storage:snapshot.storage.status}));
      };
    `,
  });
  const react = add("react"),
    dom = add("react-dom/client"),
    consumer = add("workflow-activity-consumer.tsx");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}
    window.fixture={auth:new Set(),reads:[],requests:[],renders:0,catalog:${JSON.stringify(activityCatalog)},detail:${JSON.stringify(workflowDetail())},receipt:${JSON.stringify(receipt())},delivery:${JSON.stringify(delivery("accepted"))},scope:${JSON.stringify(scope)},token:'token-1',profile:{user:{id:'${ids.user}'},studio_id:'${ids.studio}',role:'admin',membership_status:'active'}};
    const React=require(${react}),root=require(${dom}).createRoot(document.getElementById('root')),Consumer=require(${consumer});
    let generation=0;window.fixture.mount=()=>root.render(React.createElement(Consumer,{key:++generation}));window.fixture.unmount=()=>root.render(null);window.fixture.mount();})();`;
}

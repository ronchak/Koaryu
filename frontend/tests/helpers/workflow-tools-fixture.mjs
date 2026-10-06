import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { chromium, expect } from "@playwright/test";
import { createCommonJsPacker } from "./store-browser-harness.mjs";
import { frontend, fixtureTheme } from "./workflow-graph-fixture.mjs";
import { detail } from "./workflow-workspace-fixture.mjs";

export const specimen = JSON.parse(
  readFileSync(resolve(frontend, "tests/fixtures/workflow-activity-contracts.json"), "utf8"),
);
export const ids = { ...specimen.ids, user: "10000000-0000-4000-8000-000000000001" };
export const emailNode = specimen.test_request.email_node_id;
const catalog = JSON.parse(
  readFileSync(resolve(frontend, "src/lib/generated/workflow-preview-catalog.json"), "utf8"),
);
const cssStubs = { "@/components/leads/leads-ledger.module.css": "module.exports={}" };
let css =
  fixtureTheme +
  "button,input,select,textarea{font:inherit}button{cursor:pointer}h1,h2,h3,h4,p{margin:0}#fixture-bar{display:flex;gap:8px;padding:8px;flex-wrap:wrap}#fixture-bar>*{max-width:100%;min-height:44px}#fixture-bar label{display:flex;gap:4px;align-items:center;flex-wrap:wrap}.koaryu-modal-root{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center}.koaryu-modal-backdrop{position:absolute;inset:0;background:#000a}.koaryu-modal-panel{position:relative}";
for (const [index, name] of [
  "workflow-workspace",
  "workflow-graph-editor",
  "workflow-node-inspector",
].entries()) {
  const source = readFileSync(
    resolve(frontend, `src/components/automations/${name}.module.css`),
    "utf8",
  );
  const classes = Object.fromEntries(
    [...source.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => [match[1], `t${index}_${match[1]}`]),
  );
  cssStubs[`./${name}.module.css`] = `module.exports=${JSON.stringify(classes)}`;
  css += source.replace(
    /:global\(([^)]+)\)|\.([a-zA-Z][\w-]*)/g,
    (_, global, local) => global ?? `.${classes[local]}`,
  );
}
css += readFileSync(resolve(frontend, "node_modules/@xyflow/react/dist/style.css"), "utf8");
export const toolsCss = css;
const cache = new Map();
export function bundleTools(options = {}) {
  const settings = { preview: false, picker: false, entityType: "student", ...options },
    key = JSON.stringify(settings);
  if (cache.has(key)) return cache.get(key);
  const { add, modules } = createCommonJsPacker({
    ...cssStubs,
    "./generated/workflow-preview-catalog.json": `module.exports=${JSON.stringify(catalog)}`,
    "@xyflow/react/dist/style.css": "module.exports={}",
    "next/dynamic": `const React=require('react');module.exports=(loader,options)=>{const Lazy=React.lazy(loader);return props=>React.createElement(React.Suspense,{fallback:React.createElement(options.loading)},React.createElement(Lazy,props));};`,
    "next/navigation": `exports.useRouter=()=>window.fixture.router;`,
    "@/lib/store": `module.exports=require('@/lib/store-contexts');`,
    "@/lib/supabase/client": `exports.createClient=()=>({auth:{onAuthStateChange(callback){const f=window.fixture;if(f.preview)throw Error('Preview auth');f.auth.add(callback);return {data:{subscription:{unsubscribe(){f.auth.delete(callback)}}}}}}});`,
    "./api.ts": `module.exports=require('@/lib/api');`,
    "@/lib/api": `class ApiError extends Error{constructor(message,status){super(message);this.status=status}}exports.ApiError=ApiError;exports.CommandOutcomeUnknown=require('@/lib/command-outcome').CommandOutcomeUnknown;window.fixture.ApiError=ApiError;window.fixture.CommandOutcomeUnknown=exports.CommandOutcomeUnknown;exports.api={get:(path,token,options)=>window.fixture.read(path,token,options),post:(path,body,token)=>window.fixture.command(path,body,token),put:(path,body,token)=>window.fixture.command(path,body,token)};`,
    "tools-fixture.tsx": `
import React from 'react';
import {WorkflowWorkspace} from '@/components/automations/workflow-workspace';
import {WorkflowSimulationContextPicker} from '@/components/automations/workflow-simulation-context-picker';
import {getBrowserWorkflowWorkspace} from '@/lib/automation-workflow-workspace-controller';
import {workflowPreviewSource,workflowPreviewCatalog} from '@/lib/automation-workflow-preview';
import {publishAccessIdentity,invalidateAccessIdentity} from '@/lib/access-identity';
import {setActiveStudioIdCookie} from '@/lib/studio-state-cookie';
import {refreshLiveLeadDataset} from '@/lib/store-lead-refresh-model';
import {createResourceScope} from '@/lib/store-resource-scope';
import {ConfigStoreContext,StudioStoreContext,StudentsStoreContext,ProgramsStoreContext,LeadsStoreContext,BeltsStoreContext} from '@/lib/store-contexts';
const f=window.fixture,spec=f.spec;
if(f.preview)f.routeWorkflow='70000000-0000-4000-8000-000000000001';
const clone=value=>structuredClone(value);
f.catalog=clone(workflowPreviewCatalog);
f.catalog.capabilities={can_start:false,can_test_email:true,disabled_reason:null};
f.catalog.delivery_status={mode:"test",configured:true,can_enable:true,sender:"sample@example.invalid",test_recipient:"verified@example.invalid",reason:null};
f.current=${JSON.stringify(detail({ id: ids.workflow, draft_graph: specimen.test_request.graph, draft_layout: { positions: {} } }))};
f.currentRun=clone(spec.cancellation.baseline);
f.runPage=clone(spec.page);f.runPage.has_more=true;
f.delivery=clone(spec.deliveries.find(row=>row.state==='accepted'));
f.publish=()=>{setActiveStudioIdCookie(f.studio);if(!f.preview)publishAccessIdentity({user:{id:f.user},studio_id:f.studio,role:f.role,membership_status:'active'},true)};
f.publish();
f.change=patch=>{if(['studio','user','role'].some(key=>Object.hasOwn(patch,key)&&patch[key]!==f[key])){f.epoch++;if(!f.preview)invalidateAccessIdentity();}Object.assign(f,patch);f.publish();f.notify()};
f.owner=()=>getBrowserWorkflowWorkspace(f.preview?{mode:'preview',source:workflowPreviewSource}:{mode:'live',owner:{userId:f.user,studioId:f.studio,role:f.role},token:f.token});
f.edit=change=>f.owner().edit(change);
f.eventTypes={student:'student.enrolled',promotion:'student.promoted',lead:'lead.created',trial_appointment:'trial.scheduled',invoice:'invoice.overdue',payment:'invoice.payment_failed',belt_test_recipient:'belt_test.approved'};
f.setType=type=>{f.entityType=type;if(!f.picker){const trigger=f.owner().getSnapshot().editor.history.present.graph.nodes.find(row=>row.type==='trigger');f.edit({kind:'update_config',node_id:trigger.id,update:{type:'trigger',config:{...trigger.config,event_type:f.eventTypes[type]}}});}f.notify()};
const id=n=>String(n).padStart(8,'0')+'-0000-4000-8000-000000000001';
const student=(n,name)=>({id:id(n),legal_first_name:name,legal_last_name:'Student',preferred_name:null,status:'active',program_memberships:[]});
f.resources={
 students:[student(11,'Alex'),student(12,'Blair')],
 leads:[{id:id(21),first_name:'Casey',last_name:'Lead',stage:'inquiry'},{id:id(22),first_name:'Drew',last_name:'Lead',stage:'trial_scheduled'}],
 promotions:[{id:id(31),student_id:id(11),student_name:'Alex Student',promoted_at:'2026-10-01',from_rank_name:'White',to_rank_name:'Yellow'}],
 trials:[{id:id(41),lead_id:id(21),starts_at:'2026-10-06T10:00:00Z',ends_at:'2026-10-06T10:30:00Z',timezone:'UTC',location:'North studio',status:'scheduled'}],
 invoices:[{id:id(51),invoice_number:'INV-501',number:null,status:'open',due_date:'2026-10-01',amount_remaining_cents:12345,currency:'usd'}],
 payments:[{id:id(61),invoice_id:id(51),status:'failed',amount_cents:6789,currency:'usd',processed_at:'2026-10-01',created_at:'2026-10-01',failure_message:'PRIVATE FAILURE'}],
 events:[{
  id:id(71),
  studio_id:f.studio,
  name:"Autumn grading",
  ladder_id:"00000000-0000-4000-8000-000000000003",
  program_id:null,
  starts_at:"2026-10-08T10:00:00Z",
  ends_at:"2026-10-08T11:00:00Z",
  timezone:"UTC",
  location:"Studio",
  status:"scheduled",
  revision:3,
  schedule_revision:2,
  created_by:null,
  created_at:"2026-10-01T00:00:00Z",
  updated_at:"2026-10-02T12:00:00Z",
 }],
 recipients:[{
  id:id(81),
  studio_id:f.studio,
  event_id:id(71),
  student_id:id(11),
  student_program_membership_id:null,
  approved_schedule_revision:2,
  approved_current_rank_id:id(90),
  approved_target_rank_id:id(91),
  state:"approved",
  revision:2,
  approved_by:null,
  approved_at:"2026-10-02T12:00:00Z",
  revoked_at:null,
  created_at:"2026-10-02T12:00:00Z",
  updated_at:"2026-10-02T12:00:00Z",
 }]
};
f.requests=[];f.reads=[];f.sources=[];f.held=[];f.receipts={};f.errors={};f.hold={};f.sourceEpoch=0;
f.wait=(kind,value)=>f.hold[kind]||f.hold.all?new Promise((resolve,reject)=>f.held.push({kind,value,resolve,reject})):Promise.resolve(clone(value));
f.release=(kind,override)=>{const row=f.held.find(row=>!row.done&&row.kind===kind);if(!row)throw Error('Missing held '+kind);row.done=true;row.resolve(clone(override??row.value));};
f.read=async(path,token,options)=>{
 if(f.preview)throw Error('Preview API');f.reads.push({path,token,signal:Boolean(options?.signal)});
 const kind=path.endsWith('/catalog')?'catalog':path.includes('/runs?')?'runs':path.startsWith('/automations/runs/')?'run':path.includes('/operations/')?'receipt':path.includes('/test-deliveries/')?'delivery':path.includes('/billing/invoices/page')?'invoices':path.includes('/billing/payments/page')?'payments':'detail';
 if(f.errors[kind])throw new f.ApiError('PRIVATE PROVIDER ERROR',f.errors[kind]);
 let value;
 if(kind==='catalog')value=f.catalog;
 else if(kind==='runs')value=path.includes('cursor=')?{items:[],next_cursor:null,has_more:false}:f.runPage;
 else if(kind==='run')value=f.currentRun;
 else if(kind==='receipt'){
  const operation=path.split('/').at(-1),marker=JSON.parse(sessionStorage.getItem('koaryu-workflow-activity-v1')??'{"entries":[]}').entries.find(row=>row.operation_id===operation);
  value=f.receipts[operation]??clone(marker?.command==='run.cancel'?spec.receipts[0]:spec.receipts.at(-1));
  value.operation_id=operation;if(value.command==='test_email.create'){value.result.operation_id=operation;f.delivery.operation_id=operation;}
 }else if(kind==='delivery')value=f.delivery;
 else if(kind==='invoices'||kind==='payments')value={items:path.includes('cursor=')?[]:f.resources[kind],next_cursor:path.includes('cursor=')?null:'billing opaque+/=',complete:path.includes('cursor=')};
 else value=f.current;
 return f.wait(kind,value);
};
f.command=(path,body,token)=>{
 if(f.preview)throw Error('Preview command');
 if(path.endsWith('/simulate')){f.simulations.push({path,body,token});if(f.errors.simulation)return Promise.reject(new f.ApiError('PRIVATE SIMULATION ERROR',f.errors.simulation));return f.wait('simulation',f.simulationOverride??spec.simulations[f.simulationIndex].response);}
 const request={path,body,token,done:false};f.requests.push(request);f.notify();return new Promise((resolve,reject)=>Object.assign(request,{resolve,reject}));
};
f.setReceipt=(request,state='accepted')=>{
 const cancel=request.path.endsWith('/cancel');
 const receipt=clone(cancel?spec.receipts[0]:spec.receipts.at(-1));receipt.operation_id=request.body.operation_id;
 if(cancel){f.currentRun=clone(state==='sending'?spec.cancellation.sending_result:spec.cancellation.result);receipt.result=clone(f.currentRun);}
 else {receipt.result.operation_id=request.body.operation_id;f.delivery={...clone(spec.deliveries.find(row=>row.state===state)),operation_id:request.body.operation_id};}
 f.receipts[request.body.operation_id]=receipt;
};
f.complete=(state='queued')=>{const request=f.requests.find(row=>!row.done);if(!request)throw Error('No pending request');request.done=true;f.setReceipt(request,state);request.resolve(clone(request.path.endsWith('/cancel')?f.currentRun:f.delivery));f.notify()};
f.fail=()=>{const request=f.requests.find(row=>!row.done);if(!request)throw Error('No pending request');request.done=true;f.setReceipt(request,'accepted');request.reject(new f.CommandOutcomeUnknown());f.notify()};
f.source=async(kind,query={})=>{if(f.preview)throw Error('Preview source');f.sources.push({kind,query});if(f.errors[kind])throw Error('PRIVATE SOURCE ERROR');let rows=f.resources[kind];if(kind==='students'&&query.search)rows=rows.filter(row=>(row.legal_first_name+' '+row.legal_last_name).toLowerCase().includes(query.search.toLowerCase()));return f.wait(kind,query.cursor?[]:rows)};
function Stores({children}){
 const [leads,setLeads]=React.useState([]),[leadsLoaded,setLeadsLoaded]=React.useState(false),[leadsLoadError,setLeadsLoadError]=React.useState(null);
 const scope=React.useRef(createResourceScope());
 const begin=()=>{const epoch=f.epoch,token=f.token;return {token,isCurrent:()=>epoch===f.epoch&&token===f.token,canRetryAfterTokenChange:()=>epoch===f.epoch&&token!==f.token}};
 const resourceEpoch=f.sourceEpoch,identityEpoch=f.epoch;
 const current=()=>f.role==='admin'&&f.sourceEpoch===resourceEpoch&&f.epoch===identityEpoch;
 const ready=async(kind,query)=>{const epoch=f.epoch,sourceEpoch=f.sourceEpoch;const items=await f.source(kind,query);return {status:'ready',value:{items,next_cursor:query.cursor?null:'source opaque+/=',has_more:!query.cursor},isCurrent:()=>epoch===f.epoch&&sourceEpoch===f.sourceEpoch}};
 const refreshLeads=()=>refreshLiveLeadDataset({beginLiveAuthRequest:begin,scopeRef:scope,fetchLeads:()=>f.source('leads'),setLeads,setLeadsLoaded,setLeadsLoadError});
 f.supersedeLeads=()=>{scope.current.sequence++;};f.setLeadsError=setLeadsLoadError;f.resetLeads=()=>{scope.current=createResourceScope();f.sourceEpoch++;setLeads([]);setLeadsLoaded(true);f.notify()};
 const trialAppointments={trialStorage:{status:'ready',isCurrent:current},listTrialAppointments:(leadId,query)=>ready('trials',{...query,leadId})};
 const beltTests={storage:{status:'ready',isCurrent:current},listEvents:query=>ready('events',query),listRecipients:(eventId,query)=>ready('recipients',{...query,eventId})};
 const studentStore={students:f.availableStudentLabels?f.resources.students:[],listStudentsPage:async(query,options)=>{const items=await f.source('students',{...query,signal:Boolean(options?.signal)});return {items,total:2,page_size:50,page_ordinal:query.cursor?2:1,has_next:!query.cursor,next_cursor:query.cursor?null:'student opaque+/=',has_previous:Boolean(query.cursor),previous_cursor:null}}};
 return <ConfigStoreContext.Provider value={{isPreviewMode:f.preview,token:f.token,subscriptionRequired:false}}><StudioStoreContext.Provider value={{identityReady:true,identityGeneration:f.epoch,currentRole:f.role,currentStudioId:f.studio,currentUserId:f.user}}><StudentsStoreContext.Provider value={studentStore}><LeadsStoreContext.Provider value={{leads,leadsLoaded,leadsLoadError,refreshLeads,trialAppointments}}><ProgramsStoreContext.Provider value={{programs:[],programsLoaded:true,programsLoadError:null,refreshPrograms:async()=>[]}}><BeltsStoreContext.Provider value={{beltRanks:f.availableStudentLabels?[{id:id(91),name:'Yellow'}]:[],refreshBeltLadders:async()=>({ladders:[]}),loadPromotionHistory:(studentId,options)=>f.source('promotions',{studentId,force:options.force}),beltTests}}>{children}</BeltsStoreContext.Provider></ProgramsStoreContext.Provider></LeadsStoreContext.Provider></StudentsStoreContext.Provider></StudioStoreContext.Provider></ConfigStoreContext.Provider>
}
function Picker(){const [selection,setSelection]=React.useState({context:{kind:'synthetic'},label:'Synthetic sample',isCurrent:()=>true});f.selection=selection;return <main className="t0_workspace"><WorkflowSimulationContextPicker key={f.entityType} entityType={f.entityType} value={selection} onChange={setSelection} isCurrent={()=>f.role==='admin'} disabled={f.role!=='admin'}/><output data-selection>{JSON.stringify(selection?.context??null)}</output></main>}
export default function Fixture(){React.useSyncExternalStore(f.subscribe,()=>f.version,()=>f.version);return <><div id="fixture-bar" aria-label="Synthetic fixture controls"><span>Synthetic local fixture</span><label>Fixture source<select value={f.entityType} onChange={e=>f.setType(e.target.value)}>{Object.keys(f.eventTypes).map(type=><option key={type}>{type}</option>)}</select></label><label>Fixture simulation<select value={f.simulationIndex} onChange={e=>f.change({simulationIndex:Number(e.target.value)})}>{spec.simulations.map((row,index)=><option key={row.name} value={index}>{row.name}</option>)}</select></label><button onClick={()=>f.change({token:f.token+'x'})}>Renew token fixture</button><button onClick={()=>f.change({role:f.role==='admin'?'staff':'admin'})}>Switch authority fixture</button><button onClick={()=>f.fail() } disabled={!f.requests.some(row=>!row.done)}>Lose response fixture</button>{['queued','accepted','unknown','sending'].map(state=><button key={state} disabled={!f.requests.some(row=>!row.done)} onClick={()=>f.complete(state)}>Complete {state} fixture</button>)}<button onClick={()=>{f.delivery.state='unknown';f.notify()}}>Set current unknown fixture</button><button onClick={()=>{f.storageBlocked=!f.storageBlocked;f.notify()}}>Toggle storage fixture</button><button onClick={()=>location.reload()}>Reload fixture</button><button onClick={()=>{f.hold.students=!f.hold.students;f.hold.leads=f.hold.students;f.hold.trials=f.hold.students;f.notify()}}>Toggle held source fixture</button><button disabled={!f.held.some(row=>!row.done)} onClick={()=>{const row=f.held.find(row=>!row.done);f.release(row.kind);f.notify()}}>Release source fixture</button><button disabled={f.picker} onClick={()=>{f.routeWorkflow=f.routeWorkflow===spec.ids.workflow?'99999999-0000-4000-8000-000000000001':spec.ids.workflow;f.current={...f.current,id:f.routeWorkflow};f.notify()}}>Switch workflow fixture</button></div><Stores key={f.epoch}>{f.picker?<Picker/>:<WorkflowWorkspace key={f.routeWorkflow} workflowId={f.routeWorkflow}/>}</Stores></>}
`,
  });
  const react = add("react"),
    dom = add("react-dom/client"),
    entry = add("tools-fixture.tsx");
  const result = `(()=>{const process={env:{NODE_ENV:'production'}};window.fixture={...${JSON.stringify(settings)},spec:${JSON.stringify(specimen)},user:'${ids.user}',studio:'${ids.studio}',role:'admin',token:'synthetic-token',routeWorkflow:'${ids.workflow}',epoch:0,version:0,auth:new Set(),listeners:new Set(),simulations:[],simulationIndex:0,storageReads:0,storageWrites:0,storageBlocked:false};const f=window.fixture;f.subscribe=fn=>{f.listeners.add(fn);return()=>f.listeners.delete(fn)};f.notify=()=>{f.version++;for(const fn of f.listeners)fn()};f.router={push:()=>{},replace:()=>{}};const get=Storage.prototype.getItem,set=Storage.prototype.setItem;Storage.prototype.getItem=function(key){if(this===sessionStorage){f.storageReads++;if(f.storageBlocked)throw Error('Synthetic storage blocked')}return get.call(this,key)};Storage.prototype.setItem=function(key,value){if(this===sessionStorage){f.storageWrites++;if(f.storageBlocked)throw Error('Synthetic storage blocked')}return set.call(this,key,value)};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react}),root=require(${dom}).createRoot(document.getElementById('root')),Fixture=require(${entry}).default;f.unmount=()=>root.render(null);f.mount=()=>root.render(React.createElement(Fixture));f.mount();})();`;
  cache.set(key, result);
  return result;
}
export const toolsHtml = (options) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic workflow tools</title><style>${toolsCss}</style></head><body><div id="root"></div><script>${bundleTools(options).replaceAll("</script", "<\\/script")}</script></body></html>`;
export const flush = (page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
export async function mountTools(run, options = {}) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: toolsHtml(options) }),
    );
    await page.goto("http://localhost/");
    await expect(page.getByText("Synthetic local fixture", { exact: true })).toBeVisible();
    if (!options.picker)
      await expect(
        page.getByRole("region", { name: "Workflow simulation", exact: true }),
      ).toBeVisible();
    await flush(page);
    await run(page, errors);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}
export async function selectEmail(page) {
  await page.getByRole("button", { name: "Steps", exact: true }).click();
  await page.locator(`[data-workflow-step="${emailNode}"]`).first().click();
  await expect(page.getByRole("button", { name: "Send sample email", exact: true })).toBeEnabled();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv.includes("--serve"))
    throw Error("Use --serve. This fixture binds only to 127.0.0.1 and uses synthetic data.");
  const port = Number(process.env.PORT ?? 4338);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid fixture port");
  const html = toolsHtml({ preview: process.argv.includes("--preview") });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(html);
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`Synthetic workflow tools fixture: http://127.0.0.1:${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
}

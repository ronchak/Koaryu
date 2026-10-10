import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { createCommonJsPacker } from "./store-browser-harness.mjs";
import { frontend, fixtureTheme } from "./workflow-graph-fixture.mjs";
import { detail, ids } from "./workflow-workspace-fixture.mjs";

const cssFiles = ["workflow-workspace", "workflow-graph-editor", "workflow-node-inspector"];
const stubs = { "@/components/leads/leads-ledger.module.css": "module.exports={}" };
let css =
  fixtureTheme +
  "button,input,textarea,select{font:inherit}button{cursor:pointer}h1,h2,h3,h4,p{margin:0}#fixture-bar{display:flex;gap:8px;padding:8px;background:var(--surface);flex-wrap:wrap}#fixture-bar button{min-height:44px}";
for (const [index, name] of cssFiles.entries()) {
  const source = readFileSync(
    resolve(frontend, `src/components/automations/${name}.module.css`),
    "utf8",
  );
  const classes = Object.fromEntries(
    [...source.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => [match[1], `c${index}_${match[1]}`]),
  );
  stubs[`./${name}.module.css`] = `module.exports=${JSON.stringify(classes)}`;
  css += source.replace(
    /:global\(([^)]+)\)|\.([a-zA-Z][\w-]*)/g,
    (_, global, local) => global ?? `.${classes[local]}`,
  );
}
css += readFileSync(resolve(frontend, "node_modules/@xyflow/react/dist/style.css"), "utf8");
export const workflowCompositionCss = css;
const snapshot = JSON.parse(
  readFileSync(resolve(frontend, "src/lib/generated/workflow-preview-catalog.json"), "utf8"),
);
// Proof mode forwards automation responses unchanged. Unrelated picker reads
// stay explicitly synthetic and cannot establish current source authority.
export function createCompositionProofFetch(baseUrl, forward) {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(base.hostname) ||
    base.pathname !== "/api/v1" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw Error("Composition proof requires an explicit loopback /api/v1 URL");
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const routes = {
    GET: [
      "/automations/catalog",
      "/automations/workflows",
      `/automations/workflows/${uuid}`,
      `/automations/workflows/${uuid}/runs`,
      `/automations/runs/${uuid}`,
      `/automations/operations/${uuid}`,
      `/automations/test-deliveries/${uuid}`,
    ],
    POST: [
      "/automations/workflows",
      "/automations/workflows/validate",
      `/automations/workflows/${uuid}/(?:publish|start|pause|archive|simulate|test-email)`,
    ],
    PUT: [`/automations/workflows/${uuid}`],
  };
  return async (input, init = {}) => {
    const url = new URL(input);
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith(base.pathname + "/")
    )
      throw Error("Unexpected proof destination");
    const path = url.pathname.slice(base.pathname.length);
    const method = init.method ?? "GET";
    if (
      method === "GET" &&
      ((path === "/belts/ladders" && !url.search) ||
        (path === "/programs" &&
          ["", "?include_archived=false", "?include_archived=true"].includes(url.search)))
    )
      return Response.json([], { headers: { "X-Composition-Source": "fixture-only-picker" } });
    if (!(routes[method] ?? []).some((pattern) => new RegExp(`^${pattern}$`, "i").test(path)))
      throw Error("Request is outside the bounded automation proof");
    if (
      init.body != null &&
      (typeof init.body !== "string" || new TextEncoder().encode(init.body).length > 1024 * 1024)
    )
      throw Error("Composition request exceeds the 1 MiB text body bound");
    return forward(input, { ...init, redirect: "error" });
  };
}

export function bundleWorkflowComposition(options = {}) {
  const settings = {
    preview: false,
    route: "/automations",
    role: "admin",
    mode: "production",
    ...options,
  };
  const proof = settings.proof;
  if (proof) {
    createCompositionProofFetch(proof.apiUrl, () => {});
    if (
      settings.preview ||
      !/^[0-9a-f-]{36}$/i.test(proof.actorId) ||
      !/^[0-9a-f-]{36}$/i.test(proof.studioId) ||
      proof.token !== "composition-synthetic-token"
    )
      throw Error("Proof mode requires the explicit synthetic SQL fixture identity");
  }
  const moduleStubs = {
    ...stubs,
    "./generated/workflow-preview-catalog.json": `module.exports=${JSON.stringify(snapshot)}`,
    "@xyflow/react/dist/style.css": "module.exports={}",
    "next/dynamic": `const React=require('react');module.exports=(loader,options)=>{const Lazy=React.lazy(loader);return props=>React.createElement(React.Suspense,{fallback:React.createElement(options.loading)},React.createElement(Lazy,props));};`,
    "next/navigation": `exports.useRouter=()=>window.fixture.router;`,
    "@/lib/store": `module.exports=require('@/lib/store-contexts');`,
    "@/lib/supabase/client": `exports.createClient=()=>({auth:{onAuthStateChange(callback){if(window.fixture.preview)throw Error('Preview auth');window.fixture.authCalls++;window.fixture.auth.add(callback);return {data:{subscription:{unsubscribe(){window.fixture.auth.delete(callback)}}}}}}});`,
    "@/lib/api": `class ApiError extends Error {constructor(message,status){super(message);this.status=status}};exports.ApiError=ApiError;exports.CommandOutcomeUnknown=require('@/lib/command-outcome').CommandOutcomeUnknown;exports.api={get:(path,token)=>window.fixture.read(path,token),post:(path,body,token)=>window.fixture.command(path,body,token),put:(path,body,token)=>window.fixture.command(path,body,token,'put')};`,
    "composition-fixture.tsx": `
import React from 'react';
import {WorkflowCatalogPanel} from '@/components/automations/workflow-catalog-panel';
import {WorkflowWorkspace} from '@/components/automations/workflow-workspace';
import {workflowPreviewCatalog} from '@/lib/automation-workflow-preview';
import {getBrowserWorkflowWorkspace} from '@/lib/automation-workflow-workspace-controller';
import {publishAccessIdentity,invalidateAccessIdentity} from '@/lib/access-identity';
import {setActiveStudioIdCookie} from '@/lib/studio-state-cookie';
import {useStoreBeltActions} from '@/lib/store-belt-actions';
import {useStoreProgramActions} from '@/lib/store-program-actions';
import {createResourceScope} from '@/lib/store-resource-scope';
import {ConfigStoreContext,StudioStoreContext,ProgramsStoreContext,BeltsStoreContext} from '@/lib/store-contexts';
import {ApiError,CommandOutcomeUnknown} from '@/lib/api';
const f=window.fixture;
f.catalog=structuredClone(workflowPreviewCatalog);
f.current=${JSON.stringify(detail())};
f.details={ [f.current.id]:f.current };
f.studios=new Map();
f.switchStudio=()=>{
  f.studios.set(f.studio,{current:f.current,details:f.details,programs:f.programs,ladders:f.ladders,receipts:f.receipts,catalog:f.catalog});
  const next=f.studio==='20000000-0000-4000-8000-000000000001'?'20000000-0000-4000-8000-000000000002':'20000000-0000-4000-8000-000000000001';
  let data=f.studios.get(next);
  if(!data){const current={...f.current,id:'30000000-0000-4000-8000-000000000002',name:'Other studio welcome',status:'draft',revision:1,published_version_id:null,published_version_number:null,published_at:null,pending_run_count:0,sending_run_count:0};data={current,details:{[current.id]:current},programs:[],ladders:[],receipts:{},catalog:structuredClone(workflowPreviewCatalog)};}
  f.change({...data,studio:next,route:'/automations',errors:{},hold:{}});
};
f.publish=()=>{setActiveStudioIdCookie(f.studio);if(!f.preview)publishAccessIdentity({user:{id:f.user},studio_id:f.studio,role:f.role,membership_status:'active'},true);};
f.publish();
${proof ? `if(!document.cookie.split(';').some(part=>part.trim()==='koaryu-active-studio='+f.studio))throw Error('Composition active studio cookie missing before mount');` : ""}
f.change=patch=>{const identity=['user','studio','role','ready'].some(key=>Object.hasOwn(patch,key)&&patch[key]!==f[key]);if(identity){f.epoch++;if(!f.preview)invalidateAccessIdentity();}Object.assign(f,patch);f.publish();f.notify();};
f.owner=()=>getBrowserWorkflowWorkspace(f.preview?{mode:'preview',source:require('@/lib/automation-workflow-preview').workflowPreviewSource}:{mode:'live',owner:{userId:f.user,studioId:f.studio,role:f.role},token:f.token});
f.read=async(path,token)=>{
 if(f.preview)throw Error('Preview API');f.reads.push({path,token});
 const key=path.includes('/catalog')?'catalog':path.startsWith('/belts')?'ranks':path.startsWith('/programs')?'programs':path.includes('/operations/')?'receipt':path.includes('?')?'list':'detail';
 if(f.hold[key])return new Promise((resolve,reject)=>f.held.push({key,path,token,resolve,reject}));
 if(f.errors[key])throw new ApiError('Synthetic unavailable',503);
 if(key==='catalog')return structuredClone(f.catalog);
 if(key==='list'){if(path.includes('cursor=')&&f.invalidCursor)throw new ApiError('Synthetic invalid cursor',422);return structuredClone(f.list??{items:Object.values(f.details).map(item=>({...item,created_at:item.updated_at,trigger_event_type:item.published_version_number?Object.keys(f.catalog.triggers)[0]:null,draft_trigger_event_type:item.draft_graph.nodes.find(node=>node.type==='trigger')?.config.event_type??null})),next_cursor:null,has_more:false});}
 if(key==='ranks')return structuredClone(f.ladders);
 if(key==='programs')return structuredClone(f.programs);
 if(key==='receipt'){const value=f.receipts[path.split('/').at(-1)];if(!value)throw new ApiError('Not found',404);return structuredClone(value);}
 const value=f.details[path.split('/').at(-1)];if(!value)throw new ApiError('Not found',404);return structuredClone(value);
};
f.command=(path,body,token,method)=>{if(f.preview)throw Error('Preview command');if(path.endsWith('/validate'))return Promise.resolve({valid:true,issues:[]});return new Promise((resolve,reject)=>{f.requests.push({path,body,token,method,studio:f.studio,resolve,reject});f.notify();});};
f.fail=index=>f.requests[index].reject(new CommandOutcomeUnknown());
f.complete=(index,overrides={})=>{
 const req=f.requests[index];
 if(!req||req.studio!==f.studio||req.completed)return;
 req.completed=true;
 const action=req.path.endsWith('/workflows')?'create':req.method==='put'?'save':req.path.split('/').at(-1);
 const id=action==='create'?crypto.randomUUID():action==='save'?req.path.split('/').at(-1):req.path.split('/').at(-2);
 const current=f.details[id];
 if(action!=='create'&&!current)throw Error('The synthetic workflow does not exist.');
 const requestedDraft={name:req.body.name,description:req.body.description,draft_graph:req.body.graph,draft_layout:req.body.layout,has_unpublished_changes:true};
 const result=action==='create'?{
   id,...requestedDraft,status:'draft',revision:1,published_version_id:null,published_version_number:null,published_at:null,
   pending_run_count:0,sending_run_count:0,validation_issues:[],updated_at:'2026-10-05T12:00:00Z',
 }:{...current,revision:req.body.expected_revision+1,...(action==='save'?requestedDraft:{}),...overrides};
 if(action==='publish'){result.status=current.status==='active'?'active':'paused';result.published_version_id='50000000-0000-4000-8000-000000000001';result.published_version_number=(current.published_version_number??0)+1;result.published_at=current.updated_at;result.has_unpublished_changes=false;}
 if(action==='start')result.status='active';
 if(action==='pause')result.status='paused';
 if(action==='archive')result.status='archived';
 f.details[result.id]=result;f.current=result;
 f.receipts[req.body.operation_id]={operation_id:req.body.operation_id,state:'committed',command:'workflow.'+action,entity_type:'workflow',entity_id:result.id,result,committed_at:result.updated_at};
 req.resolve(structuredClone(result));return result;
};
f.readyHeld=(key,result,fail=false)=>{const req=f.held.find(item=>item.key===key&&!item.done);if(!req)throw Error('No held '+key);req.done=true;fail?req.reject(new ApiError('Reference unavailable',503)):req.resolve(result);};
function Stores({children}){
 const [programs,setPrograms]=React.useState([]),[loaded,setLoaded]=React.useState(false),[error,setError]=React.useState(null),[usageError,setUsageError]=React.useState(null);
 const programRef=React.useRef(programs),loadedRef=React.useRef(loaded);programRef.current=programs;loadedRef.current=loaded;
 const scope=React.useRef(createResourceScope());
 const ladderRef=React.useRef([{id:'unchanged-selection',name:'Selected ladder',ranks:[]}]),rankRef=React.useRef([]),currentLadder=React.useRef('unchanged-selection');
 const begin=React.useCallback(()=>{const epoch=f.epoch,token=f.token;return {token,isSameIdentity:()=>epoch===f.epoch,isCurrent:()=>epoch===f.epoch&&token===f.token,canRetryAfterTokenChange:()=>epoch===f.epoch&&token!==f.token};},[]);
 const forbidden=React.useCallback(()=>{f.sideEffects++;throw Error('Unexpected ladder or eligibility mutation');},[]);
 const refreshBeltsRef=React.useRef(null);
 const belt=useStoreBeltActions({applyLadderSelection:forbidden,beginLiveAuthRequest:begin,beltLaddersRef:ladderRef,beltRanksRef:rankRef,commitPromotionHistoryCache:forbidden,currentLadderIdRef:currentLadder,isPreviewMode:f.preview,ladderName:'Selected ladder',loadEligibilityForLadder:forbidden,persistBeltRanks:forbidden,persistStudents:forbidden,promotionHistoryCacheRef:React.useRef({}),promotionHistoryGenerationRef:React.useRef(0),promotionHistoryRequestsRef:React.useRef({}),refreshBeltsRef,refreshStudents:forbidden,setEligibilityLoadError:forbidden,setEligibilityPendingLadderId:forbidden,studentsRef:React.useRef([]),subRankTerm:'Stripe'});
 const persistPrograms=React.useCallback(rows=>{setPrograms(rows);setLoaded(true);setError(null);},[]);
 const noop=React.useCallback(()=>{},[]);
 const program=useStoreProgramActions({applyLadderSelection:forbidden,beginLiveAuthRequest:begin,beltLaddersRef:ladderRef,currentLadderIdRef:currentLadder,isPreviewMode:f.preview,persistPrograms,programsRef:programRef,programScopeRef:scope,programsLoadedRef:loadedRef,refreshBeltsRef,setProgramsUsageLoaded:noop,setProgramsUsageLoadError:setUsageError,setProgramsLoadError:setError});
 f.metadataRead=belt.refreshBeltLadders;f.programRefresh=program.refreshPrograms;
 return <ConfigStoreContext.Provider value={{isPreviewMode:f.preview,token:f.token,subscriptionRequired:false}}><StudioStoreContext.Provider value={{identityReady:f.ready,identityGeneration:f.epoch,currentRole:f.role,currentStudioId:f.studio,currentUserId:f.user}}><ProgramsStoreContext.Provider value={{programs,programsLoaded:loaded,programsLoadError:error,programsUsageLoadError:usageError,refreshPrograms:program.refreshPrograms}}><BeltsStoreContext.Provider value={{refreshBeltLadders:belt.refreshBeltLadders}}>{children}</BeltsStoreContext.Provider></ProgramsStoreContext.Provider></StudioStoreContext.Provider></ConfigStoreContext.Provider>;
}
export default function Fixture(){React.useSyncExternalStore(f.subscribe,()=>f.version,()=>f.version);const address=new URL(f.route,'http://localhost');const draft=address.searchParams.get('draft');return <Stores key={f.epoch}><div id="fixture-bar"><span>Synthetic local fixture</span><button onClick={()=>f.router.push('/automations')}>Catalog fixture</button><button onClick={()=>f.change({token:f.token+'x'})}>Renew token fixture</button><button onClick={()=>{document.documentElement.style.cssText='color-scheme:light;--surface:#fff;--surface-raised:#f7f8fa;--surface-hover:#eef0f3;--border:#ccc;--text-primary:#17202a;--text-secondary:#536071;--accent:#795715';document.body.style.background='#f4f5f7';}}>Light fixture</button><button disabled={f.preview} onClick={()=>{f.catalog.capabilities={can_start:true,can_test_email:false,disabled_reason:null};f.catalog.delivery_status={mode:'live',configured:true,can_enable:true,sender:'synthetic@example.invalid',test_recipient:null,reason:null};f.catalog.scheduler.enabled=true;void f.owner().loadCatalog();}}>Enable synthetic delivery</button><button disabled={f.preview} onClick={()=>f.switchStudio()}>Switch synthetic studio</button><button disabled={!f.requests.some(req=>req.studio===f.studio&&!req.completed)} onClick={()=>{f.complete(f.requests.findLastIndex(req=>req.studio===f.studio&&!req.completed));f.notify();}}>Complete action fixture</button></div>{f.route==='/automations'?<WorkflowCatalogPanel/>:<WorkflowWorkspace key={f.route} {...(address.pathname==='/automations/new'?{draftId:draft}:{workflowId:address.pathname.split('/').at(-1)})}/>}</Stores>}
`,
  };
  if (proof) {
    delete moduleStubs["@/lib/api"];
    moduleStubs["composition-fixture.tsx"] = moduleStubs["composition-fixture.tsx"].replace(
      /<div id="fixture-bar">.*?<\/div>/,
      '<div id="fixture-bar">Actual automation API; synthetic Auth and fixture-only pickers</div>',
    );
  }
  const { add, modules } = createCommonJsPacker(moduleStubs);
  const react = add("react"),
    dom = add("react-dom/client"),
    fixture = add("composition-fixture.tsx");
  let source = `(()=>{const process={env:{NODE_ENV:${JSON.stringify(settings.mode)}}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}
window.fixture={preview:${settings.preview},role:${JSON.stringify(settings.role)},route:${JSON.stringify(settings.route)},ready:true,user:'${ids.user}',studio:'${ids.studio}',token:'token-1',epoch:0,version:0,auth:new Set(),listeners:new Set(),authCalls:0,reads:[],requests:[],receipts:{},hold:${JSON.stringify(settings.hold ?? {})},held:[],errors:{},programs:[],ladders:[],sideEffects:0};
const f=window.fixture;f.subscribe=fn=>{f.listeners.add(fn);return()=>f.listeners.delete(fn)};f.notify=()=>{f.version++;for(const fn of f.listeners)fn()};f.router={push:route=>{f.route=route;f.notify()},replace:route=>{f.route=route;f.notify()}};
const React=require(${react}),root=require(${dom}).createRoot(document.getElementById('root')),Fixture=require(${fixture}).default;
f.unmount=()=>root.render(null);f.mount=()=>root.render(React.createElement(${settings.mode === "development" ? "React.StrictMode" : "React.Fragment"},null,React.createElement(Fixture)));f.mount();})();`;
  if (proof) {
    source = source
      .replace(
        `NODE_ENV:${JSON.stringify(settings.mode)}`,
        `NODE_ENV:${JSON.stringify(settings.mode)},NEXT_PUBLIC_API_URL:${JSON.stringify(proof.apiUrl)},NEXT_PUBLIC_USE_API_PROXY:"false"`,
      )
      .replace(
        `user:'${ids.user}',studio:'${ids.studio}',token:'token-1'`,
        `user:${JSON.stringify(proof.actorId)},studio:${JSON.stringify(proof.studioId)},token:${JSON.stringify(proof.token)}`,
      )
      .replace(
        "const React=require(",
        () =>
          `window.fetch=(${createCompositionProofFetch.toString()})(${JSON.stringify(proof.apiUrl)},window.fetch.bind(window));const React=require(`,
      )
      .replace(
        "Synthetic local fixture",
        "Actual automation API; synthetic Auth and fixture-only pickers",
      );
  }
  return source;
}
export const compositionHtml = (options) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workflow composition fixture</title><style>${css}</style></head><body><div id="root"></div><script>${bundleWorkflowComposition(options).replaceAll("</script", "<\\/script")}</script></body></html>`;
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--proof-html")) {
    const proof = JSON.parse(readFileSync(0, "utf8"));
    process.stdout.write(compositionHtml({ proof }));
  } else {
    const port = Number(process.env.PORT ?? 4325);
    const routeArgument = process.argv.indexOf("--route");
    const initialRoute = routeArgument === -1 ? "/automations" : process.argv[routeArgument + 1];
    const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    if (
      typeof initialRoute !== "string" ||
      !new RegExp(`^/automations(?:/${uuid}|/new\\?draft=${uuid})?$`, "i").test(initialRoute)
    )
      throw Error(
        "--route requires /automations, /automations/<UUID>, or /automations/new?draft=<UUID>.",
      );
    const html = compositionHtml({
      preview: process.argv.includes("--preview"),
      route: initialRoute,
    });
    if (process.argv.includes("--write")) {
      const dir = "/tmp/koaryu-ui04b-fixture";
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "index.html"), html);
      console.log(`${dir}/index.html`);
    } else if (process.argv.includes("--serve")) {
      const server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(html);
      });
      server.listen(port, "127.0.0.1", () =>
        console.log(`Synthetic workflow fixture: http://127.0.0.1:${port}`),
      );
      for (const signal of ["SIGINT", "SIGTERM"])
        process.once(signal, () => {
          server.close();
          server.closeAllConnections();
        });
    } else
      throw Error(
        "Use --write or --serve; optional --preview and --route <path>. No external I/O is used.",
      );
  }
}

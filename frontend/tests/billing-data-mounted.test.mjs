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
function bundle({ realApi = false } = {}) {
  const modules = [];
  const ids = new Map();
  const stubs = {
    "next/navigation": `exports.usePathname=()=>'/dashboard'; const router={replace(){}}; exports.useRouter=()=>router;`,
    "@/components/loading-screen": `exports.LoadingScreen=()=>null;`,
    "@/lib/supabase/client": `exports.createClient=()=>window.fixture.supabase;`,
    "@/lib/api": `class ApiError extends Error { constructor(message,status,detail){super(message);this.status=status;this.detail=detail;} } exports.ApiError=ApiError; exports.api=window.fixture.api; exports.isSubscriptionRequiredError=e=>e.status===402; exports.isStaffArchivedError=e=>e.status===403&&/archived/i.test(e.message);`,
    "@/lib/performance": `exports.markPerformance=()=>{};exports.measurePerformance=()=>{};`,
  };
  if (realApi) delete stubs["@/lib/api"];
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
    if (/\.tsx?$/.test(key)) source = ts.transpileModule(source, { fileName: key, compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    }}).outputText;
    source = source.replace(/require\(["']([^"']+)["']\)/g, (_, dependency) => `require(${add(dependency, key)})`);
    modules[id] = `function(module,exports,require){${source}\n}`;
    return id;
  }
  const react = add("react");
  const dom = add("react-dom/client");
  const controller = add("@/lib/billing-data-controller");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react});const {useBillingDataController}=require(${controller});function Observer(){const state=useBillingDataController(window.fixture.options);window.fixture.state=state;React.useLayoutEffect(()=>{window.fixture.commits.push({tab:window.fixture.options.activeTab,settled:state.hasBillingLoadSettled,loading:state.isLoading,requestCount:window.fixture.requests.length});});React.useEffect(()=>{void state.ensureBilling();},[state.ensureBilling]);return React.createElement('output',null,JSON.stringify({landing:state.landing,plans:state.plans,payers:state.payers}));}window.fixture.root=require(${dom}).createRoot(document.getElementById('root'));window.fixture.render=()=>window.fixture.root.render(React.createElement(Observer));window.fixture.render();})();`;
}

async function mountBillingFixture(browser) {
  const page=await browser.newPage();
  await page.route("http://fixture.local/",r=>r.fulfill({contentType:"text/html",body:'<div id="root"></div>'}));
  await page.goto("http://fixture.local/");
  await page.evaluate(()=>{
   const f=window.fixture={requests:[],commits:[],waiters:[],held:null,error:"",denied:false};
   f.options={activeTab:'overview',identityKey:'user:studio:admin:1',canManageKoaryuSubscription:true,canViewStudioBilling:true,isPreviewMode:false,shouldSettleEarly:false,token:'token-a',onSubscriptionRequired:()=>{f.redirected=true;},setError:value=>{f.error=value;},setMessage:()=>{}};
   f.api={get:async(path,token)=>{
    const identity=f.options.identityKey;
    f.requests.push({path,token,identity});
    if(path===f.held) await new Promise(resolve=>f.waiters.push(resolve));
    if(path===f.fail) throw new Error('Required dataset failed');
    if(path===f.subscriptionRequired) throw Object.assign(new Error('Subscription required'),{status:402});
    if(path==='/billing/landing') return {studio_id:identity,system_status:{payment_account:{studio_id:identity},workflow_capabilities:[]},platform_status:null,financial_access:f.financialAccess??(f.denied?'subscription_required':'available'),aggregates:f.denied?null:{active_student_count:8,payment_cohort:{payment_count:1001}},errors:f.warnings??[]};
    if(path.includes('/page')) {
     const more=path.includes('/invoices/') ? f.moreInvoices ?? f.more : f.more;
     return {items:[{id:identity}],next_cursor:more && !path.includes('?')?'older':null,complete:!more || path.includes('?')};
    }
    if(path.startsWith('/billing/')) return [{id:identity}];
    throw new Error('Unexpected roster or other request');
   }};
  });
  await page.addScriptTag({content:bundle()});
  await page.waitForFunction(()=>fixture.state?.hasBillingLoadSettled);
  return page;
}

test("Billing landing waits for its server budget and body but still bounds stalled requests", async () => {
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.route("http://fixture.local/",r=>r.fulfill({contentType:"text/html",body:'<div id="root"></div>'}));
  await page.goto("http://fixture.local/");
  await page.clock.install();
  await page.evaluate(()=>{
   const f=window.fixture={requests:[],commits:[],error:"",aborts:0};
   f.options={activeTab:'overview',identityKey:'user:studio:admin:1',canManageKoaryuSubscription:true,canViewStudioBilling:true,isPreviewMode:false,shouldSettleEarly:false,token:'token-a',onSubscriptionRequired:()=>{},setError:value=>{f.error=value;},setMessage:()=>{}};
   window.fetch=(url,{signal})=>new Promise((resolve,reject)=>{
    f.requests.push({url});
    let stream;
    signal.addEventListener('abort',()=>{
     f.aborts+=1;
     const error=new DOMException('Aborted','AbortError');
     reject(error);
     stream?.error(error);
    },{once:true});
    f.sendHeaders=(status=200)=>resolve(new Response(new ReadableStream({start(controller){stream=controller;}}),{status,headers:{'content-type':'application/json'}}));
    f.sendBody=value=>{stream.enqueue(new TextEncoder().encode(JSON.stringify(value)));stream.close();};
   });
  });
  await page.addScriptTag({content:bundle({realApi:true})});
  await page.waitForFunction(()=>fixture.requests.length===1 || fixture.error, undefined, {timeout:3000});
  assert.equal(await page.evaluate(()=>fixture.error),"");
  await page.clock.fastForward(12_500);
  assert.deepEqual(await page.evaluate(()=>[fixture.state.hasBillingLoadSettled,fixture.error,fixture.aborts]),[false,"",0],"a valid composed read must survive the generic 12s deadline");
  await page.evaluate(()=>fixture.sendHeaders());
  await page.clock.fastForward(18_000);
  assert.deepEqual(await page.evaluate(()=>[fixture.state.hasBillingLoadSettled,fixture.error,fixture.aborts]),[false,"",0],"body transfer has room beyond the server's 30s deadline");
  await page.evaluate(()=>fixture.sendBody({studio_id:'studio',system_status:null,financial_access:'available',errors:[],aggregates:{active_student_count:8}}));
  await page.waitForFunction(()=>fixture.state.hasBillingLoadSettled);
  assert.equal(await page.evaluate(()=>fixture.state.landing.aggregates.active_student_count),8);
  assert.equal(await page.evaluate(()=>fixture.error),"");

  await page.evaluate(()=>{void fixture.state.refreshBilling();});
  await page.waitForFunction(()=>fixture.requests.length===2);
  await page.evaluate(()=>fixture.sendHeaders());
  await page.clock.fastForward(35_001);
  await page.waitForFunction(()=>fixture.state.hasBillingLoadSettled && fixture.error);
  assert.equal(await page.evaluate(()=>fixture.error),"Request timed out. Please try again.");
  assert.equal(await page.evaluate(()=>fixture.aborts),1,"a stalled body is canceled when the bounded landing deadline expires");

  await page.evaluate(()=>{void fixture.state.refreshBilling();});
  await page.waitForFunction(()=>fixture.requests.length===3);
  await page.clock.fastForward(30_000);
  await page.evaluate(()=>{fixture.sendHeaders(504);fixture.sendBody({detail:'Provider operation timed out.'});});
  await page.waitForFunction(()=>fixture.state.hasBillingLoadSettled && fixture.error==='Provider operation timed out.');
  assert.equal(await page.evaluate(()=>fixture.aborts),1,"the server's timeout detail arrives before the browser deadline");
 } finally {await browser.close();}
});

test("mounted Billing landing, tab retention, mutations and identity isolation", async () => {
 const browser=await chromium.launch({headless:true});
 try {
  const page=await mountBillingFixture(browser);
  await page.waitForFunction(()=>fixture.state?.hasBillingLoadSettled);
  assert.deepEqual(await page.evaluate(()=>fixture.requests.map(r=>r.path)),['/billing/landing']);
  await page.evaluate(()=>{fixture.held='/billing/plans';fixture.commits=[];fixture.options={...fixture.options,activeTab:'plans'};fixture.render();});
  await page.waitForFunction(()=>fixture.waiters.length===1);
  assert.deepEqual(await page.evaluate(()=>fixture.commits[0]),{tab:'plans',settled:false,loading:true,requestCount:1},'an unseen tab is loading in its first commit before its effect starts the request');
  await page.evaluate(()=>{fixture.held=null;fixture.waiters.splice(0).forEach(resolve=>resolve());});
  await page.waitForFunction(()=>fixture.state.plans.length===1 && fixture.state.hasBillingLoadSettled);
  const before=await page.evaluate(()=>fixture.requests.length);
  await page.evaluate(()=>{fixture.options={...fixture.options,activeTab:'overview',token:'renewed'};fixture.render();});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await page.evaluate(()=>{fixture.commits=[];fixture.options={...fixture.options,activeTab:'plans'};fixture.render();});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.deepEqual(await page.evaluate(()=>fixture.commits[0]),{tab:'plans',settled:true,loading:false,requestCount:before},'a cached tab is ready in its first commit');
  assert.equal(await page.evaluate(()=>fixture.requests.length),before,'fresh revisit and token renewal retain data');
  await page.evaluate(()=>fixture.state.refreshBilling());
  assert.equal(await page.evaluate(()=>fixture.requests.filter(r=>r.path==='/billing/landing').length),2,'mutation refresh invalidates landing');
  await page.evaluate(()=>{fixture.options={...fixture.options,activeTab:'reports'};fixture.render();});
  await page.waitForFunction(()=>fixture.state.payers.length===1 && fixture.state.payments.length===1);
  assert.ok(await page.evaluate(()=>fixture.requests.some(r=>r.path==='/billing/payments/page')),'reports preserve refund/payment history');
  await page.evaluate(()=>{fixture.more=true;return fixture.state.refreshBilling();});
  assert.equal(await page.evaluate(()=>fixture.state.hasMoreHistory),true,'Reports has another payment page');
  const beforeInvoices=await page.evaluate(()=>fixture.requests.length);
  await page.evaluate(()=>{fixture.moreInvoices=false;fixture.options={...fixture.options,activeTab:'invoices'};fixture.render();});
  await page.waitForFunction(()=>fixture.state.hasBillingLoadSettled);
  assert.equal(await page.evaluate(()=>fixture.state.hasMoreHistory),false,'a retained payment cursor cannot advertise invisible history on Invoices');
  assert.equal(await page.evaluate(n=>fixture.requests.slice(n).some(r=>r.path.startsWith('/billing/payments/')),beforeInvoices),false,'Invoices does not fetch payments it cannot render');
  const beforeNoOp=await page.evaluate(()=>fixture.requests.length);
  await page.evaluate(()=>fixture.state.loadMoreHistory());
  assert.equal(await page.evaluate(()=>fixture.requests.length),beforeNoOp,'Invoices with no invoice cursor has no history work');
  await page.evaluate(()=>{fixture.moreInvoices=true;return fixture.state.refreshBilling();});
  assert.equal(await page.evaluate(()=>fixture.state.hasMoreHistory),true);
  const beforeInvoicePage=await page.evaluate(()=>fixture.requests.length);
  await page.evaluate(()=>fixture.state.loadMoreHistory());
  assert.deepEqual(await page.evaluate(n=>fixture.requests.slice(n).map(r=>r.path),beforeInvoicePage),['/billing/invoices/page?cursor=older']);
  assert.equal(await page.evaluate(()=>fixture.state.hasMoreHistory),false);
  await page.evaluate(()=>{fixture.options={...fixture.options,activeTab:'reports'};fixture.render();});
  await page.waitForFunction(()=>fixture.state.hasBillingLoadSettled);
  assert.equal(await page.evaluate(()=>fixture.state.hasMoreHistory),true,'Reports retains its own payment cursor');
  const beforePaymentPage=await page.evaluate(()=>fixture.requests.length);
  await page.evaluate(()=>fixture.state.loadMoreHistory());
  assert.deepEqual(await page.evaluate(n=>fixture.requests.slice(n).map(r=>r.path),beforePaymentPage),['/billing/payments/page?cursor=older']);
  assert.equal(await page.evaluate(()=>fixture.state.hasMoreHistory),false);
  await page.evaluate(()=>{fixture.more=false;fixture.moreInvoices=false;});
  await page.evaluate(()=>{fixture.fail='/billing/payers';fixture.commits=[];fixture.options={...fixture.options,activeTab:'families'};fixture.render();});
  await page.waitForFunction(()=>fixture.state.hasBillingLoadSettled && fixture.error==='Required dataset failed');
  assert.equal(await page.evaluate(()=>fixture.commits[0].settled),false,'a failed tab also begins honestly pending');
  assert.equal(await page.evaluate(()=>fixture.state.isLoading),false,'a required failure settles so its error is visible');
  await page.evaluate(()=>{fixture.fail=null;fixture.options={...fixture.options,activeTab:'reports'};fixture.render();});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));

  await page.evaluate(()=>{fixture.fail='/billing/payers';fixture.commits=[];fixture.options={...fixture.options,activeTab:'families'};fixture.render();});
  await page.waitForFunction(()=>fixture.state.hasBillingLoadSettled && fixture.error==='Required dataset failed');
  assert.equal(await page.evaluate(()=>fixture.commits[0].settled),false,'a previous failed read is not retained as successful cached data');
  await page.evaluate(()=>{fixture.fail=null;fixture.options={...fixture.options,activeTab:'reports'};fixture.render();});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await page.evaluate(()=>{fixture.more=true;return fixture.state.refreshBilling();});
  await page.evaluate(()=>{fixture.held='/billing/payments/page?cursor=older';void fixture.state.loadMoreHistory();});
  await page.waitForFunction(()=>fixture.waiters.length===1 && fixture.state.isLoadingMore);
  await page.evaluate(()=>{fixture.options={...fixture.options,activeTab:'overview'};fixture.render();});
  await page.waitForFunction(()=>!fixture.state.isLoadingMore);
  await page.evaluate(()=>{fixture.options={...fixture.options,activeTab:'reports'};fixture.render();});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await page.evaluate(()=>fixture.state.isLoadingMore),false,'superseded pagination must not leave button disabled');
  await page.evaluate(()=>{fixture.waiters.splice(0).forEach(resolve=>resolve());fixture.held=null;fixture.denied=true;return fixture.state.refreshBilling();});
  assert.deepEqual(await page.evaluate(()=>fixture.state.payers),[],'verified subscription denial clears previously visible financial records');
  assert.deepEqual(await page.evaluate(()=>fixture.state.payments),[]);
  assert.equal(await page.evaluate(()=>fixture.state.hasMoreHistory),false);
  assert.ok(await page.evaluate(()=>fixture.state.billingSystemStatus),'diagnostics survive financial denial');
  await page.evaluate(()=>{fixture.denied=false;fixture.more=false;});
  await page.evaluate(()=>{fixture.options={...fixture.options,activeTab:'plans'};fixture.render();});
  await page.evaluate(()=>{fixture.held='/billing/plans';fixture.options={...fixture.options,identityKey:'other:studio:admin:2'};fixture.render();});
  await page.waitForFunction(()=>fixture.waiters.length===1);
  assert.deepEqual(await page.evaluate(()=>fixture.state.plans),[],'new identity cannot expose old plans during its pending read');
  await page.evaluate(()=>{fixture.options={...fixture.options,identityKey:null,token:null,canViewStudioBilling:false};fixture.render();});
  await page.evaluate(()=>{fixture.waiters.splice(0).forEach(resolve=>resolve());});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await page.evaluate(()=>fixture.state.landing),null);
  assert.deepEqual(await page.evaluate(()=>fixture.state.plans),[],'superseded request cannot repopulate signout');
  await page.evaluate(()=>{fixture.held=null;fixture.denied=true;fixture.options={...fixture.options,identityKey:'front:studio:front_desk:3',token:'front-token',canViewStudioBilling:true,canManageKoaryuSubscription:false,activeTab:'overview'};fixture.render();});
  await page.waitForFunction(()=>fixture.state.landing?.financial_access==='subscription_required');
  const deniedStart=await page.evaluate(()=>fixture.requests.length);
  await page.evaluate(()=>{fixture.options={...fixture.options,activeTab:'families'};fixture.render();});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.deepEqual(await page.evaluate(n=>fixture.requests.slice(n).map(r=>r.path),deniedStart),['/billing/landing'],'denied landing cannot launch a financial tab read');
  assert.equal(await page.evaluate(()=>fixture.redirected),undefined,'diagnostics remain visible on denied subscription');
 } finally {await browser.close();}
});


test("mounted Billing restores diagnostics for each cached tab and invalidates them with access and refresh", async () => {
 const browser=await chromium.launch({headless:true});
 try {
  const page=await mountBillingFixture(browser);
  const visit=async tab=>{
   await page.evaluate(tab=>{fixture.options={...fixture.options,activeTab:tab};fixture.render();},tab);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   await page.waitForFunction(()=>fixture.state.hasBillingLoadSettled);
  };
  await page.evaluate(()=>{fixture.fail='/billing/payers';});
  await visit('families');
  assert.equal(await page.evaluate(()=>fixture.error),'Required dataset failed');
  const beforeOverview=await page.evaluate(()=>fixture.requests.length);
  await visit('overview');
  assert.equal(await page.evaluate(()=>fixture.requests.length),beforeOverview,'Overview uses its retained successful data');
  assert.equal(await page.evaluate(()=>fixture.error),'','a Families failure cannot leak into cached Overview');

  await page.evaluate(()=>{fixture.fail=null;fixture.warnings=['Stripe diagnostics are unavailable.'];return fixture.state.refreshBilling();});
  assert.equal(await page.evaluate(()=>fixture.error),'Stripe diagnostics are unavailable.');
  await visit('plans');
  assert.equal(await page.evaluate(()=>fixture.error),'Stripe diagnostics are unavailable.','retained landing warnings survive a successful tab fetch');
  await page.evaluate(()=>{fixture.fail='/billing/payers';});
  await visit('families');
  assert.equal(await page.evaluate(()=>fixture.error),'Stripe diagnostics are unavailable. Required dataset failed');
  const beforeWarningOverview=await page.evaluate(()=>fixture.requests.length);
  await visit('overview');
  assert.equal(await page.evaluate(()=>fixture.requests.length),beforeWarningOverview);
  assert.equal(await page.evaluate(()=>fixture.error),'Stripe diagnostics are unavailable.','cached Overview restores landing warnings without an unrelated tab failure');
  await page.evaluate(()=>{fixture.fail=null;});
  await visit('families');
  assert.equal(await page.evaluate(()=>fixture.error),'Stripe diagnostics are unavailable.','successful retry clears only the tab failure');

  await page.evaluate(()=>{fixture.more=true;});
  await visit('reports');
  await page.evaluate(()=>{fixture.fail='/billing/payments/page?cursor=older';return fixture.state.loadMoreHistory();});
  assert.equal(await page.evaluate(()=>fixture.error),'Stripe diagnostics are unavailable. Required dataset failed');
  await visit('overview');
  assert.equal(await page.evaluate(()=>fixture.error),'Stripe diagnostics are unavailable.');
  await visit('reports');
  assert.equal(await page.evaluate(()=>fixture.error),'Stripe diagnostics are unavailable. Required dataset failed','cached history retains its own failed pagination diagnostic');
  await page.evaluate(()=>{fixture.fail=null;return fixture.state.loadMoreHistory();});
  assert.equal(await page.evaluate(()=>fixture.error),'Stripe diagnostics are unavailable.','successful history retry clears its failure');

  await page.evaluate(()=>{fixture.warnings=[];return fixture.state.refreshBilling();});
  assert.equal(await page.evaluate(()=>fixture.error),'','forced mutation refresh clears resolved landing warnings');
  await visit('overview');
  assert.equal(await page.evaluate(()=>fixture.error),'','invalidated tabs do not restore old warnings');
  await page.evaluate(()=>{fixture.warnings=['Old identity warning.'];return fixture.state.refreshBilling();});
  await page.evaluate(()=>{fixture.warnings=[];fixture.held='/billing/landing';fixture.options={...fixture.options,identityKey:'other:studio:admin:2'};fixture.render();});
  await page.waitForFunction(()=>fixture.waiters.length===1);
  assert.equal(await page.evaluate(()=>fixture.error),'','an identity change clears diagnostics before its response arrives');
  await page.evaluate(()=>{fixture.held=null;fixture.waiters.splice(0).forEach(resolve=>resolve());});
  await page.waitForFunction(()=>fixture.state.hasBillingLoadSettled);
  await page.evaluate(()=>{fixture.warnings=['Current identity warning.'];return fixture.state.refreshBilling();});
  await page.evaluate(()=>{fixture.subscriptionRequired='/billing/payers';});
  await visit('families');
  assert.equal(await page.evaluate(()=>fixture.redirected),true);
  assert.equal(await page.evaluate(()=>fixture.error),'','subscription denial discards retained diagnostics with financial data');
  assert.equal(await page.evaluate(()=>fixture.state.landing),null);
  await page.evaluate(()=>{fixture.options={...fixture.options,identityKey:null,token:null,canViewStudioBilling:false};fixture.render();});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(()=>fixture.error),'','signout cannot retain another access scope diagnostic');
 } finally {await browser.close();}
});


test("mounted Billing keeps denied landing diagnostics during Connect reads without crossing access scopes", async () => {
 const browser=await chromium.launch({headless:true});
 try {
  for (const [access, warnings, expected] of [
   ['subscription_required', [], 'Koaryu Core subscription is required for financial data. Account status and recovery remain available.'],
   ['unavailable', ['Financial verification is unavailable.'], 'Financial verification is unavailable.'],
   ['unavailable', [], 'Financial totals are unavailable.'],
  ]) {
   const page=await mountBillingFixture(browser);
   await page.evaluate(({access,warnings})=>{
    fixture.financialAccess=access;fixture.warnings=warnings;
    return fixture.state.refreshBilling();
   },{access,warnings});
   assert.equal(await page.evaluate(()=>fixture.error),expected);
   assert.ok(await page.evaluate(()=>fixture.state.billingSystemStatus),'denied financial data retains account diagnostics');
   await page.evaluate(()=>{
    fixture.held='/billing/connect/status';fixture.fail='/billing/connect/status';
    void fixture.state.refreshConnectStatus();
   });
   await page.waitForFunction(()=>fixture.waiters.length===1);
   assert.equal(await page.evaluate(()=>fixture.error),expected,'pending Connect status preserves the financial access explanation');
   await page.evaluate(()=>{fixture.held=null;fixture.waiters.splice(0).forEach(resolve=>resolve());});
   await page.waitForFunction(()=>fixture.error.includes('Required dataset failed'));
   assert.equal(await page.evaluate(()=>fixture.error),`${expected} Required dataset failed`,'a failed Connect read includes the financial access explanation');
   await page.evaluate(()=>{
    fixture.financialAccess='available';fixture.warnings=[];fixture.fail=null;fixture.held='/billing/landing';
    fixture.options={...fixture.options,identityKey:'new:studio:admin:2'};fixture.render();
   });
   await page.waitForFunction(()=>fixture.waiters.length===1);
   assert.equal(await page.evaluate(()=>fixture.error),'','another access scope cannot inherit financial or Connect errors');
   await page.evaluate(()=>{fixture.held=null;fixture.waiters.splice(0).forEach(resolve=>resolve());});
   await page.waitForFunction(()=>fixture.state.hasBillingLoadSettled);
   assert.equal(await page.evaluate(()=>fixture.error),'');
   await page.close();
  }
 } finally {await browser.close();}
});

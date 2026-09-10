import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { chromium } from "@playwright/test";

// Mount real billing hooks and page controls in local Chromium; replace I/O and decoration.
// A tiny CommonJS packer avoids adding a second frontend build or test runtime.
const require = createRequire(import.meta.url);
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function bundle({ realApi = false, refunds = false, pageController = false } = {}) {
  const modules = [];
  const ids = new Map();
  const stubs = {
    "next/navigation": `exports.usePathname=()=>'/dashboard'; const router={replace(){}}; exports.useRouter=()=>router; const search=new URLSearchParams('tab=reports'); exports.useSearchParams=()=>search;`,
    "@/lib/supabase/client": `exports.createClient=()=>window.fixture.supabase;`,
    "@/lib/api": `class ApiError extends Error { constructor(message,status,detail){super(message);this.status=status;this.detail=detail;} } exports.ApiError=window.fixture.ApiError=ApiError; exports.api=window.fixture.api; exports.isSubscriptionRequiredError=e=>e.status===402; exports.isStaffArchivedError=e=>e.status===403&&/archived/i.test(e.message);`,
    "@/lib/performance": `exports.markPerformance=()=>{};exports.measurePerformance=()=>{};exports.markDashboardReadiness=()=>{};`,
  };
  if (refunds || pageController) stubs["lucide-react"] = `module.exports=new Proxy({},{get:()=>()=>null});`;
  if (pageController) {
    stubs["next/link"] = `const React=require("react");module.exports=({children,...props})=>React.createElement("a",props,children);`;
    stubs["@/components/header"] = `exports.Header=({children})=>children;`;
    stubs["@/components/operations/operations-surface"] = `exports.OperationsSurface=({children})=>children;`;
  }
  if (realApi) delete stubs["@/lib/api"];
  function add(specifier, parent = resolve(frontend, "entry.js")) {
    let key = specifier;
    if (!(key in stubs)) {
      if (specifier.startsWith("@/")) key = resolve(frontend, "src", specifier.slice(2));
      else if (specifier.startsWith(".")) key = resolve(dirname(parent), specifier);
      else key = require.resolve(specifier, { paths: [dirname(parent), frontend] });
      if (existsSync(key) && statSync(key).isDirectory()) key = resolve(key, "index");
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
  const pageHook = pageController ? add("@/lib/billing-page-controller") : null;
  const pageContent = pageController ? add("@/components/billing/billing-page-content") : null;
  const refund = refunds ? add("@/lib/billing-refund-controller") : null;
  const reports = refunds ? add("@/components/billing/billing-reports-tab") : null;
  const refundObserver = refunds ? `const refunds=require(${refund}).useBillingRefundController({...window.fixture.refundOptions,refreshBilling:state.refreshBilling,refreshPaymentAfterRefund:state.refreshPaymentAfterRefund});window.fixture.refunds=refunds;` : "";
  const rendered = refunds ? `React.createElement(require(${reports}).BillingReportsTab,{billingPayers:[],billingPayments:state.payments,refundController:refunds,canManageRoutineBilling:false,externalAmount:'',externalMethod:'',externalNote:'',externalPayerId:'',externalPaymentReady:false,externalPaymentFormLocked:true,externalPaymentRecoveryMessage:'',externalPaymentIsRetry:false,externalPaymentTotal:0,exportJobs:[],isActionLoading:false,isLoadingAction:()=>false,onExternalAmountChange:()=>{},onExternalMethodChange:()=>{},onExternalNoteChange:()=>{},onExternalPayerChange:()=>{},onRecordExternalPayment:()=>{},paymentCohortAvailable:true,stripePaymentTotal:0})` : `React.createElement('output',null,JSON.stringify({landing:state.landing,plans:state.plans,payers:state.payers}))`;
  const observer = pageController
    ? `function Observer(){const page=require(${pageHook}).useBillingPageController(window.fixture.pageOptions);window.fixture.page=page.contentProps;window.fixture.actions=page.contentProps.tabContentProps.actions;return React.createElement(require(${pageContent}).BillingPageContent,page.contentProps);}`
    : `function Observer(){const state=useBillingDataController(window.fixture.options);window.fixture.state=state;${refundObserver}React.useLayoutEffect(()=>{window.fixture.commits.push({tab:window.fixture.options.activeTab,settled:state.hasBillingLoadSettled,loading:state.isLoading,requestCount:window.fixture.requests.length});});React.useEffect(()=>{void state.ensureBilling();},[state.ensureBilling]);return ${rendered};}`;
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react});const {useBillingDataController}=require(${controller});${observer}window.fixture.root=require(${dom}).createRoot(document.getElementById('root'));window.fixture.render=()=>window.fixture.root.render(React.createElement(Observer));window.fixture.remount=()=>{window.fixture.root.unmount();window.fixture.root=require(${dom}).createRoot(document.getElementById('root'));window.fixture.render();};window.fixture.render();})();`;
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

async function mountRefundFixture(browser) {
  const page = await browser.newPage();
  await page.route("http://localhost:4173/", route => route.fulfill({contentType:"text/html", body:'<div id="root"></div>'}));
  await page.goto("http://localhost:4173/");
  await page.evaluate(() => {
    const f = window.fixture = {requests:[], commits:[], error:"", message:"", posts:[], waiters:[]};
    f.options = {activeTab:"reports",identityKey:"admin:studio:admin:1",identity:{userId:"admin",studioId:"studio"},canManageKoaryuSubscription:true,canViewStudioBilling:true,isPreviewMode:false,shouldSettleEarly:false,token:"token-a",onSubscriptionRequired:()=>{f.denied=true;},setError:value=>{f.error=value;},setMessage:value=>{f.message=value;}};
    f.refundOptions = {enabledWorkflowIds:new Set(["payment.refund"]),identity:{userId:"admin",studioId:"studio"},identityKey:f.options.identityKey,isPreviewMode:false,role:"admin",token:"token-a",setError:f.options.setError,setMessage:f.options.setMessage};
    f.payment = {id:"payment-1",studio_id:"studio",payer_id:"payer-1",stripe_charge_id:"charge-1",stripe_account_id:"account-1",status:"succeeded",amount_cents:5000,gross_paid_amount_cents:5000,refunded_amount_cents:0,disputed_amount_cents:0,net_collected_amount_cents:5000,refundable_amount_cents:5000,adjustment_reconciliation_required:false,currency:"usd",created_at:"2026-09-01T00:00:00Z",updated_at:"2026-09-01T00:00:00Z",payment_method_type:"Test card"};
    f.api = {
      get:async (path,token) => {
        f.requests.push({path,token});
        const snapshot = path === "/billing/landing" ? {financial_access:"available",errors:[],system_status:{workflow_capabilities:[{workflow_id:"payment.refund",enabled:true}]},aggregates:{payment_cohort:{payment_count:1}}}
          : path === "/billing/payers" ? []
          : path === "/billing/plans" ? [{id:"plan-1",studio_id:"studio",name:"Monthly",amount_cents:5000,currency:"usd",billing_interval:"month",interval_count:1}]
          : path === "/billing/payments/current-month-cohort" ? {payment_count:1,net_amount_cents:f.payment.net_collected_amount_cents}
          : path === "/billing/payments/page" ? {items:structuredClone((f.pageRows ?? [f.payment]).map(row=>row.id===f.payment.id ? f.payment : row)),next_cursor:f.more ? "older" : null,complete:!f.more}
          : path === "/billing/payments/page?cursor=older" ? {items:structuredClone((f.historyRows ?? []).map(row=>row.id===f.payment.id ? f.payment : row)),next_cursor:null,complete:true}
          : path === `/billing/payments/${f.payment.id}` ? structuredClone(f.targetOverride ?? f.payment)
          : null;
        if (path === f.heldGet) await new Promise(resolve=>f.waiters.push({path,resolve}));
        if (path === `/billing/payments/${f.payment.id}` && f.targetStatus && (!f.deniedToken || f.deniedToken === token)) throw new f.ApiError("Target access denied",f.targetStatus);
        if (path.startsWith("/billing/payments/") && f.failPayments) throw new Error("Payment read failed");
        if (snapshot) return snapshot;
        throw new Error(`Unexpected read ${path}`);
      },
      post:async (path,body,token,options) => {
        f.posts.push({path,body,token,options});
        if (f.holdBeforeCommit) await new Promise(resolve=>f.waiters.push({path:"refund-commit",resolve}));
        if (!f.refundResponse) {
          f.payment = {...f.payment,refunded_amount_cents:body.amount_cents,net_collected_amount_cents:5000-body.amount_cents,refundable_amount_cents:5000-body.amount_cents};
          f.refundResponse = {id:"refund-1",studio_id:f.payment.studio_id,payment_id:f.payment.id,amount_cents:body.amount_cents,status:"succeeded",reconciliation_required:false,created_at:"2026-09-08T00:00:00Z"};
        }
        const response=structuredClone(f.refundResponse);
        if (f.heldPost) await new Promise(resolve=>f.waiters.push({path,resolve}));
        f.failPayments = f.failAfterPost ?? true;
        if (f.postStatus) throw new f.ApiError("Original request not confirmed",f.postStatus);
        return response;
      },
    };
    f.receipts = () => Object.entries(localStorage).filter(([key])=>key.startsWith("koaryu.billing.payment-refund.v1"));
    window.confirm = message => { f.confirmations=(f.confirmations ?? []).concat(message); return !f.cancelConfirm; };
  });
  await page.addScriptTag({content:bundle({refunds:true})});
  await page.waitForFunction(()=>fixture.state?.payments.length===1 && fixture.refunds?.refundActionReady);
  return page;
}

// The server stores one synthetic receipt per key. Capture body, identity and durable
// browser state at the I/O boundary, before either committing or holding the response.
async function mountExternalPaymentFixture(browser, { role = "admin", preview = false, workflow = true, storageFault = null } = {}) {
  const page = await browser.newPage();
  await page.route("http://localhost:4173/", route => route.fulfill({contentType:"text/html",body:'<div id="root"></div>'}));
  await page.goto("http://localhost:4173/");
  await page.evaluate(({role,preview,workflow,storageFault}) => {
    const f = window.fixture = {requests:[],posts:[],receipts:{},waiters:[],workflow,externalStorageReads:0};
    f.pageOptions = {
      config:{isPreviewMode:preview,token:"token-a",markSubscriptionRequired:()=>{f.redirected=true;}},
      programsStore:{programs:[],programsLoaded:true,programsLoadError:null,refreshPrograms:async()=>{}},
      studentsStore:{students:[],studentsLoaded:true,studentsLoadError:null,studentsMayBePartial:false,refreshStudents:async()=>{}},
      studioStore:{currentRole:role,currentStudioId:"studio",currentUserId:"admin",identityGeneration:1},
    };
    f.saved = () => Object.entries(localStorage).filter(([key])=>key.startsWith("koaryu.external-payment:"));
    f.storageFault = mode => {
      const proto=Storage.prototype;
      f.storageOriginals ??= {getItem:proto.getItem,setItem:proto.setItem,removeItem:proto.removeItem};
      Object.assign(proto,f.storageOriginals);
      if (mode==="get") proto.getItem=function(key){if(key.startsWith("koaryu.external-payment:")) {f.externalStorageReads++;throw new Error("Storage denied");}return f.storageOriginals.getItem.call(this,key);};
      if (["set","silent","corrupt-write"].includes(mode)) proto.setItem=function(key,value){
        if (!key.startsWith("koaryu.external-payment:")) return f.storageOriginals.setItem.call(this,key,value);
        if(mode==="set") throw new Error("Storage full");
        if(mode==="corrupt-write") return f.storageOriginals.setItem.call(this,key,"broken");
      };
      if (["remove","silent-remove"].includes(mode)) proto.removeItem=function(key){
        if(!key.startsWith("koaryu.external-payment:")) return f.storageOriginals.removeItem.call(this,key);
        if(mode==="remove") throw new Error("Storage denied");
      };
    };
    if(storageFault==="missing") Object.defineProperty(window,"localStorage",{configurable:true,get(){throw new Error("Storage unavailable");}});
    else if(storageFault==="corrupt") localStorage.setItem("koaryu.external-payment:admin:studio","broken");
    else f.storageFault(storageFault);
    f.api = {
      get:async(path,token)=>{
        f.requests.push({path,token,identity:structuredClone(f.pageOptions.studioStore)});
        if(f.failReads) throw new Error("Payment read failed");
        if(path==="/billing/landing") return {studio_id:f.pageOptions.studioStore.currentStudioId,financial_access:"available",errors:[],system_status:{workflow_capabilities:[{workflow_id:"payment.external.record",enabled:f.workflow}]},aggregates:{payment_cohort:{payment_count:Object.keys(f.receipts).length}}};
        if(path==="/billing/payers") return [{id:"payer-1",display_name:"Family One"},{id:"payer-2",display_name:"Family Two"}];
        if(path==="/billing/payments/page") return {items:Object.values(f.receipts),next_cursor:null,complete:true};
        if(path==="/billing/payments/current-month-cohort") return {payment_count:Object.keys(f.receipts).length,net_amount_cents:7525,external_net_amount_cents:7525,stripe_net_amount_cents:0};
        throw new Error(`Unexpected read ${path}`);
      },
      post:async(path,body,token,options)=>{
        if(path!=="/billing/payments/external") throw new Error(`Unexpected write ${path}`);
        const identity=structuredClone(f.pageOptions.studioStore);
        const requestKey=options.headers["Idempotency-Key"];
        f.posts.push({path,body:structuredClone(body),token,requestKey,identity,saved:structuredClone(f.saved())});
        f.receipts[requestKey] ??= {id:`payment-${Object.keys(f.receipts).length+1}`,studio_id:identity.currentStudioId,...structuredClone(body),status:"externally_recorded",payment_method_type:"external",gross_paid_amount_cents:7525,net_collected_amount_cents:7525,refunded_amount_cents:0,disputed_amount_cents:0,refundable_amount_cents:0,created_at:"2026-09-09T00:00:00Z"};
        const result=Object.hasOwn(f,"responseOverride") ? f.responseOverride : structuredClone(f.receipts[requestKey]);
        if(f.holdPost) await new Promise(resolve=>f.waiters.push(resolve));
        if(f.loseResponse) throw new Error("Payment response lost");
        if(f.failAfterPost) f.failReads=true;
        return result;
      },
    };
  },{role,preview,workflow,storageFault});
  await page.addScriptTag({content:bundle({pageController:true})});
  await page.waitForFunction(()=>fixture.page && !fixture.page.showBillingLoading);
  return page;
}

async function fillExternalPayment(page, values = {}) {
  const draft={payer:"payer-1",amount:"75.25",method:" Check ",note:" paid at front desk ",...values};
  await page.getByLabel("Payer",{exact:true}).selectOption(draft.payer);
  await page.getByLabel("Amount",{exact:true}).fill(draft.amount);
  await page.getByLabel("Method",{exact:true}).fill(draft.method);
  await page.getByLabel("Note",{exact:true}).fill(draft.note);
}
const settleExternalPage = page => page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));

test("external payment keeps the exact durable request through lost response, edits, remount and retry", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const page=await mountExternalPaymentFixture(browser);
    await fillExternalPayment(page);
    await page.evaluate(()=>{fixture.loseResponse=true;});
    await page.getByRole("button",{name:"Record",exact:true}).click();
    await page.waitForFunction(()=>fixture.page.error==="Payment response lost");
    const first=await page.evaluate(()=>fixture.posts[0]);
    assert.deepEqual(first.body,{payer_id:"payer-1",amount_cents:7525,currency:"usd",external_method:"Check",note:"paid at front desk"});
    assert.equal(first.saved.length,1,"the complete request must exist before POST");
    assert.deepEqual(JSON.parse(first.saved[0][1]),{version:1,requestKey:first.requestKey,payload:first.body});
    assert.equal(first.token,"token-a");
    assert.equal(first.path,"/billing/payments/external");
    for(const label of ["Payer","Amount","Method","Note"]) assert.equal(await page.getByLabel(label,{exact:true}).isDisabled(),true);
    await page.evaluate(()=>{
      fixture.actions.onExternalPayerChange("payer-2");fixture.actions.onExternalAmountChange("99");
      fixture.actions.onExternalMethodChange("Cash");fixture.actions.onExternalNoteChange("replacement");
    });
    await settleExternalPage(page);
    assert.deepEqual(await page.evaluate(()=>[fixture.actions.externalPayerId,fixture.actions.externalAmount,fixture.actions.externalMethod,fixture.actions.externalNote]),["payer-1","75.25","Check","paid at front desk"]);
    await page.evaluate(()=>fixture.remount());
    await page.getByRole("button",{name:"Retry payment",exact:true}).waitFor();
    assert.equal(await page.getByLabel("Note",{exact:true}).inputValue(),"paid at front desk");
    await page.evaluate(()=>{fixture.loseResponse=false;});
    await page.getByRole("button",{name:"Retry payment",exact:true}).click();
    await page.waitForFunction(()=>fixture.page.message==="External payment recorded." && !fixture.page.isLoading);
    assert.deepEqual(await page.evaluate(()=>fixture.posts.map(p=>[p.requestKey,p.body])),[[first.requestKey,first.body],[first.requestKey,first.body]]);
    assert.equal(await page.evaluate(()=>Object.keys(fixture.receipts).length),1);
    assert.equal(await page.evaluate(()=>fixture.saved().length),0);
    assert.equal(await page.getByLabel("Amount",{exact:true}).inputValue(),"");
    assert.equal(await page.getByLabel("Note",{exact:true}).inputValue(),"");
  } finally {await browser.close();}
});

test("external payment rejects invalid drafts before capture and blocks unsafe storage", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const invalid=await mountExternalPaymentFixture(browser);
    await fillExternalPayment(invalid);
    for(const [field,value] of [["Amount","0.001"],["Amount","21474836.48"],["Method"," "],["Payer",""]]) {
      await fillExternalPayment(invalid);
      if(field==="Payer") await invalid.getByLabel(field,{exact:true}).selectOption(value);
      else await invalid.getByLabel(field,{exact:true}).fill(value);
      await invalid.getByRole("button",{name:"Record",exact:true}).click();
      await settleExternalPage(invalid);
      assert.ok(await invalid.evaluate(()=>fixture.page.error));
      assert.deepEqual(await invalid.evaluate(()=>[fixture.posts.length,fixture.saved().length]),[0,0],`${field} must fail before durable capture`);
    }
    await fillExternalPayment(invalid);
    // A direct callback exercises the API method limit beyond the input's maxLength.
    await invalid.evaluate(()=>fixture.actions.onExternalMethodChange("x".repeat(81)));
    await settleExternalPage(invalid);
    await invalid.getByRole("button",{name:"Record",exact:true}).click();
    assert.deepEqual(await invalid.evaluate(()=>[fixture.posts.length,fixture.saved().length]),[0,0]);
    await invalid.close();

    for(const fault of ["missing","get","corrupt","set","silent","corrupt-write"]) {
      const early=["missing","get","corrupt"].includes(fault);
      const page=await mountExternalPaymentFixture(browser,{storageFault:early ? fault : null});
      if(!early) {
        await fillExternalPayment(page);
        await page.evaluate(fault=>fixture.storageFault(fault),fault);
        await page.getByRole("button",{name:"Record",exact:true}).click();
      }
      await page.waitForFunction(()=>!fixture.actions.externalPaymentReady);
      assert.equal(await page.getByRole("button",{name:"Record",exact:true}).isDisabled(),true,fault);
      await page.evaluate(()=>fixture.actions.onRecordExternalPayment({preventDefault(){}}));
      assert.equal(await page.evaluate(()=>fixture.posts.length),0,fault);
      assert.match(await page.locator("body").innerText(),/storage is unavailable|saved payment request cannot be verified/i);
      await page.close();
    }
  } finally {await browser.close();}
});

test("external payment retains an unverified response or failed retirement and retries its original key", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    for(const response of [null,{id:"payment-1"},"wrong-studio","wrong-note","wrong-amount"]) {
      const page=await mountExternalPaymentFixture(browser);
      await fillExternalPayment(page);
      await page.evaluate(response=>{
        fixture.responseOverride=typeof response==="string"
          ? {id:"payment-1",studio_id:response==="wrong-studio"?"other":"studio",payer_id:"payer-1",amount_cents:response==="wrong-amount"?1:7525,currency:"usd",external_method:"Check",note:response==="wrong-note"?"different":"paid at front desk",status:"externally_recorded",payment_method_type:"external"}
          : response;
      },response);
      await page.getByRole("button",{name:"Record",exact:true}).click();
      await page.waitForFunction(()=>fixture.page.error.includes("could not be verified"));
      assert.equal(await page.evaluate(()=>fixture.saved().length),1);
      assert.equal(await page.getByLabel("Note",{exact:true}).isDisabled(),true);
      assert.equal(await page.evaluate(()=>fixture.page.message),"");
      await page.evaluate(()=>{delete fixture.responseOverride;});
      await page.getByRole("button",{name:"Retry payment",exact:true}).click();
      await page.waitForFunction(()=>fixture.saved().length===0 && !fixture.actions.isActionLoading);
      assert.equal(await page.evaluate(()=>Object.keys(fixture.receipts).length),1);
      assert.equal(await page.evaluate(()=>fixture.posts[0].requestKey===fixture.posts[1].requestKey),true);
      await page.close();
    }
    for(const fault of ["remove","silent-remove"]) {
      const page=await mountExternalPaymentFixture(browser);
      await fillExternalPayment(page);
      await page.evaluate(fault=>fixture.storageFault(fault),fault);
      await page.getByRole("button",{name:"Record",exact:true}).click();
      await page.waitForFunction(()=>fixture.page.error.includes("completion needs attention"));
      assert.equal(await page.evaluate(()=>fixture.page.message),"External payment recorded.");
      assert.equal(await page.evaluate(()=>fixture.saved().length),1);
      assert.equal(await page.getByLabel("Amount",{exact:true}).isDisabled(),true);
      await page.evaluate(()=>{fixture.storageFault(null);fixture.remount();});
      await page.getByRole("button",{name:"Retry payment",exact:true}).click();
      await page.waitForFunction(()=>fixture.saved().length===0 && !fixture.actions.isActionLoading);
      assert.equal(await page.evaluate(()=>Object.keys(fixture.receipts).length),1);
      assert.equal(await page.evaluate(()=>fixture.posts[0].requestKey===fixture.posts[1].requestKey),true);
      await page.close();
    }
  } finally {await browser.close();}
});

test("external payment confirmation survives real loader failure and page Refresh only reads", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const page=await mountExternalPaymentFixture(browser);
    await fillExternalPayment(page);
    await page.evaluate(()=>{fixture.failAfterPost=true;});
    await page.getByRole("button",{name:"Record",exact:true}).click();
    await page.waitForFunction(()=>fixture.page.error.includes("Payment read failed") && !fixture.page.isLoading);
    assert.equal(await page.evaluate(()=>fixture.page.message),"External payment recorded.");
    assert.equal(await page.evaluate(()=>fixture.saved().length),0);
    assert.match(await page.locator("body").innerText(),/External payment recorded/);
    const reads=await page.evaluate(()=>fixture.requests.length);
    await page.evaluate(()=>{fixture.failReads=false;});
    await page.getByRole("button",{name:"Refresh",exact:true}).click();
    await page.waitForFunction(()=>!fixture.page.isLoading && fixture.page.tabContentProps.billingPayments.length===1);
    assert.equal(await page.evaluate(()=>fixture.posts.length),1);
    assert.ok(await page.evaluate(n=>fixture.requests.length>n,reads));
    assert.equal(await page.evaluate(()=>fixture.page.error),"");
    assert.equal(await page.evaluate(()=>fixture.page.message),"External payment recorded.");
  } finally {await browser.close();}
});

test("external payment held completion follows token renewal but cannot settle another identity or action", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    for(const change of ["token","user","studio","role","generation","signout","unmount"]) {
      const page=await mountExternalPaymentFixture(browser);
      await fillExternalPayment(page);
      await page.evaluate(()=>{fixture.holdPost=true;});
      await page.getByRole("button",{name:"Record",exact:true}).click();
      await page.waitForFunction(()=>fixture.waiters.length===1);
      const saved=await page.evaluate(()=>fixture.saved());
      const before=await page.evaluate(()=>fixture.requests.length);
      await page.evaluate(change=>{
        const f=fixture;
        if(change==="unmount") {f.root.unmount();return;}
        const config={...f.pageOptions.config};
        const studioStore={...f.pageOptions.studioStore};
        if(change==="token") config.token="renewed";
        if(change==="user") studioStore.currentUserId="replacement";
        if(change==="studio") studioStore.currentStudioId="other";
        if(change==="role") studioStore.currentRole="front_desk";
        if(change==="generation") studioStore.identityGeneration++;
        if(change==="signout") {config.token=null;studioStore.currentUserId=null;studioStore.currentRole=null;studioStore.identityGeneration++;}
        f.pageOptions={...f.pageOptions,config,studioStore};f.render();
      },change);
      await settleExternalPage(page);
      if(!["token","unmount"].includes(change)) {
        assert.equal(await page.evaluate(()=>fixture.actions.isActionLoading),false,`${change} releases the old claim`);
        assert.equal(await page.evaluate(()=>fixture.actions.claimAction("record-external")),true);
        await settleExternalPage(page);
      }
      await page.evaluate(()=>fixture.waiters.shift()());
      await settleExternalPage(page);
      if(change==="token") {
        await page.waitForFunction(()=>!fixture.actions.isActionLoading && !fixture.page.isLoading);
        assert.equal(await page.evaluate(()=>fixture.saved().length),0);
        assert.equal(await page.evaluate(()=>fixture.page.message),"External payment recorded.");
        assert.ok(await page.evaluate(n=>fixture.requests.slice(n).every(r=>r.token==="renewed"),before));
        assert.ok(await page.evaluate(n=>fixture.requests.length>n,before));
      } else {
        assert.deepEqual(await page.evaluate(()=>fixture.saved()),saved,`${change} cannot retire the original scope's attempt`);
        if(change!=="unmount") {
          assert.equal(await page.evaluate(()=>fixture.page.message),"");
          assert.equal(await page.evaluate(()=>fixture.page.error),"");
          assert.equal(await page.evaluate(()=>fixture.actions.isLoadingAction("record-external")),true,`${change} stale release cannot clear a new claim of the same action`);
        }
      }
      assert.equal(await page.evaluate(()=>fixture.posts.length),1);
      assert.equal(await page.evaluate(()=>fixture.posts[0].identity.currentUserId),"admin");
      assert.equal(await page.evaluate(()=>fixture.posts[0].identity.currentStudioId),"studio");
      await page.close();
    }
  } finally {await browser.close();}
});

test("external payment page enforces front desk, preview, denied-role and exact-workflow gates", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const front=await mountExternalPaymentFixture(browser,{role:"front_desk"});
    await fillExternalPayment(front);
    await front.getByRole("button",{name:"Record",exact:true}).click();
    await front.waitForFunction(()=>fixture.page.message==="External payment recorded." && !fixture.page.isLoading);
    assert.equal(await front.evaluate(()=>fixture.posts.length),1);
    assert.equal(await front.evaluate(()=>fixture.posts[0].identity.currentRole),"front_desk");
    assert.ok(await front.evaluate(()=>fixture.requests.some(r=>r.path==="/billing/landing")));
    assert.deepEqual(await front.evaluate(()=>[...new Set(fixture.requests.map(r=>r.path))].sort()),["/billing/landing","/billing/payers","/billing/payments/page"]);
    await front.close();

    const preview=await mountExternalPaymentFixture(browser,{preview:true,storageFault:"get"});
    const payer=await preview.getByLabel("Payer",{exact:true}).locator("option").nth(1).getAttribute("value");
    await fillExternalPayment(preview,{payer});
    await preview.getByRole("button",{name:"Record",exact:true}).click();
    await preview.waitForFunction(()=>fixture.page.message==="Demo external payment recorded locally.");
    assert.deepEqual(await preview.evaluate(()=>[fixture.requests.length,fixture.posts.length,fixture.externalStorageReads]),[0,0,0]);
    await preview.close();

    for(const options of [{workflow:false},{role:"instructor"}]) {
      const page=await mountExternalPaymentFixture(browser,options);
      if(options.workflow===false) assert.equal(await page.getByRole("button",{name:"Record",exact:true}).isDisabled(),true);
      else assert.match(await page.locator("body").innerText(),/Billing access is limited/);
      await page.evaluate(()=>fixture.actions.onRecordExternalPayment({preventDefault(){}}));
      assert.deepEqual(await page.evaluate(()=>[fixture.posts.length,fixture.saved().length]),[0,0]);
      if(options.role) assert.equal(await page.evaluate(()=>fixture.requests.length),0);
      await page.close();
    }
  } finally {await browser.close();}
});

test("confirmed refund retains its receipt when the real payment loader fails, then recovers with only a read", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const page=await mountRefundFixture(browser);
    await page.evaluate(()=>fixture.refunds.refundPayment(fixture.state.payments[0],"12.50","requested_by_customer"));
    assert.equal(await page.evaluate(()=>fixture.posts.length),1);
    assert.match(await page.evaluate(()=>fixture.message),/Refund (submitted|accepted)/);
    assert.equal(await page.evaluate(()=>fixture.receipts().length),1,"failed payment refresh must retain the original refund request");
    const key=await page.evaluate(()=>JSON.parse(fixture.receipts()[0][1]).requestKey);
    assert.equal(key,await page.evaluate(()=>fixture.posts[0].options.headers["Idempotency-Key"]));
    assert.equal(await page.evaluate(()=>fixture.state.payments[0].refundable_amount_cents),5000);
    await page.evaluate(()=>{fixture.failPayments=false;});
    await page.getByRole("button",{name:"Refresh payment",exact:true}).click();
    await page.waitForFunction(()=>fixture.receipts().length===0);
    assert.equal(await page.evaluate(()=>fixture.posts.length),1,"confirmed recovery must not submit another refund");
    assert.equal(await page.evaluate(()=>fixture.state.payments[0].refundable_amount_cents),3750);
    assert.ok(await page.evaluate(()=>fixture.requests.some(r=>r.path==="/billing/payments/payment-1")));
    assert.match(await page.locator("body").innerText(),/Refundable \$37\.50/);
  } finally {await browser.close();}
});

test("refund target refresh preserves older pages and rejects held first-page and history snapshots", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    for (const held of ["/billing/payments/page", "/billing/payments/page?cursor=older"]) {
      const page=await mountRefundFixture(browser);
      await page.evaluate(()=>{
        fixture.pageRows=[{...fixture.payment,id:"newer-payment",payment_method_type:"Newer card"}];
        fixture.historyRows=[fixture.payment]; fixture.more=true;
        return fixture.state.refreshBilling();
      });
      await page.evaluate(()=>fixture.state.loadMoreHistory());
      assert.deepEqual(await page.evaluate(()=>fixture.state.payments.map(p=>p.id)),["newer-payment","payment-1"]);
      if (held.includes("?")) {
        await page.evaluate(()=>{fixture.holdBeforeCommit=true;fixture.failAfterPost=false;fixture.pendingRefund=fixture.refunds.refundPayment(fixture.state.payments[1],"12.50","requested_by_customer");});
        await page.waitForFunction(()=>fixture.waiters.some(w=>w.path==="refund-commit"));
        await page.evaluate(()=>fixture.state.refreshBilling());
      }
      await page.evaluate(held=>{
        fixture.heldGet=held; fixture.failAfterPost=false;
        fixture.staleRead=held.includes("?") ? fixture.state.loadMoreHistory() : fixture.state.refreshBilling();
      },held);
      await page.waitForFunction(held=>fixture.waiters.some(w=>w.path===held),held);
      if (held.includes("?")) {
        await page.evaluate(()=>{fixture.waiters.find(w=>w.path==="refund-commit").resolve();return fixture.pendingRefund;});
      } else {
        await page.evaluate(()=>fixture.refunds.refundPayment(fixture.state.payments.find(p=>p.id==="payment-1"),"12.50","requested_by_customer"));
      }
      assert.equal(await page.evaluate(()=>fixture.receipts().length),0);
      await page.evaluate(()=>{fixture.heldGet=null;fixture.waiters.splice(0).forEach(w=>w.resolve());return fixture.staleRead;});
      assert.equal(await page.evaluate(()=>fixture.state.payments.find(p=>p.id==="payment-1")?.refundable_amount_cents),held.includes("?") ? undefined : 3750);
      assert.equal(await page.evaluate(()=>fixture.state.isLoading || fixture.state.isLoadingMore),false);
      const before=await page.evaluate(()=>fixture.requests.length);
      await page.evaluate(()=>fixture.state.ensureBilling());
      assert.ok(await page.evaluate(n=>fixture.requests.slice(n).some(r=>r.path==="/billing/payments/page"),before),"discarded page must not become retained fresh data");
      assert.equal(await page.evaluate(()=>fixture.posts.length),1);
      await page.close();
    }
  } finally {await browser.close();}
});

test("refund completion uses renewed credentials but drops old identity, capability and unmounted settlements", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const renewed=await mountRefundFixture(browser);
    await renewed.evaluate(()=>{fixture.failAfterPost=false;fixture.heldGet="/billing/payments/payment-1";fixture.pendingRefund=fixture.refunds.refundPayment(fixture.payment,"12.50","requested_by_customer");});
    await renewed.waitForFunction(()=>fixture.waiters.length===1);
    await renewed.evaluate(()=>{fixture.options={...fixture.options,token:"renewed"};fixture.refundOptions={...fixture.refundOptions,token:"renewed"};fixture.targetStatus=401;fixture.deniedToken="token-a";fixture.render();});
    await renewed.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    await renewed.evaluate(()=>{fixture.heldGet=null;fixture.waiters.splice(0).forEach(w=>w.resolve());return fixture.pendingRefund;});
    assert.equal(await renewed.evaluate(()=>fixture.receipts().length),0);
    assert.deepEqual(await renewed.evaluate(()=>fixture.requests.filter(r=>r.path==="/billing/payments/payment-1").map(r=>r.token)),["token-a","renewed"]);
    assert.equal(await renewed.evaluate(()=>fixture.posts.length),1,"only the rejected read may replay after token renewal");
    await renewed.close();

    const postRenewal=await mountRefundFixture(browser);
    await postRenewal.evaluate(()=>{fixture.failAfterPost=false;fixture.heldPost=true;fixture.pendingRefund=fixture.refunds.refundPayment(fixture.payment,"12.50","requested_by_customer");});
    await postRenewal.waitForFunction(()=>fixture.waiters.length===1);
    await postRenewal.evaluate(()=>{fixture.options={...fixture.options,token:"renewed"};fixture.refundOptions={...fixture.refundOptions,token:"renewed"};fixture.render();});
    await postRenewal.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    await postRenewal.evaluate(()=>{fixture.waiters[0].resolve();return fixture.pendingRefund;});
    assert.equal(await postRenewal.evaluate(()=>fixture.receipts().length),0);
    assert.equal(await postRenewal.evaluate(()=>fixture.requests.find(r=>r.path==="/billing/payments/payment-1").token),"renewed");
    await postRenewal.close();

    for (const change of ["signout","other-studio","role","capability","unmount"]) {
      const page=await mountRefundFixture(browser);
      await page.evaluate(()=>{fixture.failAfterPost=false;fixture.heldGet="/billing/payments/payment-1";fixture.pendingRefund=fixture.refunds.refundPayment(fixture.payment,"12.50","requested_by_customer");});
      await page.waitForFunction(()=>fixture.waiters.length===1);
      assert.match(await page.evaluate(()=>fixture.message),/Refund submitted/);
      await page.evaluate(change=>{
        if (change==="unmount") {fixture.root.unmount();return;}
        if (change==="capability") fixture.refundOptions={...fixture.refundOptions,enabledWorkflowIds:new Set()};
        else {
          const identity=change==="signout" ? null : {userId:"replacement",studioId:change==="other-studio" ? "other" : "studio"};
          const key=identity ? `${identity.userId}:${identity.studioId}:instructor:2` : null;
          fixture.options={...fixture.options,identity,identityKey:key,token:identity?"replacement-token":null,canViewStudioBilling:false};
          fixture.refundOptions={...fixture.refundOptions,identity,identityKey:key,role:"instructor",token:fixture.options.token};
        }
        fixture.render();
      },change);
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      if (change!=="unmount") assert.equal(await page.evaluate(()=>fixture.message),"",`${change} must remove the old refund's message`);
      await page.evaluate(()=>{fixture.heldGet=null;fixture.waiters.splice(0).forEach(w=>w.resolve());return fixture.pendingRefund;});
      assert.equal(await page.evaluate(()=>fixture.receipts().length),1,`${change} retains original recovery state`);
      if (!["unmount","capability"].includes(change)) assert.deepEqual(await page.evaluate(()=>fixture.state.payments),[]);
      assert.equal(await page.evaluate(()=>fixture.posts.length),1);
      await page.close();
    }
  } finally {await browser.close();}
});

test("an old refund's finally cannot release the replacement identity's pending operation", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const page=await mountRefundFixture(browser);
    await page.evaluate(()=>{fixture.failAfterPost=false;fixture.heldPost=true;fixture.oldRefund=fixture.refunds.refundPayment(fixture.payment,"12.50","requested_by_customer");});
    await page.waitForFunction(()=>fixture.waiters.length===1);
    await page.evaluate(()=>{
      const identity={userId:"new-admin",studioId:"new-studio"};
      fixture.options={...fixture.options,identity,identityKey:"new-admin:new-studio:admin:2",token:"new-token"};
      fixture.refundOptions={...fixture.refundOptions,identity,identityKey:fixture.options.identityKey,token:"new-token"};
      fixture.payment={...fixture.payment,id:"payment-2",studio_id:"new-studio",stripe_charge_id:"charge-2",refunded_amount_cents:0,net_collected_amount_cents:5000,refundable_amount_cents:5000};
      fixture.refundResponse=null;fixture.render();
    });
    await page.waitForFunction(()=>fixture.state.payments[0]?.id==="payment-2");
    await page.evaluate(()=>{fixture.newRefund=fixture.refunds.refundPayment(fixture.state.payments[0],"10.00","requested_by_customer");});
    await page.waitForFunction(()=>fixture.waiters.length===2);
    await page.evaluate(()=>{fixture.waiters[0].resolve();return fixture.oldRefund;});
    assert.equal(await page.evaluate(()=>fixture.refunds.activePaymentId),"payment-2");
    assert.equal(await page.evaluate(()=>fixture.message),"");
    await page.evaluate(()=>{fixture.waiters[1].resolve();return fixture.newRefund;});
    assert.equal(await page.evaluate(()=>fixture.refunds.activePaymentId),null);
    assert.equal(await page.evaluate(()=>fixture.receipts().length),1,"only the unresolved old identity's receipt remains");
    assert.equal(await page.evaluate(()=>fixture.posts.length),2);
  } finally {await browser.close();}
});

test("accepted refund recovery survives remount at zero balance without another provider command", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const page=await mountRefundFixture(browser);
    await page.evaluate(()=>fixture.refunds.refundPayment(fixture.payment,"50.00","requested_by_customer"));
    assert.equal(await page.evaluate(()=>fixture.receipts().length),1);
    await page.evaluate(()=>{fixture.root.unmount();fixture.failPayments=false;});
    await page.addScriptTag({content:bundle({refunds:true})});
    await page.waitForFunction(()=>fixture.state.payments[0]?.refundable_amount_cents===0);
    await page.getByRole("button",{name:"Refresh payment",exact:true}).click();
    await page.waitForFunction(()=>fixture.receipts().length===0);
    assert.equal(await page.evaluate(()=>fixture.posts.length),1);
    assert.equal(await page.getByRole("button",{name:"Issue refund",exact:true}).count(),0);
  } finally {await browser.close();}
});

test("unverified refund or target results retain the exact receipt, and current access denial clears financial data", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    for (const fault of ["refund-studio","refund-amount","refund-missing","target-studio","target-id","target-balance",404,401,403,402]) {
      const page=await mountRefundFixture(browser);
      await page.evaluate(fault=>{
        fixture.failAfterPost=false;
        if (String(fault).startsWith("refund")) {
          fixture.refundResponse={id:"refund-1",studio_id:"studio",payment_id:"payment-1",amount_cents:1250,status:"succeeded",reconciliation_required:false};
          if (fault==="refund-studio") fixture.refundResponse.studio_id="other";
          if (fault==="refund-amount") fixture.refundResponse.amount_cents=5000;
          if (fault==="refund-missing") delete fixture.refundResponse.payment_id;
        }
        if (String(fault).startsWith("target")) {
          fixture.targetOverride={...fixture.payment};
          if (fault==="target-studio") fixture.targetOverride.studio_id="other";
          if (fault==="target-id") fixture.targetOverride.id="another-payment";
          if (fault==="target-balance") delete fixture.targetOverride.refundable_amount_cents;
        }
        if (typeof fault==="number") fixture.targetStatus=fault;
        return fixture.refunds.refundPayment(fixture.payment,"12.50","requested_by_customer");
      },fault);
      assert.equal(await page.evaluate(()=>fixture.receipts().length),1,String(fault));
      assert.equal(await page.evaluate(()=>JSON.parse(fixture.receipts()[0][1]).requestKey),await page.evaluate(()=>fixture.posts[0].options.headers["Idempotency-Key"]));
      if ([401,402,403].includes(fault)) assert.deepEqual(await page.evaluate(()=>fixture.state.payments),[]);
      if (String(fault).startsWith("refund")) assert.equal(await page.evaluate(()=>fixture.message),"");
      await page.close();
    }
  } finally {await browser.close();}
});

test("refund storage failures recover the original command or only its balance, including zero remaining balance", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    for (const failure of ["marker","removal"]) {
      const page=await mountRefundFixture(browser);
      await page.evaluate(failure=>{
        fixture.failAfterPost=false;
        fixture.originalSet=Storage.prototype.setItem;fixture.originalRemove=Storage.prototype.removeItem;
        if (failure==="marker") Storage.prototype.setItem=function(key,value){if (value.includes("acceptedRefundId")) throw new Error("storage full");fixture.originalSet.call(this,key,value);};
        else Storage.prototype.removeItem=function(){};
        return fixture.refunds.refundPayment(fixture.payment,"50.00","requested_by_customer");
      },failure);
      const original=await page.evaluate(()=>JSON.parse(fixture.receipts()[0][1]));
      assert.equal(Boolean(original.acceptedRefundId),failure==="removal");
      assert.match(await page.evaluate(()=>fixture.error),failure==="marker" ? /could not be saved/ : /could not be cleared/);
      await page.evaluate(()=>{Storage.prototype.setItem=fixture.originalSet;Storage.prototype.removeItem=fixture.originalRemove;fixture.root.unmount();});
      await page.addScriptTag({content:bundle({refunds:true})});
      await page.waitForFunction(()=>fixture.state.payments[0]?.refundable_amount_cents===0);
      await page.getByRole("button",{name:failure==="marker" ? "Retry original refund" : "Refresh payment",exact:true}).click();
      await page.waitForFunction(()=>fixture.receipts().length===0);
      const posts=await page.evaluate(()=>fixture.posts);
      assert.equal(posts.length,failure==="marker" ? 2 : 1);
      assert.ok(posts.every(post=>post.options.headers["Idempotency-Key"]===original.requestKey && post.body.amount_cents===5000));
      await page.close();
    }

    const page=await mountRefundFixture(browser);
    await page.evaluate(()=>{fixture.postStatus=503;return fixture.refunds.refundPayment(fixture.payment,"50.00","requested_by_customer");});
    const key=await page.evaluate(()=>JSON.parse(fixture.receipts()[0][1]).requestKey);
    await page.evaluate(()=>{fixture.postStatus=401;fixture.failPayments=false;return fixture.refunds.recoverRefund(fixture.payment);});
    assert.equal(await page.evaluate(()=>JSON.parse(fixture.receipts()[0][1]).requestKey),key,"a rejection of a replay does not disprove the earlier accepted request");
    await page.evaluate(()=>{fixture.postStatus=null;fixture.failAfterPost=false;return fixture.refunds.recoverRefund(fixture.payment);});
    assert.equal(await page.evaluate(()=>fixture.receipts().length),0);
    assert.ok(await page.evaluate(()=>fixture.posts.every(p=>p.options.headers["Idempotency-Key"]===fixture.posts[0].options.headers["Idempotency-Key"])));
  } finally {await browser.close();}
});

test("refund completion preserves a newer receipt and settles through tab changes without stranding other reads", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const page=await mountRefundFixture(browser);
    await page.evaluate(()=>{fixture.failAfterPost=false;fixture.heldGet="/billing/payments/payment-1";fixture.pendingRefund=fixture.refunds.refundPayment(fixture.payment,"12.50","requested_by_customer");});
    await page.waitForFunction(()=>fixture.waiters.length===1);
    await page.evaluate(()=>{
      const [key,raw]=fixture.receipts()[0];localStorage.setItem(key,JSON.stringify({...JSON.parse(raw),requestKey:"newer-request"}));
      fixture.options={...fixture.options,activeTab:"plans"};fixture.heldGet="/billing/plans";fixture.render();
    });
    await page.waitForFunction(()=>fixture.waiters.length===2);
    await page.evaluate(()=>{fixture.waiters.find(w=>w.path==="/billing/payments/payment-1").resolve();return fixture.pendingRefund;});
    assert.equal(await page.evaluate(()=>JSON.parse(fixture.receipts()[0][1]).requestKey),"newer-request");
    await page.evaluate(()=>{fixture.heldGet=null;fixture.waiters.find(w=>w.path==="/billing/plans").resolve();});
    await page.waitForFunction(()=>fixture.state.hasBillingLoadSettled);
    assert.equal(await page.evaluate(()=>fixture.state.isLoading),false);
    assert.equal(await page.evaluate(()=>fixture.options.activeTab),"plans");
  } finally {await browser.close();}
});

test("known target access loss prevents older landing and unrelated tab reads from restoring financial access", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    for (const held of ["/billing/landing","/billing/plans"]) {
      const page=await mountRefundFixture(browser);
      await page.evaluate(()=>{fixture.failAfterPost=false;fixture.heldPost=true;fixture.pendingRefund=fixture.refunds.refundPayment(fixture.state.payments[0],"12.50","requested_by_customer");});
      await page.waitForFunction(()=>fixture.waiters.length===1);
      await page.evaluate(held=>{
        fixture.heldGet=held;
        if (held==="/billing/plans") {fixture.options={...fixture.options,activeTab:"plans"};fixture.render();}
        else fixture.staleRead=fixture.state.refreshBilling();
      },held);
      await page.waitForFunction(held=>fixture.waiters.some(w=>w.path===held),held);
      await page.evaluate(()=>{fixture.targetStatus=403;fixture.waiters.find(w=>w.path.endsWith("/refund")).resolve();return fixture.pendingRefund;});
      assert.equal(await page.evaluate(()=>fixture.state.isLoading),false);
      assert.equal(await page.evaluate(()=>fixture.state.landing),null);
      await page.evaluate(held=>{fixture.heldGet=null;fixture.waiters.find(w=>w.path===held).resolve();return fixture.staleRead;},held);
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      assert.deepEqual(await page.evaluate(()=>[fixture.state.landing,fixture.state.billingSystemStatus,fixture.state.plans,fixture.state.payments,fixture.state.isLoading]),[null,null,[],[],false]);
      assert.equal(await page.evaluate(()=>fixture.receipts().length),1);
      await page.close();
    }
  } finally {await browser.close();}
});

test("real refund controls enforce confirmation, access, preview, storage and reconciliation gates", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const page=await mountRefundFixture(browser);
    assert.doesNotMatch(await page.locator("body").innerText(),/charge-1|account-1/);
    await page.getByLabel("Refund amount",{exact:true}).fill("12.50");
    await page.evaluate(()=>{fixture.cancelConfirm=true;});
    await page.getByRole("button",{name:"Issue refund",exact:true}).click();
    assert.equal(await page.evaluate(()=>fixture.posts.length),0);
    for (const gate of ["role","capability","preview","storage"]) {
      await page.evaluate(gate=>{
        fixture.refundOptions={...fixture.refundOptions,role:gate==="role"?"instructor":"admin",enabledWorkflowIds:new Set(gate==="capability"?[]:["payment.refund"]),isPreviewMode:gate==="preview"};
        if (gate==="storage") Object.defineProperty(window,"localStorage",{get(){throw new Error("storage blocked");}});
        fixture.render();
      },gate);
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      await page.evaluate(()=>fixture.refunds.refundPayment(fixture.payment,"12.50","requested_by_customer"));
      assert.equal(await page.evaluate(()=>fixture.posts.length),0,gate);
    }
    await page.close();

    for (const status of ["failed","canceled","pending","requires_action","reconciliation"]) {
      const payment=await mountRefundFixture(browser);
      await payment.evaluate(status=>{
        fixture.failAfterPost=false;
        fixture.refundResponse={id:"refund-1",studio_id:"studio",payment_id:"payment-1",amount_cents:1250,status:status==="reconciliation"?"pending":status,reconciliation_required:status==="reconciliation"};
        if (["pending","requires_action"].includes(status)) fixture.payment.refundable_amount_cents=3750;
        return fixture.refunds.refundPayment(fixture.payment,"12.50","requested_by_customer");
      },status);
      if (status==="reconciliation") {
        assert.equal(await payment.evaluate(()=>fixture.receipts().length),1);
        assert.equal(await payment.getByRole("button",{name:/Issue refund|Retry original refund|Refresh payment/}).count(),0);
      } else {
        assert.equal(await payment.evaluate(()=>fixture.receipts().length),0);
        assert.match(await payment.evaluate(()=>fixture.message),status==="failed" ? /refund failed/ : status==="canceled" ? /refund was canceled/ : /Refund submitted/);
      }
      await payment.close();
    }
  } finally {await browser.close();}
});

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

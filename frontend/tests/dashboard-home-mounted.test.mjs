import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function bundle() {
  const { add, modules } = createCommonJsPacker({
    "lucide-react": `module.exports=new Proxy({},{get:(_,key)=>key==='createLucideIcon'?()=>()=>null:()=>null});`,
    "@/components/intent-prefetch-link": `exports.IntentPrefetchLink=props=>require('react').createElement('a',{href:props.href},props.children);`,
    "@/lib/performance": `exports.markDashboardReadiness=()=>()=>{};`,
    "@/components/dataset-readiness-panel": `exports.DatasetReadinessErrorPanel=()=>null;`,
    "./dashboard-home.module.css": `module.exports={};`,
  });
  const react = add("react"),
    dom = add("react-dom/client");
  const home = add("@/components/dashboard/dashboard-page-content");
  const retained = add("@/lib/retained-state"),
    layout = add("@/lib/dashboard-layout-store");
  const catalog = add("@/lib/dashboard-widget-catalog");
  return `(()=>{
    const process={env:{NODE_ENV:'production'}},modules=[${modules.join(",")}],cache={};
    function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
    const React=require(${react}),f=window.fixture={firstFrames:[]};
    const layouts=require(${layout});
    const saved=layouts.buildDefaultDashboardLayout('admin');
    saved.items=layouts.resizeDashboardLayoutItem(saved.items,saved.items[1].widget_id,'2x2');
    layouts.writeDashboardLayout(window.localStorage,{userId:'user',studioId:'studio',role:'admin'},saved);
    const models=Object.fromEntries(require(${catalog}).DASHBOARD_WIDGET_CATALOG.map(w=>[w.id,{id:w.id,state:'unavailable',detail:'No data',rows:[],actions:[],provenanceLabel:'Live'}]));
    const noop=()=>{};
    function Probe({studio,ready}){
      React.useLayoutEffect(()=>{f.firstFrames.push(document.querySelector('[data-layout-resolved]').dataset.layoutResolved);},[]);
      return React.createElement(require(${home}).DashboardPageContent,{currentUserId:'user',currentStudioId:studio,currentRole:'admin',identityGeneration:1,isDashboardIdentityReady:ready,isDashboardDataReady:false,isPreviewMode:false,widgetViewModels:models,onVisibleWidgetsChange:noop,retryDashboardDatasets:noop});
    }
    function App(){
      const [mounted,setMounted]=React.useState(true),[studio,setStudio]=React.useState('studio'),[ready,setReady]=React.useState(true);
      f.setMounted=setMounted;f.setStudio=setStudio;f.setReady=setReady;
      return React.createElement(require(${retained}).RetainedStateProvider,{scope:studio},mounted?React.createElement(Probe,{key:studio,studio,ready}):null);
    }
    f.root=require(${dom}).createRoot(document.getElementById('root'));f.root.render(React.createElement(App));
  })();`;
}
const flush = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

test("Home revisits render saved geometry on the first commit and still respect identity and studio changes", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
    );
    await page.goto("http://fixture.local/");
    await page.addScriptTag({ content: bundle() });
    await page.waitForFunction(() => document.querySelector('[data-layout-resolved="true"]'));
    assert.equal(await page.evaluate(() => fixture.firstFrames[0]), "false");
    const savedGeometry = await page
      .locator("[data-widget-id]")
      .evaluateAll((nodes) =>
        nodes.map((node) => [node.dataset.widgetId, node.dataset.size, node.getAttribute("style")]),
      );
    await page.evaluate(() => fixture.setMounted(false));
    await flush(page);
    await page.evaluate(() => fixture.setMounted(true));
    await flush(page);
    assert.equal(await page.evaluate(() => fixture.firstFrames[1]), "true");
    assert.deepEqual(
      await page
        .locator("[data-widget-id]")
        .evaluateAll((nodes) =>
          nodes.map((node) => [
            node.dataset.widgetId,
            node.dataset.size,
            node.getAttribute("style"),
          ]),
        ),
      savedGeometry,
    );
    assert.equal(await page.locator("#dashboard-layout-status").count(), 0);
    await page.evaluate(() => fixture.setReady(false));
    await flush(page);
    assert.equal(await page.locator('[data-layout-resolved="false"]').count(), 1);
    assert.equal(await page.getByRole("heading", { name: "Dashboard", exact: true }).count(), 1);
    await page.evaluate(() => {
      fixture.setReady(true);
      fixture.setStudio("studio-b");
    });
    await flush(page);
    assert.equal(await page.evaluate(() => fixture.firstFrames[2]), "false");
  } finally {
    await browser.close();
  }
});

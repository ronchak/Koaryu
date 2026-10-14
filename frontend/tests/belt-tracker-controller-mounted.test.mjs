import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function bundle() {
  const { add, modules } = createCommonJsPacker({
    "next/navigation": `const router={push:href=>history.pushState(null,'',href)};exports.useRouter=()=>router;`,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const controller = add("@/lib/belt-tracker-page-controller");
  return `(()=>{const process={env:{NODE_ENV:'production'}},modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}const React=require(${react}),noop=()=>{};
    const beltStore={beltLadders:[],beltRanks:[],currentLadderId:null,eligibility:[],eligibilityLadderId:null,eligibilityPendingLadderId:null,subRankTerm:'Stripe',loadEligibilityForLadder:async()=>[],setCurrentLadder:noop};
    const programsStore={programs:[],programsLoaded:true,refreshPrograms:noop};
    function Fixture(){const c=require(${controller}).useBeltTrackerPageController({beltStore,config:{currentRole:'admin'},programsStore});return React.createElement('button',{onClick:c.eligibilityPanelProps.onViewStudents},'View students');}
    require(${dom}).createRoot(document.getElementById('root')).render(React.createElement(Fixture));})();`;
}

test("empty eligibility opens students through client history and Back returns to Belt Tracker", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
    );
    await page.goto("http://fixture.local/belt-tracker");
    const documents = [];
    page.on("request", (request) => {
      if (request.resourceType() === "document") documents.push(request.url());
    });
    await page.addScriptTag({ content: bundle() });
    await page.getByRole("button", { name: "View students" }).click();
    assert.equal(new URL(page.url()).pathname, "/students");
    await page.goBack();
    assert.equal(new URL(page.url()).pathname, "/belt-tracker");
    assert.deepEqual(documents, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";
import { NAV_ITEMS, crmLinkPrefetch } from "../src/lib/constants.ts";
import { canPrefetchOnConnection, createIntentPrefetchPolicy } from "../src/lib/intent-prefetch.ts";

test("intent prefetch respects constrained connections and bounds speculative requests", () => {
  let now = 1000;
  const allow = createIntentPrefetchPolicy(() => now);
  assert.equal(allow("/billing", { saveData: true }), false);
  assert.equal(allow("/billing", { effectiveType: "2g" }), false);
  assert.equal(allow("/billing"), true);
  assert.equal(allow("/reports"), false);
  now += 251;
  assert.equal(allow("/reports"), true);
  now += 1000;
  assert.equal(allow("/billing"), false);
  now += 30000;
  assert.equal(allow("/billing"), true);
});

test("every nav item uses default prefetch and connection constraints cover automatic requests", () => {
  for (const item of NAV_ITEMS) {
    assert.equal(item.prefetch, undefined);
    assert.equal(crmLinkPrefetch(item.href), undefined);
  }
  for (const connection of [
    { saveData: true },
    { effectiveType: "2g" },
    { effectiveType: "slow-2g" },
  ])
    assert.equal(canPrefetchOnConnection(connection), false);
  assert.equal(canPrefetchOnConnection(), true);
  assert.equal(canPrefetchOnConnection({ effectiveType: "4g" }), true);
});

function browserBundle() {
  const { add, modules } = createCommonJsPacker({
    "next/link": `exports.__esModule=true;exports.default=({prefetch,children,...props})=>require('react').createElement('a',{...props,'data-prefetch':prefetch===false?'off':'auto'},children);`,
    "next/navigation": `exports.useRouter=()=>({prefetch:path=>window.fixture.prefetches.push(path)});`,
    "@/lib/supabase/client": `exports.createClient=()=>({});`,
    "@/lib/api": `exports.api={};`,
    "@/components/auth/social-sign-in": `exports.SocialSignIn=()=>null;`,
    "@/components/auth/callback-error": `exports.CallbackError=()=>null;`,
    "@/components/auth/legal-consent-notice": `exports.LegalConsentNotice=()=>null;`,
    "@/components/auth/horizon-scene": `for(const name of ['SceneFootnote','SceneIntro','SceneSheet','SceneSplit'])exports[name]=({children})=>require('react').createElement('div',null,children);`,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
  });
  const react = add("react"),
    dom = add("react-dom/client"),
    link = add("@/components/intent-prefetch-link"),
    login = add("@/app/(auth)/login/page");
  return `(()=>{const process={env:{NODE_ENV:'production'}},modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}const React=require(${react}),root=require(${dom}).createRoot(document.getElementById('root'));root.render(React.createElement(React.Fragment,null,React.createElement(require(${link}).IntentPrefetchLink,{href:'/billing'},'Billing'),React.createElement(require(${login}).default)));})();`;
}

for (const connection of [
  undefined,
  { saveData: true },
  { effectiveType: "2g" },
  { effectiveType: "slow-2g" },
]) {
  test(`mounted links and first login interaction respect ${JSON.stringify(connection) ?? "normal connection"}`, async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent('<div id="root"></div>');
      await page.evaluate((connection) => {
        window.fixture = { prefetches: [] };
        Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
      }, connection);
      await page.addScriptTag({ content: browserBundle() });
      const allowed = canPrefetchOnConnection(connection);
      await page.waitForFunction(
        (allowed) =>
          document.querySelector('a[href="/billing"]')?.dataset.prefetch ===
          (allowed ? "auto" : "off"),
        allowed,
      );
      const email = page.getByLabel("Email", { exact: true });
      await email.focus();
      await email.fill("owner@example.test");
      await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
      await email.focus();
      assert.deepEqual(
        await page.evaluate(() => fixture.prefetches),
        allowed ? ["/dashboard"] : [],
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}

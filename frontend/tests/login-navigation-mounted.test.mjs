import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function bundle(preview) {
  const { add, modules } = createCommonJsPacker({
    "next/navigation": `exports.useRouter=()=>({push:path=>fixture.events.push(['push',path,performance.now()]),refresh:()=>fixture.events.push(['refresh']),prefetch:()=>{}});`,
    "next/link": `exports.__esModule=true;exports.default=({children,...props})=>require('react').createElement('a',props,children);`,
    "@/lib/supabase/client": `exports.createClient=()=>({auth:{signInWithPassword:async()=>({data:{session:{access_token:'synthetic',user:{id:'user-1'}}}})}});`,
    "@/lib/api": `exports.api={get:async path=>{fixture.events.push(['read',path]);return fixture.profile}};`,
    "@/components/auth/social-sign-in": `exports.SocialSignIn=()=>null;`,
    "@/components/auth/callback-error": `exports.CallbackError=()=>null;`,
    "@/components/auth/legal-consent-notice": `exports.LegalConsentNotice=()=>null;`,
    "@/components/auth/horizon-scene": `for(const name of ['SceneFootnote','SceneIntro','SceneSheet','SceneSplit'])exports[name]=({children})=>require('react').createElement('div',null,children);`,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
  });
  const react = add("react"),
    dom = add("react-dom/client"),
    login = add("@/app/(auth)/login/page");
  return `(()=>{const process={env:{NODE_ENV:'production',NEXT_PUBLIC_PREVIEW_MODE:'${preview}'}},modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}require(${dom}).createRoot(document.getElementById('root')).render(require(${react}).createElement(require(${login}).default));})();`;
}

for (const status of ["active", "archived", "none", "preview"]) {
  test(`password login navigates once without refreshing: ${status}`, async (t) => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.route("http://login.test/**", (route) =>
        route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
      );
      await page.goto("http://login.test");
      await page.evaluate((status) => {
        window.fixture = {
          events: [],
          profile: {
            user: { id: "user-1" },
            studio_id: status === "none" ? null : "studio-1",
            role: "admin",
            membership_status: status,
          },
        };
      }, status);
      await page.addScriptTag({ content: bundle(status === "preview") });
      await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
      await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
      await page.evaluate(() => (fixture.started = performance.now()));
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForFunction(() => fixture.events.some((e) => e[0] === "push"));
      const result = await page.evaluate(() => ({
        events: fixture.events,
        cookie: document.cookie,
        started: fixture.started,
      }));
      const pushes = result.events.filter((e) => e[0] === "push");
      assert.equal(pushes.length, 1);
      assert.equal(
        pushes[0][1],
        status === "archived"
          ? "/account-archived"
          : status === "none"
            ? "/onboarding"
            : "/dashboard",
      );
      assert.equal(result.events.filter((e) => e[0] === "refresh").length, 0);
      assert.equal(
        result.events.filter((e) => e[0] === "read").length,
        status === "preview" ? 0 : 1,
      );
      if (status !== "preview")
        assert.match(
          decodeURIComponent(result.cookie),
          new RegExp(`koaryu-studio-state=user-1\\|[01]\\|${status}`),
        );
      t.diagnostic(
        `synthetic login to push: ${(pushes[0][2] - result.started).toFixed(1)}ms; refresh requests: 0 (previously 1)`,
      );
    } finally {
      await browser.close();
    }
  });
}

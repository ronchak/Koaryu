import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function bundle(pageName, preview = false) {
  const { add, modules } = createCommonJsPacker({
    "next/navigation":
      "exports.useRouter=()=>({push:()=>{},refresh:()=>{}});exports.useSearchParams=()=>new URLSearchParams(window.testSearch);",
    "next/link":
      'exports.__esModule=true;exports.default=({children,...props})=>require("react").createElement("a",props,children);',
    "@/lib/supabase/client": `exports.createClient=()=>({auth:{signInWithOAuth:async(options)=>{window.calls.push(options);return await new Promise(resolve=>window.finish=resolve)},signInWithPassword:async()=>({error:{message:'Password attempt reached auth'}}),signInWithOtp:async()=>({error:null})}});`,
    "@/lib/api": "exports.api={};",
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const subject = add(`@/app/(auth)/${pageName}/page`);
  return `(()=>{const process={env:{NODE_ENV:'production',NEXT_PUBLIC_SITE_URL:'https://studio.example',NEXT_PUBLIC_PREVIEW_MODE:'${preview ? "true" : "false"}'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}window.calls=[];require(${dom}).createRoot(document.getElementById('root')).render(require(${react}).createElement(require(${subject}).default));})();`;
}

for (const pageName of ["login", "signup"]) {
  test(`${pageName}: Google precedes email, locks concurrent submissions, and recovers from provider failure`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: bundle(pageName) });
      const google = page.getByRole("button", { name: "Continue with Google" });
      await google.waitFor();
      assert.equal(await page.locator("button").first().textContent(), "Continue with Google");
      await google.click();
      assert.equal(await google.isDisabled(), true);
      assert.equal(
        await page
          .getByRole("button", {
            name: pageName === "login" ? "Sign in" : "Create account",
            exact: true,
          })
          .isDisabled(),
        true,
      );
      assert.deepEqual(await page.evaluate(() => window.calls), [
        {
          provider: "google",
          options: {
            redirectTo: "https://studio.example/auth/callback",
            queryParams: { prompt: "select_account" },
          },
        },
      ]);
      await page.evaluate(() => window.finish({ error: { message: "SECRET provider error" } }));
      await page.getByRole("alert").waitFor();
      assert.match(await page.getByRole("alert").textContent(), /try again or sign in with email/);
      assert.equal(await google.isEnabled(), true);
      assert.equal((await page.locator("body").textContent()).includes("SECRET"), false);
      if (pageName === "login") {
        await page.getByLabel("Email", { exact: true }).fill("owner@example.com");
        await page.getByLabel("Password", { exact: true }).fill("test-password");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await page.getByText("Password attempt reached auth", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Sign in with magic link instead" }).click();
        await page.getByRole("button", { name: "Send magic link" }).click();
        await page.getByText("Check your email", { exact: true }).waitFor();
      }
    } finally {
      await browser.close();
    }
  });
}

test("login displays only recognized callback failures", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const code of ["missing_code", "callback_failed", "access_denied", "untrusted", null]) {
      const page = await browser.newPage();
      await page.setContent('<div id="root"></div>');
      await page.evaluate((code) => {
        window.testSearch = code ? `error=${code}` : "";
      }, code);
      await page.addScriptTag({ content: bundle("login") });
      await page.getByRole("button", { name: "Continue with Google" }).waitFor();
      assert.equal(await page.getByRole("alert").count(), code && code !== "untrusted" ? 1 : 0);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

for (const pageName of ["login", "signup"]) {
  test(`${pageName}: Microsoft requests basic identity scopes, excludes extra access, and shares the provider submission lock`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: bundle(pageName) });
      const microsoft = page.getByRole("button", { name: "Sign in with Microsoft", exact: true });
      await microsoft.waitFor();
      assert.deepEqual((await page.locator("button").allTextContents()).slice(0, 2), [
        "Continue with Google",
        "Sign in with Microsoft",
      ]);
      // Fire both clicks in one task, before React can commit disabled props.
      await page.evaluate(() => {
        const buttons = [...document.querySelectorAll("button")];
        buttons[1].click();
        buttons[0].click();
      });
      assert.deepEqual(await page.evaluate(() => window.calls), [
        {
          provider: "azure",
          options: {
            redirectTo: "https://studio.example/auth/callback",
            scopes: "email profile",
            queryParams: { prompt: "select_account" },
          },
        },
      ]);
      assert.equal(await microsoft.isDisabled(), true);
      assert.equal(
        await page.getByRole("button", { name: "Continue with Google" }).isDisabled(),
        true,
      );
      await page.evaluate(() => window.finish({ error: null }));
      // Resolving OAuth does not mean navigation has finished. Keep PKCE locked.
      assert.equal(await microsoft.isDisabled(), true);
      await page.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })),
      );
      assert.equal(await microsoft.isDisabled(), true);
      await page.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
      );
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll("button")].find((b) =>
            b.textContent.includes("Sign in with Microsoft"),
          ).disabled,
      );
      await microsoft.click();
      await page.evaluate(() => window.finish({ error: { message: "PRIVATE tenant detail" } }));
      await page.getByRole("alert").waitFor();
      assert.match(await page.getByRole("alert").textContent(), /Microsoft sign-in couldn't start/);
      assert.equal((await page.locator("body").textContent()).includes("PRIVATE"), false);
      assert.equal(await microsoft.isEnabled(), true);
    } finally {
      await browser.close();
    }
  });
}

test("preview mode refuses Microsoft auth and leaves email fallback usable", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle("login", true) });
    await page.getByRole("button", { name: "Sign in with Microsoft" }).click();
    await page.getByRole("alert").waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    assert.equal(
      await page.getByRole("button", { name: "Sign in", exact: true }).isEnabled(),
      true,
    );
  } finally {
    await browser.close();
  }
});

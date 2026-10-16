import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

// The catalog's entry points: the header's New workflow button and the built-in
// missed-class row at the top of the automations list. Synthetic stores and API only.
function bundle() {
  const { add, modules } = createCommonJsPacker({
    "@/lib/store": `const React=require('react');exports.useConfigStore=exports.useStudioStore=()=>React.useSyncExternalStore(window.f.subscribe,window.f.getState);`,
    "@/lib/api": `class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}exports.ApiError=ApiError;exports.api=window.f.api;`,
    "next/navigation": `exports.useRouter=()=>({push(path){window.f.pushes.push(path)},replace(path){window.f.pushes.push(path)}});`,
    "next/link": `exports.__esModule=true;exports.default=({children,href,prefetch,...props})=>require('react').createElement('a',{href,...props},children);`,
    "./workflow-workspace.module.css": "module.exports=new Proxy({},{get:(_,key)=>String(key)});",
    "@/components/ui/horizon.module.css":
      "module.exports=new Proxy({},{get:(_,key)=>String(key)});",
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const row = add("@/components/automations/missed-class-summary-row");
  const button = add("@/components/automations/new-workflow-button");
  const refresh = add("@/components/automations/catalog-refresh-context");
  const retained = add("@/lib/retained-state");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
const React=require(${react});const root=require(${dom}).createRoot(document.getElementById('root'));
function Fixture(){const [shown,setShown]=React.useState(true);window.f.show=setShown;const state=React.useSyncExternalStore(window.f.subscribe,window.f.getState);return React.createElement(require(${retained}).RetainedStateProvider,{scope:JSON.stringify([state.isPreviewMode,state.currentUserId,state.currentStudioId])},React.createElement('div',null,React.createElement(require(${button}).NewWorkflowButton),React.createElement(require(${refresh}).CatalogRefreshContext.Provider,{value:state.refreshGeneration??0},React.createElement('ul',null,shown?React.createElement(require(${row}).MissedClassSummaryRow):null))));}
root.render(React.createElement(Fixture));})();`;
}

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

async function mount(t, options = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  // A localhost origin is a secure context, so crypto.randomUUID exists as it does in the app.
  await page.route("**/*", (route) =>
    route.request().url() === "http://localhost/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://localhost/");
  await page.evaluate((options) => {
    const f = (window.f = { calls: [], pushes: [], reads: [], ...options });
    const listeners = new Set();
    f.state = {
      token: "token-one",
      isPreviewMode: false,
      currentRole: "admin",
      currentStudioId: "studio-one",
      currentUserId: "owner-one",
      identityReady: true,
      ...options.state,
    };
    f.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    f.getState = () => f.state;
    f.setState = (patch) => {
      f.state = { ...f.state, ...patch };
      listeners.forEach((listener) => listener());
    };
    f.settings = {
      rule: {
        enabled: !!options.enabled,
        inactivity_days: 21,
        subject_template: "Hello",
        body_template: "Body",
        reply_to_email: "",
        revision: 3,
        updated_at: null,
      },
      delivery_status: {
        mode: "test",
        configured: true,
        can_enable: true,
        sender: "sample@example.test",
        test_recipient: null,
        reason: null,
      },
    };
    f.api = {
      get: (path, token, requestOptions) => {
        f.calls.push({ path, token });
        if (f.fail) return Promise.reject(new Error("Settings unavailable"));
        if (f.hold)
          return new Promise((resolve, reject) =>
            f.reads.push({ resolve, reject, signal: requestOptions.signal }),
          );
        return Promise.resolve(structuredClone(f.settings));
      },
    };
  }, options);
  await page.addScriptTag({ content: bundle() });
  return page;
}

test("the built-in row reads the saved rule once and shows its state, gap and destination", async (t) => {
  const page = await mount(t, { enabled: true });
  const row = page.locator('[data-built-in-automation="missed-class"]');
  await row.getByText("Enabled", { exact: true }).waitFor();
  await row.getByText("21 days", { exact: false }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.f.calls), [
    { path: "/automations/missed-class", token: "token-one" },
  ]);
  const links = await row
    .locator("a")
    .evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href")));
  assert.deepEqual(links, ["/automations/missed-class", "/automations/missed-class"]);
  await page.getByRole("link", { name: "Missed-class nudges", exact: true }).waitFor();
  await page.getByRole("link", { name: "Open Missed-class nudges", exact: true }).waitFor();
});

test("a paused rule, an unavailable read and the sample all say so without a second request", async (t) => {
  const paused = await mount(t, { enabled: false });
  await paused.locator('[data-built-in-automation="missed-class"]').getByText("Paused").waitFor();
  const failed = await mount(t, { fail: true });
  await failed.getByText("Current status could not be loaded. Open the rule to retry.").waitFor();
  assert.equal(await failed.evaluate(() => window.f.calls.length), 1);
  await failed.getByText("a while without class", { exact: false }).waitFor();
  const sample = await mount(t, { state: { isPreviewMode: true, token: null } });
  await sample.locator('[data-built-in-automation="missed-class"]').getByText("Sample").waitFor();
  await sample.getByText("14 days", { exact: false }).waitFor();
  assert.deepEqual(await sample.evaluate(() => window.f.calls), []);
});

test("New workflow opens a fresh draft address for admins and stays out of other roles' way", async (t) => {
  const page = await mount(t);
  await page.getByRole("button", { name: "New workflow" }).click();
  const pushes = await page.evaluate(() => window.f.pushes);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /^\/automations\/new\?draft=[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "New workflow" }).click();
  const [first, second] = await page.evaluate(() => window.f.pushes);
  assert.notEqual(first, second);
  await page.evaluate(() => window.f.setState({ currentRole: "front_desk" }));
  await page.getByRole("button", { name: "New workflow" }).waitFor({ state: "detached" });
  await page.evaluate(() => window.f.setState({ currentRole: "admin", identityReady: false }));
  assert.equal(await page.getByRole("button", { name: "New workflow" }).isDisabled(), true);
  const sample = await mount(t, {
    state: { isPreviewMode: true, token: null, identityReady: false },
  });
  assert.equal(await sample.getByRole("button", { name: "New workflow" }).isDisabled(), false);
});

test("catalog revisit paints retained status then refreshes changes made elsewhere", async (t) => {
  const page = await mount(t);
  const row = page.locator('[data-built-in-automation="missed-class"]');
  await row.getByText("Paused", { exact: true }).waitFor();
  await page.evaluate(() => f.show(false));
  await row.waitFor({ state: "detached" });
  await page.evaluate(() => {
    f.hold = true;
    f.settings.rule = { ...f.settings.rule, enabled: true, inactivity_days: 30 };
    f.show(true);
  });
  await page.waitForFunction(() => f.reads.length === 1);
  await row.getByText("Paused", { exact: true }).waitFor();
  await page.evaluate(() => f.reads[0].resolve(structuredClone(f.settings)));
  await row.getByText("Enabled", { exact: true }).waitFor();
  await row.getByText("30 days", { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => f.calls.length), 2);
});

test("the catalog's refresh re-reads the built-in row and clears an earlier failure", async (t) => {
  const page = await mount(t, { fail: true });
  await page.getByText("Current status could not be loaded. Open the rule to retry.").waitFor();
  assert.equal(await page.evaluate(() => window.f.calls.length), 1);
  await page.evaluate(() => {
    window.f.fail = false;
    window.f.settings.rule.enabled = true;
    window.f.setState({ refreshGeneration: 1 });
  });
  await page.locator('[data-built-in-automation="missed-class"]').getByText("Enabled").waitFor();
  await page
    .getByText("Current status could not be loaded. Open the rule to retry.")
    .waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.f.calls.length), 2);
});

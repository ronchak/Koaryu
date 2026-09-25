import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

// Real support and account-settings pages with their real controls. The store, API,
// router and page chrome are synthetic; every read and write settles when the test says.
function bundle(pageModule) {
  const { add, modules } = createCommonJsPacker({
    "@/lib/store": `const React=require("react");exports.useConfigStore=()=>React.useSyncExternalStore(window.fixture.subscribe,()=>window.fixture.config);exports.useStudioStore=()=>window.fixture.studio;`,
    "@/lib/api": `exports.api=window.fixture.api;`,
    "next/navigation": `const search=new URLSearchParams('');exports.useSearchParams=()=>search;const router={push(){},refresh(){},replace(){}};exports.useRouter=()=>router;exports.usePathname=()=>'/help/contact';`,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
    "@/components/account-page-shell": `const React=require("react");const box=({title,children})=>React.createElement("section",null,title?React.createElement("h2",null,title):null,children);exports.AccountPageShell=({children})=>React.createElement("main",null,children);exports.AccountSection=box;exports.AccountNotice=({children})=>React.createElement("p",null,children);exports.AccountLinkTile=({title})=>React.createElement("a",null,title);exports.AccountInfoRow=({label,value})=>React.createElement("p",null,label+": "+value);`,
    "@/components/account/account-name-section": `exports.AccountNameSection=()=>null;`,
    "@/components/intent-prefetch-link": `const React=require("react");exports.IntentPrefetchLink=({children,href})=>React.createElement("a",{href},children);`,
    "@/lib/supabase/client": `exports.createClient=()=>({auth:{}});`,
    "@/lib/store-session-cookies": `exports.clearStoredStudioSessionCookies=()=>{};`,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const subject = add(pageModule);
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}require(${dom}).createRoot(document.getElementById('root')).render(require(${react}).createElement(require(${subject}).default));})();`;
}

const sources = {
  support: bundle("@/app/(dashboard)/help/contact/page"),
  settings: bundle("@/app/(dashboard)/account/settings/page"),
};
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function mountPage(source) {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    const listeners = new Set();
    const f = (window.fixture = { reads: [], writes: [] });
    f.config = { token: "token-a" };
    f.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    f.setToken = (token) => {
      f.config = { token };
      listeners.forEach((listener) => listener());
    };
    f.studio = {
      currentRole: "admin",
      currentUserId: "user-a",
      refreshStaff: async () => {},
      staffLoaded: true,
      staffMembers: [],
      studioName: "Synthetic Studio",
      userEmail: "owner@example.test",
      userName: "Owner Name",
    };
    const held = (list, entry) =>
      new Promise((resolve, reject) => list.push({ ...entry, resolve, reject }));
    f.api = {
      get: (path, token, options = {}) =>
        new Promise((resolve, reject) => {
          const read = { path, token, resolve, reject };
          f.reads.push(read);
          options.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
      post: (path, body, token) => held(f.writes, { path, body, token }),
    };
  });
  await page.addScriptTag({ content: source });
  return { errors, page };
}

const ticket = (id, subject, createdAt) => ({
  id,
  subject,
  topic: "bug_report",
  severity: "normal",
  status: "open",
  created_at: createdAt,
});

async function submitSupportRequest(page, subject) {
  await page.getByLabel("Subject").fill(subject);
  await page.getByLabel("Details").fill("The front desk printer jams on every receipt.");
  await page.getByRole("button", { name: "Send request" }).click();
  await page.waitForFunction(() => fixture.writes.length === 1);
  await page.evaluate(
    (confirmed) => fixture.writes[0].resolve(confirmed),
    ticket("ticket-new", subject, "2026-09-24T12:00:00Z"),
  );
  await page.getByLabel("Subject").and(page.locator('[value=""]')).waitFor();
}

const recentSubjects = (page) =>
  page
    .getByRole("heading", { name: "Recent support requests" })
    .locator("xpath=..")
    .locator("p.truncate")
    .allTextContents();

test("a support ticket confirmed while the initial list read is pending survives that read", async () => {
  const { errors, page } = await mountPage(sources.support);
  await page.waitForFunction(() => fixture.reads.length === 1);
  await submitSupportRequest(page, "Printer jam");
  // The read started before the ticket existed, so its snapshot omits it.
  await page.evaluate(
    (older) => fixture.reads[0].resolve([older]),
    ticket("ticket-old", "Older issue", "2026-09-20T12:00:00Z"),
  );
  await page.getByText("Older issue").waitFor();
  assert.deepEqual(await recentSubjects(page), ["Printer jam", "Older issue"]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a support ticket confirmed while a retried list read is pending survives that read", async () => {
  const { errors, page } = await mountPage(sources.support);
  await page.waitForFunction(() => fixture.reads.length === 1);
  await page.evaluate(() => fixture.reads[0].reject(new Error("Recent requests unavailable")));
  await page.getByRole("button", { name: "Retry recent requests" }).click();
  await page.waitForFunction(() => fixture.reads.length === 2);
  await submitSupportRequest(page, "Printer jam");
  await page.evaluate(
    (older) => fixture.reads[1].resolve([older]),
    ticket("ticket-old", "Older issue", "2026-09-20T12:00:00Z"),
  );
  await page.getByText("Older issue").waitFor();
  assert.deepEqual(await recentSubjects(page), ["Printer jam", "Older issue"]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("an older ticket list read cannot replace a newer one", async () => {
  const { errors, page } = await mountPage(sources.support);
  await page.waitForFunction(() => fixture.reads.length === 1);
  await page.evaluate(() => fixture.reads[0].reject(new Error("Recent requests unavailable")));
  await page.getByRole("button", { name: "Retry recent requests" }).click();
  await page.waitForFunction(() => fixture.reads.length === 2);
  // A credential renewal starts a newer read while the retry is still pending.
  await page.evaluate(() => fixture.setToken("token-b"));
  await page.waitForFunction(() => fixture.reads.length === 3);
  await page.evaluate(
    (newer) => fixture.reads[2].resolve([newer]),
    ticket("ticket-current", "Current list", "2026-09-22T12:00:00Z"),
  );
  await page.getByText("Current list").waitFor();
  await page.evaluate(
    (stale) => fixture.reads[1].resolve([stale]),
    ticket("ticket-stale", "Stale list", "2026-09-21T12:00:00Z"),
  );
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.deepEqual(await recentSubjects(page), ["Current list"]);
  assert.deepEqual(errors, []);
  await page.close();
});

const scheduledDeletion = {
  id: "deletion-1",
  user_id: "user-a",
  status: "scheduled",
  requested_at: "2026-09-20T00:00:00Z",
  scheduled_for: "2026-10-20T00:00:00Z",
  canceled_at: null,
  completed_at: null,
};

test("a deletion status read from before a cancellation cannot restore the request", async () => {
  const { errors, page } = await mountPage(sources.settings);
  await page.waitForFunction(() => fixture.reads.length === 1);
  await page.evaluate((request) => fixture.reads[0].resolve(request), scheduledDeletion);
  const cancel = page.getByRole("button", { name: "Cancel deletion request" });
  await cancel.waitFor();
  // Credential renewal starts a status read before the owner cancels.
  await page.evaluate(() => fixture.setToken("token-b"));
  await page.waitForFunction(() => fixture.reads.length === 2);
  await cancel.click();
  await page.waitForFunction(() => fixture.writes.length === 1);
  assert.equal(
    await page.evaluate(() => fixture.writes[0].path),
    "/account/deletion-request/cancel",
  );
  await page.evaluate(() => fixture.writes[0].resolve(null));
  await page.getByText("Account deletion canceled.").waitFor();
  await page.evaluate((request) => fixture.reads[1].resolve(request), scheduledDeletion);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(await cancel.count(), 0, "the confirmed cancellation stays in place");
  assert.equal(await page.getByRole("button", { name: "Delete account" }).count(), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a deletion status read from before scheduling cannot clear the scheduled request", async () => {
  const { errors, page } = await mountPage(sources.settings);
  await page.waitForFunction(() => fixture.reads.length === 1);
  await page.evaluate(() => fixture.reads[0].resolve(null));
  await page.getByRole("button", { name: "Delete account" }).click();
  await page.evaluate(() => fixture.setToken("token-b"));
  await page.waitForFunction(() => fixture.reads.length === 2);
  await page.getByLabel("Type DELETE to continue").fill("DELETE");
  await page.getByRole("button", { name: "Schedule deletion" }).click();
  await page.waitForFunction(() => fixture.writes.length === 1);
  assert.equal(await page.evaluate(() => fixture.writes[0].path), "/account/deletion-request");
  await page.evaluate((request) => fixture.writes[0].resolve(request), scheduledDeletion);
  const cancel = page.getByRole("button", { name: "Cancel deletion request" });
  await cancel.waitFor();
  await page.evaluate(() => fixture.reads[1].resolve(null));
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(await cancel.count(), 1, "the confirmed schedule stays in place");
  assert.deepEqual(errors, []);
  await page.close();
});

test("a stale ticket read that fails cannot replace a newer list with an error", async () => {
  const { errors, page } = await mountPage(sources.support);
  await page.waitForFunction(() => fixture.reads.length === 1);
  await page.evaluate(() => fixture.reads[0].reject(new Error("Recent requests unavailable")));
  await page.getByRole("button", { name: "Retry recent requests" }).click();
  await page.waitForFunction(() => fixture.reads.length === 2);
  await page.evaluate(() => fixture.setToken("token-b"));
  await page.waitForFunction(() => fixture.reads.length === 3);
  await page.evaluate(
    (newer) => fixture.reads[2].resolve([newer]),
    ticket("ticket-current", "Current list", "2026-09-22T12:00:00Z"),
  );
  await page.getByText("Current list").waitFor();
  await page.evaluate(() => fixture.reads[1].reject(new Error("Stale retry failed")));
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.deepEqual(await recentSubjects(page), ["Current list"]);
  assert.equal(await page.getByText("Stale retry failed").count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a deletion status read from before a cancellation cannot report its failure afterwards", async () => {
  const { errors, page } = await mountPage(sources.settings);
  await page.waitForFunction(() => fixture.reads.length === 1);
  await page.evaluate((request) => fixture.reads[0].resolve(request), scheduledDeletion);
  const cancel = page.getByRole("button", { name: "Cancel deletion request" });
  await cancel.waitFor();
  await page.evaluate(() => fixture.setToken("token-b"));
  await page.waitForFunction(() => fixture.reads.length === 2);
  await cancel.click();
  await page.waitForFunction(() => fixture.writes.length === 1);
  await page.evaluate(() => fixture.writes[0].resolve(null));
  await page.getByText("Account deletion canceled.").waitFor();
  await page.evaluate(() => fixture.reads[1].reject(new Error("Status read failed")));
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(await page.getByText("Status read failed").count(), 0);
  assert.equal(await page.getByText("Account deletion canceled.").count(), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a failed cancellation leaves the pending status read in charge", async () => {
  const { errors, page } = await mountPage(sources.settings);
  await page.waitForFunction(() => fixture.reads.length === 1);
  await page.evaluate((request) => fixture.reads[0].resolve(request), scheduledDeletion);
  const cancel = page.getByRole("button", { name: "Cancel deletion request" });
  await cancel.waitFor();
  await page.evaluate(() => fixture.setToken("token-b"));
  await page.waitForFunction(() => fixture.reads.length === 2);
  await cancel.click();
  await page.waitForFunction(() => fixture.writes.length === 1);
  await page.evaluate(() => fixture.writes[0].reject(new Error("Cancellation failed")));
  await page.getByText("Cancellation failed").waitFor();
  // The server canceled the request some other way; the status read reports that truth.
  await page.evaluate(() => fixture.reads[1].resolve(null));
  await page.getByRole("button", { name: "Delete account" }).waitFor();
  assert.equal(await cancel.count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

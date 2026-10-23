import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function fixtureBundle() {
  const packer = createCommonJsPacker({
    "@/lib/api": "exports.api=window.fixture.api;",
    "@/lib/store":
      "const React=require('react');const subscribe=cb=>{window.addEventListener('fixture:context',cb);return()=>window.removeEventListener('fixture:context',cb)};exports.useConfigStore=()=>React.useSyncExternalStore(subscribe,()=>window.fixture.context,()=>window.fixture.context);",
    "@/lib/supabase/client": "exports.createClient=()=>window.fixture.supabase;",
    "next/link":
      "exports.__esModule=true;exports.default=({children,href,prefetch,...props})=>require('react').createElement('a',{href,...props},children);",
  });
  const react = packer.add("react");
  const dom = packer.add("react-dom/client");
  const connections = packer.add("@/components/settings/ai-connections");
  const consent = packer.add("@/components/settings/ai-consent");
  return `(function(){var process={env:{NODE_ENV:'production'}};var modules=[${packer.modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;var m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}const React=require(${react});const root=require(${dom}).createRoot(document.getElementById('root'));window.fixture.mount=(view,id)=>{window.fixture.view=view;root.render(React.createElement(view==='consent'?require(${consent}).AiConsent:require(${connections}).AiConnectionsSection,view==='consent'?{authorizationId:id}:{}));};window.fixture.mount(window.fixture.view,window.fixture.requestA);})();`;
}
const bundle = fixtureBundle();

async function openFixture(browser, options = {}) {
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.request().url() === "http://fixture.local/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://fixture.local/");
  await page.evaluate((options) => {
    const f = (window.fixture = {
      view: options.view || "connections",
      requests: [],
      mutations: [],
      authListeners: [],
      requestA: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      requestB: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      context: { token: "token-a", isPreviewMode: false },
    });
    const labels = {
      students: "Student roster",
      schedule: "Classes and attendance",
      contacts: "Contact details",
      notes: "Free-text notes",
    };
    const row = (id, name) => ({
      id,
      client_id: id,
      client_name: name,
      permissions: ["students", "schedule"],
      authorized_at: "2026-10-23T00:00:00Z",
      expires_at: options.expired ? "2020-01-01T00:00:00Z" : "2035-01-01T00:00:00Z",
      revoked_at: null,
      last_used_at: null,
      last_dataset: null,
      last_tool: null,
      last_row_count: null,
      session_ready: !options.pending,
    });
    f.server = {
      "token-a": {
        enabled: true,
        server_url: "https://backend.example.invalid/mcp",
        connections: [row("connection-a", "Assistant A")],
        permissions: labels,
        default_permissions: ["students", "schedule"],
      },
      "token-b": {
        enabled: true,
        server_url: "https://backend.example.invalid/mcp",
        connections: [row("connection-b", "Assistant B")],
        permissions: labels,
        default_permissions: ["students", "schedule"],
      },
    };
    const details = (id) => ({
      authorization_id: id,
      client_name: id === f.requestA ? "Assistant A" : "Assistant B",
      redirect_uri: "https://assistant.example.invalid/callback",
      identity_scope: "offline_access",
      permissions: labels,
      default_permissions: [id === f.requestA ? "students" : "schedule"],
    });
    f.api = {
      get: async (path, token) => {
        f.requests.push({ method: "GET", path, token });
        if (path === "/mcp/connections") {
          if (token === "token-b" && f.holdB)
            await new Promise((resolve) => {
              f.releaseB = resolve;
            });
          return structuredClone(f.server[token]);
        }
        const id = path.split("/").at(-1);
        if (id === f.requestB && f.holdRequestB)
          await new Promise((resolve) => {
            f.releaseRequestB = resolve;
          });
        return structuredClone(details(id));
      },
      delete: async (path, token) => {
        f.mutations.push({ method: "DELETE", path, token });
        if (token === "token-a" && f.holdDeleteA)
          await new Promise((resolve) => {
            f.releaseDeleteA = resolve;
          });
        f.server[token].connections[0].revoked_at = new Date().toISOString();
        return { native_consent_removed: true };
      },
      post: async (path, body, token) => {
        f.mutations.push({ method: "POST", path, token, body: structuredClone(body) });
        if (path.includes("/authorizations/"))
          return new Promise((resolve) => {
            f.releaseConsent = resolve;
          });
        const connection = f.server[token].connections[0];
        if (f.staleOnce) {
          f.staleOnce = false;
          connection.permissions = ["schedule"];
          connection.authorized_at = "2026-10-23T00:00:01Z";
          throw new Error("Connection access changed. Refresh and review it before saving.");
        }
        if (body.expected_authorized_at !== connection.authorized_at)
          throw new Error("Stale authorization");
        connection.permissions = [...body.permissions];
        connection.authorized_at = new Date().toISOString();
        if (body.expires_days)
          connection.expires_at = new Date(Date.now() + body.expires_days * 86400000).toISOString();
        return structuredClone(connection);
      },
    };
    f.supabase = {
      auth: {
        getSession: async () => {
          const result = { data: { session: { access_token: f.context.token } } };
          if (options.delayInitialSession)
            await new Promise((resolve) => {
              f.releaseInitialSession = resolve;
            });
          return result;
        },
        onAuthStateChange: (cb) => {
          f.authListeners.push(cb);
          return {
            data: {
              subscription: {
                unsubscribe: () => {
                  f.authListeners = f.authListeners.filter((item) => item !== cb);
                },
              },
            },
          };
        },
      },
    };
    f.setToken = (token) => {
      f.context = { ...f.context, token };
      window.dispatchEvent(new Event("fixture:context"));
      f.authListeners.forEach((cb) => cb("SIGNED_IN", { access_token: token }));
    };
  }, options);
  await page.addScriptTag({ content: bundle });
  return page;
}

async function withPage(t, options = {}) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  return openFixture(browser, options);
}
const waitText = async (page, text) => page.getByText(text, { exact: true }).waitFor();

test("owner permission edits retain expiration unless renewal is selected", async (t) => {
  const page = await withPage(t);
  await waitText(page, "Assistant A");
  await page.getByRole("button", { name: "Edit access", exact: true }).click();
  await page.getByRole("checkbox", { name: "Contact details", exact: true }).check();
  await page.getByRole("button", { name: "Save permissions", exact: true }).click();
  await page.getByRole("button", { name: "Edit access", exact: true }).waitFor();
  const calls = await page.evaluate(() => window.fixture.mutations);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    permissions: ["students", "schedule", "contacts"],
    expected_authorized_at: "2026-10-23T00:00:00Z",
  });
  assert.equal(
    await page.evaluate(() => window.fixture.server["token-a"].connections[0].expires_at),
    "2035-01-01T00:00:00Z",
  );
});

test("expired grants renew explicitly and pending grants cannot be edited", async (t) => {
  const page = await withPage(t, { expired: true });
  await page.getByRole("button", { name: "Renew access", exact: true }).click();
  await page.getByRole("button", { name: "Save and renew access", exact: true }).click();
  await page.getByRole("button", { name: "Edit access", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.mutations[0].body.expires_days), 7);
  const pending = await openFixture(page.context().browser(), { pending: true });
  await waitText(pending, "Assistant A");
  assert.equal(await pending.getByRole("button", { name: "Edit access", exact: true }).count(), 0);
  assert.match(await pending.locator("#root").innerText(), /Awaiting assistant/);
});

test("account change hides old connections and old mutation completion cannot overwrite the new account", async (t) => {
  const page = await withPage(t);
  await waitText(page, "Assistant A");
  await page.evaluate(() => {
    window.fixture.holdDeleteA = true;
    window.fixture.holdB = true;
  });
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.evaluate(() => window.fixture.setToken("token-b"));
  await page.getByText("Loading connections…", { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator("#root").innerText(), /Assistant A/);
  await page.evaluate(() => {
    window.fixture.holdB = false;
    window.fixture.releaseB();
  });
  await waitText(page, "Assistant B");
  await page.getByRole("button", { name: "Edit access", exact: true }).click();
  await page.getByRole("checkbox", { name: "Contact details", exact: true }).check();
  await page.getByRole("button", { name: "Save permissions", exact: true }).click();
  await page.evaluate(() => window.fixture.releaseDeleteA());
  await waitText(page, "Assistant B");
  assert.doesNotMatch(await page.locator("#root").innerText(), /Assistant A/);
  const calls = await page.evaluate(() => window.fixture.mutations);
  assert.equal(calls[0].token, "token-a");
  assert.equal(calls[1].token, "token-b");
  assert.equal(calls[1].path, "/mcp/connections/connection-b/access");
});

test("a changed authorization request never displays or approves the old assistant's details", async (t) => {
  const page = await withPage(t, { view: "consent" });
  await waitText(page, "Assistant A");
  await page.evaluate(() => {
    window.fixture.holdRequestB = true;
    window.fixture.mount("consent", window.fixture.requestB);
  });
  await page.getByText("Loading connection request…", { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator("#root").innerText(), /Assistant A/);
  assert.equal(
    await page.getByRole("button", { name: "Allow selected reads", exact: true }).count(),
    0,
  );
  await page.evaluate(() => window.fixture.releaseRequestB());
  await waitText(page, "Assistant B");
  await page.getByRole("button", { name: "Allow selected reads", exact: true }).click();
  const call = await page.evaluate(() => window.fixture.mutations[0]);
  assert.equal(call.path, "/mcp/authorizations/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/approve");
  assert.deepEqual(call.body.permissions, ["schedule"]);
});

test("late initial session cannot replace a newer sign-in event", async (t) => {
  const page = await withPage(t, { view: "consent", delayInitialSession: true });
  await page.getByText("Checking sign-in…", { exact: true }).waitFor();
  await page.evaluate(() => window.fixture.setToken("token-b"));
  await waitText(page, "Assistant A");
  await page.evaluate(() => window.fixture.releaseInitialSession());
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const tokens = await page.evaluate(() => window.fixture.requests.map((request) => request.token));
  assert.ok(tokens.length > 0 && tokens.every((token) => token === "token-b"));
});

test("stale consent can be refreshed and reviewed without silently overwriting current settings", async (t) => {
  const page = await withPage(t);
  await waitText(page, "Assistant A");
  await page.getByRole("button", { name: "Edit access", exact: true }).click();
  await page.evaluate(() => {
    window.fixture.staleOnce = true;
  });
  await page.getByRole("button", { name: "Save permissions", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
  assert.equal(
    await page.getByRole("checkbox", { name: "Student roster", exact: true }).isChecked(),
    false,
  );
  assert.equal(
    await page.getByRole("checkbox", { name: "Classes and attendance", exact: true }).isChecked(),
    true,
  );
});

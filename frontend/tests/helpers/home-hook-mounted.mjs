import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { bundle } from "./store-browser-harness.mjs";

const sources = new Map();
export const START = new Date("2026-10-10T12:00:00Z");

export async function flush(page) {
  // React schedules commits through MessageChannel, independent of the paused clock.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
          };
          channel.port2.postMessage(null);
        }),
    );
  }
}

export async function until(page, predicate, message = "fixture did not settle") {
  for (let i = 0; i < 150; i++) {
    await flush(page);
    if (await page.evaluate(predicate)) return;
    await delay(10);
  }
  assert.fail(message);
}

export async function mountHome(browser, options = {}) {
  const {
    mode = "production",
    preview = false,
    homePage = false,
    realApi = false,
    ...fixtureOptions
  } = options;
  const key = `${mode}:${preview}:${homePage}:${realApi}`;
  if (!sources.has(key))
    sources.set(key, bundle(mode, { homeHook: true, homePage, preview, realApi }));
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    route.request().url() === "http://fixture.local/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://fixture.local/");
  if (homePage)
    await page.evaluate(() => {
      // Playwright's fake performance.mark does not retain entries. Keep Chromium's
      // implementation and record it at the controlled clock's frame time.
      window.nativeHomePerformance = Object.fromEntries(
        [
          "mark",
          "getEntriesByType",
          "getEntriesByName",
          "clearMarks",
          "clearMeasures",
          "measure",
        ].map((key) => [key, performance[key].bind(performance)]),
      );
    });
  await page.clock.install({ time: START });
  if (homePage)
    await page.evaluate(() => {
      const native = window.nativeHomePerformance;
      Object.assign(performance, native, {
        mark: (name, options) => native.mark(name, { ...options, startTime: performance.now() }),
      });
    });
  // A loaded test machine may advance the newly installed clock before the
  // next protocol call. Pause in the future, then restore the fixture date.
  await page.clock.pauseAt(new Date(START.getTime() + 60_000));
  await page.clock.setSystemTime(START);
  await page.evaluate((options) => {
    const f = (window.fixture = {
      pathname: "/dashboard",
      observations: [],
      identityObservations: [],
      homeRenders: [],
      requests: [],
      homeReads: [],
      workspaceReads: [],
      redirects: [],
      resumeEvents: [],
      refreshEvents: 0,
      callbacks: new Set(),
      holdHome: true,
      ...options,
    });
    f.session = {
      access_token: "token-a",
      user: { id: "user-a", email: "a@example.test", user_metadata: {} },
    };
    f.profile = () => ({
      user: { ...f.session.user, legal_first_name: "Test", legal_last_name: "Owner" },
      studio_id: f.studioId ?? "studio-a",
      role: f.role ?? "admin",
      membership_status: "active",
      staff_profiles_available: true,
    });
    f.payload = (name = "initial", today = "2026-10-10") => ({
      studio: { id: f.studioId ?? "studio-a", name, timezone: "UTC", today },
      viewer: { role: f.role ?? "admin", first_name: "Test" },
      generated_at: `${today}T12:00:00Z`,
      needs_attention: { items: [] },
      classes_today: { total: 0, overflow: 0, rows: [] },
      stats: { active_students: { total: 0, active: 0, trialing: 0, on_hold: 0 } },
      recent_students: [],
    });
    f.emit = (event, session = f.session) => {
      f.session = session;
      for (const callback of [...f.callbacks]) callback(event, session);
    };
    f.rotate = (token) => f.emit("TOKEN_REFRESHED", { ...f.session, access_token: token });
    f.supabase = {
      auth: {
        getSession: async () =>
          f.holdSession
            ? new Promise(
                (resolve) => (f.releaseSession = () => resolve({ data: { session: f.session } })),
              )
            : { data: { session: f.session } },
        onAuthStateChange: (callback) => {
          f.callbacks.add(callback);
          return { data: { subscription: { unsubscribe: () => f.callbacks.delete(callback) } } };
        },
      },
    };
    f.api = {
      get: async (path, token, options) => {
        f.requests.push({ path, token, options });
        if (path.startsWith("/dashboard/home")) {
          if (!f.holdHome) return f.payload();
          return new Promise((resolve, reject) =>
            f.homeReads.push({ path, token, options, resolve, reject }),
          );
        }
        if (path === "/dashboard/workspace") {
          f.workspaceReads.push({ path, token });
          if (f.workspaceError)
            throw Object.assign(Error("Workspace denied"), { status: f.workspaceError });
          const value = { auth: f.profile(), studio: { name: "Studio", timezone: "UTC" } };
          if (f.holdWorkspace)
            return new Promise((resolve) => (f.releaseWorkspace = () => resolve(value)));
          return value;
        }
        if (path.startsWith("/dashboard/bootstrap"))
          return {
            auth: f.profile(),
            studio_name: "Studio",
            studio_timezone: "UTC",
            students: [],
            leads: [],
            programs: [],
            belt_ladders: [],
            primary_belt_ladder: null,
          };
        if (path === "/auth/me") return f.profile();
        if (path.startsWith("/schedule/window"))
          return { sessions: [], templates: [], attendance: [] };
        if (
          ["/programs", "/students", "/leads", "/staff", "/belts/ladders"].includes(
            path.split("?")[0],
          )
        )
          return [];
        throw Error(`Unexpected GET ${path}`);
      },
      post: async () => ({}),
      patch: async () => ({}),
      delete: async () => ({}),
    };
    f.visibility = (state) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    window.addEventListener("koaryu:resume", (event) => f.resumeEvents.push(event.detail));
    window.addEventListener("koaryu:data-refresh", () => f.refreshEvents++);
  }, fixtureOptions);
  if (realApi)
    await page.evaluate(() => {
      // Real transport, synthetic responses: never dispatch a network request.
      window.fetch = async (url, init = {}) => {
        const path = new URL(url, location.href).pathname.replace(/^\/api\/v1/, "");
        const f = window.fixture;
        try {
          const value =
            init.method === "PUT"
              ? await f.api.put(path, JSON.parse(init.body), init.headers, init)
              : await f.api.get(path, init.headers, init);
          return new Response(JSON.stringify(value), { status: 200 });
        } catch (error) {
          return new Response(JSON.stringify({ detail: error.message }), {
            status: error.status ?? 500,
          });
        }
      };
    });
  await page.addScriptTag({ content: sources.get(key) });
  await flush(page);
  if (preview) {
    // The adapter suspends before the store mounts. React's Suspense retry uses
    // a timer, so let the paused fixture clock run until the provider exists.
    // Observe a committed effect: a render can publish store before Suspense reveals it.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await page.evaluate(() => window.fixture.observations.length > 0)) break;
      await tick(page, 25);
    }
    assert.ok(
      await page.evaluate(() => window.fixture.observations.length > 0),
      "preview provider did not commit",
    );
  }
  return { page, errors };
}

export async function resolveHome(page, index = 0, name = "initial", today = "2026-10-10") {
  await until(page, () => window.fixture.homeReads.length > 0);
  await page.evaluate(
    ({ index, name, today }) => {
      window.fixture.homeReads[index].resolve(window.fixture.payload(name, today));
    },
    { index, name, today },
  );
  await flush(page);
}

export async function rejectHome(page, index, status = 500, message = "Home outage") {
  await page.evaluate(
    ({ index, status, message }) => {
      window.fixture.homeReads[index].reject(new window.fixture.ApiError(message, status));
    },
    { index, status, message },
  );
  await flush(page);
}

export async function state(page) {
  return page.evaluate(() => {
    const { status, payload, error, asOf, isRevalidating } = window.fixture.home;
    return {
      status,
      name: payload?.studio?.name ?? null,
      today: payload?.studio?.today ?? null,
      error,
      asOf,
      isRevalidating,
    };
  });
}

export async function homeCount(page) {
  return page.evaluate(
    () => window.fixture.requests.filter((r) => r.path.startsWith("/dashboard/home")).length,
  );
}

export async function tick(page, ms) {
  await page.clock.runFor(ms);
  await flush(page);
}

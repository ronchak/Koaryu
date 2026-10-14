import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homePayload } from "./helpers/home-fixtures.mjs";
import { chromium } from "@playwright/test";

// Set only for an explicit historical measurement. Normal tests always mount
// current application code. No server, credentials, or hosted traffic is used.
const baselineRoot = process.env.KOARYU_DASHBOARD_BASELINE_ROOT;
const { bundle } = await import(
  baselineRoot
    ? pathToFileURL(resolve(baselineRoot, "frontend/tests/helpers/store-browser-harness.mjs"))
    : "./helpers/store-browser-harness.mjs"
);
const regression = baselineRoot ? test.skip : test;
const browserErrors = new WeakMap();

async function mount(browser, options = {}) {
  const page = await browser.newPage({ timezoneId: "America/Los_Angeles" });
  const errors = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-10-05T18:00:00Z") });
  await page.route("**/*", (route) =>
    route.request().url() === "http://fixture.local/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://fixture.local/");
  await page.evaluate(
    ({
      studentCount,
      leadCount,
      holdFeature,
      denyWorkspace,
      role,
      featureDelayMs,
      readDelayMs,
    }) => {
      const f = (window.fixture = {
        pathname: "/dashboard",
        observations: [],
        requests: [],
        marks: [],
        timingMarks: [],
        eligibilityWaiters: [],
        holdFeature,
        denyWorkspace,
        featureDelayMs,
        readDelayMs,
      });
      f.session = {
        access_token: "synthetic-a",
        user: {
          id: "user-a",
          email: "a@example.test",
          legal_first_name: "Synthetic",
          legal_last_name: "Owner",
        },
      };
      f.auth = {
        user: f.session.user,
        studio_id: "studio-a",
        membership_status: "active",
        role,
        staff_profiles_available: true,
      };
      f.students = Array.from({ length: studentCount }, (_, index) => ({
        id: `student-${String(index).padStart(5, "0")}`,
        studio_id: "studio-a",
        legal_first_name: "Synthetic",
        legal_last_name: `Student ${index}`,
        status: "active",
        created_at: "2026-09-01T12:00:00Z",
        updated_at: "2026-09-01T12:00:00Z",
        guardians: [],
        programs: [],
        tags: [],
        photo_url: null,
      }));
      f.leads = Array.from({ length: leadCount }, (_, index) => ({
        id: `lead-${String(index).padStart(5, "0")}`,
        studio_id: "studio-a",
        first_name: "Synthetic",
        last_name: `Lead ${index}`,
        source: "website",
        stage: index >= leadCount - 7 ? "inquiry" : "closed_lost",
        is_minor: false,
        follow_up_date: index >= leadCount - 7 ? "2026-10-05" : null,
        email: null,
        phone: null,
        notes: "Synthetic historical note for payload measurement.",
        program_id: null,
        program_interest: null,
        guardian_name: null,
        guardian_email: null,
        guardian_phone: null,
        assigned_staff_id: null,
        lost_reason: null,
        converted_student_id: null,
        created_at: "2026-09-01T12:00:00Z",
        updated_at: "2026-09-01T12:00:00Z",
      })).reverse();
      f.ladder = {
        id: "ladder-a",
        studio_id: "studio-a",
        program_id: "program-a",
        name: "Synthetic ladder",
        ranks: [],
      };
      f.programs = [
        {
          id: "program-a",
          name: "Synthetic program",
          color_hex: "#38bdf8",
          archived_at: null,
          is_system: false,
        },
      ];
      f.homePayload = null;
      f.homeRenders = [];
      f.navigate = (path) => {
        f.pathname = path;
        history.pushState(null, "", path);
        window.dispatchEvent(new Event("fixture:navigate"));
      };
      f.supabase = {
        auth: {
          getSession: async () => ({ data: { session: f.session } }),
          onAuthStateChange: (callback) => {
            f.emit = (event, session) => {
              f.session = session;
              callback(event, session);
            };
            return { data: { subscription: { unsubscribe() {} } } };
          },
        },
      };
      const pause = (ms) => new Promise((done) => setTimeout(done, ms));
      f.api = {
        get: async (path, token) => {
          const request = { path, token, atMs: performance.now(), endMs: null, bytes: 0 };
          f.requests.push(request);
          try {
            const url = new URL(path, "http://fixture.local");
            let result;
            if (url.pathname === "/dashboard/workspace") {
              if (f.holdWorkspace)
                await new Promise((done) => {
                  f.releaseWorkspace = done;
                });
              if (f.denyWorkspace) throw new f.ApiError("Access denied", 403);
              result = {
                auth: f.auth,
                studio: { name: "Synthetic studio", timezone: "America/Los_Angeles" },
              };
            } else if (url.pathname === "/dashboard/home") {
              result = f.homePayload;
            } else if (url.pathname === "/dashboard/bootstrap") {
              if (f.holdFeature)
                await new Promise((done) => {
                  f.releaseFeature = done;
                });
              await pause(f.featureDelayMs);
              if (f.failFeature) throw new Error("Synthetic feature outage");
              const ladders = f.featureLadders ?? [f.ladder];
              result = {
                auth: f.auth,
                studio: { name: "Synthetic studio", timezone: "America/Los_Angeles" },
                studio_name: "Synthetic studio",
                students: url.searchParams.get("view") === "home" ? [] : f.students.slice(0, 200),
                students_total: f.students.length,
                students_may_be_partial: f.students.length > 200,
                students_page_size: 200,
                leads: url.searchParams.get("view") === "home" ? [] : f.leads,
                programs: f.programs,
                belt_ladders: url.searchParams.get("view") === "home" ? [] : ladders,
                primary_belt_ladder:
                  url.searchParams.get("view") === "home" ? null : (ladders[0] ?? null),
              };
            } else if (url.pathname === "/students") {
              const ordinal = Number(url.searchParams.get("cursor")?.replace("page-", "") ?? 1);
              const size = 200;
              const hasNext = ordinal * size < f.students.length;
              result = {
                items: f.students.slice((ordinal - 1) * size, ordinal * size),
                total: f.students.length,
                page_size: size,
                page_ordinal: ordinal,
                has_next: hasNext,
                has_previous: ordinal > 1,
                next_cursor: hasNext ? `page-${ordinal + 1}` : null,
              };
            } else if (url.pathname === "/leads") result = f.leads;
            else if (url.pathname === "/programs") result = f.programs;
            else if (url.pathname === "/schedule/window")
              result = { sessions: [], attendance: [], templates: [] };
            else if (url.pathname === "/belts/ladders") {
              if (f.failBelts) throw new Error("Synthetic belt metadata outage");
              result = [f.ladder];
            } else if (url.pathname === "/belts/eligibility") {
              result = [{ student_id: "student-00000", is_eligible: Boolean(f.eligible) }];
              if (f.holdEligibility) await new Promise((done) => f.eligibilityWaiters.push(done));
              if (f.failEligibility) throw new Error("Synthetic eligibility outage");
            } else throw new Error(`Unexpected read ${path}`);
            await pause(f.readDelayMs);
            request.bytes = new TextEncoder().encode(JSON.stringify(result)).length;
            return result;
          } finally {
            request.endMs = performance.now();
          }
        },
        post: async () => {
          throw new Error("Dashboard measurement must not write");
        },
        patch: async () => {
          throw new Error("Dashboard measurement must not write");
        },
        delete: async () => {
          throw new Error("Dashboard measurement must not write");
        },
      };
    },
    {
      studentCount: 2500,
      leadCount: 5000,
      holdFeature: false,
      denyWorkspace: false,
      role: "admin",
      featureDelayMs: 100,
      readDelayMs: 5,
      ...options,
    },
  );
  await page.evaluate((value) => {
    fixture.baseline = value;
  }, Boolean(baselineRoot));
  if (options.homePage)
    await page.evaluate(
      (payload) => {
        fixture.homePayload = payload;
      },
      homePayload(options.role ?? "admin", { rich: true }),
    );
  await page.addScriptTag({
    content: bundle(options.mode ?? "production", {
      homePage: options.homePage,
    }),
  });
  return page;
}

async function settle(page) {
  for (let i = 0; i < 2; i++) {
    await page.waitForFunction(() => fixture.requests.every((request) => request.endMs !== null));
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  }
  assert.deepEqual(browserErrors.get(page), []);
}

async function stats(page, offset = 0) {
  return page.evaluate((start) => {
    const requests = fixture.requests.slice(start);
    const count = (path) =>
      requests.filter((request) => request.path.split("?")[0] === path).length;
    const feature = requests.find((request) => request.path.startsWith("/dashboard/bootstrap"));
    const schedule = requests.find((request) => request.path.startsWith("/schedule/window"));
    return {
      request_count: requests.length,
      serialized_response_bytes: requests.reduce((sum, request) => sum + request.bytes, 0),
      roster_pages: count("/students"),
      full_lead_reads: count("/leads"),
      eligibility_reads: count("/belts/eligibility"),
      schedule_reads: count("/schedule/window"),
      workspace_reads: count("/dashboard/workspace"),
      bootstrap_response_bytes: feature?.bytes ?? null,
      schedule_start_after_bootstrap_start_ms:
        feature && schedule ? Math.round(schedule.atMs - feature.atMs) : null,
      students_in_store: fixture.store.students.length,
      leads_in_store: fixture.store.leads.length,
    };
  }, offset);
}

test("Home synthetic request and payload measurements", async (t) => {
  const browser = await chromium.launch();
  try {
    for (const leadCount of [25, 5000]) {
      const page = await mount(browser, { leadCount, homePage: true });
      await page.waitForFunction(() => fixture.home?.status === "ready");
      await settle(page);
      const cold = await stats(page);
      const paths = await page.evaluate(() => fixture.requests.map((r) => r.path));
      assert.deepEqual(
        paths.map((path) => path.split("?")[0]),
        ["/dashboard/workspace", "/dashboard/home"],
      );
      assert.equal(cold.eligibility_reads, 0);
      assert.equal(cold.students_in_store, 0);
      assert.equal(cold.leads_in_store, 0);
      assert.ok(cold.serialized_response_bytes > 0);
      assert.equal(cold.bootstrap_response_bytes, null, "Home requests no bootstrap payload");
      await page.evaluate(() => fixture.unmountHome());
      await settle(page);
      const offset = await page.evaluate(() => fixture.requests.length);
      await page.evaluate(() => fixture.mountHome());
      await page.waitForFunction((start) => fixture.requests.length > start, offset);
      await settle(page);
      assert.deepEqual(
        await page.evaluate(
          (start) => fixture.requests.slice(start).map((r) => r.path.split("?")[0]),
          offset,
        ),
        ["/dashboard/home"],
      );
      t.diagnostic(
        JSON.stringify({
          fixture: "home-mounted",
          leads: leadCount,
          semantics: "synthetic JSON bytes, no hosted traffic",
          cold,
          revisit: await stats(page, offset),
        }),
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

regression("Home access failure starts no feature reads", async () => {
  const browser = await chromium.launch();
  try {
    const page = await mount(browser, { denyWorkspace: true, homePage: true });
    await page.waitForFunction(() => fixture.requests.length > 0);
    await settle(page);
    assert.deepEqual(await page.evaluate(() => fixture.requests.map((request) => request.path)), [
      "/dashboard/workspace",
    ]);
    assert.equal(await page.evaluate(() => fixture.store.identityReady), false);
  } finally {
    await browser.close();
  }
});

regression("Home defers full lead collection until navigation to Leads", async () => {
  const browser = await chromium.launch();
  try {
    const page = await mount(browser, { homePage: true });
    await page.waitForFunction(() => fixture.home?.status === "ready");
    await settle(page);
    assert.equal(await page.evaluate(() => fixture.store.leadsLoaded), false);
    assert.deepEqual(
      await page.evaluate(() => fixture.requests.map((request) => request.path.split("?")[0])),
      ["/dashboard/workspace", "/dashboard/home"],
    );
    const offset = await page.evaluate(() => fixture.requests.length);
    await page.evaluate(() => fixture.navigate("/leads"));
    await page.waitForFunction(() => fixture.store.leadsLoaded);
    await settle(page);
    assert.deepEqual(
      await page.evaluate(
        (start) => fixture.requests.slice(start).map((request) => request.path.split("?")[0]),
        offset,
      ),
      ["/leads", "/programs"],
    );
    assert.equal((await stats(page)).full_lead_reads, 1);
    assert.equal(await page.evaluate(() => fixture.store.leads.length), 5000);
  } finally {
    await browser.close();
  }
});

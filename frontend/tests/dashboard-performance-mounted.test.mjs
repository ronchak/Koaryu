import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
        summaryWaiters: [],
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
      f.summary = {
        auth: f.auth,
        generated_at: "2026-10-05T18:00:00Z",
        students: {
          total_students: studentCount,
          active_students: studentCount,
          trialing_students: 0,
          on_hold_students: 0,
        },
        leads: {
          active_leads: Math.min(7, leadCount),
          enrolled_leads: 0,
          due_today_leads: Math.min(7, leadCount),
        },
        schedule: { today_sessions: 0 },
        belts: { belt_count: 0, tip_count: 0 },
        inactivity: { watch_14: 0, watch_30: 0, watch_90: 0 },
        new_students: { new_14: 0, new_30: 0, new_90: 0, new_year_to_date: 0 },
        operational: {
          attendance_with_capacity: 0,
          total_capacity: 0,
          sessions_tracked: 0,
          sessions_with_capacity: 0,
          average_attendance: 0,
        },
        churn: { inactive_students: 0, canceled_students: 0, churn_marked_students: 0 },
        test_readiness: { available: false },
        billing: { can_view_billing: true },
        setup: {
          has_programs: true,
          has_students: true,
          has_belt_system: false,
          has_weekly_classes: false,
        },
        today_schedule: {
          available: true,
          expected_counts_available: true,
          rows: [],
          overflow_count: 0,
        },
        emergency_contacts: {
          available: true,
          active_students: studentCount,
          students_with_contact_name: studentCount,
          students_missing_contact_name: 0,
        },
        recent_students: [],
        actions: [],
      };
      f.followUps = {
        available: true,
        rows: f.leads.slice(0, 5).map(({ id, first_name, last_name, follow_up_date }) => ({
          id,
          first_name,
          last_name,
          follow_up_date,
        })),
      };
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
            } else if (url.pathname === "/dashboard/bootstrap") {
              if (f.holdFeature)
                await new Promise((done) => {
                  f.releaseFeature = done;
                });
              await pause(f.featureDelayMs);
              if (f.failFeature) throw new Error("Synthetic feature outage");
              const bounded = url.searchParams.get("bounded_dashboard") === "true";
              const ladders = f.featureLadders ?? [f.ladder];
              result = {
                auth: f.auth,
                studio: { name: "Synthetic studio", timezone: "America/Los_Angeles" },
                studio_name: "Synthetic studio",
                students: f.students.slice(0, 200),
                students_total: f.students.length,
                students_may_be_partial: f.students.length > 200,
                students_page_size: 200,
                leads: bounded ? [] : f.leads,
                programs: f.programs,
                belt_ladders: ladders,
                primary_belt_ladder: ladders[0] ?? null,
              };
              f.bounded = bounded;
            } else if (url.pathname === "/dashboard/summary") {
              result = structuredClone({
                ...f.summary,
                ...(f.baseline ? {} : { lead_follow_ups: f.followUps }),
              });
              if (f.holdSummary)
                await new Promise((done) => {
                  f.releaseSummary = done;
                  f.summaryWaiters.push(done);
                });
              if (f.failSummary) throw new Error("Synthetic summary outage");
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
  await page.addScriptTag({
    content: bundle(options.mode ?? "production", {
      dashboardController: true,
      dashboardVisibleWidgets: options.visibleWidgets,
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
      summary_reads: count("/dashboard/summary"),
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

test("Dashboard synthetic request and payload measurements", async (t) => {
  const browser = await chromium.launch();
  try {
    for (const leadCount of [25, 5000]) {
      const page = await mount(browser, { leadCount });
      await page.waitForFunction(() => fixture.store?.identityReady);
      await settle(page);
      const cold = await stats(page);
      await page.evaluate(() =>
        fixture.dashboard.onVisibleWidgetsChange([
          "student_pulse",
          "classes_today",
          "needs_attention",
          "lead_follow_ups",
        ]),
      );
      const offset = await page.evaluate(() => fixture.requests.length);
      await page.evaluate(() => window.dispatchEvent(new Event("koaryu:resume")));
      await page.waitForFunction((start) => fixture.requests.length > start, offset);
      await settle(page);
      const resume = await stats(page, offset);
      t.diagnostic(
        JSON.stringify({
          version: baselineRoot ? "baseline" : "candidate",
          fixture: "dashboard-mounted-v1",
          students: 2500,
          leads: leadCount,
          synthetic_feature_delay_ms: 100,
          synthetic_read_delay_ms: 5,
          semantics:
            "mock API JSON bytes, not wire bytes; request order, not hosted latency or UI paint",
          cold,
          resume,
        }),
      );
      if (baselineRoot) {
        assert.equal(resume.roster_pages, 13);
        assert.equal(resume.full_lead_reads, 1);
        assert.equal(resume.eligibility_reads, 1);
        assert.equal(cold.schedule_reads, 1);
        assert.ok(cold.schedule_start_after_bootstrap_start_ms >= 100);
      } else {
        assert.equal(resume.roster_pages, 0);
        assert.equal(resume.full_lead_reads, 0);
        assert.equal(resume.eligibility_reads, 0);
        assert.equal(cold.schedule_reads, 0);
        assert.equal(resume.schedule_reads, 0);
        assert.equal(cold.leads_in_store, 0);
        assert.equal(resume.students_in_store, 200);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

for (const mode of ["production", "development"]) {
  regression(`Dashboard summary can render with feature bootstrap pending in ${mode}`, async () => {
    const browser = await chromium.launch();
    try {
      const page = await mount(browser, { holdFeature: true, mode });
      await page.waitForFunction(
        () => fixture.store?.dashboardSummaryLoaded && fixture.releaseFeature,
      );
      await page.evaluate(() =>
        fixture.dashboard.onVisibleWidgetsChange([
          "student_pulse",
          "classes_today",
          "setup_progress",
          "lead_follow_ups",
        ]),
      );
      const state = await page.evaluate(() => ({
        scheduleReads: fixture.requests.filter((request) =>
          request.path.startsWith("/schedule/window"),
        ).length,
        bootstraps: fixture.requests.filter((request) =>
          request.path.startsWith("/dashboard/bootstrap"),
        ).length,
        states: ["student_pulse", "classes_today", "setup_progress", "lead_follow_ups"].map(
          (id) => fixture.dashboard.widgetViewModels[id].state,
        ),
      }));
      assert.equal(state.scheduleReads, 0);
      assert.equal(state.bootstraps, 1);
      assert.ok(
        state.states.every((value) => ["ready", "empty"].includes(value)),
        JSON.stringify(state),
      );
      await page.evaluate(() => {
        fixture.failFeature = true;
        fixture.releaseFeature();
      });
      await settle(page);
      assert.equal(await page.evaluate(() => fixture.store.identityReady), true);
      assert.equal((await stats(page)).schedule_reads, 0);
    } finally {
      await browser.close();
    }
  });
}

regression("Dashboard access failure starts no feature, summary, or schedule reads", async () => {
  const browser = await chromium.launch();
  try {
    const page = await mount(browser, { denyWorkspace: true });
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

regression(
  "Dashboard resume preserves valid summary, coalesces events, and rejects lost access",
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await mount(browser);
      await settle(page);
      await page.evaluate(() => {
        fixture.dashboard.onVisibleWidgetsChange(["student_pulse"]);
        fixture.holdWorkspace = true;
        fixture.holdSummary = true;
        window.dispatchEvent(new Event("koaryu:resume"));
        window.dispatchEvent(new Event("koaryu:resume"));
        window.dispatchEvent(new Event("koaryu:resume"));
      });
      await page.waitForFunction(() => fixture.releaseWorkspace);
      await page.evaluate(() => {
        fixture.holdWorkspace = false;
        fixture.releaseWorkspace();
      });
      await page.waitForFunction(() => fixture.releaseSummary);
      assert.equal(
        await page.evaluate(() => fixture.dashboard.widgetViewModels.student_pulse.state),
        "ready",
      );
      await page.evaluate(() => {
        fixture.holdSummary = false;
        fixture.releaseSummary();
      });
      await settle(page);
      assert.equal((await stats(page)).summary_reads, 2);
      assert.equal((await stats(page)).roster_pages, 0);
      const before = await page.evaluate(() => fixture.requests.length);
      await page.evaluate(() => {
        fixture.denyWorkspace = true;
        window.dispatchEvent(new Event("koaryu:resume"));
      });
      await page.waitForFunction((start) => fixture.requests.length > start, before);
      await settle(page);
      assert.equal(await page.evaluate(() => fixture.store.identityReady), false);
      assert.equal(await page.evaluate(() => fixture.store.dashboardSummary), null);
    } finally {
      await browser.close();
    }
  },
);

regression("Dashboard defers full lead collection until navigation to Leads", async () => {
  const browser = await chromium.launch();
  try {
    const page = await mount(browser);
    await settle(page);
    assert.equal(await page.evaluate(() => fixture.store.leadsLoaded), false);
    assert.equal((await stats(page)).full_lead_reads, 0);
    await page.evaluate(() => fixture.navigate("/leads"));
    await page.waitForFunction(() => fixture.store.leadsLoaded);
    await settle(page);
    assert.equal((await stats(page)).full_lead_reads, 1);
    assert.equal(await page.evaluate(() => fixture.store.leads.length), 5000);
  } finally {
    await browser.close();
  }
});

regression("hidden promotion eligibility refreshes when revealed after resume", async () => {
  const browser = await chromium.launch();
  try {
    const page = await mount(browser);
    await settle(page);
    await page.evaluate(() => fixture.dashboard.onVisibleWidgetsChange(["promotions_due"]));
    await page.waitForFunction(() => fixture.store.eligibilityLadderId === "ladder-a");
    await page.evaluate(() => {
      fixture.dashboard.onVisibleWidgetsChange(["student_pulse"]);
      fixture.eligible = true;
      window.dispatchEvent(new Event("koaryu:resume"));
    });
    await settle(page);
    assert.equal((await stats(page)).eligibility_reads, 1);
    await page.evaluate(() => fixture.dashboard.onVisibleWidgetsChange(["promotions_due"]));
    await page.waitForFunction(
      () =>
        fixture.requests.filter((request) => request.path.startsWith("/belts/eligibility?"))
          .length === 2,
    );
    await settle(page);
    assert.equal(await page.evaluate(() => fixture.store.eligibility[0].is_eligible), true);
  } finally {
    await browser.close();
  }
});

regression(
  "a delayed bootstrap cannot replace promotion metadata loaded by a visible panel",
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await mount(browser, { holdFeature: true });
      await page.waitForFunction(() => fixture.store?.identityReady && fixture.releaseFeature);
      await page.evaluate(() => {
        fixture.featureLadders = [];
        fixture.dashboard.onVisibleWidgetsChange(["promotions_due"]);
      });
      await page.waitForFunction(() => fixture.store.eligibilityLadderId === "ladder-a");
      await page.evaluate(() => fixture.releaseFeature());
      await settle(page);
      assert.equal(await page.evaluate(() => fixture.store.currentLadderId), "ladder-a");
      assert.equal(await page.evaluate(() => fixture.store.eligibilityLadderId), "ladder-a");
      assert.equal((await stats(page)).eligibility_reads, 1);
    } finally {
      await browser.close();
    }
  },
);

regression(
  "explicit Dashboard retry forces fresh facts without hydrating complete collections",
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await mount(browser);
      await settle(page);
      await page.evaluate(() => fixture.dashboard.onVisibleWidgetsChange(["student_pulse"]));
      const offset = await page.evaluate(() => fixture.requests.length);
      await page.evaluate(() => fixture.dashboard.retryDashboardDatasets());
      await settle(page);
      const paths = await page.evaluate(
        (start) => fixture.requests.slice(start).map((request) => request.path),
        offset,
      );
      assert.equal(paths.length, 1);
      const query = new URL(paths[0], "http://fixture.local");
      assert.equal(query.pathname, "/dashboard/summary");
      assert.equal(query.searchParams.get("fresh"), "true");
      assert.equal(query.searchParams.get("include_follow_ups"), "true");
      assert.equal((await stats(page)).roster_pages, 0);
      assert.equal((await stats(page)).full_lead_reads, 0);
    } finally {
      await browser.close();
    }
  },
);

regression(
  "a held summary refresh cannot return protected Dashboard data after sign-out",
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await mount(browser);
      await settle(page);
      await page.evaluate(() => {
        fixture.holdSummary = true;
        window.dispatchEvent(new Event("koaryu:resume"));
      });
      await page.waitForFunction(() => fixture.releaseSummary);
      await page.evaluate(() => fixture.emit("SIGNED_OUT", null));
      await page.waitForFunction(() => !fixture.store.identityReady);
      await page.evaluate(() => fixture.releaseSummary());
      await settle(page);
      assert.equal(await page.evaluate(() => fixture.store.dashboardSummary), null);
      assert.equal(await page.evaluate(() => fixture.store.leads.length), 0);
      assert.equal(await page.evaluate(() => fixture.store.students.length), 0);
    } finally {
      await browser.close();
    }
  },
);

async function nextStudioDay(page) {
  await page.clock.setFixedTime(new Date("2026-10-06T18:00:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => fixture.store.businessDate === "2026-10-06");
}

regression("a prior-day eligibility response cannot erase a new-day metadata failure", async () => {
  const browser = await chromium.launch();
  try {
    const page = await mount(browser, { visibleWidgets: ["promotions_due"] });
    await settle(page);
    await page.evaluate(() => {
      fixture.eligible = true;
      fixture.holdEligibility = true;
      fixture.dashboard.retryDashboardDatasets();
    });
    await page.waitForFunction(() => fixture.eligibilityWaiters.length === 1);
    await page.evaluate(() => {
      fixture.failBelts = true;
    });
    await nextStudioDay(page);
    await page.waitForFunction(() =>
      fixture.store.eligibilityLoadError?.includes("metadata outage"),
    );
    assert.equal(
      await page.evaluate(() => fixture.dashboard.widgetViewModels.promotions_due.state),
      "error",
    );
    await page.evaluate(() => fixture.eligibilityWaiters[0]());
    await settle(page);
    assert.equal(
      await page.evaluate(() => fixture.dashboard.widgetViewModels.promotions_due.state),
      "error",
    );
    assert.match(await page.evaluate(() => fixture.store.eligibilityLoadError), /metadata outage/);
    assert.deepEqual(await page.evaluate(() => fixture.store.eligibility), []);
  } finally {
    await browser.close();
  }
});

regression(
  "studio-date rollover rejects held prior-day facts and loads visible panels through child effects",
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await mount(browser, {
        visibleWidgets: ["student_pulse", "lead_follow_ups", "promotions_due"],
      });
      await settle(page);
      assert.equal(await page.evaluate(() => fixture.store.eligibilityLadderId), "ladder-a");
      await page.evaluate(() => {
        fixture.holdSummary = true;
        fixture.holdEligibility = true;
        fixture.dashboard.retryDashboardDatasets();
      });
      await page.waitForFunction(
        () => fixture.summaryWaiters.length === 1 && fixture.eligibilityWaiters.length === 1,
      );
      assert.equal(
        await page.evaluate(() => fixture.dashboard.widgetViewModels.student_pulse.state),
        "ready",
      );
      assert.equal(
        await page.evaluate(() => fixture.dashboard.widgetViewModels.promotions_due.state),
        "empty",
      );
      await page.evaluate(() => {
        fixture.summary.generated_at = "2026-10-06T18:00:00Z";
        fixture.summary.students.total_students = 2501;
        fixture.eligible = true;
      });
      await nextStudioDay(page);
      await page.waitForFunction(
        () => fixture.summaryWaiters.length === 2 && fixture.eligibilityWaiters.length === 2,
      );
      assert.equal(await page.evaluate(() => fixture.store.dashboardSummary), null);
      assert.equal(
        await page.evaluate(() => fixture.dashboard.widgetViewModels.promotions_due.state),
        "loading",
      );
      await page.evaluate(() => {
        fixture.summaryWaiters[0]();
        fixture.eligibilityWaiters[0]();
      });
      await page.waitForFunction(
        () =>
          fixture.requests.filter(
            (request) => request.path.startsWith("/dashboard/summary") && request.endMs !== null,
          ).length === 2,
      );
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      assert.equal(await page.evaluate(() => fixture.store.dashboardSummary), null);
      assert.equal(
        await page.evaluate(() => fixture.dashboard.widgetViewModels.promotions_due.state),
        "loading",
      );
      await page.evaluate(() => {
        fixture.summaryWaiters[1]();
        fixture.eligibilityWaiters[1]();
      });
      await settle(page);
      assert.equal(
        await page.evaluate(() => fixture.store.dashboardSummary.students.total_students),
        2501,
      );
      assert.equal(
        await page.evaluate(() => fixture.store.dashboardSummary.generated_at),
        "2026-10-06T18:00:00Z",
      );
      assert.equal(await page.evaluate(() => fixture.store.eligibility[0].is_eligible), true);
      assert.equal(
        await page.evaluate(() => fixture.dashboard.widgetViewModels.student_pulse.state),
        "ready",
      );
      assert.equal(
        await page.evaluate(() => fixture.dashboard.widgetViewModels.promotions_due.state),
        "ready",
      );
    } finally {
      await browser.close();
    }
  },
);

regression(
  "failed rollover reads expose settled errors instead of prior-day facts or permanent loading",
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await mount(browser, {
        visibleWidgets: ["student_pulse", "lead_follow_ups", "promotions_due"],
      });
      await settle(page);
      await page.evaluate(() => {
        fixture.failSummary = true;
        fixture.failEligibility = true;
      });
      await nextStudioDay(page);
      await settle(page);
      assert.equal(await page.evaluate(() => fixture.store.dashboardSummary), null);
      const states = await page.evaluate(() => ({
        summaryError: fixture.store.dashboardSummaryLoadError,
        eligibilityError: fixture.store.eligibilityLoadError,
        student: fixture.dashboard.widgetViewModels.student_pulse.state,
        leads: fixture.dashboard.widgetViewModels.lead_follow_ups.state,
        promotions: fixture.dashboard.widgetViewModels.promotions_due.state,
      }));
      assert.ok(states.summaryError);
      assert.ok(states.eligibilityError);
      assert.ok(["error", "unavailable"].includes(states.student), JSON.stringify(states));
      assert.ok(["error", "unavailable"].includes(states.leads), JSON.stringify(states));
      assert.equal(states.promotions, "error");
      await page.evaluate(() => {
        fixture.failSummary = false;
        fixture.failEligibility = false;
        fixture.summary.generated_at = "2026-10-06T18:00:00Z";
        fixture.eligible = true;
        fixture.dashboard.retryDashboardDatasets();
      });
      await settle(page);
      assert.equal(
        await page.evaluate(() => fixture.dashboard.widgetViewModels.student_pulse.state),
        "ready",
      );
      assert.equal(
        await page.evaluate(() => fixture.dashboard.widgetViewModels.promotions_due.state),
        "ready",
      );
      assert.equal(await page.evaluate(() => fixture.store.dashboardSummaryLoadError), null);
      assert.equal(await page.evaluate(() => fixture.store.eligibilityLoadError), null);
    } finally {
      await browser.close();
    }
  },
);

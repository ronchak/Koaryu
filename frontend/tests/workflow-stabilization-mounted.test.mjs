import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { bundle } from "./helpers/store-browser-harness.mjs";

async function fixturePage(browser, options = {}) {
  const page = await browser.newPage({ timezoneId: options.timezone });
  if (options.now) await page.clock.install({ time: new Date(options.now) });
  await page.route("**/*", (route) =>
    route.request().url() === "http://fixture.local/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://fixture.local/");
  await page.evaluate(() => {
    const f = (window.fixture = {
      identityObservations: [],
      marks: [],
      timingMarks: [],
      observations: [],
      requests: [],
      events: [],
      leadReads: [],
      writes: [],
      summaries: [],
      details: [],
      importSubmissions: [],
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
      role: "admin",
      staff_profiles_available: true,
    };
    f.summaryResponse = {
      auth: f.auth,
      generated_at: "2026-09-12T12:00:00Z",
      students: {
        total_students: 250,
        active_students: 250,
        trialing_students: 0,
        on_hold_students: 0,
      },
      leads: { active_leads: 0, enrolled_leads: 0, due_today_leads: 0 },
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
        has_programs: false,
        has_students: true,
        has_belt_system: false,
        has_weekly_classes: false,
      },
      recent_students: [],
      actions: [],
    };
    f.student = {
      id: "student-1",
      studio_id: "studio-a",
      legal_first_name: "Ari",
      legal_last_name: "Lane",
      status: "active",
      guardians: [],
      photo_url: null,
      programs: [],
      tags: [],
    };
    f.lead = { id: "lead-1", first_name: "Old", last_name: "Lead", status: "new", stage: "new" };
    f.navigate = (path, search = "") => {
      f.pathname = path;
      f.search = search;
      history.pushState(null, "", path + search);
      window.dispatchEvent(new Event("fixture:navigate"));
    };
    f.supabase = {
      auth: {
        getSession: async () => ({ data: { session: f.session } }),
        onAuthStateChange: (cb) => {
          f.emit = (event, session) => {
            f.session = session;
            cb(event, session);
          };
          return { data: { subscription: { unsubscribe() {} } } };
        },
      },
    };
    f.api = {
      get: async (path, token) => {
        f.requests.push({ path, token, atMs: performance.now() });
        f.events.push(path);
        if (path === "/dashboard/workspace")
          return {
            auth: f.auth,
            studio: { name: "Synthetic Studio", timezone: "America/Los_Angeles" },
          };
        if (path.startsWith("/dashboard/bootstrap") && f.holdFeature)
          return new Promise((resolve) => {
            f.featureWaiters ??= [];
            f.featureWaiters.push(resolve);
            f.releaseFeature = resolve;
          });
        if (path.startsWith("/dashboard/bootstrap"))
          return {
            auth: f.auth,
            studio_name: "Synthetic Studio",
            students: f.uncached ? [] : [f.student],
            students_may_be_partial: true,
            leads: [f.lead],
            programs: [],
            belt_ladders: [],
            primary_belt_ladder: null,
            summary: f.summaryResponse,
          };
        if (path.startsWith("/schedule/window"))
          return { sessions: [], attendance: [], templates: [] };
        if (path.startsWith("/programs")) return [];
        if (path.startsWith("/students?")) {
          if (f.holdRosterRead)
            return new Promise((resolve) => {
              f.releaseRosterRead = resolve;
            });
          if (f.rosterEmpty)
            return {
              items: [],
              total: 0,
              page_size: 200,
              page_ordinal: 1,
              has_next: false,
              has_previous: false,
            };
          const params = new URL(path, "http://fixture.local").searchParams;
          const ordinal = Number(
            params.get("cursor")?.replace("page-", "") ?? params.get("page") ?? 1,
          );
          return {
            items: [f.student],
            total: 251,
            page_size: 50,
            page_ordinal: ordinal,
            has_next: ordinal < 6,
            next_cursor: `page-${ordinal + 1}`,
            has_previous: ordinal > 1,
            previous_cursor: ordinal > 1 ? `page-${ordinal - 1}` : null,
          };
        }
        if (path === "/leads" && f.autoLeads) return [];
        if (path === "/leads") return new Promise((resolve) => f.leadReads.push(resolve));
        if (path.startsWith("/dashboard/summary"))
          return new Promise((resolve, reject) => f.summaries.push({ resolve, reject }));
        if (path === "/students/student-1")
          return new Promise((resolve, reject) => f.details.push({ resolve, reject }));
        if (path === "/belts/ladders") {
          if (f.failBeltRefresh) throw Error("Synthetic belt refresh failure");
          return f.ladder ? [f.ladder] : [];
        }
        if (path.startsWith("/belts/eligibility?")) {
          f.eligibilityReads = (f.eligibilityReads ?? 0) + 1;
          return f.useNewEligibility
            ? [{ student_id: "student-new", eligible: true }]
            : [{ student_id: "student-old", eligible: false }];
        }
        if (path.includes("promotions")) return [];
        throw Error(`Unexpected read ${path}`);
      },
      post: (path, body) =>
        path.startsWith("/schedule/window")
          ? Promise.resolve({ sessions: [], attendance: [], templates: [] })
          : new Promise((resolve) => f.writes.push({ path, body, resolve })),
      postForm: async (path, body, token) => {
        f.events.push(path);
        f.importSubmissions.push({ path, token, importKey: body.get("idempotency_key") });
        return {
          total_rows: 1,
          valid_rows: 1,
          error_rows: 0,
          non_critical_errors: [],
          imported_count: 1,
          reused_result: false,
          created_programs: [],
          created_ladders: [],
          created_belts: [],
          warnings: [],
          execution_status: "completed",
        };
      },
      patch: (path, body) => new Promise((resolve) => f.writes.push({ path, body, resolve })),
      delete: (path) => new Promise((resolve) => f.writes.push({ path, resolve })),
    };
  });
  await page.evaluate(
    ({ path, holdFeature, uncached }) => {
      if (path) {
        fixture.pathname = path;
        history.replaceState(null, "", path);
      }
      fixture.holdFeature = holdFeature;
      fixture.uncached = uncached;
    },
    { path: options.path, holdFeature: options.holdFeature, uncached: options.uncached },
  );
  await page.addScriptTag({ content: bundle(options.mode ?? "production", options) });
  await page.waitForFunction(() => fixture.store?.identityReady);
  return page;
}

test("confirmed live import refreshes selected-ladder eligibility after belt refresh fails", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser);
    await page.evaluate(() => {
      fixture.ladder = {
        id: "ladder-1",
        name: "Synthetic Ladder",
        sub_rank_term: "Stripe",
        ranks: [],
      };
      fixture.prime = fixture.store.setCurrentLadder("ladder-1");
    });
    await page.waitForFunction(() => fixture.store.eligibilityLadderId === "ladder-1");
    await page.evaluate(() => fixture.prime);
    assert.deepEqual(await page.evaluate(() => fixture.store.eligibility), [
      { student_id: "student-old", eligible: false },
    ]);

    await page.evaluate(() => {
      fixture.failBeltRefresh = true;
      fixture.useNewEligibility = true;
      fixture.events = [];
      fixture.import = fixture.store.importStudents(
        new File(["First Name,Last Name\nNew,Student"], "students.csv", { type: "text/csv" }),
        [{ "First Name": "New", "Last Name": "Student" }],
        { "First Name": "legal_first_name", "Last Name": "legal_last_name" },
        { status_alias_mode: "normalize" },
        { importKey: "stable-import-key" },
      );
    });
    await page.waitForFunction(() => fixture.store.eligibility[0]?.student_id === "student-new");
    const result = await page.evaluate(() => fixture.import);
    assert.equal(result.imported_count, 1);
    assert.equal(result.execution_status, "completed_with_warnings");
    assert.match(result.non_critical_errors.at(-1), /Synthetic belt refresh failure/);
    assert.equal(await page.evaluate(() => fixture.store.eligibilityLadderId), "ladder-1");
    assert.equal(await page.evaluate(() => fixture.eligibilityReads), 2);
    assert.deepEqual(
      await page.evaluate(() => fixture.events.filter((path) => path.startsWith("/belts"))),
      ["/belts/ladders", "/belts/eligibility?ladder_id=ladder-1"],
    );
    assert.deepEqual(await page.evaluate(() => fixture.importSubmissions), [
      { path: "/students/import/execute", token: "synthetic-a", importKey: "stable-import-key" },
    ]);
    await page.evaluate(() => fixture.root.unmount());
  } finally {
    await browser.close();
  }
});

test("mounted lead actions preserve confirmed edits through token renewal, old GETs, and deletion", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser);
    await page.evaluate(() => {
      fixture.read = fixture.store.refreshLeads();
      fixture.save = fixture.store.updateLead("lead-1", { first_name: "Saved" });
    });
    await page.waitForFunction(() => fixture.writes.length === 1);
    await page.evaluate(() =>
      fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "synthetic-renewed" }),
    );
    await page.waitForFunction(() => fixture.store.token === "synthetic-renewed");
    await page.evaluate(() => fixture.writes[0].resolve({ ...fixture.lead, first_name: "Saved" }));
    await page.waitForFunction(() => fixture.store.leads[0]?.first_name === "Saved");
    await page.evaluate(() => fixture.leadReads[0]([fixture.lead]));
    await page.waitForFunction(() => fixture.leadReads.length === 2);
    assert.equal(await page.evaluate(() => fixture.store.leads[0].first_name), "Saved");
    await page.evaluate(() => fixture.leadReads[1]([{ ...fixture.lead, first_name: "Saved" }]));
    await page.evaluate(() => fixture.read);
    assert.equal(await page.evaluate(() => fixture.writes.length), 1);
    await page.evaluate(() => {
      fixture.read = fixture.store.refreshLeads();
      fixture.remove = fixture.store.deleteLead("lead-1");
    });
    await page.waitForFunction(() => fixture.writes.length === 2);
    await page.evaluate(() => fixture.writes[1].resolve());
    await page.waitForFunction(() => fixture.store.leads.length === 0);
    await page.evaluate(() => fixture.leadReads[2]([fixture.lead]));
    await page.waitForFunction(() => fixture.leadReads.length === 4);
    await page.evaluate(() => fixture.leadReads[3]([]));
    await page.evaluate(() => fixture.read);
    assert.equal(await page.evaluate(() => fixture.store.leads.length), 0);
    await page.evaluate(() => {
      fixture.older = fixture.store.refreshLeads();
      fixture.newer = fixture.store.refreshLeads();
    });
    await page.waitForFunction(() => fixture.leadReads.length === 6);
    await page.evaluate(() =>
      fixture.leadReads[5]([{ ...fixture.lead, id: "lead-2", first_name: "Newest" }]),
    );
    await page.evaluate(() => fixture.newer);
    await page.evaluate(() => fixture.leadReads[4]([fixture.lead]));
    await page.evaluate(() => fixture.older);
    assert.equal(await page.evaluate(() => fixture.store.leads[0].first_name), "Newest");
    await page.evaluate(() => fixture.root.unmount());
  } finally {
    await browser.close();
  }
});

test("mounted detail ensures complete cached data, retains it after roster changes, and exposes retry", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { detailController: true });
    await page.evaluate(() => fixture.mountDetail());
    await page.waitForFunction(() => fixture.details.length === 1);
    assert.equal(await page.evaluate(() => fixture.detail.detailReady), false);
    await page.evaluate(() => fixture.details[0].reject(Error("Detail unavailable")));
    await page.waitForFunction(() => fixture.detail.loadError);
    assert.equal(await page.evaluate(() => fixture.detail.detailReady), false);
    await page.evaluate(() => fixture.detail.onRetryDetail());
    await page.waitForFunction(() => fixture.details.length === 2);
    await page.evaluate(() =>
      fixture.details[1].resolve({
        ...fixture.student,
        guardians: [
          {
            id: "g1",
            first_name: "Guardian",
            last_name: "One",
            is_primary_contact: true,
          },
          {
            id: "g2",
            first_name: "Guardian",
            last_name: "Two",
            is_primary_contact: false,
          },
        ],
        photo_url: "https://synthetic.invalid/photo.png",
      }),
    );
    await page.waitForFunction(() => fixture.detail.detailReady);
    assert.equal(await page.evaluate(() => fixture.detail.student.guardians.length), 2);
    await page.evaluate(() => {
      fixture.save = fixture.store.updateStudent("student-1", { notes: "Changed" });
    });
    await page.waitForFunction(() => fixture.writes.length === 1);
    await page.evaluate(() => fixture.writes[0].resolve({ ...fixture.student, notes: "Changed" }));
    await page.evaluate(() => fixture.save);
    assert.equal(await page.evaluate(() => fixture.detail.student.guardians.length), 2);
    assert.equal(await page.evaluate(() => fixture.details.length), 2);
    await page.evaluate(() => fixture.root.unmount());
  } finally {
    await browser.close();
  }
});

test("mounted summary reconciliation preserves saved records and rejects older summary responses", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser);
    await page.evaluate(() => {
      fixture.oldSummary = fixture.store.refreshDashboardSummary();
      fixture.save = fixture.store.updateStudent("student-1", { legal_first_name: "Saved" });
    });
    await page.waitForFunction(() => fixture.summaries.length === 1 && fixture.writes.length === 1);
    await page.evaluate(() =>
      fixture.writes[0].resolve({ ...fixture.student, legal_first_name: "Saved" }),
    );
    await page.waitForFunction(() => fixture.summaries.length === 2);
    await page.evaluate(() =>
      fixture.summaries[1].resolve({
        ...fixture.summaryResponse,
        students: { ...fixture.summaryResponse.students, total_students: 251 },
      }),
    );
    await page.waitForFunction(
      () => fixture.store.dashboardSummary.students.total_students === 251,
    );
    await page.evaluate(() => fixture.summaries[0].resolve(fixture.summaryResponse));
    await page.evaluate(() => fixture.oldSummary);
    assert.equal(
      await page.evaluate(() => fixture.store.dashboardSummary.students.total_students),
      251,
    );
    await page.evaluate(() => {
      fixture.refresh = fixture.store.refreshDashboardSummary().catch(() => {});
    });
    await page.waitForFunction(() => fixture.summaries.length === 3);
    await page.evaluate(() => fixture.summaries[2].reject(Error("Offline")));
    await page.evaluate(() => fixture.refresh);
    assert.equal(await page.evaluate(() => fixture.store.students[0].legal_first_name), "Saved");
    assert.equal(
      await page.evaluate(() => fixture.store.dashboardSummary.students.total_students),
      251,
    );
    assert.match(await page.evaluate(() => fixture.store.dashboardSummaryLoadError), /retained/);
    await page.evaluate(() => fixture.root.unmount());
  } finally {
    await browser.close();
  }
});

for (const path of ["/students", "/billing"]) {
  test(`cold ${path} resolves protected workspace without unrelated feature waits`, async () => {
    const browser = await chromium.launch();
    try {
      const page = await fixturePage(browser, {
        path,
        holdFeature: true,
        layout: true,
        rosterController: path === "/students",
      });
      assert.equal(await page.locator('[data-preview-sidebar="ready"]').count(), 1);
      if (path === "/students") {
        await page.evaluate(() => fixture.mountRoster());
        await page.waitForFunction(() => fixture.roster?.pagedTotal === 251);
        assert.equal(await page.getByRole("button", { name: "Open student" }).count(), 1);
      }
      const requests = await page.evaluate(() => fixture.requests.map((r) => r.path));
      assert.ok(requests.includes("/dashboard/workspace"));
      assert.ok(
        !requests.some(
          (path) =>
            path === "/leads" || path.startsWith("/schedule/window") || path.startsWith("/belts"),
        ),
      );
      if (path === "/billing") assert.ok(!requests.some((path) => path.includes("bootstrap")));
      assert.ok(await page.evaluate(() => fixture.marks.includes("workspace.identity_ready")));
      console.log(
        "fixture workspace/controller readiness trace",
        JSON.stringify(
          await page.evaluate(() => ({
            route: fixture.pathname,
            requests: fixture.requests.map(({ path, atMs }) => ({ path, atMs })),
            marks: fixture.timingMarks,
            observedFixtureWorkspaceControllerReadyAtMs: performance.now(),
          })),
        ),
      );
      await page.evaluate(() => fixture.root.unmount());
    } finally {
      await browser.close();
    }
  });
}

for (const mode of ["production", "development"]) {
  test(`mounted roster keeps later page across credential renewal and detail return (${mode})`, async () => {
    const browser = await chromium.launch();
    try {
      const page = await fixturePage(browser, {
        mode,
        path: "/students",
        rosterController: true,
        detailController: true,
      });
      await page.evaluate(() => fixture.mountRoster());
      await page.waitForFunction(() => fixture.roster?.pagedTotal === 251);
      await page.getByRole("textbox", { name: "Search" }).fill("Ari");
      await page.evaluate(() => fixture.roster.onSort("membership_start_date"));
      await page.waitForFunction(() =>
        fixture.requests.some(
          (r) => r.path.includes("search=Ari") && r.path.includes("sort_by=membership_start_date"),
        ),
      );
      await page.getByRole("button", { name: "Next page" }).click();
      await page.waitForFunction(() => fixture.roster.page === 2 && !fixture.roster.isPagedLoading);
      await page.evaluate(() =>
        fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "synthetic-renewed" }),
      );
      await page.waitForFunction(() => fixture.store.token === "synthetic-renewed");
      assert.equal(await page.evaluate(() => fixture.roster.page), 2);
      await page.getByRole("button", { name: "Open student" }).click();
      await page.evaluate(() => {
        fixture.search = new URL(fixture.redirects.at(-1), "http://fixture.local").search;
        fixture.unmountRoster();
        fixture.mountDetail();
      });
      await page.waitForFunction(() => fixture.details.length >= 1);
      await page.evaluate(() => fixture.details.at(-1).resolve(fixture.student));
      await page.waitForFunction(() => fixture.detail.detailReady);
      await page.evaluate(() => fixture.detail.onBackToStudents());
      await page.evaluate(() => {
        fixture.search = new URL(fixture.redirects.at(-1), "http://fixture.local").search;
        fixture.unmountDetail();
        fixture.mountRoster();
      });
      await page.waitForFunction(
        () => fixture.roster.page === 2 && fixture.roster.pagedTotal === 251,
      );
      assert.equal(await page.getByRole("textbox", { name: "Search" }).inputValue(), "Ari");
      await page.waitForFunction(() => document.activeElement?.textContent === "Open student");
      await page.evaluate(() => fixture.root.unmount());
    } finally {
      await browser.close();
    }
  });
}

test("uncached detail has the same complete guardian and photo result", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { detailController: true, uncached: true });
    await page.evaluate(() => fixture.mountDetail());
    await page.waitForFunction(() => fixture.details.length === 1);
    await page.evaluate(() =>
      fixture.details[0].resolve({
        ...fixture.student,
        guardians: [
          { id: "g1", first_name: "Guardian", last_name: "One", is_primary_contact: true },
          { id: "g2", first_name: "Guardian", last_name: "Two", is_primary_contact: false },
        ],
        photo_url: "https://synthetic.invalid/photo.png",
      }),
    );
    await page.waitForFunction(() => fixture.detail.detailReady);
    assert.equal(await page.evaluate(() => fixture.detail.student.guardians.length), 2);
    assert.equal(
      await page.evaluate(() => fixture.detail.student.photo_url),
      "https://synthetic.invalid/photo.png",
    );
    await page.evaluate(() => fixture.root.unmount());
  } finally {
    await browser.close();
  }
});

test("credential renewal during feature bootstrap recovers without stranding route loading", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { path: "/students", holdFeature: true });
    await page.waitForFunction(() => fixture.featureWaiters?.length === 1);
    await page.evaluate(() => {
      fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "synthetic-renewed" });
      fixture.featurePayload = {
        auth: fixture.auth,
        students: [fixture.student],
        leads: [],
        programs: [],
        belt_ladders: [],
        primary_belt_ladder: null,
      };
      fixture.featureWaiters[0](fixture.featurePayload);
    });
    await page.waitForFunction(() => fixture.featureWaiters.length === 2);
    await page.evaluate(() => fixture.featureWaiters[1](fixture.featurePayload));
    await page.waitForFunction(() => fixture.store.studentsLoaded && fixture.store.programsLoaded);
    assert.equal(await page.evaluate(() => fixture.store.identityReady), true);
    await page.evaluate(() => fixture.root.unmount());
  } finally {
    await browser.close();
  }
});

test("cross-studio summary and changed membership between workspace and features cannot commit", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { path: "/students", holdFeature: true });
    await page.evaluate(() => {
      fixture.read = fixture.store.refreshDashboardSummary().catch(() => {});
    });
    await page.waitForFunction(() => fixture.summaries.length === 1);
    await page.evaluate(() =>
      fixture.summaries[0].resolve({
        ...fixture.summaryResponse,
        auth: { ...fixture.auth, studio_id: "other-studio" },
        students: { ...fixture.summaryResponse.students, total_students: 999 },
      }),
    );
    await page.evaluate(() => fixture.read);
    assert.equal(await page.evaluate(() => fixture.store.dashboardSummary), null);
    await page.evaluate(() =>
      fixture.releaseFeature({
        auth: { ...fixture.auth, role: "instructor" },
        students: [fixture.student],
        leads: [],
        programs: [],
        belt_ladders: [],
      }),
    );
    await page.waitForFunction(() => fixture.store.identityLoadError);
    assert.equal(await page.evaluate(() => fixture.store.identityReady), false);
    assert.deepEqual(await page.evaluate(() => fixture.store.students), []);
    await page.evaluate(() => fixture.root.unmount());
  } finally {
    await browser.close();
  }
});

test("studio midnight updates day-sensitive context without clearing a form draft", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, {
      path: "/students",
      studentForm: true,
      now: "2026-09-06T06:59:50Z",
    });
    await page.getByRole("button", { name: "Open form", exact: true }).click();
    await page.getByLabel("Legal first name", { exact: false }).fill("Draft");
    await page.getByLabel("Legal last name", { exact: false }).fill("Student");
    assert.equal(await page.evaluate(() => fixture.store.businessDate), "2026-09-05");
    await page.clock.fastForward(31_000);
    await page.waitForFunction(() => fixture.store.businessDate === "2026-09-06");
    assert.equal(await page.getByLabel("Legal first name", { exact: false }).inputValue(), "Draft");
    assert.equal(
      await page.getByLabel("Membership start", { exact: true }).inputValue(),
      "2026-09-05",
      "an open draft retains its chosen start date",
    );
    await page.evaluate(() => {
      fixture.api.post = async () => {
        throw Error("Synthetic save rejection");
      };
    });
    await page.getByRole("button", { name: "Add student", exact: true }).click();
    await page.getByText("Synthetic save rejection", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Legal first name", { exact: false }).inputValue(), "Draft");
    await page.evaluate(() => {
      fixture.api.post = async () => {
        throw new fixture.CommandOutcomeUnknown();
      };
    });
    await page.getByRole("button", { name: "Add student", exact: true }).click();
    await page.getByText(/The request may have been saved/).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Add student", exact: true }).isEnabled(),
      false,
    );
    assert.equal(await page.getByLabel("Legal first name", { exact: false }).inputValue(), "Draft");
    await page.getByLabel("Legal first name", { exact: false }).press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Open form");
    await page.evaluate(() => fixture.root.unmount());
  } finally {
    await browser.close();
  }
});

test("a confirmed old write cannot repopulate protected data after sign-out", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser);
    await page.evaluate(() => {
      fixture.save = fixture.store.updateLead("lead-1", { first_name: "Saved" });
    });
    await page.waitForFunction(() => fixture.writes.length === 1);
    await page.evaluate(() => fixture.emit("SIGNED_OUT", null));
    await page.waitForFunction(() => !fixture.store.identityReady);
    await page.evaluate(() => fixture.writes[0].resolve({ ...fixture.lead, first_name: "Saved" }));
    await page.evaluate(() => fixture.save);
    assert.deepEqual(await page.evaluate(() => fixture.store.leads), []);
    assert.equal(await page.evaluate(() => fixture.store.currentStudioId), null);
    await page.evaluate(() => fixture.root.unmount());
  } finally {
    await browser.close();
  }
});

test("archive settlement prevents a current-token roster read from resurrecting the student", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { path: "/students" });
    await page.waitForFunction(() => fixture.store.studentsLoaded);
    await page.evaluate(() => {
      fixture.archive = fixture.store.deleteStudents(["student-1"]);
    });
    await page.waitForFunction(() => fixture.writes.length === 1);
    await page.evaluate(() =>
      fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "synthetic-renewed" }),
    );
    await page.waitForFunction(() => fixture.store.token === "synthetic-renewed");
    await page.evaluate(() => {
      fixture.holdRosterRead = true;
      fixture.read = fixture.store.refreshStudents();
    });
    await page.waitForFunction(() => fixture.releaseRosterRead);
    await page.evaluate(() => fixture.writes[0].resolve({ updated: 1 }));
    await page.evaluate(() => fixture.archive);
    await page.waitForFunction(() => fixture.store.students.length === 0);
    await page.evaluate(() => {
      fixture.holdRosterRead = false;
      fixture.rosterEmpty = true;
      fixture.releaseRosterRead({
        items: [fixture.student],
        total: 1,
        page_size: 200,
        page_ordinal: 1,
        has_next: false,
        has_previous: false,
      });
    });
    await page.evaluate(() => fixture.read);
    assert.deepEqual(await page.evaluate(() => fixture.store.students), []);
    await page.evaluate(() => fixture.root.unmount());
  } finally {
    await browser.close();
  }
});

test("Add class snapshots the selected studio day for both modes and retains an open draft", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, {
      path: "/schedule",
      scheduleController: true,
      scheduleForm: true,
      timezone: "Asia/Tokyo",
      now: "2026-09-06T06:59:50Z",
    });
    await page.evaluate(() => fixture.mountSchedule());
    await page.waitForFunction(() => fixture.controller);
    await page.evaluate(() => fixture.controller.onOpenAddClass());
    await page.getByRole("dialog", { name: "Add class" }).waitFor();
    const defaults = await page
      .locator('input[type="date"]')
      .evaluateAll((inputs) => inputs.map((input) => input.value));
    assert.ok(defaults.includes("2026-09-05"));
    assert.ok(!defaults.includes("2026-09-06"));
    await page.getByRole("button", { name: /One-off session/ }).click();
    assert.deepEqual(
      await page
        .locator('input[type="date"]')
        .evaluateAll((inputs) => inputs.map((input) => input.value)),
      ["2026-09-05"],
    );
    await page.clock.fastForward(31_000);
    await page.waitForFunction(() => fixture.store.businessDate === "2026-09-06");
    assert.deepEqual(
      await page
        .locator('input[type="date"]')
        .evaluateAll((inputs) => inputs.map((input) => input.value)),
      ["2026-09-05"],
    );
    await page.evaluate(() => fixture.controller.onCloseAddClass());
    await page.evaluate(() => fixture.controller.onJumpToToday());
    await page.evaluate(() => fixture.controller.onOpenAddClass());
    assert.equal(
      await page.evaluate(() => fixture.controller.classFormInitialValues.date),
      "2026-09-06",
    );
    await page.evaluate(() => fixture.root.unmount());
  } finally {
    await browser.close();
  }
});

for (const entry of ["/students", "/billing"]) {
  for (const destination of ["/leads", "/reports"]) {
    test(`cold ${entry} then ${destination} loads its previously omitted data`, async () => {
      const browser = await chromium.launch();
      try {
        const page = await fixturePage(browser, { path: entry });
        if (entry === "/students") await page.waitForFunction(() => fixture.store.studentsLoaded);
        assert.equal(await page.evaluate(() => fixture.store.leadsLoaded), false);
        await page.evaluate((path) => {
          fixture.autoLeads = true;
          fixture.navigate(path);
        }, destination);
        await page.waitForFunction(() => fixture.store.leadsLoaded && fixture.store.programsLoaded);
        assert.ok(await page.evaluate(() => fixture.requests.some((r) => r.path === "/leads")));
        await page.evaluate(() => fixture.root.unmount());
      } finally {
        await browser.close();
      }
    });
  }
}

test("the fallback roster loads its first complete dataset after a Billing entry", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, {
      path: "/billing",
      rosterController: true,
      pagedRoster: false,
    });
    assert.equal(await page.evaluate(() => fixture.store.studentsLoaded), false);
    await page.evaluate(() => {
      fixture.rosterEmpty = true;
      fixture.navigate("/students", "?fullRoster=1");
      fixture.mountRoster();
    });
    await page.waitForFunction(() => fixture.store.studentsLoaded && fixture.store.programsLoaded);
    assert.equal(await page.evaluate(() => fixture.store.studentsMayBePartial), false);
    await page.evaluate(() => fixture.root.unmount());
  } finally {
    await browser.close();
  }
});

test("off-dashboard business commands do not fan out into uncached summary reads", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { path: "/leads" });
    await page.waitForFunction(() => fixture.store.leadsLoaded);
    await page.evaluate(async () => {
      fixture.api.patch = async () => fixture.lead;
      for (let i = 0; i < 30; i += 1)
        await fixture.store.updateLead("lead-1", { notes: `Edit ${i}` });
    });
    assert.equal(await page.evaluate(() => fixture.summaries.length), 0);
    await page.evaluate(() => {
      fixture.navigate("/dashboard");
      fixture.summaryRequest = fixture.store.refreshDashboardSummary();
    });
    await page.waitForFunction(() => fixture.summaries.length === 1);
    await page.evaluate(() => fixture.summaries[0].resolve(fixture.summaryResponse));
    await page.evaluate(() => fixture.summaryRequest);
    await page.evaluate(() => fixture.root.unmount());
  } finally {
    await browser.close();
  }
});

test("an unknown lead save stays locked until dismissal, then a new form is usable", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { path: "/leads", leadController: true });
    await page.evaluate(() => {
      fixture.writeAttempts = 0;
      fixture.api.post = async () => {
        fixture.writeAttempts += 1;
        throw new fixture.CommandOutcomeUnknown();
      };
    });
    await page.getByRole("button", { name: "New lead", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add new lead" });
    await dialog.locator('[name="first_name"]').fill("Synthetic");
    await dialog.locator('[name="last_name"]').fill("Lead");
    await dialog.getByRole("button", { name: "Add lead", exact: true }).click();
    await page.waitForFunction(() => fixture.leadController.addLeadOutcomeUnknown);
    assert.equal(
      await dialog.getByRole("button", { name: "Add lead", exact: true }).isEnabled(),
      false,
    );
    assert.equal(await page.evaluate(() => fixture.leadController.isAddingLead), false);
    assert.equal(await page.evaluate(() => fixture.writeAttempts), 1);
    await dialog.getByRole("button", { name: "Close add lead dialog" }).click();
    await page.getByRole("button", { name: "New lead", exact: true }).click();
    assert.equal(
      await dialog.getByRole("button", { name: "Add lead", exact: true }).isEnabled(),
      true,
    );
    await page.evaluate(() => fixture.root.unmount());
  } finally {
    await browser.close();
  }
});

for (const path of ["schedule", "settings", "leads", "reports", "belt-tracker"]) {
  test(`cold ${path} requests only its own bootstrap projection`, async () => {
    const browser = await chromium.launch();
    try {
      const page = await fixturePage(browser, { path: `/${path}` });
      await page.waitForFunction(() =>
        fixture.requests.some((r) => r.path.startsWith("/dashboard/bootstrap")),
      );
      const expected = path === "belt-tracker" ? "training" : path;
      assert.equal(
        await page.evaluate(
          () => fixture.requests.find((r) => r.path.startsWith("/dashboard/bootstrap")).path,
        ),
        `/dashboard/bootstrap?allow_partial=true&view=${expected}`,
      );
      if (["schedule", "settings", "leads", "reports", "belt-tracker"].includes(path)) {
        await page.waitForFunction(() => fixture.store.programsLoaded);
        assert.equal(await page.evaluate(() => fixture.store.studentsLoaded), false);
      }
    } finally {
      await browser.close();
    }
  });
}

test("same-build resume verifies access before refreshing visible data and retains the mounted form", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { path: "/leads", leadController: true });
    await page.getByRole("button", { name: "New lead" }).click();
    const input = page.getByRole("textbox").first();
    await input.fill("Unsaved lead");
    await page.evaluate(() => {
      fixture.resumeEvents = 0;
      window.addEventListener("koaryu:data-refresh", () => fixture.resumeEvents++);
      window.dispatchEvent(new Event("koaryu:resume"));
    });
    await page.waitForFunction(() => fixture.resumeEvents === 1);
    await expectValue(input, "Unsaved lead");
    assert.equal(
      await page.evaluate(
        () => fixture.requests.filter((r) => r.path === "/dashboard/workspace").length,
      ),
      2,
    );
    await page.evaluate(() => {
      fixture.auth = { ...fixture.auth, role: "instructor" };
      window.dispatchEvent(new Event("koaryu:resume"));
    });
    await page.waitForFunction(() => fixture.store.currentRole === "instructor");
    assert.equal(await page.evaluate(() => fixture.resumeEvents), 1);
  } finally {
    await browser.close();
  }
});

async function expectValue(input, expected) {
  assert.equal(await input.inputValue(), expected);
}

test("explicit refresh supersedes an older cached visit read", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser);
    await page.evaluate(() => {
      fixture.visit = fixture.store.refreshDashboardSummary({ reason: "visit" });
    });
    await page.waitForFunction(() => fixture.summaries.length === 1);
    assert.equal(await page.evaluate(() => fixture.requests.at(-1).path), "/dashboard/summary");
    await page.evaluate(() => {
      fixture.refresh = fixture.store.refreshDashboardSummary();
    });
    await page.waitForFunction(() => fixture.summaries.length === 2);
    assert.equal(
      await page.evaluate(() => fixture.requests.at(-1).path),
      "/dashboard/summary?fresh=true",
    );
    await page.evaluate(() =>
      fixture.summaries[1].resolve({
        ...fixture.summaryResponse,
        students: { ...fixture.summaryResponse.students, total_students: 251 },
      }),
    );
    await page.evaluate(() => fixture.refresh);
    await page.evaluate(() => fixture.summaries[0].resolve(fixture.summaryResponse));
    await page.evaluate(() => fixture.visit);
    assert.equal(
      await page.evaluate(() => fixture.store.dashboardSummary.students.total_students),
      251,
    );
  } finally {
    await browser.close();
  }
});

test("resuming a student detail forces a second promotion-history read", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, {
      path: "/students/student-1",
      detailController: true,
    });
    await page.evaluate(() => fixture.mountDetail());
    await page.waitForFunction(
      () =>
        fixture.details.length === 1 && fixture.requests.some((r) => r.path.includes("promotions")),
    );
    await page.evaluate(() => fixture.details[0].resolve(fixture.student));
    const initial = await page.evaluate(
      () => fixture.requests.filter((r) => r.path.includes("promotions")).length,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("koaryu:resume")));
    await page.waitForFunction(
      (before) => fixture.requests.filter((r) => r.path.includes("promotions")).length > before,
      initial,
    );
    await page.waitForFunction(() => fixture.details.length === 2);
    await page.evaluate(() => fixture.details[1].resolve(fixture.student));
  } finally {
    await browser.close();
  }
});

test("Settings does not start a deferred belt read after its metadata projection", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { path: "/settings" });
    await page.waitForFunction(() => fixture.store.programsLoaded);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(
      await page.evaluate(() => fixture.requests.some((r) => r.path.includes("/belts"))),
      false,
    );
  } finally {
    await browser.close();
  }
});

test("resume access denial clears prior studio records", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser);
    await page.waitForFunction(() => fixture.store.students.length > 0);
    await page.evaluate(() => {
      const original = fixture.api.get;
      fixture.api.get = (path, ...args) =>
        path === "/dashboard/workspace"
          ? Promise.reject(Object.assign(new Error("Studio access revoked"), { status: 403 }))
          : original(path, ...args);
      window.dispatchEvent(new Event("koaryu:resume"));
    });
    await page.waitForFunction(
      () => !fixture.store.identityReady && fixture.store.students.length === 0,
    );
    assert.equal(
      await page.evaluate(() => document.cookie.includes("koaryu-active-studio=studio-a")),
      false,
    );
  } finally {
    await browser.close();
  }
});

test("resume verification waits again for a command that started during its read", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser);
    await page.evaluate(() => {
      fixture.resumeReads = 0;
      fixture.resumeEvents = 0;
      window.addEventListener("koaryu:data-refresh", () => fixture.resumeEvents++);
      const original = fixture.api.get;
      fixture.api.get = (path, ...args) =>
        path === "/dashboard/workspace" && ++fixture.resumeReads === 1
          ? new Promise((resolve) => {
              fixture.releaseWorkspace = resolve;
            })
          : original(path, ...args);
      window.dispatchEvent(new Event("koaryu:resume"));
    });
    await page.waitForFunction(() => fixture.releaseWorkspace);
    await page.evaluate(() => {
      fixture.finishCommand = fixture.beginPendingCommand();
      fixture.releaseWorkspace({ auth: fixture.auth });
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    assert.equal(await page.evaluate(() => fixture.resumeEvents), 0);
    await page.evaluate(() => fixture.finishCommand());
    await page.waitForFunction(() => fixture.resumeEvents === 1);
    assert.equal(await page.evaluate(() => fixture.resumeReads), 2);
  } finally {
    await browser.close();
  }
});

test("resume restores externally renewed subscription access", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser);
    await page.evaluate(() => {
      fixture.store.markSubscriptionRequired();
      fixture.navigate("/subscription-required");
    });
    await page.waitForFunction(() => fixture.store.subscriptionRequired);
    await page.evaluate(() => window.dispatchEvent(new Event("koaryu:resume")));
    await page.waitForFunction(() => !fixture.store.subscriptionRequired);
    assert.equal(await page.evaluate(() => fixture.redirects.includes("/dashboard")), true);
  } finally {
    await browser.close();
  }
});

test("detail resume continues after an independent belt-read failure", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, {
      path: "/students/student-1",
      detailController: true,
    });
    await page.evaluate(() => fixture.mountDetail());
    await page.waitForFunction(() => fixture.details.length === 1);
    await page.evaluate(() => fixture.details[0].resolve(fixture.student));
    await page.evaluate(() => {
      const original = fixture.api.get;
      fixture.api.get = (path, ...args) =>
        path === "/belts/ladders"
          ? Promise.reject(new Error("Belt provider unavailable"))
          : original(path, ...args);
      window.dispatchEvent(new Event("koaryu:resume"));
    });
    await page.waitForFunction(() => fixture.details.length === 2);
    await page.evaluate(() => fixture.details[1].resolve(fixture.student));
  } finally {
    await browser.close();
  }
});

test("resumed schedule updates or closes its selected session and refreshes its roster", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { path: "/schedule", scheduleController: true });
    await page.evaluate(() => {
      fixture.scheduleRow = {
        id: "session-one",
        date: fixture.store.businessDate,
        name: "Before",
        start_time: "10:00",
        end_time: "11:00",
        attendance_count: 0,
      };
      const get = fixture.api.get,
        post = fixture.api.post;
      const windowData = () => ({
        sessions: fixture.scheduleRow ? [fixture.scheduleRow] : [],
        attendance: [],
        templates: [],
      });
      fixture.api.get = (path, ...args) =>
        path.startsWith("/schedule/window")
          ? Promise.resolve(windowData())
          : path.includes("attendance")
            ? Promise.resolve([])
            : path.startsWith("/students?")
              ? Promise.resolve({
                  items: [fixture.student],
                  total: 1,
                  page_size: 200,
                  page_ordinal: 1,
                  has_next: false,
                })
              : get(path, ...args);
      fixture.api.post = (path, ...args) =>
        path.startsWith("/schedule/window") ? Promise.resolve(windowData()) : post(path, ...args);
      fixture.mountSchedule();
    });
    await page.waitForFunction(() =>
      fixture.controller?.sessions.some((s) => s.id === "session-one"),
    );
    await page.evaluate(() => fixture.controller.onOpenSession(fixture.controller.sessions[0]));
    await page.waitForFunction(() => fixture.controller.selectedSession?.name === "Before");
    await page.evaluate(() => {
      fixture.scheduleRow = { ...fixture.scheduleRow, name: "After" };
      fixture.student = { ...fixture.student, legal_first_name: "Renamed" };
      window.dispatchEvent(new Event("koaryu:resume"));
    });
    await page.waitForFunction(
      () =>
        fixture.controller.selectedSession?.name === "After" &&
        fixture.controller.activeStudents[0]?.legal_first_name === "Renamed",
    );
    await page.evaluate(() => {
      fixture.scheduleRow = null;
      window.dispatchEvent(new Event("koaryu:resume"));
    });
    await page.waitForFunction(() => fixture.controller.selectedSession === null);
  } finally {
    await browser.close();
  }
});

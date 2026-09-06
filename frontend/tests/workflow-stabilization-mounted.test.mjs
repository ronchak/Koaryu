import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { bundle } from "./helpers/store-browser-harness.mjs";

async function fixturePage(browser, options = {}) {
  const page = await browser.newPage();
  if (options.now) await page.clock.install({ time: new Date(options.now) });
  await page.route("**/*", route => route.request().url() === "http://fixture.local/"
    ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }) : route.abort());
  await page.goto("http://fixture.local/");
  await page.evaluate(() => {
    const f = window.fixture = { identityObservations: [], marks: [], timingMarks: [], observations: [], requests: [], leadReads: [], writes: [], summaries: [], details: [] };
    f.session = { access_token: "synthetic-a", user: { id: "user-a", email: "a@example.test", legal_first_name: "Synthetic", legal_last_name: "Owner" } };
    f.auth = { user: f.session.user, studio_id: "studio-a", membership_status: "active", role: "admin", staff_profiles_available: true };
    f.student = { id: "student-1", studio_id: "studio-a", legal_first_name: "Ari", legal_last_name: "Lane", status: "active", guardians: [], photo_url: null, programs: [], tags: [] };
    f.lead = { id: "lead-1", first_name: "Old", last_name: "Lead", status: "new" };
    f.supabase = { auth: {
      getSession: async () => ({ data: { session: f.session } }),
      onAuthStateChange: cb => { f.emit = (event, session) => { f.session = session; cb(event, session); }; return { data: { subscription: { unsubscribe() {} } } }; },
    } };
    f.api = {
      get: async (path, token) => {
        f.requests.push({ path, token, atMs: performance.now() });
        if (path === "/dashboard/workspace") return { auth: f.auth, studio: { name: "Synthetic Studio", timezone: "America/Los_Angeles" } };
        if (path.startsWith("/dashboard/bootstrap") && f.holdFeature) return new Promise(resolve => { f.featureWaiters ??= []; f.featureWaiters.push(resolve); f.releaseFeature = resolve; });
        if (path.startsWith("/dashboard/bootstrap")) return { auth: f.auth, studio_name: "Synthetic Studio", students: f.uncached ? [] : [f.student], students_may_be_partial: true, leads: [f.lead], programs: [], belt_ladders: [], primary_belt_ladder: null, summary: { auth: f.auth, students: { total: 250 } } };
        if (path.startsWith("/schedule/window")) return { sessions: [], attendance: [], templates: [] };
        if (path.startsWith("/programs")) return [];
        if (path.startsWith("/students?")) {
          const params = new URL(path, "http://fixture.local").searchParams;
          const ordinal = Number(params.get("cursor")?.replace("page-", "") ?? params.get("page") ?? 1);
          return { items: [f.student], total: 251, page_size: 50, page_ordinal: ordinal, has_next: ordinal < 6,
            next_cursor: `page-${ordinal + 1}`, has_previous: ordinal > 1, previous_cursor: ordinal > 1 ? `page-${ordinal - 1}` : null };
        }
        if (path === "/leads") return new Promise(resolve => f.leadReads.push(resolve));
        if (path.startsWith("/dashboard/summary")) return new Promise((resolve, reject) => f.summaries.push({ resolve, reject }));
        if (path === "/students/student-1") return new Promise((resolve, reject) => f.details.push({ resolve, reject }));
        if (path.includes("promotions") || path.includes("/belts/ladders")) return [];
        throw Error(`Unexpected read ${path}`);
      },
      patch: (path, body) => new Promise(resolve => f.writes.push({ path, body, resolve })),
      delete: path => new Promise(resolve => f.writes.push({ path, resolve })),
    };
  });
  await page.evaluate(({ path, holdFeature, uncached }) => {
    if (path) fixture.pathname = path;
    fixture.holdFeature = holdFeature;
    fixture.uncached = uncached;
  }, { path: options.path, holdFeature: options.holdFeature, uncached: options.uncached });
  await page.addScriptTag({ content: bundle(options.mode ?? "production", options) });
  await page.waitForFunction(() => fixture.store?.identityReady);
  return page;
}

test("mounted lead actions preserve confirmed edits through token renewal, old GETs, and deletion", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser);
    await page.evaluate(() => { fixture.read = fixture.store.refreshLeads(); fixture.save = fixture.store.updateLead("lead-1", { first_name: "Saved" }); });
    await page.waitForFunction(() => fixture.writes.length === 1);
    await page.evaluate(() => fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "synthetic-renewed" }));
    await page.waitForFunction(() => fixture.store.token === "synthetic-renewed");
    await page.evaluate(() => fixture.writes[0].resolve({ ...fixture.lead, first_name: "Saved" }));
    await page.waitForFunction(() => fixture.store.leads[0]?.first_name === "Saved");
    await page.evaluate(() => fixture.leadReads[0]([fixture.lead]));
    await page.waitForFunction(() => fixture.leadReads.length === 2);
    assert.equal(await page.evaluate(() => fixture.store.leads[0].first_name), "Saved");
    await page.evaluate(() => fixture.leadReads[1]([{ ...fixture.lead, first_name: "Saved" }]));
    await page.evaluate(() => fixture.read);
    assert.equal(await page.evaluate(() => fixture.writes.length), 1);
    await page.evaluate(() => { fixture.read = fixture.store.refreshLeads(); fixture.remove = fixture.store.deleteLead("lead-1"); });
    await page.waitForFunction(() => fixture.writes.length === 2);
    await page.evaluate(() => fixture.writes[1].resolve());
    await page.waitForFunction(() => fixture.store.leads.length === 0);
    await page.evaluate(() => fixture.leadReads[2]([fixture.lead]));
    await page.waitForFunction(() => fixture.leadReads.length === 4);
    await page.evaluate(() => fixture.leadReads[3]([]));
    await page.evaluate(() => fixture.read);
    assert.equal(await page.evaluate(() => fixture.store.leads.length), 0);
    await page.evaluate(() => { fixture.older = fixture.store.refreshLeads(); fixture.newer = fixture.store.refreshLeads(); });
    await page.waitForFunction(() => fixture.leadReads.length === 6);
    await page.evaluate(() => fixture.leadReads[5]([{ ...fixture.lead, id: "lead-2", first_name: "Newest" }]));
    await page.evaluate(() => fixture.newer);
    await page.evaluate(() => fixture.leadReads[4]([fixture.lead]));
    await page.evaluate(() => fixture.older);
    assert.equal(await page.evaluate(() => fixture.store.leads[0].first_name), "Newest");
    await page.evaluate(() => fixture.root.unmount());
  } finally { await browser.close(); }
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
    await page.evaluate(() => fixture.details[1].resolve({ ...fixture.student, guardians: [{ id: "g1", full_name: "Guardian One", is_primary: true }, { id: "g2", full_name: "Guardian Two" }], photo_url: "https://synthetic.invalid/photo.png" }));
    await page.waitForFunction(() => fixture.detail.detailReady);
    assert.equal(await page.evaluate(() => fixture.detail.student.guardians.length), 2);
    await page.evaluate(() => { fixture.save = fixture.store.updateStudent("student-1", { notes: "Changed" }); });
    await page.waitForFunction(() => fixture.writes.length === 1);
    await page.evaluate(() => fixture.writes[0].resolve({ ...fixture.student, notes: "Changed" }));
    await page.evaluate(() => fixture.save);
    assert.equal(await page.evaluate(() => fixture.detail.student.guardians.length), 2);
    assert.equal(await page.evaluate(() => fixture.details.length), 2);
    await page.evaluate(() => fixture.root.unmount());
  } finally { await browser.close(); }
});

test("mounted summary reconciliation preserves saved records and rejects older summary responses", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser);
    await page.evaluate(() => { fixture.oldSummary = fixture.store.refreshDashboardSummary(); fixture.save = fixture.store.updateStudent("student-1", { legal_first_name: "Saved" }); });
    await page.waitForFunction(() => fixture.summaries.length === 1 && fixture.writes.length === 1);
    await page.evaluate(() => fixture.writes[0].resolve({ ...fixture.student, legal_first_name: "Saved" }));
    await page.waitForFunction(() => fixture.summaries.length === 2);
    await page.evaluate(() => fixture.summaries[1].resolve({ auth: fixture.auth, students: { total: 251 } }));
    await page.waitForFunction(() => fixture.store.dashboardSummary.students.total === 251);
    await page.evaluate(() => fixture.summaries[0].resolve({ auth: fixture.auth, students: { total: 250 } }));
    await page.evaluate(() => fixture.oldSummary);
    assert.equal(await page.evaluate(() => fixture.store.dashboardSummary.students.total), 251);
    await page.evaluate(() => { fixture.refresh = fixture.store.refreshDashboardSummary().catch(() => {}); });
    await page.waitForFunction(() => fixture.summaries.length === 3);
    await page.evaluate(() => fixture.summaries[2].reject(Error("Offline")));
    await page.evaluate(() => fixture.refresh);
    assert.equal(await page.evaluate(() => fixture.store.students[0].legal_first_name), "Saved");
    assert.equal(await page.evaluate(() => fixture.store.dashboardSummary.students.total), 251);
    assert.match(await page.evaluate(() => fixture.store.dashboardSummaryLoadError), /retained/);
    await page.evaluate(() => fixture.root.unmount());
  } finally { await browser.close(); }
});

for (const path of ["/students", "/billing"]) {
  test(`cold ${path} resolves protected workspace without unrelated feature waits`, async () => {
    const browser = await chromium.launch();
    try {
      const page = await fixturePage(browser, { path, holdFeature: true, layout: true, rosterController: path === "/students" });
      assert.equal(await page.locator('[data-preview-sidebar="ready"]').count(), 1);
      if (path === "/students") {
        await page.evaluate(() => fixture.mountRoster());
        await page.waitForFunction(() => fixture.roster?.pagedTotal === 251);
        assert.equal(await page.getByRole("button", { name: "Open student" }).count(), 1);
      }
      const requests = await page.evaluate(() => fixture.requests.map(r => r.path));
      assert.ok(requests.includes("/dashboard/workspace"));
      assert.ok(!requests.some(path => path === "/leads" || path.startsWith("/schedule/window") || path.startsWith("/belts")));
      if (path === "/billing") assert.ok(!requests.some(path => path.includes("bootstrap")));
      assert.ok(await page.evaluate(() => fixture.marks.includes("workspace.identity_ready")));
      console.log("synthetic startup trace", JSON.stringify(await page.evaluate(() => ({
        route: fixture.pathname,
        requests: fixture.requests.map(({ path, atMs }) => ({ path, atMs })),
        marks: fixture.timingMarks,
        observedUsableAtMs: performance.now(),
      }))));
      await page.evaluate(() => fixture.root.unmount());
    } finally { await browser.close(); }
  });
}

for (const mode of ["production", "development"]) {
test(`mounted roster keeps later page across credential renewal and detail return (${mode})`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { mode, path: "/students", rosterController: true, detailController: true });
    await page.evaluate(() => fixture.mountRoster());
    await page.waitForFunction(() => fixture.roster?.pagedTotal === 251);
    await page.getByRole("textbox", { name: "Search" }).fill("Ari");
    await page.evaluate(() => fixture.roster.onSort("membership_start_date"));
    await page.waitForFunction(() => fixture.requests.some(r => r.path.includes("search=Ari") && r.path.includes("sort_by=membership_start_date")));
    await page.getByRole("button", { name: "Next page" }).click();
    await page.waitForFunction(() => fixture.roster.page === 2 && !fixture.roster.isPagedLoading);
    await page.evaluate(() => fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "synthetic-renewed" }));
    await page.waitForFunction(() => fixture.store.token === "synthetic-renewed");
    assert.equal(await page.evaluate(() => fixture.roster.page), 2);
    await page.getByRole("button", { name: "Open student" }).click();
    await page.evaluate(() => {
      fixture.search = new URL(fixture.redirects.at(-1), "http://fixture.local").search;
      fixture.unmountRoster(); fixture.mountDetail();
    });
    await page.waitForFunction(() => fixture.details.length >= 1);
    await page.evaluate(() => fixture.details.at(-1).resolve(fixture.student));
    await page.waitForFunction(() => fixture.detail.detailReady);
    await page.evaluate(() => fixture.detail.onBackToStudents());
    await page.evaluate(() => {
      fixture.search = new URL(fixture.redirects.at(-1), "http://fixture.local").search;
      fixture.unmountDetail(); fixture.mountRoster();
    });
    await page.waitForFunction(() => fixture.roster.page === 2 && fixture.roster.pagedTotal === 251);
    assert.equal(await page.getByRole("textbox", { name: "Search" }).inputValue(), "Ari");
    await page.waitForFunction(() => document.activeElement?.textContent === "Open student");
    await page.evaluate(() => fixture.root.unmount());
  } finally { await browser.close(); }
});

}

test("uncached detail has the same complete guardian and photo result", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { detailController: true, uncached: true });
    await page.evaluate(() => fixture.mountDetail());
    await page.waitForFunction(() => fixture.details.length === 1);
    await page.evaluate(() => fixture.details[0].resolve({ ...fixture.student, guardians: [{ id: "g1" }, { id: "g2" }], photo_url: "https://synthetic.invalid/photo.png" }));
    await page.waitForFunction(() => fixture.detail.detailReady);
    assert.equal(await page.evaluate(() => fixture.detail.student.guardians.length), 2);
    assert.equal(await page.evaluate(() => fixture.detail.student.photo_url), "https://synthetic.invalid/photo.png");
    await page.evaluate(() => fixture.root.unmount());
  } finally { await browser.close(); }
});

test("credential renewal during feature bootstrap recovers without stranding route loading", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { path: "/students", holdFeature: true });
    await page.waitForFunction(() => fixture.featureWaiters?.length === 1);
    await page.evaluate(() => {
      fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "synthetic-renewed" });
      fixture.featurePayload = { auth: fixture.auth, students: [fixture.student], leads: [], programs: [], belt_ladders: [], primary_belt_ladder: null };
      fixture.featureWaiters[0](fixture.featurePayload);
    });
    await page.waitForFunction(() => fixture.featureWaiters.length === 2);
    await page.evaluate(() => fixture.featureWaiters[1](fixture.featurePayload));
    await page.waitForFunction(() => fixture.store.studentsLoaded && fixture.store.programsLoaded);
    assert.equal(await page.evaluate(() => fixture.store.identityReady), true);
    await page.evaluate(() => fixture.root.unmount());
  } finally { await browser.close(); }
});

test("cross-studio summary and changed membership between workspace and features cannot commit", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { path: "/students", holdFeature: true });
    await page.evaluate(() => { fixture.read = fixture.store.refreshDashboardSummary().catch(() => {}); });
    await page.waitForFunction(() => fixture.summaries.length === 1);
    await page.evaluate(() => fixture.summaries[0].resolve({ auth: { ...fixture.auth, studio_id: "other-studio" }, students: { total: 999 } }));
    await page.evaluate(() => fixture.read);
    assert.equal(await page.evaluate(() => fixture.store.dashboardSummary), null);
    await page.evaluate(() => fixture.releaseFeature({ auth: { ...fixture.auth, role: "instructor" }, students: [fixture.student], leads: [], programs: [], belt_ladders: [] }));
    await page.waitForFunction(() => fixture.store.identityLoadError);
    assert.equal(await page.evaluate(() => fixture.store.identityReady), false);
    assert.deepEqual(await page.evaluate(() => fixture.store.students), []);
    await page.evaluate(() => fixture.root.unmount());
  } finally { await browser.close(); }
});

test("studio midnight updates day-sensitive context without clearing a form draft", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser, { path: "/students", studentForm: true, now: "2026-09-06T06:59:50Z" });
    await page.getByRole("button", { name: "Open form", exact: true }).click();
    await page.getByLabel("Legal first name", { exact: false }).fill("Draft");
    await page.getByLabel("Legal last name", { exact: false }).fill("Student");
    assert.equal(await page.evaluate(() => fixture.store.businessDate), "2026-09-05");
    await page.clock.fastForward(31_000);
    await page.waitForFunction(() => fixture.store.businessDate === "2026-09-06");
    assert.equal(await page.getByLabel("Legal first name", { exact: false }).inputValue(), "Draft");
    assert.equal(await page.getByLabel("Membership start", { exact: true }).inputValue(), "2026-09-05", "an open draft retains its chosen start date");
    await page.evaluate(() => { fixture.api.post = async () => { throw Error("Synthetic save rejection"); }; });
    await page.getByRole("button", { name: "Add student", exact: true }).click();
    await page.getByText("Synthetic save rejection", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Legal first name", { exact: false }).inputValue(), "Draft");
    await page.getByLabel("Legal first name", { exact: false }).press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Open form");
    await page.evaluate(() => fixture.root.unmount());
  } finally { await browser.close(); }
});

test("a confirmed old write cannot repopulate protected data after sign-out", async () => {
  const browser = await chromium.launch();
  try {
    const page = await fixturePage(browser);
    await page.evaluate(() => { fixture.save = fixture.store.updateLead("lead-1", { first_name: "Saved" }); });
    await page.waitForFunction(() => fixture.writes.length === 1);
    await page.evaluate(() => fixture.emit("SIGNED_OUT", null));
    await page.waitForFunction(() => !fixture.store.identityReady);
    await page.evaluate(() => fixture.writes[0].resolve({ ...fixture.lead, first_name: "Saved" }));
    await page.evaluate(() => fixture.save);
    assert.deepEqual(await page.evaluate(() => fixture.store.leads), []);
    assert.equal(await page.evaluate(() => fixture.store.currentStudioId), null);
    await page.evaluate(() => fixture.root.unmount());
  } finally { await browser.close(); }
});

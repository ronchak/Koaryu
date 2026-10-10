import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { bundle } from "./helpers/store-browser-harness.mjs";

const source = bundle("production", { identityLifecycle: true });
const previewSource = bundle("production", { identityLifecycle: true, preview: true });
const layoutSource = bundle("production", { identityLifecycle: true, layout: true });
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});
const flush = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
async function fixture({ view = "belt", layout = false, preview = false } = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  page.on("pageerror", (e) => console.error(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error(m.text());
  });
  await page.route("**/*", (route) =>
    route.request().url() === "http://fixture.local/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://fixture.local/");
  await page.evaluate(
    ({ view }) => {
      const f = (window.fixture = {
        view,
        pathname:
          view === "belt" ? "/belt-tracker" : view === "dashboard" ? "/dashboard" : "/reports",
        observations: [],
        identityObservations: [],
        reads: [],
        downloads: [],
        offers: [],
        urls: [],
        revoked: [],
        callbacks: new Set(),
        requests: [],
      });
      f.session = { access_token: "token-a", user: { id: "user-a", email: "a@example.test" } };
      f.auth = {
        user: { ...f.session.user, legal_first_name: "Test", legal_last_name: "Owner" },
        studio_id: "studio-a",
        role: "admin",
        membership_status: "active",
        staff_profiles_available: true,
      };
      f.ladders = ["A", "B"].map((id) => ({
        id,
        studio_id: "studio-a",
        name: id,
        created_at: "2026-01-01",
        is_active: true,
        is_primary: id === "A",
        ranks: [],
        sub_rank_term: "stripe",
      }));
      f.programs = ["A", "B"].map((id) => ({
        id: "program-" + id,
        name: id,
        belt_ladder_id: id,
        is_active: true,
        order_index: 0,
      }));
      f.supabase = {
        auth: {
          getSession: async () =>
            f.holdSession
              ? new Promise((resolve) => (f.sessions ??= []).push(resolve))
              : { data: { session: f.session } },
          onAuthStateChange: (callback) => {
            f.callbacks.add(callback);
            if (f.emitInitial) queueMicrotask(() => callback("INITIAL_SESSION", f.session));
            return {
              data: {
                subscription: {
                  unsubscribe() {
                    f.callbacks.delete(callback);
                  },
                },
              },
            };
          },
        },
      };
      f.emit = (event, session = f.session) => {
        f.session = session;
        for (const callback of [...f.callbacks]) callback(event, session);
      };
      f.rotate = (token) => f.emit("TOKEN_REFRESHED", { ...f.session, access_token: token });
      f.api = {
        get: async (path, token) => {
          f.requests.push({ path, token });
          if (path === "/auth/me") return structuredClone(f.auth);
          if (path === "/dashboard/workspace") {
            if (f.denyWorkspace)
              throw Object.assign(Error("Subscription required"), { status: 402 });
            const result = {
              auth: structuredClone(f.auth),
              studio: { name: "Studio", timezone: "UTC" },
            };
            if (f.holdWorkspace)
              return new Promise((resolve) => (f.workspaces ??= []).push(() => resolve(result)));
            return result;
          }
          if (path.startsWith("/dashboard/bootstrap"))
            return {
              auth: structuredClone(f.auth),
              studio_name: "Studio",
              students: [],
              leads: [],
              programs: f.programs,
              belt_ladders: f.ladders,
              primary_belt_ladder: f.ladders[0],
              summary: null,
            };
          if (path.startsWith("/belts/eligibility?"))
            return new Promise((resolve, reject) => f.reads.push({ path, token, resolve, reject }));
          if (path === "/belts/ladders") return f.ladders;
          if (path.startsWith("/schedule/window"))
            return { sessions: [], templates: [], attendance: [] };
          if (path.startsWith("/dashboard/summary")) return new Promise(() => {});
          if (path.startsWith("/programs")) return f.programs;
          if (path.startsWith("/students")) return [];
          if (path === "/leads") return [];
          throw Error(`Unexpected GET ${path}`);
        },
        post: async () => ({}),
        patch: async () => ({}),
        delete: async () => ({}),
      };
      window.fetch = async (url, options) => {
        if (url.includes("/belts/eligibility?"))
          return new Promise((resolve) =>
            f.reads.push({
              path: url,
              token: options.headers.Authorization.replace("Bearer ", ""),
              resolve: (rows) => resolve(new Response(JSON.stringify(rows), { status: 200 })),
              reject: () =>
                resolve(
                  new Response(
                    JSON.stringify({
                      detail: "Authentication token has expired",
                      error: { code: "unauthorized", status_code: 401 },
                    }),
                    { status: 401 },
                  ),
                ),
            }),
          );
        const d = { url, options };
        f.downloads.push(d);
        // The actual api.download waits for this body, with its real timeout/signal.
        return {
          ok: true,
          status: 200,
          headers: new Headers(
            f.noFilename ? {} : { "content-disposition": 'attachment; filename="fixture.csv"' },
          ),
          blob: () =>
            new Promise((resolve, reject) => {
              d.resolve = () => resolve(new Blob(["fixture"]));
              d.reject = reject;
              if (f.honorAbort)
                options.signal.addEventListener(
                  "abort",
                  () => reject(new DOMException("Aborted", "AbortError")),
                  { once: true },
                );
            }),
        };
      };
      URL.createObjectURL = (blob) => {
        f.urls.push(blob.size);
        return "blob:fixture";
      };
      URL.revokeObjectURL = (url) => f.revoked.push(url);
      HTMLAnchorElement.prototype.click = function () {
        f.offers.push(this.download);
      };
    },
    { view },
  );
  await page.addScriptTag({ content: preview ? previewSource : layout ? layoutSource : source });
  await page.waitForFunction(() => fixture.store?.identityReady);
  if (view === "belt" && !preview) await page.waitForFunction(() => fixture.reads.length === 1);
  return page;
}
async function settle(page, index = 0, { error = false, rows = [] } = {}) {
  await page.evaluate(
    ({ index, error, rows }) => {
      const r = fixture.reads[index];
      if (error) r.reject(Error("expired credential"));
      else r.resolve(rows);
    },
    { index, error, rows },
  );
  await flush(page);
}
async function startDownload(page) {
  await page.locator('[data-export-group="Owner Intelligence"] button').first().click();
  await page.waitForFunction(() => fixture.downloads.at(-1)?.resolve);
}
async function finishDownload(page, index = 0) {
  await page.evaluate((index) => fixture.downloads[index].resolve(), index);
  await flush(page);
}
for (const failure of [false, true])
  test(`eligibility replays rotated-token ${failure ? "failure" : "success"} through mounted Belt Tracker`, async () => {
    const page = await fixture();
    await page.evaluate(() => fixture.rotate("token-b"));
    await settle(page, 0, { error: failure });
    assert.equal(await page.evaluate(() => fixture.reads.length), 2);
    assert.equal(await page.evaluate(() => fixture.reads[1].token), "token-b");
    await settle(page, 1);
    assert.equal(await page.evaluate(() => fixture.store.eligibilityPendingLadderId), null);
    assert.equal(await page.getByText(/Loading eligibility for/).count(), 0);
    await page.close();
  });
test("eligibility ordinary error has actual Retry; bounded renewal exhaustion also settles", async () => {
  const page = await fixture();
  await settle(page, 0, { error: true });
  assert.equal(await page.evaluate(() => fixture.reads.length), 1);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  for (let n = 1; n <= 3; n++) {
    await page.evaluate((n) => fixture.rotate("token-" + n), n);
    await settle(page, n, { error: true });
    if (n < 3) assert.equal(await page.evaluate(() => fixture.reads.length), n + 2);
  }
  assert.equal(await page.evaluate(() => fixture.reads.length), 4);
  assert.match(
    await page.locator("#belt-panel-eligibility").innerText(),
    /Session changed repeatedly/,
  );
  assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 1);
  await page.close();
});
for (const failure of [false, true])
  test(`old A ${failure ? "failure" : "success"} cannot clear B pending or replay after supersession`, async () => {
    const page = await fixture();
    await page.evaluate(() => {
      fixture.rotate("token-b");
      void fixture.store.setCurrentLadder("B");
    });
    await flush(page);
    await settle(page, 0, { error: failure });
    assert.equal(await page.evaluate(() => fixture.store.eligibilityPendingLadderId), "B");
    assert.equal(await page.evaluate(() => fixture.reads.length), 2);
    await settle(page, 1);
    assert.equal(await page.evaluate(() => fixture.store.eligibilityLadderId), "B");
    await page.close();
  });
for (const change of ["panel", "layout", "remount", "renewal"])
  test(`authorized report survives ${change}`, async () => {
    const page = await fixture({ view: "reports", layout: true });
    await startDownload(page);
    await page.evaluate((change) => {
      if (change === "panel") fixture.panel(null);
      if (change === "layout" || change === "remount") fixture.layout(false);
      if (change === "renewal") fixture.rotate("token-b");
    }, change);
    await flush(page);
    if (change === "remount") {
      await page.evaluate(() => fixture.layout(true));
      await page.waitForFunction(() => fixture.store.identityReady);
      await flush(page);
    }
    await finishDownload(page);
    assert.deepEqual(await page.evaluate(() => fixture.offers), ["fixture.csv"]);
    assert.equal(await page.evaluate(() => fixture.revoked.length), 1);
    assert.equal(await page.locator("a[download]").count(), 0);
    assert.equal(await page.evaluate(() => fixture.callbacks.size), change === "layout" ? 0 : 1);
    await page.close();
  });
for (const change of ["signout", "user", "updated", "studio", "role", "access", "aba"])
  test(`report suppresses ${change} observed after layout unmount`, async () => {
    const page = await fixture({ view: "reports", layout: true });
    await startDownload(page);
    await page.evaluate(() => fixture.layout(false));
    await flush(page);
    await page.evaluate((change) => {
      if (change === "signout") fixture.emit("SIGNED_OUT", null);
      else if (change === "user")
        fixture.emit("SIGNED_IN", { ...fixture.session, user: { id: "user-b" } });
      else if (change === "updated") fixture.emit("USER_UPDATED");
      else {
        if (change === "studio" || change === "aba") fixture.auth.studio_id = "studio-b";
        if (change === "role") fixture.auth.role = "front_desk";
        if (change === "access") fixture.auth.membership_status = "archived";
        fixture.layout(true);
      }
    }, change);
    await flush(page);
    if (change === "aba") {
      await page.evaluate(() => fixture.layout(false));
      await flush(page);
      await page.evaluate(() => {
        fixture.auth.studio_id = "studio-a";
        fixture.layout(true);
      });
      await flush(page);
    }
    await finishDownload(page);
    assert.equal(await page.evaluate(() => fixture.urls.length), 0);
    assert.equal(
      await page.evaluate(() => fixture.callbacks.size),
      ["signout", "user", "updated"].includes(change) ? 0 : 1,
    );
    await page.close();
  });

const row = (name) => ({
  student_id: name,
  student_name: name,
  program_id: "program-A",
  classes_since_promo: 2,
  classes_required: 1,
  days_at_rank: 10,
  days_required: 2,
  classes_met: true,
  time_met: true,
  needs_approval: false,
  is_eligible: true,
});
test("cached eligibility revalidates across renewal and retains rows after ordinary failure; force retains rows and mutation invalidates", async () => {
  const page = await fixture();
  await settle(page, 0, { rows: [row("Initial")] });
  await page.evaluate(() => {
    void fixture.store.loadEligibilityForLadder("A");
  });
  await flush(page);
  assert.equal(await page.evaluate(() => fixture.store.eligibility[0].student_name), "Initial");
  assert.equal(await page.evaluate(() => fixture.store.eligibilityPendingLadderId), null);
  await page.evaluate(() => fixture.rotate("token-b"));
  await settle(page, 1, { error: true });
  await settle(page, 2, { rows: [row("Renewed")] });
  assert.equal(await page.evaluate(() => fixture.store.eligibility[0].student_name), "Renewed");
  await page.evaluate(() => {
    void fixture.store.loadEligibilityForLadder("A");
  });
  await settle(page, 3, { error: true });
  assert.equal(await page.evaluate(() => fixture.store.eligibility[0].student_name), "Renewed");
  assert.equal(await page.evaluate(() => fixture.store.eligibilityLoadError), null);
  await page.evaluate(() => {
    void fixture.store.loadEligibilityForLadder("A", { force: true }).catch(() => {});
  });
  await flush(page);
  assert.equal(await page.evaluate(() => fixture.store.eligibilityPendingLadderId), "A");
  assert.equal(await page.evaluate(() => fixture.store.eligibility[0].student_name), "Renewed");
  assert.equal(await page.evaluate(() => fixture.store.eligibilityLadderId), "A");
  await page.evaluate(() => {
    void fixture.store.bulkUpdateStudentStatus(["student"], "inactive", { refreshMode: "local" });
  });
  await flush(page);
  const current = await page.evaluate(() => fixture.reads.length - 1);
  await settle(page, 4, { rows: [row("Obsolete")] });
  assert.equal(
    await page.evaluate(() => fixture.store.eligibility.some((r) => r.student_name === "Obsolete")),
    false,
  );
  assert.equal(await page.evaluate(() => fixture.store.eligibilityPendingLadderId), "A");
  await settle(page, current, { rows: [row("After mutation")] });
  await page.close();
});
for (const change of ["user", "studio", "role", "updated", "subscription"])
  test(`eligibility replay cannot retry or settle across ${change}`, async () => {
    const page = await fixture();
    await page.evaluate(() => fixture.rotate("token-b"));
    await settle(page, 0, { error: true });
    await page.evaluate((change) => {
      if (change === "user") {
        fixture.auth.user.id = "user-b";
        fixture.emit("SIGNED_IN", { ...fixture.session, user: { id: "user-b" } });
      }
      if (change === "updated") fixture.emit("USER_UPDATED");
      if (change === "subscription") fixture.store.markSubscriptionRequired();
      if (change === "studio" || change === "role") {
        fixture.auth[change === "studio" ? "studio_id" : "role"] =
          change === "studio" ? "studio-b" : "instructor";
        window.dispatchEvent(new CustomEvent("koaryu:resume", { detail: { refreshData: false } }));
      }
    }, change);
    await flush(page);
    const count = await page.evaluate(() => fixture.reads.length);
    await settle(page, 1, { rows: [row("Obsolete")] });
    assert.equal(await page.evaluate(() => fixture.reads.length), count);
    assert.equal(
      await page.evaluate(() =>
        fixture.store.eligibility.some((r) => r.student_name === "Obsolete"),
      ),
      false,
    );
    if (change !== "subscription")
      assert.equal(await page.evaluate(() => fixture.store.eligibilityPendingLadderId), "A");
    await page.close();
  });
for (const failure of [false, true])
  test(`A renewal replay ${failure ? "failure" : "success"} stays obsolete after B selected`, async () => {
    const page = await fixture();
    await page.evaluate(() => fixture.rotate("token-b"));
    await settle(page, 0, { error: true });
    await page.evaluate(() => {
      fixture.rotate("token-c");
      void fixture.store.setCurrentLadder("B");
    });
    await flush(page);
    await settle(page, 1, { error: failure });
    assert.equal(await page.evaluate(() => fixture.reads.length), 3);
    assert.equal(await page.evaluate(() => fixture.store.eligibilityPendingLadderId), "B");
    await settle(page, 2);
    await page.close();
  });
test("Dashboard promotions_due owns lazy eligibility recovery", async () => {
  const page = await fixture({ view: "dashboard" });
  // The actual dashboard controller requests eligibility only for its visible widget.
  await page.waitForFunction(() => fixture.store.currentLadderId === "A");
  assert.equal(await page.evaluate(() => fixture.reads.length), 0);
  await page.evaluate(() =>
    fixture.dashboard.contentProps.onVisibleWidgetsChange(["promotions_due"]),
  );
  await flush(page);
  await page.evaluate(() => fixture.rotate("token-b"));
  await settle(page, 0, { error: true });
  await settle(page, 1);
  await page.waitForFunction(() => fixture.reads.length === 3);
  assert.equal(await page.evaluate(() => fixture.reads[2].token), "token-b");
  assert.equal(await page.evaluate(() => fixture.store.eligibilityPendingLadderId), "A");
  await settle(page, 2);
  assert.equal(await page.evaluate(() => fixture.store.eligibilityPendingLadderId), null);
  await page.close();
});
test("report invalidation after API resolution suppresses file even when abort cannot revoke the completed response", async () => {
  const page = await fixture({ view: "reports" });
  await page.evaluate(() => {
    const original = fixture.api.download;
    fixture.api.download = async (...args) => {
      const result = await original(...args);
      fixture.emit("USER_UPDATED");
      return result;
    };
  });
  await startDownload(page);
  await finishDownload(page);
  assert.equal(await page.evaluate(() => fixture.urls.length), 0);
  assert.equal(await page.evaluate(() => fixture.callbacks.size), 1);
  await page.close();
});
for (const failure of ["error", "timeout"])
  test(`report ${failure} cleans listeners and permits retry`, async () => {
    const page = await fixture({ view: "reports" });
    if (failure === "timeout") {
      await page.clock.install();
      await page.evaluate(() => (fixture.honorAbort = true));
    }
    await startDownload(page);
    assert.equal(await page.evaluate(() => fixture.callbacks.size), 2);
    if (failure === "timeout") await page.clock.fastForward(60001);
    else await page.evaluate(() => fixture.downloads[0].reject(Error("export failed")));
    if (failure === "timeout") await page.clock.resume();
    await flush(page);
    assert.equal(await page.evaluate(() => fixture.callbacks.size), 1);
    assert.match(
      await page.locator("[data-report-appendix]").innerText(),
      failure === "timeout" ? /taking longer/ : /export failed/,
    );
    await startDownload(page);
    await finishDownload(page, 1);
    assert.equal(await page.evaluate(() => fixture.offers.length), 1);
    await page.close();
  });
test("subscription invalidation suppresses old report error and leaves replacement identity usable", async () => {
  const page = await fixture({ view: "reports" });
  await startDownload(page);
  await page.evaluate(() => fixture.store.markSubscriptionRequired());
  await flush(page);
  await page.evaluate(() => fixture.emit("USER_UPDATED"));
  await flush(page);
  await page.waitForFunction(
    () => fixture.store.identityReady && !fixture.store.subscriptionRequired,
  );
  await startDownload(page);
  await page.evaluate(() => fixture.downloads[0].reject(Error("old private error")));
  await flush(page);
  assert.doesNotMatch(
    await page.locator("[data-report-appendix]").innerText(),
    /old private error/,
  );
  assert.equal(
    await page.locator('[data-export-group="Owner Intelligence"] button').first().isDisabled(),
    true,
  );
  await finishDownload(page, 1);
  assert.equal(await page.evaluate(() => fixture.offers.length), 1);
  assert.equal(await page.evaluate(() => fixture.callbacks.size), 1);
  await page.close();
});
test("report filename fallback, tenant header, unchanged INITIAL_SESSION and current role gates", async () => {
  const page = await fixture({ view: "reports" });
  await page.evaluate(() => (fixture.noFilename = true));
  await startDownload(page);
  await page.evaluate(() => fixture.emit("INITIAL_SESSION"));
  await finishDownload(page);
  assert.match(
    await page.evaluate(() => fixture.offers[0]),
    /^koaryu-owner-kpi-summary-\d{4}-\d{2}-\d{2}\.csv$/,
  );
  assert.equal(
    await page.evaluate(() => fixture.downloads[0].options.headers["X-Studio-Id"]),
    "studio-a",
  );
  await page.evaluate(() => {
    fixture.auth.role = "front_desk";
    fixture.emit("USER_UPDATED");
  });
  await flush(page);
  assert.equal(
    await page.locator('[data-export-group="Owner Intelligence"] button').first().isDisabled(),
    true,
  );
  assert.equal(
    await page.locator('[data-export-group="Programs and Ranks"] button').first().isDisabled(),
    false,
  );
  await page.close();
});
test("ordinary remount INITIAL_SESSION before getSession resolves preserves authorized report", async () => {
  const page = await fixture({ view: "reports", layout: true });
  await startDownload(page);
  await page.evaluate(() => fixture.layout(false));
  await flush(page);
  await page.evaluate(() => {
    fixture.holdSession = true;
    fixture.emitInitial = true;
    fixture.layout(true);
  });
  await flush(page);
  await finishDownload(page);
  assert.equal(await page.evaluate(() => fixture.offers.length), 1);
  await page.close();
});
test("unmounted provider's stale workspace result cannot publish over the current provider", async () => {
  const page = await fixture({ view: "reports", layout: true });
  await page.evaluate(() => fixture.layout(false));
  await flush(page);
  await page.evaluate(() => {
    fixture.holdWorkspace = true;
    fixture.auth.studio_id = "obsolete-studio";
    fixture.layout(true);
  });
  await flush(page);
  await page.waitForFunction(() => fixture.workspaces?.length === 1);
  await page.evaluate(() => fixture.layout(false));
  await flush(page);
  await page.evaluate(() => {
    fixture.holdWorkspace = false;
    fixture.auth.studio_id = "studio-a";
    fixture.layout(true);
  });
  await flush(page);
  await startDownload(page);
  await page.evaluate(() => fixture.workspaces[0]());
  await flush(page);
  await finishDownload(page);
  assert.equal(await page.evaluate(() => fixture.offers.length), 1);
  await page.close();
});
test("preview eligibility stays local and preview export refuses dispatch", async () => {
  const page = await fixture({ view: "belt", preview: true });
  await page.waitForFunction(
    () => fixture.store.currentLadderId && !fixture.store.eligibilityPendingLadderId,
  );
  assert.equal(await page.evaluate(() => fixture.reads.length), 0);
  await page.evaluate(() => fixture.panel("reports"));
  await flush(page);
  assert.equal(
    await page.locator('[data-export-group="Owner Intelligence"] button').first().isDisabled(),
    true,
  );
  assert.equal(await page.evaluate(() => fixture.downloads.length), 0);
  await page.close();
});
test("null ladder clears pending without allowing older eligibility to commit", async () => {
  const page = await fixture();
  await page.evaluate(() => {
    fixture.pathname = "/reports";
    window.dispatchEvent(new Event("fixture:navigate"));
    fixture.panel(null);
  });
  await flush(page);
  await page.evaluate(() => fixture.store.loadEligibilityForLadder(null));
  await settle(page, 0, { rows: [row("Obsolete")] });
  assert.equal(await page.evaluate(() => fixture.store.eligibilityPendingLadderId), null);
  assert.equal(await page.evaluate(() => fixture.store.eligibility.length), 0);
  await page.close();
});
test("missing token refuses actual export dispatch", async () => {
  const page = await fixture({ view: "reports" });
  await page.evaluate(() => {
    fixture.missingToken = true;
    fixture.panel(null);
  });
  await flush(page);
  await page.evaluate(() => fixture.panel("reports"));
  await flush(page);
  await page.locator('[data-export-group="Owner Intelligence"] button').first().click();
  assert.equal(await page.evaluate(() => fixture.downloads.length), 0);
  assert.match(await page.locator("[data-report-appendix]").innerText(), /Sign in again/);
  await page.close();
});
test("actual subscription-required bootstrap cannot grant a new report lifetime from auth profile alone", async () => {
  const page = await fixture({ view: "reports" });
  await page.evaluate(() => {
    fixture.denyWorkspace = true;
    fixture.emit("USER_UPDATED");
  });
  await page.waitForFunction(
    () => fixture.store.subscriptionRequired && fixture.store.identityReady,
  );
  await page.locator('[data-export-group="Owner Intelligence"] button').first().click();
  assert.equal(await page.evaluate(() => fixture.downloads.length), 0);
  // An off-dashboard profile observation must not re-grant known denied access.
  await page.evaluate(() => fixture.publishAccessIdentity(fixture.auth));
  await page.locator('[data-export-group="Owner Intelligence"] button').first().click();
  assert.equal(await page.evaluate(() => fixture.downloads.length), 0);
  await page.close();
});
test("stale rendered report scope cannot borrow a newly published identity", async () => {
  const page = await fixture({ view: "reports" });
  await page.evaluate(() =>
    fixture.publishAccessIdentity({ ...fixture.auth, studio_id: "other-studio" }, true),
  );
  await page.locator('[data-export-group="Owner Intelligence"] button').first().click();
  assert.equal(await page.evaluate(() => fixture.downloads.length), 0);
  assert.match(await page.locator("[data-report-appendix]").innerText(), /Sign in again/);
  await page.close();
});

test("forced and resume eligibility reads retain the current ladder until atomic replacement", async () => {
  const page = await fixture();
  await settle(page, 0, { rows: [row("Visible")] });
  await page.evaluate(() => {
    void fixture.store.loadEligibilityForLadder("A", { force: true });
  });
  await flush(page);
  assert.equal(await page.evaluate(() => fixture.store.eligibility[0].student_name), "Visible");
  assert.equal(await page.evaluate(() => fixture.store.eligibilityPendingLadderId), "A");
  await settle(page, 1, { rows: [row("Fresh")] });
  assert.equal(await page.evaluate(() => fixture.store.eligibility[0].student_name), "Fresh");
  await page.evaluate(() => window.dispatchEvent(new Event("koaryu:resume")));
  await page.waitForFunction(() => fixture.reads.length === 3);
  assert.equal(await page.evaluate(() => fixture.store.eligibility[0].student_name), "Fresh");
  assert.equal(await page.evaluate(() => fixture.store.eligibilityPendingLadderId), "A");
  await settle(page, 2, { rows: [] });
  await page.waitForFunction(() => fixture.reads.length === 4);
  await settle(page, 3, { rows: [] });
  await page.evaluate(() => {
    void fixture.store.loadEligibilityForLadder("A", { force: true });
  });
  await flush(page);
  assert.equal(await page.evaluate(() => fixture.store.eligibilityLadderId), "A");
  assert.equal(await page.evaluate(() => fixture.store.eligibility.length), 0);
  await settle(page, 4, { rows: [row("After empty")] });
  assert.equal(await page.evaluate(() => fixture.store.eligibility[0].student_name), "After empty");
  await page.close();
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { bundle } from "./helpers/store-browser-harness.mjs";

// Real page, controller, store actions and edit controls. Only auth, API,
// unrelated eligibility presentation, CSS and decorative icons are replaced.
async function mountEditor(browser, { emptyFirst = true, mode = "production" } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.request().url() === "http://localhost/"
    ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
    : route.abort());
  await page.goto("http://localhost/");
  await page.evaluate(({ emptyFirst }) => {
    const f = window.fixture = {
      pathname: "/belt-tracker", requests: [], observations: [], writes: [],
      holdSave: false, failSave: false, failRefresh: false, receipts: {},
    };
    f.session = { access_token: "synthetic-a", user: { id: "user-a", email: "owner@example.test" } };
    f.auth = { user: f.session.user, studio_id: "studio-a", membership_status: "active", role: "admin", staff_profiles_available: true };
    f.programs = ["A", "B"].map(name => ({ id: `program-${name}`, studio_id: "studio-a", name, color_hex: "#ffffff", is_system: false, archived_at: null }));
    f.ladders = ["A", "B"].map(name => ({
      id: `ladder-${name}`, program_id: `program-${name}`, studio_id: "studio-a", name,
      created_at: "2026-09-01T00:00:00Z", is_default: name === "A",
      sub_rank_term: name === "A" ? "Stripe" : "Tip",
      ranks: name === "A" && emptyFirst ? [] : ["White", "Blue"].map((color, index) => ({
        id: `${name}-${color}`, ladder_id: `ladder-${name}`, studio_id: "studio-a",
        name: `${color} ${name}`, color_hex: "#ffffff", is_tip: false,
        min_classes: 0, min_months: 0, requires_approval: false, display_order: index,
        created_at: "2026-09-01T00:00:00Z",
      })),
    }));
    f.supabase = { auth: {
      getSession: async () => ({ data: { session: f.session } }),
      onAuthStateChange: callback => {
        f.emit = (event, session) => { f.session = session; callback(event, session); };
        return { data: { subscription: { unsubscribe() {} } } };
      },
    } };
    f.api = {
      get: async (path, token) => {
        f.requests.push({ path, token });
        if (path === "/dashboard/workspace") return { auth: f.auth, studio: { name: "Synthetic", timezone: "UTC" } };
        if (path.startsWith("/dashboard/bootstrap")) return {
          auth: f.auth, studio_name: "Synthetic", programs: f.programs, belt_ladders: f.ladders,
          primary_belt_ladder: f.ladders[0], students: [], leads: [],
        };
        if (path.startsWith("/programs")) return f.programs;
        if (path === "/belts/ladders") return f.ladders;
        if (path.startsWith("/belts/eligibility")) {
          if (f.failRefresh) throw Error("Eligibility unavailable");
          return [];
        }
        if (path.startsWith("/students?")) return { items: [], total: 0, has_next: false, has_previous: false, page_size: 200, page_ordinal: 1 };
        if (path.startsWith("/schedule/window")) return { sessions: [], templates: [], attendance: [] };
        throw Error(`Unexpected read ${path}`);
      },
      post: async (path, body, token) => {
        if (path.startsWith("/schedule/window")) return { sessions: [], templates: [], attendance: [] };
        if (!path.endsWith("/sync")) throw Error(`Unexpected write ${path}`);
        f.writes.push({ path, body: structuredClone(body), token });
        if (f.holdSave) await new Promise(resolve => { f.releaseSave = resolve; });
        if (f.failSave) throw Object.assign(Error("Rejected rank plan"), { status: 400 });
        if (f.receipts[body.operation_id]) return f.receipts[body.operation_id];
        const ladder = f.ladders.find(row => path === `/belts/ladders/${row.id}/sync`);
        if (!ladder) throw Error("Unexpected ladder");
        ladder.ranks = body.ranks.map((rank, index) => ({ ...rank, id: rank.id ?? `saved-${index}`, ladder_id: ladder.id, studio_id: "studio-a" }));
        ladder.sub_rank_term = body.sub_rank_term;
        const result = structuredClone(ladder);
        f.receipts[body.operation_id] = result;
        return result;
      },
    };
  }, { emptyFirst });
  await page.addScriptTag({ content: bundle(mode, { beltPage: "editor" }) });
  try {
    await page.waitForFunction(() => fixture.store?.identityReady && fixture.store.programsLoaded, undefined, { timeout: 5000 });
  } catch (error) {
    throw new Error(JSON.stringify({ errors, state: await page.evaluate(() => ({ requests: fixture.requests, observations: fixture.observations, body: document.body.innerText })) }), { cause: error });
  }
  await page.getByRole("tab", { name: "Rank Plan" }).click();
  assert.deepEqual(errors, []);
  return page;
}

async function changeTerm(page, term) {
  await page.getByRole("button", { name: "Edit sub-rank term" }).click();
  await page.getByRole("textbox", { name: "Sub-rank term" }).fill(term);
  await page.getByRole("button", { name: "Save", exact: true }).click();
}

for (const mode of ["production", "development"]) {
  test(`rank edits preserve the selected ladder's whole draft (${mode})`, async () => {
    const browser = await chromium.launch();
    try {
      const page = await mountEditor(browser, { mode });
      await page.getByLabel("Program", { exact: true }).selectOption("program-B");
      await expect(page.getByRole("button", { name: "Edit White B", exact: true })).toBeVisible();
      await changeTerm(page, "Degree");
      await page.getByRole("button", { name: "Save ranks", exact: true }).click();
      await expect(page.getByText("Program ranks saved.", { exact: true })).toBeVisible();
      const first = await page.evaluate(() => fixture.writes[0]);
      assert.equal(first.path, "/belts/ladders/ladder-B/sync");
      assert.deepEqual(first.body.ranks.map(rank => rank.id), ["B-White", "B-Blue"]);
      assert.equal(first.body.sub_rank_term, "Degree");

      await page.getByRole("button", { name: "Move Blue B up", exact: true }).click();
      await page.getByRole("button", { name: "Save ranks", exact: true }).click();
      await page.waitForFunction(() => fixture.writes.length === 2 && fixture.store.beltRanks[0]?.id === "B-Blue");
      const second = await page.evaluate(() => fixture.writes[1]);
      assert.deepEqual(second.body.ranks.map(rank => rank.id), ["B-Blue", "B-White"]);
      assert.equal(second.body.sub_rank_term, "Degree");
      await page.close();

      const populated = await mountEditor(browser, { emptyFirst: false, mode });
      await populated.getByLabel("Program", { exact: true }).selectOption("program-B");
      await populated.getByRole("button", { name: "Move Blue B up", exact: true }).click();
      await populated.getByRole("button", { name: "Save ranks", exact: true }).click();
      await expect(populated.getByText("Program ranks saved.", { exact: true })).toBeVisible();
      assert.equal(await populated.evaluate(() => fixture.writes[0].body.sub_rank_term), "Tip");
    } finally { await browser.close(); }
  });
}

test("a pending rank save owns editing and survives credential renewal", async () => {
  const browser = await chromium.launch();
  try {
    const page = await mountEditor(browser, { emptyFirst: false });
    await changeTerm(page, "Degree");
    await page.evaluate(() => { fixture.holdSave = true; });
    await page.getByRole("button", { name: "Save ranks", exact: true }).click();
    await page.waitForFunction(() => fixture.writes.length === 1);
    for (const name of ["Add belt", "Edit sub-rank term", "Edit White A", "Delete White A", "Move Blue A up", "Discard"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
    }
    for (const button of await page.getByRole("button", { name: "Add degree", exact: true }).all()) {
      await expect(button).toBeDisabled();
    }
    await expect(page.getByLabel("Program", { exact: true })).toBeDisabled();
    assert.equal(await page.locator('[data-belt-drag-handle="A-Blue"]').getAttribute("draggable"), "false");
    // A queued drop may still be delivered after dragging was disabled.
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await page.locator('[data-belt-drag-handle="A-Blue"]').dispatchEvent("dragstart", { dataTransfer });
    await page.locator('[data-belt-drag-handle="A-White"]').locator("..").dispatchEvent("drop");
    await page.evaluate(() => fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "synthetic-renewed" }));
    await page.waitForFunction(() => fixture.store.token === "synthetic-renewed");
    await page.evaluate(() => { fixture.holdSave = false; fixture.releaseSave(); });
    await expect(page.getByText("Program ranks saved.", { exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => fixture.store.subRankTerm), "Degree");
    assert.deepEqual(await page.evaluate(() => fixture.store.beltRanks.map(rank => rank.id)), ["A-White", "A-Blue"]);
    assert.equal(await page.evaluate(() => fixture.writes.length), 1);
    await expect(page.getByRole("button", { name: "Save ranks", exact: true })).toHaveCount(0);

    await changeTerm(page, "Level");
    await page.evaluate(() => { fixture.holdSave = true; });
    await page.getByRole("button", { name: "Save ranks", exact: true }).click();
    await page.waitForFunction(() => fixture.writes.length === 2);
    await page.evaluate(() => fixture.emit("SIGNED_OUT", null));
    await page.waitForFunction(() => fixture.store.currentStudioId === null);
    await page.evaluate(() => { fixture.holdSave = false; fixture.releaseSave(); });
    await page.waitForFunction(() => Object.keys(fixture.receipts).length === 2);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await page.evaluate(() => fixture.store.beltRanks), [], "a previous identity's acknowledged save cannot restore private state");
    assert.equal(await page.evaluate(() => fixture.store.currentStudioId), null);
    assert.equal(await page.evaluate(() => fixture.writes.length), 2);
  } finally { await browser.close(); }
});

test("rejected saves retain the draft, while committed refresh failures do not invite another save", async () => {
  const browser = await chromium.launch();
  try {
    const page = await mountEditor(browser, { emptyFirst: false });
    await changeTerm(page, "Degree");
    await page.evaluate(() => { fixture.failSave = true; });
    await page.getByRole("button", { name: "Save ranks", exact: true }).click();
    await expect(page.getByText("Could not save ladder changes. Please try again.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save ranks", exact: true })).toBeEnabled();
    assert.equal(await page.getByRole("button", { name: "Edit sub-rank term" }).innerText(), "Degree");
    assert.equal(await page.evaluate(() => fixture.store.subRankTerm), "Stripe");

    await page.evaluate(() => { fixture.failSave = false; fixture.failRefresh = true; });
    await page.getByRole("button", { name: "Save ranks", exact: true }).click();
    await expect(page.getByText("Program ranks saved. Refresh needed to show the latest student ranks.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save ranks", exact: true })).toHaveCount(0);
    assert.equal(await page.evaluate(() => fixture.store.subRankTerm), "Degree");
    assert.equal(await page.evaluate(() => fixture.writes.length), 2);

    const before = await page.evaluate(() => fixture.writes.length);
    const error = await page.evaluate(async () => {
      try {
        await fixture.store.setBeltRanks([], { ladderId: "ladder-B", subRankTerm: "Wrong" });
      } catch (error) { return error.message; }
    });
    assert.match(error, /selected program changed/i);
    assert.equal(await page.evaluate(() => fixture.writes.length), before, "a stale draft target must be rejected before transport");
  } finally { await browser.close(); }
});

test("Add Belt cannot offer a sub-rank and an open edit blocks program switching", async () => {
  const browser = await chromium.launch();
  try {
    const page = await mountEditor(browser);
    await page.getByRole("button", { name: "Add belt", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel("Program", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Stripe", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByLabel("Program", { exact: true })).toBeEnabled();
  } finally { await browser.close(); }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { bundle } from "./helpers/store-browser-harness.mjs";

const source = bundle("production", { realApi: true });

async function mountedRankFixture(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.route("**/*", (route) =>
    route.request().url() === "https://fixture.local/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("https://fixture.local/");
  await page.evaluate(() => {
    const f = (window.fixture = {
      observations: [],
      requests: [],
      writes: [],
      ladderReads: [],
    });
    f.session = {
      access_token: "token-a",
      user: {
        id: "actor-a",
        email: "actor-a@example.test",
        legal_first_name: "Test",
        legal_last_name: "Actor",
      },
    };
    f.auth = {
      user: f.session.user,
      studio_id: "studio-a",
      role: "admin",
      membership_status: "active",
      staff_profiles_available: true,
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
    f.promotion = (id, operationId, kind = "promotion") => ({
      id,
      studio_id: f.auth.studio_id,
      student_id: "student",
      operation_id: operationId,
      transition_kind: kind,
      from_rank_id: null,
      to_rank_id: null,
      promoted_by: f.auth.user.id,
      promoted_at: "2026-09-20T00:00:00Z",
      from_rank_name: "White",
      to_rank_name: "Yellow",
    });
    window.fetch = async (url, options = {}) => {
      const parsed = new URL(url, location.href);
      const path = parsed.pathname.replace(/^\/api\/v1/, "");
      const method = options.method ?? "GET";
      const token = new Headers(options.headers).get("Authorization")?.replace("Bearer ", "");
      f.requests.push({ path, method, token });
      if (method === "POST" && ["/belts/promote", "/belts/demote"].includes(path)) {
        const body = JSON.parse(options.body);
        return new Promise((resolve) => f.writes.push({ body, path, token, resolve }));
      }
      if (path === "/belts/promotions")
        return Response.json([f.promotion("existing", "existing-operation")]);
      if (path === "/dashboard/workspace")
        return Response.json({
          auth: f.auth,
          studio: { name: "Test Studio", timezone: "UTC" },
        });
      if (path === "/dashboard/bootstrap")
        return Response.json({
          auth: f.auth,
          studio_name: "Test Studio",
          students: [],
          leads: [],
          programs: [],
          belt_ladders: [],
          primary_belt_ladder: null,
          summary: { auth: f.auth, students: { total: 0 } },
        });
      if (path === "/students")
        return Response.json({
          items: [],
          has_next: false,
          page_ordinal: 1,
          page_size: 200,
          total: 0,
        });
      if (path === "/belts/ladders") {
        if (f.holdLadders) return new Promise((resolve) => f.ladderReads.push({ token, resolve }));
        return Response.json([]);
      }
      if (path === "/programs") return Response.json([]);
      if (path === "/dashboard/summary")
        return Response.json({ auth: f.auth, students: { total: 0 } });
      if (path === "/schedule/window")
        return Response.json({ sessions: [], templates: [], attendance: [] });
      throw new Error(`Unexpected ${method} ${path}`);
    };
  });
  await page.addScriptTag({ content: source });
  await page.waitForFunction(
    () =>
      fixture.store?.identityReady && fixture.store.studentsLoaded && fixture.store.programsLoaded,
  );
  return page;
}

test("real rank commands keep known conflicts separate from unknown-result recovery", async () => {
  const browser = await chromium.launch();
  try {
    for (const kind of ["promotion", "demotion"]) {
      for (const status of [409, 500]) {
        const page = await browser.newPage();
        page.setDefaultTimeout(6000);
        try {
          await page.route("**/*", (route) =>
            route.request().url() === "https://fixture.local/"
              ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
              : route.abort(),
          );
          await page.goto("https://fixture.local/");
          await page.evaluate(
            ({ kind, status }) => {
              const user = {
                id: "actor",
                email: "actor@example.test",
                legal_first_name: "Test",
                legal_last_name: "Actor",
              };
              const session = { access_token: "token", user };
              const auth = {
                user,
                studio_id: "studio",
                role: "admin",
                membership_status: "active",
                staff_profiles_available: true,
              };
              const f = (window.fixture = {
                observations: [],
                requests: [],
                operationId: null,
                kind,
                status,
              });
              f.supabase = {
                auth: {
                  getSession: async () => ({ data: { session } }),
                  onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
                },
              };
              window.fetch = async (url, options = {}) => {
                const path = new URL(url, location.href).pathname.replace(/^\/api\/v1/, "");
                const method = options.method ?? "GET";
                f.requests.push({ path, method });
                if (method === "POST" && ["/belts/promote", "/belts/demote"].includes(path)) {
                  f.operationId = JSON.parse(options.body).operation_id;
                  return Response.json(
                    {
                      detail:
                        status === 409
                          ? "This rank change could not be verified against the recorded history. Check the student's history before trying again."
                          : "Internal server error.",
                      error: {
                        code: status === 409 ? "conflict" : "internal_server_error",
                        status_code: status,
                      },
                    },
                    { status },
                  );
                }
                // This same-operation trap would turn an incorrectly classified conflict into success.
                if (path === "/belts/promotions")
                  return Response.json([
                    {
                      id: "recorded-transition",
                      studio_id: "studio",
                      student_id: "student",
                      operation_id: f.operationId,
                      transition_kind: kind,
                      from_rank_id: null,
                      to_rank_id: null,
                      promoted_by: null,
                      promoted_at: "2026-09-08T00:00:00Z",
                      from_rank_name: "White",
                      to_rank_name: "Yellow",
                    },
                  ]);
                if (path === "/dashboard/workspace")
                  return Response.json({ auth, studio: { name: "Test Studio", timezone: "UTC" } });
                if (path === "/dashboard/bootstrap")
                  return Response.json({
                    auth,
                    studio_name: "Test Studio",
                    students: [],
                    leads: [],
                    programs: [],
                    belt_ladders: [],
                    primary_belt_ladder: null,
                    summary: { auth, students: { total: 0 } },
                  });
                if (path === "/dashboard/summary")
                  return Response.json({ auth, students: { total: 0 } });
                if (path === "/students")
                  return Response.json({
                    items: [],
                    has_next: false,
                    page_ordinal: 1,
                    page_size: 200,
                    total: 0,
                  });
                if (["/belts/ladders", "/programs"].includes(path)) return Response.json([]);
                if (path === "/schedule/window")
                  return Response.json({ sessions: [], templates: [], attendance: [] });
                throw new Error(`Unexpected ${method} ${path}`);
              };
            },
            { kind, status },
          );
          await page.addScriptTag({ content: source });
          await page.waitForFunction(
            () =>
              fixture.store?.identityReady &&
              fixture.store.studentsLoaded &&
              fixture.store.programsLoaded,
          );
          const result = await page.evaluate(async () => {
            fixture.requests = [];
            const payload = { student_id: "student", to_rank_id: "target" };
            try {
              const row =
                fixture.kind === "promotion"
                  ? await fixture.store.promoteStudent({ ...payload, notes: null })
                  : await fixture.store.demoteStudent({ ...payload, reason: "Correction" });
              return { ok: true, id: row.id };
            } catch (error) {
              return { ok: false, name: error.name, status: error.status, message: error.message };
            }
          });
          const requests = await page.evaluate(() => fixture.requests);
          assert.equal(
            requests.filter((r) => r.method === "POST").length,
            1,
            `${kind}/${status}: ${JSON.stringify(result)}`,
          );
          assert.equal(
            requests.filter((r) => r.path === "/belts/promotions").length,
            status === 409 ? 0 : 1,
          );
          if (status === 409) {
            assert.equal(result.ok, false);
            assert.equal(result.status, 409);
            assert.equal(
              result.message,
              "This rank change could not be verified against the recorded history. Check the student's history before trying again.",
            );
            assert.equal(
              requests.filter((r) => ["/students", "/belts/ladders"].includes(r.path)).length,
              0,
            );
          } else assert.deepEqual(result, { ok: true, id: "recorded-transition" });
          await page.evaluate(() => fixture.root.unmount());
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
});

test("confirmed promotion and demotion settle through renewal and reconcile with current credentials", async () => {
  const browser = await chromium.launch();
  try {
    for (const kind of ["promotion", "demotion"]) {
      const page = await mountedRankFixture(browser);
      try {
        await page.evaluate(() => fixture.store.loadPromotionHistory("student"));
        await page.evaluate((kind) => {
          fixture.requests = [];
          fixture.holdLadders = true;
          const payload = { student_id: "student", to_rank_id: "target" };
          fixture.transition = (
            kind === "promotion"
              ? fixture.store.promoteStudent({ ...payload, notes: null })
              : fixture.store.demoteStudent({ ...payload, reason: "Correction" })
          ).then(
            (row) => ({ ok: true, id: row.id }),
            (error) => ({ ok: false, message: error.message }),
          );
        }, kind);
        await page.waitForFunction(() => fixture.writes.length === 1);
        await page.evaluate(() =>
          fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "token-b" }),
        );
        await page.waitForFunction(() => fixture.store.token === "token-b");
        await page.evaluate((kind) => {
          const write = fixture.writes[0];
          write.resolve(
            Response.json(fixture.promotion("confirmed", write.body.operation_id, kind)),
          );
        }, kind);
        await page.waitForFunction(() => fixture.ladderReads.length === 1);
        await page.evaluate(() =>
          fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "token-c" }),
        );
        await page.waitForFunction(() => fixture.store.token === "token-c");
        await page.evaluate(() => fixture.ladderReads[0].resolve(Response.json([])));
        await page.waitForFunction(() => fixture.ladderReads.length === 2);
        await page.evaluate(() => fixture.ladderReads[1].resolve(Response.json([])));

        assert.deepEqual(await page.evaluate(() => fixture.transition), {
          ok: true,
          id: "confirmed",
        });
        assert.equal(await page.evaluate(() => fixture.writes.length), 1);
        assert.deepEqual(await page.evaluate(() => fixture.ladderReads.map((read) => read.token)), [
          "token-b",
          "token-c",
        ]);
        assert.deepEqual(
          (await page.evaluate(() => fixture.requests))
            .filter((request) => request.path === "/students")
            .map((request) => request.token),
          ["token-b"],
        );
        assert.deepEqual(
          await page.evaluate(() =>
            fixture.store.promotionHistoryByStudent.student.map((row) => row.id),
          ),
          ["confirmed", "existing"],
        );
        assert.equal(
          await page.evaluate(
            (kind) => sessionStorage.getItem(`koaryu:pending-rank-transition:${kind}:student`),
            kind,
          ),
          null,
        );
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test("identity resets cannot recover old rank writes or clear a replacement receipt", async () => {
  const browser = await chromium.launch();
  try {
    for (const [kind, reset] of [
      ["promotion", "SIGNED_OUT"],
      ["demotion", "USER_UPDATED"],
    ]) {
      for (const outcome of ["confirmed", "unknown500"]) {
        const page = await mountedRankFixture(browser);
        try {
          await page.evaluate((kind) => {
            fixture.requests = [];
            const payload = { student_id: "student", to_rank_id: "target" };
            fixture.transition = (
              kind === "promotion"
                ? fixture.store.promoteStudent({ ...payload, notes: null })
                : fixture.store.demoteStudent({ ...payload, reason: "Correction" })
            ).then(
              (row) => ({ ok: true, id: row.id }),
              (error) => ({ ok: false, message: error.message }),
            );
          }, kind);
          await page.waitForFunction(() => fixture.writes.length === 1);
          if (reset === "SIGNED_OUT") {
            await page.evaluate(() => fixture.emit("SIGNED_OUT", null));
            await page.waitForFunction(() => fixture.store.currentStudioId === null);
          } else {
            await page.evaluate(() => {
              fixture.auth = {
                ...fixture.auth,
                user: {
                  id: "actor-b",
                  email: "actor-b@example.test",
                  legal_first_name: "New",
                  legal_last_name: "Actor",
                },
                studio_id: "studio-b",
              };
              fixture.emit("USER_UPDATED", {
                access_token: "token-b",
                user: fixture.auth.user,
              });
            });
            await page.waitForFunction(
              () => fixture.store.identityReady && fixture.store.currentStudioId === "studio-b",
            );
          }
          await page.evaluate(
            ({ kind, outcome }) => {
              sessionStorage.setItem(
                `koaryu:pending-rank-transition:${kind}:student`,
                JSON.stringify({
                  fingerprint: "replacement",
                  operationId: "replacement-operation",
                }),
              );
              fixture.settlementRequestIndex = fixture.requests.length;
              const response =
                outcome === "confirmed"
                  ? Response.json(
                      fixture.promotion(
                        "confirmed-after-reset",
                        fixture.writes[0].body.operation_id,
                        kind,
                      ),
                    )
                  : Response.json(
                      { detail: "Internal server error", error: { status_code: 500 } },
                      { status: 500 },
                    );
              fixture.writes[0].resolve(response);
            },
            { kind, outcome },
          );
          const transition = await page.evaluate(() => fixture.transition);
          if (outcome === "confirmed") {
            assert.deepEqual(transition, { ok: true, id: "confirmed-after-reset" });
          } else {
            assert.equal(transition.ok, false);
            assert.match(transition.message, /confirmation was lost/);
          }
          assert.deepEqual(
            await page.evaluate(() =>
              fixture.requests
                .slice(fixture.settlementRequestIndex)
                .filter((request) =>
                  ["/belts/promotions", "/students", "/belts/ladders"].includes(request.path),
                ),
            ),
            [],
          );
          assert.deepEqual(await page.evaluate(() => fixture.store.promotionHistoryByStudent), {});
          assert.equal(
            await page.evaluate(
              (kind) =>
                JSON.parse(sessionStorage.getItem(`koaryu:pending-rank-transition:${kind}:student`))
                  .operationId,
              kind,
            ),
            "replacement-operation",
          );
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
});

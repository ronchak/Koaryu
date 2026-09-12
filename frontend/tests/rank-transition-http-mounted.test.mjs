import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { bundle } from "./helpers/store-browser-harness.mjs";

const source = bundle("production", { realApi: true });

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

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { bundleActivity, ids, JOURNAL } from "./helpers/workflow-activity-fixture.mjs";

const flush = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
async function mount(run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
    );
    await page.goto("http://localhost/");
    await page.addScriptTag({ content: bundleActivity() });
    await flush(page);
    await page.evaluate(() => window.fixture.ready);
    await run(page);
    assert.deepEqual(errors, []);
    assert.ok(await page.evaluate(() => window.fixture.renders < 40));
  } finally {
    await browser.close();
  }
}
const start = (page) =>
  page.evaluate(() => {
    const f = window.fixture;
    f.pending = f.workspace.activity.createTest(
      f.detail.id,
      f.detail.draft_graph,
      "hasOwnProperty",
    );
  });
const rendered = async (page) => JSON.parse(await page.locator("[data-activity]").textContent());

test("real mounted activity subscription renders child transitions and preserves owner on remount/token renewal", async () =>
  mount(async (page) => {
    await start(page);
    await flush(page);
    assert.equal((await rendered(page)).operations[0].status, "submitting");
    await page.evaluate(() => {
      const f = window.fixture;
      f.first = f.workspace;
      f.oldView = [...f.workspace.activity.getSnapshot().operations.values()][0];
      f.workspace.activity.getSnapshot().operations.clear();
      f.unmount();
    });
    await flush(page);
    await page.evaluate(() => {
      const f = window.fixture;
      f.token = "token-2";
      const { userId, studioId, role } = f.scope;
      f.scope = { role, studioId, userId };
      for (const callback of f.auth) callback("TOKEN_REFRESHED", { user: { id: userId } });
      f.mount();
    });
    await flush(page);
    await page.evaluate(() => window.fixture.ready);
    await start(page);
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 1);
    assert.equal(
      await page.evaluate(() => window.fixture.first === window.fixture.workspace),
      true,
    );
    await page.evaluate(async () => {
      const f = window.fixture,
        request = f.requests[0];
      request.resolve({ ...f.delivery, operation_id: request.body.operation_id, state: "queued" });
      await f.pending;
    });
    await flush(page);
    assert.equal((await rendered(page)).operations[0].current.state, "queued");
    assert.equal(
      await page.evaluate(
        () =>
          window.fixture.workspace.activity.pendingOperation({
            kind: "test",
            workflowId: window.fixture.detail.id,
          }).locked,
      ),
      true,
    );
    await page.evaluate(async () => {
      const f = window.fixture,
        operationId = f.requests[0].body.operation_id;
      f.receipt.operation_id = operationId;
      f.receipt.result.operation_id = operationId;
      f.delivery.operation_id = operationId;
      await f.workspace.activity.checkResult({ kind: "test", workflowId: f.detail.id });
    });
    await flush(page);
    assert.equal((await rendered(page)).operations[0].current.state, "accepted");
    assert.equal(await page.evaluate(() => window.fixture.reads.at(-1).token), "token-2");
    assert.equal(await page.evaluate(() => window.fixture.auth.size), 1);
  }));

test("real user/studio/role/entitlement ABA fences late mutation and separate owner re-adopts only its marker", async () => {
  for (const change of ["user", "studio", "role", "entitlement"])
    await mount(async (page) => {
      await start(page);
      await page.evaluate((change) => {
        const f = window.fixture;
        f.previous = f.workspace;
        f.oldView = [...f.workspace.activity.getSnapshot().operations.values()][0];
        const patches = {
          user: { user: { id: "50000000-0000-4000-8000-000000000001" } },
          studio: { studio_id: "50000000-0000-4000-8000-000000000001" },
          role: { role: "front_desk" },
          entitlement: { accessAllowed: false },
        };
        f.publish(patches[change]);
      }, change);
      await flush(page);
      assert.equal((await rendered(page)).operations.length, 0);
      await page.evaluate(() => {
        const f = window.fixture;
        f.publish({
          user: { id: f.scope.userId },
          studio_id: f.scope.studioId,
          role: "admin",
          accessAllowed: true,
        });
        f.mount();
      });
      await flush(page);
      await page.evaluate(() => window.fixture.ready);
      assert.equal(
        await page.evaluate(() => window.fixture.previous === window.fixture.workspace),
        false,
      );
      assert.equal((await rendered(page)).operations[0].status, "unknown");
      await page.evaluate(async () => {
        const f = window.fixture,
          request = f.requests[0];
        request.resolve({ ...f.delivery, operation_id: request.body.operation_id });
        await f.pending;
      });
      await flush(page);
      assert.equal((await rendered(page)).operations[0].status, "unknown");
      assert.equal(await page.evaluate(() => window.fixture.oldView.isCurrent()), false);
      assert.equal(
        await page.evaluate(
          (key) => JSON.parse(sessionStorage.getItem(key)).entries.length,
          JOURNAL,
        ),
        1,
      );
    });
});

test("real active-studio cookie and foreign journal owner cannot preserve authority or adopt foreign work", async () =>
  mount(async (page) => {
    await start(page);
    await page.evaluate(() => {
      const f = window.fixture;
      f.previous = f.workspace;
      f.cookie("50000000-0000-4000-8000-000000000001");
      f.workspace.activity.getSnapshot();
    });
    await flush(page);
    assert.equal((await rendered(page)).operations.length, 0);
    await page.evaluate((ids) => {
      const f = window.fixture;
      f.scope = { ...f.scope, userId: ids.other };
      f.cookie(ids.studio);
      f.publish({ user: { id: ids.other } });
      f.mount();
    }, ids);
    await flush(page);
    await page.evaluate(() => window.fixture.ready);
    assert.equal((await rendered(page)).operations.length, 0);
    assert.equal(await page.evaluate(() => window.fixture.previous.isCurrent()), false);
    assert.equal(
      await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).entries.length, JOURNAL),
      1,
    );
  }));

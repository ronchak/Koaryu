import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { bundleWorkspace } from "./helpers/workflow-workspace-mounted.mjs";
import { ids } from "./helpers/workflow-workspace-fixture.mjs";
const flush = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
async function mount(run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
    );
    await page.goto("http://localhost/");
    await page.addScriptTag({ content: bundleWorkspace() });
    await flush(page);
    await run(page);
  } finally {
    await browser.close();
  }
}

test("mounted consumer and provider remount retain create/save identity through token renewal", async () =>
  mount(async (page) => {
    await page.getByLabel("Workflow name").fill("Submitted A");
    await page.getByRole("button", { name: "Save" }).click();
    await page.evaluate(() => {
      window.fixture.first = window.fixture.workspace;
      window.fixture.unmount();
    });
    await flush(page);
    await page.evaluate(() => {
      window.fixture.token = "token-2";
      const { userId, studioId, role } = window.fixture.scope;
      window.fixture.scope = { role, studioId, userId };
      for (const callback of window.fixture.auth)
        callback("TOKEN_REFRESHED", { user: { id: window.fixture.scope.userId } });
      window.fixture.mount();
    });
    await flush(page);
    assert.equal(
      await page.evaluate(() => window.fixture.first === window.fixture.workspace),
      true,
    );
    await page.getByRole("button", { name: "Save" }).click();
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 1);
    await page.getByLabel("Workflow name").fill("Local B");
    await page.evaluate(() => {
      const f = window.fixture;
      f.current = { ...f.current, name: "Submitted A" };
      f.requests[0].resolve(structuredClone(f.current));
    });
    await flush(page);
    assert.equal(await page.getByLabel("Workflow name").inputValue(), "Local B");
    assert.equal(
      await page.evaluate(() => window.fixture.workspace.getSnapshot().editor.workflowId),
      ids.workflow,
    );
    await page.getByRole("button", { name: "Save" }).click();
    await page.evaluate(() => {
      window.fixture.unmount();
    });
    await flush(page);
    await page.evaluate(() => window.fixture.mount());
    await flush(page);
    await page.getByRole("button", { name: "Save" }).click();
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 2);
    assert.equal(await page.evaluate(() => window.fixture.requests[1].token), "token-2");
    await page.evaluate(() => {
      const f = window.fixture;
      f.current = { ...f.current, name: "Local B", revision: 2 };
      f.requests[1].resolve(structuredClone(f.current));
    });
    await flush(page);
    assert.equal(
      await page.evaluate(() => window.fixture.workspace.getSnapshot().editor.baseline.revision),
      2,
    );
    assert.equal(await page.evaluate(() => window.fixture.auth.size), 1);
  }));

test("real verified-access epochs fence signout, role, studio, user, entitlement and ABA callbacks", async () => {
  for (const change of ["signout", "role", "studio", "user", "entitlement"])
    await mount(async (page) => {
      await page.evaluate(() => {
        const f = window.fixture;
        f.previous = f.workspace;
        f.workspace.submit("workflow.create");
      });
      await flush(page);
      await page.evaluate((change) => {
        const f = window.fixture;
        if (change === "signout") {
          for (const callback of [...f.auth]) callback("SIGNED_OUT", null);
        }
        if (change === "role") f.publish({ role: "front_desk" });
        if (change === "studio") f.publish({ studio_id: "50000000-0000-4000-8000-000000000001" });
        if (change === "user") f.publish({ user: { id: "50000000-0000-4000-8000-000000000001" } });
        if (change === "entitlement") f.publish({ accessAllowed: false });
      }, change);
      await flush(page);
      assert.equal(
        await page.evaluate(() => window.fixture.previous.getSnapshot().editor),
        null,
        change,
      );
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
      assert.equal(
        await page.evaluate(() => window.fixture.previous === window.fixture.workspace),
        false,
        change,
      );
      await page.evaluate(() => {
        const f = window.fixture;
        f.requests[0].resolve(structuredClone(f.current));
      });
      await flush(page);
      assert.equal(
        await page.evaluate(() => window.fixture.workspace.getSnapshot().editor.workflowId),
        null,
        change,
      );
      assert.equal(await page.evaluate(() => window.fixture.previous.isCurrent()), false, change);
      assert.equal(await page.evaluate(() => window.fixture.requests.length), 1);
    });
});

test("mounted recovery retains discovered workflow reservation across explicit navigation", async () =>
  mount(async (page) => {
    await page.getByRole("button", { name: "Save" }).click();
    await page.evaluate(() => {
      const f = window.fixture;
      f.detailFailure = true;
      f.requests[0].resolve(structuredClone(f.current));
    });
    await flush(page);
    await page.evaluate(async () => {
      const f = window.fixture;
      f.detailFailure = false;
      await f.workspace.openWorkflow(f.current.id, true);
      f.workspace.submit("workflow.pause");
    });
    await flush(page);
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 1);
    assert.equal(
      await page.evaluate(
        () => Object.values(window.fixture.workspace.getSnapshot().operations)[0].locked,
      ),
      true,
    );
    assert.equal(
      await page.evaluate(
        () =>
          JSON.parse(sessionStorage.getItem("koaryu-workflow-operations-v1")).entries[0]
            .workflow_id,
      ),
      ids.workflow,
    );
    await page.evaluate(async () => {
      const f = window.fixture;
      await f.workspace.reconcile({ kind: "workflow", id: f.current.id });
    });
    assert.equal(
      await page.evaluate(
        () => Object.values(window.fixture.workspace.getSnapshot().operations)[0].locked,
      ),
      false,
    );
  }));

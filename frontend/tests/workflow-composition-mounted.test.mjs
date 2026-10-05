import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import {
  bundleWorkflowComposition,
  workflowCompositionCss,
} from "./helpers/workflow-composition-mounted.mjs";
import { ids } from "./helpers/workflow-workspace-fixture.mjs";
const bundles = new Map();
async function mount(options, run) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: options.width ?? 390, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.route("**/*", (route) =>
      route.request().url() === "http://localhost/"
        ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
        : route.abort(),
    );
    await page.goto("http://localhost/");
    if (options.preview)
      await page.evaluate(() => {
        Storage.prototype.getItem = Storage.prototype.setItem = () => {
          throw Error("Preview journal touched");
        };
      });
    await page.addStyleTag({ content: workflowCompositionCss });
    const key = JSON.stringify(options);
    if (!bundles.has(key)) bundles.set(key, bundleWorkflowComposition(options));
    await page.addScriptTag({ content: bundles.get(key) });
    await expect.poll(() => page.evaluate(() => Boolean(window.fixture?.owner))).toBe(true);
    await run(page, errors);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
const draftRoute = `/automations/new?draft=${ids.draft}`;
const savedRoute = `/automations/${ids.workflow}`;
const name = (page) => page.getByRole("textbox", { name: /^Workflow name/ });
const count = (page) => page.evaluate(() => fixture.requests.length);
const graphViewport = (page) =>
  page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
async function assertReadableGraphStart(page, startId) {
  await expect.poll(async () => (await graphViewport(page)).zoom).toBe(0.9);
  const canvas = page.locator(".react-flow");
  await canvas.scrollIntoViewIfNeeded();
  const start = page.locator(`[data-testid="rf__node-${startId}"]`);
  await expect(start).toBeInViewport();
  const bounds = await start.evaluate((element) => {
    const node = element.getBoundingClientRect();
    const canvas = element.closest(".react-flow").getBoundingClientRect();
    const title = element.querySelector("strong");
    const viewport = new DOMMatrixReadOnly(
      getComputedStyle(element.closest(".react-flow__viewport")).transform,
    );
    return {
      x: node.x - canvas.x,
      y: node.y - canvas.y,
      width: node.width,
      height: node.height,
      labelPixels: parseFloat(getComputedStyle(title).fontSize) * viewport.a,
    };
  });
  assert.ok(Math.abs(bounds.x - 24) < 0.1, JSON.stringify(bounds));
  assert.ok(Math.abs(bounds.y - 24) < 0.1, JSON.stringify(bounds));
  assert.ok(Math.abs(bounds.width - 216) < 0.1, JSON.stringify(bounds));
  assert.ok(bounds.height > 118 && bounds.labelPixels >= 11.5, JSON.stringify(bounds));
}
async function assertFiniteGraphEdges(page, count) {
  const paths = page.locator(".react-flow__edge-path");
  await expect(paths).toHaveCount(count);
  const data = await paths.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("d")),
  );
  for (const path of data)
    assert.ok(
      path && /^M/.test(path) && !/NaN|undefined|Infinity/.test(path),
      `Invalid SVG connection: ${path}`,
    );
}

const complete = (page, index) => page.evaluate((index) => fixture.complete(index), index);
const flush = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

for (const mode of ["production", "development"])
  test(`catalog composes actual presets, editable pending save and retained history (${mode})`, async () => {
    await mount({ mode }, async (page) => {
      await expect(page.getByRole("heading", { name: "Build your next workflow" })).toBeVisible();
      const title = await page.evaluate(() => fixture.catalog.presets[0].name);
      await page.getByRole("button", { name: `Use ${title}`, exact: true }).click();
      await expect(name(page)).toHaveValue(title);
      assert.equal(await count(page), 0);
      assert.match(
        await page.evaluate(() => fixture.route),
        /^\/automations\/new\?draft=[0-9a-f-]{36}$/,
      );
      await name(page).fill("First save");
      await page.getByRole("button", { name: "Save draft", exact: true }).click();
      await expect.poll(() => count(page)).toBe(1);
      await name(page).fill("Still editing");
      await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Renew token fixture" }).click();
      await complete(page, 0);
      await expect(
        page.getByText("Action completed. Current workflow status is loaded."),
      ).toBeVisible();
      await expect(name(page)).toHaveValue("Still editing");
      await expect(page.getByText("Unsaved local changes", { exact: false })).toBeVisible();
      assert.equal(await count(page), 1);
      await page.getByRole("button", { name: "All workflows" }).click();
      await expect(
        page.getByText("Your unsaved draft stays open while you browse.", { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByText("Reloading discards unsaved changes.", { exact: false }),
      ).toBeVisible();
      await page.getByRole("button", { name: /^Continue editing/ }).click();
      await expect(name(page)).toHaveValue("Still editing");
      assert.equal(await page.evaluate(() => fixture.sideEffects), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
    });
  });

test("admin boundary and preview perform no protected I/O", async () => {
  for (const role of ["instructor", "staff"])
    await mount({ role, route: savedRoute }, async (page) => {
      await expect(page.getByText("An Admin can create and manage workflows.")).toBeVisible();
      assert.equal(
        await page.evaluate(
          () => fixture.reads.length + fixture.requests.length + fixture.authCalls,
        ),
        0,
      );
    });
  await mount({ preview: true }, async (page) => {
    await page.getByRole("button", { name: /^Use / }).first().click();
    await expect(name(page)).toBeVisible();
    await name(page).fill("Sample local changes");
    await page.getByRole("button", { name: "All workflows" }).click();
    await expect(
      page.getByText("Your unsaved draft stays open while you browse.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("Reloading discards unsaved changes.", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText(/Save before reloading/)).toHaveCount(0);
    await page
      .getByRole("button", { name: "Continue editing Sample local changes", exact: true })
      .click();
    await expect(name(page)).toHaveValue("Sample local changes");
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
    assert.equal(
      await page.evaluate(
        () =>
          fixture.reads.length + fixture.requests.length + fixture.authCalls + fixture.sideEffects,
      ),
      0,
    );
  });
});

test("published status, independent loads, cursor recovery and explicit dirty switch", async () => {
  await mount({}, async (page) => {
    await expect(page.getByRole("heading", { name: "Build your next workflow" })).toBeVisible();
    await page.evaluate(() => {
      const current = fixture.current;
      fixture.list = {
        items: [
          {
            ...current,
            status: "active",
            published_version_id: "50000000-0000-4000-8000-000000000001",
            published_version_number: 3,
            published_at: current.updated_at,
            created_at: current.updated_at,
            trigger_event_type: Object.keys(fixture.catalog.triggers)[0],
            draft_trigger_event_type:
              current.draft_graph.nodes.find((node) => node.type === "trigger")?.config
                .event_type ?? null,
          },
        ],
        next_cursor: "opaque-next",
        has_more: true,
      };
      fixture.errors.catalog = true;
    });
    await page.getByRole("button", { name: "Refresh list", exact: true }).click();
    await expect(page.getByText(/Published version 3/)).toBeVisible();
    await expect(page.getByText("Saved changes are not published")).toBeVisible();
    await page.evaluate(() => {
      fixture.invalidCursor = true;
    });
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByRole("button", { name: "Back to first page" })).toBeVisible();
    await expect(page.getByText(/Published version 3/)).toBeVisible();
    await page.getByRole("button", { name: "Back to first page" }).click();
    await expect(page.getByRole("button", { name: "Retry page" })).toHaveCount(0);
    await page.getByRole("button", { name: "New workflow", exact: true }).click();
    await expect(name(page)).toHaveValue("Untitled workflow");
    await name(page).fill("Keep this draft");
    await page.getByRole("button", { name: "All workflows" }).click();
    await page.getByRole("button", { name: "New workflow", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Discard your unsaved changes?" })).toBeVisible();
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await page.getByRole("button", { name: "Continue editing Keep this draft" }).click();
    await expect(name(page)).toHaveValue("Keep this draft");
    assert.equal(await count(page), 0);
  });
});

test("publish, start, pause, archive and reload require the bound confirmations", async () => {
  await mount({ route: savedRoute }, async (page) => {
    await expect(name(page)).toHaveValue("Welcome");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText(/first published version starts paused/)).toBeVisible();
    await page.getByRole("checkbox", { name: /Cancel pending runs/ }).check();
    await page.getByRole("button", { name: "Confirm publish" }).click();
    await expect.poll(() => count(page)).toBe(1);
    assert.equal(await page.evaluate(() => fixture.requests[0].body.cancel_pending), true);
    await complete(page, 0);
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
    await page.evaluate(() => {
      fixture.catalog.capabilities.can_start = true;
      fixture.catalog.delivery_status = {
        mode: "live",
        configured: true,
        can_enable: true,
        sender: "synthetic@example.invalid",
        test_recipient: null,
        reason: null,
      };
      fixture.catalog.scheduler.enabled = true;
    });
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
    await name(page).fill("Not part of start");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByText(/Start published version 1 for future events/)).toBeVisible();
    await page.getByRole("button", { name: "Confirm start" }).click();
    await expect.poll(() => count(page)).toBe(2);
    await complete(page, 1);
    await expect(name(page)).toHaveValue("Not part of start");
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByText(/Email already in flight may still arrive/)).toBeVisible();
    await page.getByRole("button", { name: "Confirm pause" }).click();
    await expect.poll(() => count(page)).toBe(3);
    await complete(page, 2);
    await page.getByRole("button", { name: "Discard and reload", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Discard and reload", exact: true })
      .click();
    await expect(name(page)).toHaveValue("Welcome");
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByText(/Archive this workflow permanently/)).toBeVisible();
    await page.getByRole("button", { name: "Confirm archive" }).click();
    await expect.poll(() => count(page)).toBe(4);
    await complete(page, 3);
    await expect(name(page)).toBeDisabled();
  });
});

test("unknown create stays unresolved through missing result and detail failure", async () => {
  await mount({ route: draftRoute }, async (page) => {
    await expect(name(page)).toBeVisible();
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect.poll(() => count(page)).toBe(1);
    await page.evaluate(() => fixture.fail(0));
    await name(page).fill("Preserve this after unknown result");
    await page.getByRole("button", { name: "Check result", exact: true }).click();
    await expect(page.getByText(/result is not confirmed yet/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
    await page.evaluate(() => {
      fixture.complete(0);
      fixture.errors.detail = true;
    });
    await page.getByRole("button", { name: "Check result", exact: true }).click();
    await expect(page.getByRole("button", { name: "Check result", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
    await page.evaluate(() => {
      fixture.errors.detail = false;
    });
    await page.getByRole("button", { name: "Check result", exact: true }).click();
    await expect(
      page.getByText("Action completed. Current workflow status is loaded."),
    ).toBeVisible();
    await expect(name(page)).toHaveValue("Preserve this after unknown result");
    assert.equal(await count(page), 1);
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /receipt|operation_id|schema_version/,
    );
  });
});

test("cold reference loads support empty, outage retry and same-owner renewal without selection writes", async () => {
  await mount({}, async (page) => {
    await page.evaluate(() => {
      fixture.hold.ranks = true;
      fixture.hold.programs = true;
      fixture.router.push("/automations/new?draft=40000000-0000-4000-8000-000000000001");
    });
    await expect(name(page)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => fixture.held.filter((item) => item.key === "ranks").length))
      .toBe(1);
    await page.locator('[data-workflow-step="trigger_1"]').click();
    await page.getByRole("combobox", { name: "Trigger event" }).selectOption("student.promoted");
    await expect(page.getByText(/Program choices are loading/)).toBeVisible();
    await page.evaluate(() => {
      fixture.change({ token: "token-2" });
      fixture.readyHeld("ranks", []);
      fixture.readyHeld("programs", []);
    });
    await expect
      .poll(() => page.evaluate(() => fixture.held.filter((item) => item.key === "ranks").length))
      .toBe(2);
    await page.evaluate(() => {
      fixture.hold.ranks = false;
      fixture.hold.programs = false;
      fixture.readyHeld("ranks", [], true);
      fixture.readyHeld("programs", []);
    });
    await expect(page.getByRole("button", { name: "Reload ranks" })).toBeVisible();
    await page.getByRole("button", { name: "Reload ranks" }).click();
    await expect(page.getByRole("button", { name: "Reload ranks" })).toHaveCount(0);
    assert.equal(await page.evaluate(() => fixture.sideEffects), 0);
    assert.equal(
      await page.evaluate(
        () => fixture.reads.filter((read) => read.path.includes("eligibility")).length,
      ),
      0,
    );
    assert.equal(
      await page.evaluate(
        () => fixture.reads.filter((read) => read.path.startsWith("/belts")).at(-1).token,
      ),
      "token-2",
    );
  });
});

test("reference owner rejects ABA results and stale dialogs cannot act on another target", async () => {
  await mount({ route: savedRoute }, async (page) => {
    await expect(name(page)).toBeVisible();
    await page.evaluate(() => {
      fixture.hold.ranks = true;
      fixture.directResult = null;
      fixture.metadataRead().then(
        (value) => (fixture.directResult = value),
        (error) => (fixture.directResult = error.message),
      );
    });
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.evaluate(() => {
      fixture.change({ studio: "20000000-0000-4000-8000-000000000002" });
      fixture.change({ studio: "20000000-0000-4000-8000-000000000001" });
      fixture.readyHeld("ranks", [{ id: "bad" }]);
    });
    await expect.poll(() => page.evaluate(() => fixture.directResult)).toMatch(/workspace changed/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    assert.equal(await count(page), 0);
    assert.equal(await page.evaluate(() => fixture.sideEffects), 0);
    await flush(page);
  });
});

for (const mode of ["production", "development"])
  test(`current reference choices and readable graph labels share the inspector (${mode})`, async () => {
    await mount({ mode }, async (page) => {
      await page.evaluate(() => {
        fixture.programs = [
          { id: "71000000-0000-4000-8000-000000000001", name: "Adults", archived_at: null },
        ];
        fixture.ladders = [
          {
            id: "73000000-0000-4000-8000-000000000001",
            name: "Adult ranks",
            ranks: [{ id: "72000000-0000-4000-8000-000000000001", name: "Blue belt" }],
          },
          {
            id: "73000000-0000-4000-8000-000000000002",
            name: "Youth ranks",
            ranks: [{ id: "72000000-0000-4000-8000-000000000002", name: "Green belt" }],
          },
        ];
        fixture.router.push("/automations/new?draft=40000000-0000-4000-8000-000000000001");
      });
      await expect(name(page)).toBeVisible();
      await page.locator('[data-workflow-step="trigger_1"]').click();
      await page.getByRole("combobox", { name: "Trigger event" }).selectOption("student.promoted");
      await expect(page.getByRole("combobox", { name: "Program filter" })).toBeEnabled();
      await page
        .getByRole("combobox", { name: "Program filter" })
        .selectOption("71000000-0000-4000-8000-000000000001");
      await expect(page.locator('[data-workflow-step="trigger_1"]')).toContainText(
        "Student earns a rank promotion",
      );
      await page.getByRole("combobox", { name: "Step type" }).selectOption("condition");
      await page.getByRole("button", { name: "Add step", exact: true }).click();
      await page
        .getByRole("combobox", { name: "Comparison field" })
        .selectOption("promotion.rank_id");
      await page.getByRole("combobox", { name: "Comparison operator" }).selectOption("eq");
      await page
        .getByRole("combobox", { name: "Comparison value", exact: true })
        .selectOption(JSON.stringify("72000000-0000-4000-8000-000000000002"));
      await expect(page.getByRole("list", { name: "Workflow steps" })).toContainText(
        "Youth ranks: Green belt",
      );
      await page.getByRole("button", { name: "Graph", exact: true }).click();
      await expect(page.locator(".react-flow")).toContainText("Youth ranks: Green belt");
      await page.getByRole("button", { name: "Steps", exact: true }).click();
      await name(page).fill("😀".repeat(121));
      await expect(name(page)).toHaveValue("😀".repeat(120));
      assert.equal(await page.evaluate(() => fixture.sideEffects), 0);
      const history = await page.evaluate(
        () => fixture.owner().getSnapshot().editor.history.past.length,
      );
      await page.getByRole("button", { name: "All workflows" }).click();
      await page.getByRole("button", { name: /Continue editing/ }).click();
      assert.equal(
        await page.evaluate(() => fixture.owner().getSnapshot().editor.history.past.length),
        history,
      );
    });
  });

test("retained live re-entry refreshes facts while keeping local content and baseline checks", async () => {
  await mount({ route: savedRoute }, async (page) => {
    await expect(name(page)).toHaveValue("Welcome");
    await name(page).fill("Local revision");
    await page.getByRole("button", { name: "All workflows" }).click();
    await page.evaluate(() => {
      const detail = fixture.details[fixture.current.id];
      fixture.details[detail.id] = {
        ...detail,
        revision: 2,
        pending_run_count: 9,
        validation_issues: [
          {
            code: "new",
            message: "New server graph issue",
            node_id: "trigger_1",
            edge_id: null,
            field: null,
          },
        ],
      };
    });
    await page.getByRole("button", { name: /Continue editing/ }).click();
    await expect(name(page)).toHaveValue("Local revision");
    await expect(page.getByText("9 waiting · 0 sending")).toBeVisible();
    await expect(page.getByText(/changed since you opened/)).toBeVisible();
    await expect(page.getByText("New server graph issue")).toHaveCount(0);
    await page.getByRole("button", { name: "Discard and reload", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Discard and reload", exact: true })
      .click();
    await expect(name(page)).toHaveValue("Welcome");
    await expect(page.getByText("New server graph issue").first()).toBeVisible();
  });
});

test("metadata reads return explicit empty success and reject studio/user ownership changes", async () => {
  await mount({ route: savedRoute }, async (page) => {
    await expect(name(page)).toBeVisible();
    assert.deepEqual(await page.evaluate(() => fixture.metadataRead()), { ladders: [] });
    for (const patch of [
      { user: "10000000-0000-4000-8000-000000000002" },
      { studio: "20000000-0000-4000-8000-000000000002" },
    ]) {
      await page.evaluate(() => {
        fixture.hold.ranks = true;
        fixture.metadataOutcome = null;
        fixture.metadataRead().then(
          (result) => {
            fixture.metadataOutcome = result;
          },
          (error) => {
            fixture.metadataOutcome = error.message;
          },
        );
      });
      await page.evaluate((patch) => {
        fixture.change(patch);
        fixture.hold.ranks = false;
        fixture.readyHeld("ranks", [{ id: "stale-ladder", name: "Old studio ranks", ranks: [] }]);
      }, patch);
      await expect
        .poll(() => page.evaluate(() => fixture.metadataOutcome))
        .toMatch(/workspace changed/);
      await expect(name(page)).toBeVisible();
      await expect(page.getByText("Old studio ranks")).toHaveCount(0);
    }
    assert.equal(await page.evaluate(() => fixture.sideEffects), 0);
  });
});

test("restored confirmed create alias exposes Check result on a direct workflow route", async () => {
  await mount({}, async (page) => {
    await page.evaluate(() => {
      const operationId = "60000000-0000-4000-8000-000000000099";
      const result = fixture.current;
      fixture.receipts[operationId] = {
        operation_id: operationId,
        command: "workflow.create",
        state: "committed",
        entity_type: "workflow",
        entity_id: result.id,
        result,
        committed_at: result.updated_at,
      };
      sessionStorage.setItem(
        "koaryu-workflow-operations-v1",
        JSON.stringify({
          version: 1,
          entries: [
            {
              operation_id: operationId,
              command: "workflow.create",
              target: { kind: "draft", id: "40000000-0000-4000-8000-000000000001" },
              owner_user_id: fixture.user,
              owner_studio_id: fixture.studio,
              workflow_id: result.id,
            },
          ],
        }),
      );
      fixture.change({ role: "instructor" });
      fixture.change({ role: "admin" });
      fixture.router.push("/automations/" + result.id);
    });
    await expect(name(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Check result", exact: true })).toBeVisible();
    await name(page).fill("Preserve direct-route local edit");
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Check result", exact: true }).click();
    await expect(page.getByRole("button", { name: "Check result", exact: true })).toHaveCount(0);
    await expect(name(page)).toHaveValue("Preserve direct-route local edit");
    assert.equal(await count(page), 0);
  });
});

test("unknown creation blocks another workflow with a previous-action check, while a known alias does not", async () => {
  for (const known of [false, true])
    await mount({}, async (page) => {
      await page.evaluate((known) => {
        const operationId = "60000000-0000-4000-8000-000000000099";
        const draftId = "40000000-0000-4000-8000-000000000001";
        fixture.details[draftId] = {
          ...fixture.current,
          id: draftId,
          name: "Separate workflow",
          revision: 7,
        };
        const marker = {
          operation_id: operationId,
          command: "workflow.create",
          target: { kind: "draft", id: draftId },
          owner_user_id: fixture.user,
          owner_studio_id: fixture.studio,
          ...(known ? { workflow_id: fixture.current.id } : {}),
        };
        sessionStorage.setItem(
          "koaryu-workflow-operations-v1",
          JSON.stringify({ version: 1, entries: [marker] }),
        );
        fixture.change({ role: "instructor" });
        fixture.change({ role: "admin" });
        fixture.router.push("/automations/" + draftId);
      }, known);
      await expect(name(page)).toHaveValue("Separate workflow");
      await name(page).fill("Separate changes");
      if (known) {
        await expect(page.getByRole("button", { name: "Check result", exact: true })).toHaveCount(
          0,
        );
        await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "Save draft", exact: true }).click();
        await expect.poll(() => count(page)).toBe(1);
        assert.match(
          await page.evaluate(() => fixture.requests[0].path),
          /\/40000000-0000-4000-8000-000000000001$/,
        );
        assert.equal(await page.evaluate(() => fixture.requests[0].body.expected_revision), 7);
      } else {
        await expect(page.getByText(/Check the previous action before saving/)).toBeVisible();
        await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
        await page.getByRole("button", { name: "Check result", exact: true }).click();
        await expect(name(page)).toHaveValue("Separate changes");
        assert.equal(await count(page), 0);
      }
    });
});

test("confirmation Escape and cancel return focus to the action without dispatch", async () => {
  await mount({ route: savedRoute }, async (page) => {
    await expect(name(page)).toBeVisible();
    const action = page.getByRole("button", { name: "Archive", exact: true });
    await action.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(action).toBeFocused();
    await action.click();
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(action).toBeFocused();
    assert.equal(await count(page), 0);
  });
});

test("a failed refresh of cached programs remains unavailable on editor re-entry until retry", async () => {
  await mount({}, async (page) => {
    await page.evaluate(() => {
      fixture.programs = [
        { id: "71000000-0000-4000-8000-000000000001", name: "Adults", archived_at: null },
      ];
      fixture.router.push("/automations/new?draft=40000000-0000-4000-8000-000000000001");
    });
    await expect(name(page)).toBeVisible();
    await page.locator('[data-workflow-step="trigger_1"]').click();
    await page.getByRole("combobox", { name: "Trigger event" }).selectOption("student.promoted");
    await page
      .getByRole("combobox", { name: "Program filter" })
      .selectOption("71000000-0000-4000-8000-000000000001");
    await page.evaluate(async () => {
      fixture.errors.programs = true;
      await fixture.programRefresh({ force: true, includeArchived: true }).catch(() => {});
    });
    await page.getByRole("button", { name: "All workflows" }).click();
    await page.getByRole("button", { name: /Continue editing/ }).click();
    await expect(page.getByRole("button", { name: "Reload programs" })).toBeVisible();
    await page.locator('[data-workflow-step="trigger_1"]').click();
    await expect(page.getByRole("combobox", { name: "Program filter" })).toHaveValue(
      "71000000-0000-4000-8000-000000000001",
    );
    await page.evaluate(() => {
      fixture.errors.programs = false;
    });
    await page.getByRole("button", { name: "Reload programs" }).click();
    await expect(page.getByRole("button", { name: "Reload programs" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Program filter" })).toBeEnabled();
  });
});

test("graph and steps share catalog anchor labels and distinct boolean, null and omitted comparisons", async () => {
  await mount({ route: draftRoute }, async (page) => {
    await expect(name(page)).toBeVisible();
    await page.evaluate(() => {
      const owner = fixture.owner();
      for (const node of [
        {
          id: "false",
          type: "condition",
          config: { field: "student.on_hold", operator: "eq", value: false },
        },
        {
          id: "null",
          type: "condition",
          config: { field: "program.id", operator: "eq", value: null },
        },
        { id: "omitted", type: "condition", config: { field: "program.id", operator: "eq" } },
        {
          id: "unavailable",
          type: "condition",
          config: { field: "lead.stage", operator: "eq", value: "unavailable_saved_id" },
        },
        {
          id: "anchor",
          type: "delay",
          config: { mode: "until", field: "trial.starts_at", offset_minutes: -30 },
        },
      ])
        owner.edit({ kind: "add_node", node });
    });
    const expected = [
      "Student is on hold Is No",
      "Program Is No value",
      "Program Is Choose a value",
      "Lead stage Is unavailable_saved_id",
      "Wait until Trial start (-30 minutes)",
    ];
    for (const text of expected)
      await expect(page.getByRole("list", { name: "Workflow steps" })).toContainText(text);
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    for (const text of expected) await expect(page.locator(".react-flow")).toContainText(text);
  });
});

test("visible fixture studio control switches to distinct synthetic records and access", async () => {
  await mount({ route: savedRoute }, async (page) => {
    await expect(name(page)).toHaveValue("Welcome");
    await name(page).fill("Old studio local draft");
    await page.getByRole("button", { name: "Switch synthetic studio", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Other studio welcome", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Continue editing/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Enable synthetic delivery", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => fixture.owner().getSnapshot().catalog.capabilities.can_start))
      .toBe(true);
    await page.getByRole("button", { name: "Switch synthetic studio", exact: true }).click();
    await expect(page.getByRole("button", { name: "Welcome", exact: true })).toBeVisible();
    await expect(page.getByText("Old studio local draft")).toHaveCount(0);
    assert.equal(await count(page), 0);
  });
});

test("ready email with unavailable scheduling uses the actual reason and permits draft saving", async () => {
  await mount({}, async (page) => {
    await page.evaluate(() => {
      fixture.catalog.delivery_status = {
        mode: "live",
        configured: true,
        can_enable: true,
        sender: "synthetic@example.invalid",
        test_recipient: null,
        reason: null,
      };
      fixture.catalog.scheduler.enabled = false;
      fixture.catalog.capabilities = {
        can_start: false,
        can_test_email: true,
        disabled_reason: "Scheduled workflow processing is unavailable.",
      };
      fixture.details[fixture.current.id] = {
        ...fixture.current,
        status: "paused",
        published_version_id: "50000000-0000-4000-8000-000000000001",
        published_version_number: 1,
        published_at: fixture.current.updated_at,
      };
      fixture.router.push("/automations/" + fixture.current.id);
    });
    await expect(name(page)).toBeVisible();
    await expect(page.getByText("Scheduled workflow processing is unavailable.")).toBeVisible();
    await expect(page.getByText(/until email delivery is ready/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
    await name(page).fill("Save despite unavailable scheduling");
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect.poll(() => count(page)).toBe(1);
    await complete(page, 0);
    await expect(
      page.getByText("Action completed. Current workflow status is loaded."),
    ).toBeVisible();
    await page.evaluate(() => {
      fixture.catalog.capabilities.disabled_reason = null;
    });
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect(page.getByText("Starting is unavailable right now.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
  });
});

test("a cold missing workflow offers the catalog and does not invent a retained draft", async () => {
  await mount({ route: "/automations/30000000-0000-4000-8000-000000000099" }, async (page) => {
    await expect(page.getByRole("alert")).toHaveText("This workflow could not be opened.");
    await expect(
      page.getByRole("button", { name: "Return to retained draft", exact: true }),
    ).toHaveCount(0);
    assert.equal(await page.evaluate(() => fixture.owner().getSnapshot().editor), null);
    await page.getByRole("button", { name: "Back to catalog", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Build your next workflow" })).toBeVisible();
  });
});

test("a failed detail request offers the draft that is actually retained", async () => {
  await mount({ route: draftRoute }, async (page) => {
    await expect(name(page)).toBeVisible();
    await name(page).fill("Retained working draft");
    await page.getByRole("button", { name: "Add step", exact: true }).click();
    const history = await page.evaluate(() =>
      structuredClone(fixture.owner().getSnapshot().editor.history),
    );
    assert.equal(history.past.length, 1);
    await page.evaluate(() => {
      fixture.router.push("/automations/30000000-0000-4000-8000-000000000099");
    });
    await page.getByRole("button", { name: "Discard and open workflow", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "This workflow could not be opened. Your retained draft is still available.",
    );
    await expect(page.getByRole("button", { name: "Back to catalog", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Return to retained draft", exact: true }).click();
    await expect(name(page)).toHaveValue("Retained working draft");
    assert.equal(await page.evaluate(() => fixture.route), draftRoute);
    assert.deepEqual(
      await page.evaluate(() => structuredClone(fixture.owner().getSnapshot().editor.history)),
      history,
    );
    assert.equal(
      await page.evaluate(
        () =>
          fixture.reads.filter(
            (read) => read.path === "/automations/workflows/30000000-0000-4000-8000-000000000099",
          ).length,
      ),
      1,
    );
  });
});

test("template and duplicate creates get fresh canonical records, including after archive", async () => {
  await mount({}, async (page) => {
    const seed = await page.evaluate(() => structuredClone(fixture.current));
    await page.getByRole("button", { name: /^Use / }).first().click();
    await expect(name(page)).toBeVisible();
    const createAndCheck = async (index) => {
      await page.getByRole("button", { name: "Save draft", exact: true }).click();
      await expect.poll(() => count(page)).toBe(index + 1);
      const result = await complete(page, index);
      assert.match(
        result.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(result.status, "draft");
      assert.equal(result.revision, 1);
      assert.equal(result.published_version_id, null);
      assert.equal(result.published_version_number, null);
      assert.equal(result.published_at, null);
      assert.equal(result.pending_run_count, 0);
      assert.equal(result.sending_run_count, 0);
      const request = await page.evaluate((index) => fixture.requests[index].body, index);
      assert.deepEqual(
        [result.name, result.description, result.draft_graph, result.draft_layout],
        [request.name, request.description, request.graph, request.layout],
      );
      await expect(
        page.getByText("Action completed. Current workflow status is loaded."),
      ).toBeVisible();
      assert.equal(
        await page.evaluate(() => fixture.owner().getSnapshot().editor.workflowId),
        result.id,
      );
      const receipt = await page.evaluate(
        (index) => fixture.receipts[fixture.requests[index].body.operation_id],
        index,
      );
      assert.equal(receipt.entity_id, result.id);
      assert.equal(receipt.result.id, result.id);
      assert.equal(
        await page.evaluate(
          (id) => fixture.reads.some((read) => read.path === "/automations/workflows/" + id),
          result.id,
        ),
        true,
      );
      return result;
    };
    const first = await createAndCheck(0);
    await page.getByRole("button", { name: "Duplicate draft", exact: true }).click();
    await page.getByRole("button", { name: "Create local copy", exact: true }).click();
    const second = await createAndCheck(1);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByRole("button", { name: "Confirm publish", exact: true }).click();
    await expect.poll(() => count(page)).toBe(3);
    await complete(page, 2);
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await page.getByRole("button", { name: "Confirm archive", exact: true }).click();
    await expect.poll(() => count(page)).toBe(4);
    const archived = await complete(page, 3);
    await expect(name(page)).toBeDisabled();
    assert.equal(archived.status, "archived");
    assert.equal(archived.published_version_number, 1);
    await page.getByRole("button", { name: "Duplicate draft", exact: true }).click();
    await page.getByRole("button", { name: "Create local copy", exact: true }).click();
    await expect(name(page)).toBeEnabled();
    const third = await createAndCheck(4);
    assert.equal(new Set([seed.id, first.id, second.id, third.id]).size, 4);
    const records = await page.evaluate(() => fixture.details);
    assert.deepEqual(records[seed.id], seed);
    assert.deepEqual(records[first.id], first);
    assert.deepEqual(records[second.id], archived);
  });
});

for (const mode of ["production", "development"])
  test(`first desktop entry draws every connection of the generated branching preset (${mode})`, async () => {
    await mount({ width: 1280, mode }, async (page) => {
      const preset = await page.evaluate(() =>
        fixture.catalog.presets.find((preset) => preset.id === "new_lead_follow_up"),
      );
      assert.ok(preset.graph.edges.some((edge) => edge.port === "yes"));
      assert.ok(preset.graph.edges.some((edge) => edge.port === "no"));
      await page.getByRole("button", { name: "Use " + preset.name, exact: true }).click();
      await expect(name(page)).toHaveValue(preset.name);
      await assertReadableGraphStart(
        page,
        preset.graph.nodes.find((node) => node.type === "trigger").id,
      );
      assert.deepEqual(
        await page.evaluate(
          () => fixture.owner().getSnapshot().editor.history.present.layout.positions,
        ),
        {},
      );
      assert.equal(
        await page.evaluate(() => fixture.owner().getSnapshot().editor.history.past.length),
        0,
      );
      await expect(page.getByRole("button", { name: "Graph", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const paths = page.locator(".react-flow__edge-path");
      await expect(paths).toHaveCount(preset.graph.edges.length);
      const data = await paths.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("d")),
      );
      assert.equal(data.length, preset.graph.edges.length);
      for (const path of data) {
        assert.ok(
          path && /^M/.test(path) && !/NaN|undefined|Infinity/.test(path),
          `Invalid SVG connection: ${path}`,
        );
        const coordinates = path.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi);
        assert.ok(
          coordinates?.length && coordinates.every((value) => Number.isFinite(Number(value))),
          `Non-finite SVG coordinates: ${path}`,
        );
      }
      assert.equal(await page.getByRole("list", { name: "Workflow steps" }).count(), 0);
    });
  });

for (const mode of ["production", "development"])
  test(`forty-node first entry retains readable start, finite paths and untouched layout (${mode})`, async () => {
    await mount({ width: 1280, mode }, async (page) => {
      const graph = {
        schema_version: 1,
        nodes: [
          {
            id: "start",
            type: "trigger",
            config: { event_type: "lead.created", program_id: null },
          },
          ...Array.from({ length: 38 }, (_, index) => ({
            id: `delay_${index}`,
            type: "delay",
            config: { mode: "duration", minutes: 1 },
          })),
          { id: "end", type: "end", config: {} },
        ],
        edges: [],
      };
      graph.edges = graph.nodes.slice(1).map((node, index) => ({
        id: `edge_${index}`,
        source: graph.nodes[index].id,
        target: node.id,
        port: "next",
      }));
      await page.evaluate((graph) => {
        fixture.details[fixture.current.id] = {
          ...fixture.current,
          draft_graph: graph,
          draft_layout: { positions: {} },
        };
        fixture.router.push("/automations/" + fixture.current.id);
      }, graph);
      await expect(name(page)).toBeVisible();
      await assertReadableGraphStart(page, "start");
      await assertFiniteGraphEdges(page, 39);
      const editor = await page.evaluate(() => fixture.owner().getSnapshot().editor);
      assert.equal(editor.history.present.graph.nodes.length, 40);
      assert.deepEqual(editor.history.present.layout.positions, {});
      assert.equal(editor.history.past.length, 0);
      assert.equal(await count(page), 0);
    });
  });

for (const [id, position] of [
  ["saved_start", { x: 1234, y: -4567 }],
  ["__proto__", { x: 100000, y: -100000 }],
  ["constructor", { x: -100000, y: 100000 }],
])
  test(`saved trigger ${id} at ${position.x},${position.y} opens at the margin without movement`, async () => {
    await mount({ width: 1280 }, async (page) => {
      const draft = await page.evaluate(
        ({ id, position }) => {
          const graph = structuredClone(
            fixture.catalog.presets.find((preset) => preset.id === "new_lead_follow_up").graph,
          );
          const trigger = graph.nodes.find((node) => node.type === "trigger"),
            previous = trigger.id;
          trigger.id = id;
          graph.edges = graph.edges.map((edge) => ({
            ...edge,
            source: edge.source === previous ? id : edge.source,
            target: edge.target === previous ? id : edge.target,
          }));
          const draft = { graph, layout: { positions: Object.fromEntries([[id, position]]) } };
          fixture.details[fixture.current.id] = {
            ...fixture.current,
            draft_graph: draft.graph,
            draft_layout: draft.layout,
          };
          fixture.router.push("/automations/" + fixture.current.id);
          return JSON.stringify(draft);
        },
        { id, position },
      );
      await expect(name(page)).toBeVisible();
      await assertReadableGraphStart(page, id);
      await assertFiniteGraphEdges(page, JSON.parse(draft).graph.edges.length);
      const current = await page.evaluate(() =>
        JSON.stringify(fixture.owner().getSnapshot().editor.history.present.layout),
      );
      assert.deepEqual(JSON.parse(current), JSON.parse(draft).layout);
      const camera = await graphViewport(page);
      assert.ok(Math.abs(camera.x - (24 - position.x * 0.9)) < 0.0001);
      assert.ok(Math.abs(camera.y - (24 - position.y * 0.9)) < 0.0001);
      assert.equal(camera.zoom, 0.9);
      assert.equal(
        await page.evaluate(() => fixture.owner().getSnapshot().editor.history.past.length),
        0,
      );
    });
  });

for (const empty of [false, true])
  test(`${empty ? "empty" : "missing-trigger"} draft opens a stable repair camera`, async () => {
    await mount({ width: 1280 }, async (page) => {
      await page.evaluate((empty) => {
        fixture.details[fixture.current.id] = {
          ...fixture.current,
          draft_graph: {
            schema_version: 1,
            nodes: empty
              ? []
              : [
                  { id: "z_last", type: "end", config: {} },
                  { id: "a_first", type: "end", config: {} },
                ],
            edges: [],
          },
          draft_layout: { positions: empty ? {} : { a_first: { x: 450, y: -800 } } },
        };
        fixture.router.push("/automations/" + fixture.current.id);
      }, empty);
      await expect(name(page)).toBeVisible();
      if (empty) await expect.poll(() => graphViewport(page)).toEqual({ x: 0, y: 0, zoom: 0.9 });
      else await assertReadableGraphStart(page, "a_first");
      await assertFiniteGraphEdges(page, 0);
      const camera = await graphViewport(page);
      await page.getByRole("combobox", { name: "Step type" }).selectOption("trigger");
      await page.getByRole("button", { name: "Add step", exact: true }).click();
      await expect(page.getByRole("combobox", { name: "Trigger event" })).toBeVisible();
      assert.deepEqual(await graphViewport(page), camera);
      assert.equal(
        await page.evaluate(
          () =>
            fixture
              .owner()
              .getSnapshot()
              .editor.history.present.graph.nodes.filter((node) => node.type === "trigger").length,
        ),
        1,
      );
    });
  });

test("manual camera survives edits, history and resize, and a new canvas mount restores the start view", async () => {
  await mount({ width: 1280 }, async (page) => {
    const preset = await page.evaluate(() =>
      fixture.catalog.presets.find((preset) => preset.id === "new_lead_follow_up"),
    );
    await page.getByRole("button", { name: "Use " + preset.name, exact: true }).click();
    const trigger = preset.graph.nodes.find((node) => node.type === "trigger").id;
    await assertReadableGraphStart(page, trigger);
    await page.getByRole("button", { name: "Zoom Out", exact: true }).click();
    await expect.poll(async () => (await graphViewport(page)).zoom).toBeCloseTo(0.75, 6);
    const zoomed = await graphViewport(page);
    const pane = page.locator(".react-flow__pane");
    await pane.scrollIntoViewIfNeeded();
    const box = await pane.boundingBox();
    await page.mouse.move(box.x + box.width - 170, box.y + box.height - 100);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 110, box.y + box.height - 65, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => graphViewport(page)).not.toEqual(zoomed);
    const camera = await graphViewport(page);
    assert.equal(camera.zoom, zoomed.zoom);
    await name(page).fill("Manual camera retained");
    assert.deepEqual(await graphViewport(page), camera);
    await page.locator(`[data-testid="rf__node-${trigger}"]`).click();
    assert.deepEqual(await graphViewport(page), camera);
    await page.getByRole("combobox", { name: "Trigger event" }).selectOption("lead.stage_changed");
    assert.deepEqual(await graphViewport(page), camera);
    await page.getByRole("button", { name: "Add step", exact: true }).click();
    assert.deepEqual(await graphViewport(page), camera);
    for (const action of ["Auto layout", "Undo", "Redo"]) {
      await page.getByRole("button", { name: action, exact: true }).click();
      assert.deepEqual(await graphViewport(page), camera);
    }
    await page.setViewportSize({ width: 1180, height: 1000 });
    assert.deepEqual(await graphViewport(page), camera);
    const history = await page.evaluate(() =>
      structuredClone(fixture.owner().getSnapshot().editor.history),
    );
    await page.getByRole("button", { name: "All workflows" }).click();
    await page.getByRole("button", { name: "Continue editing Manual camera retained" }).click();
    await assertReadableGraphStart(page, trigger);
    assert.deepEqual(
      await page.evaluate(() => structuredClone(fixture.owner().getSnapshot().editor.history)),
      history,
    );
    assert.equal(await count(page), 0);
  });
});

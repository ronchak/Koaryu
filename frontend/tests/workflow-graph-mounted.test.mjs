import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { bundleWorkflowGraph, workflowGraphCss } from "./helpers/workflow-graph-mounted.mjs";
import { initialGraph, settleFixtureChild } from "./helpers/workflow-graph-fixture.mjs";

const bundles = new Map();
async function mount(
  browser,
  { width = 1200, mode = "production", instrumentMeasurements = false } = {},
) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
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
  await page.addStyleTag({ content: workflowGraphCss });
  const bundleKey = `${mode}:${instrumentMeasurements}`;
  if (!bundles.has(bundleKey))
    bundles.set(bundleKey, bundleWorkflowGraph(mode, { instrumentMeasurements }));
  await page.addScriptTag({ content: bundles.get(bundleKey) });
  await page.waitForFunction(() => window.workflowFixture);
  if (width >= 768) {
    try {
      await page.locator(".react-flow").waitFor({ timeout: 5000 });
    } catch (error) {
      throw new Error(JSON.stringify({ errors, body: await page.locator("body").innerText() }), {
        cause: error,
      });
    }
  }
  return { page, errors };
}
// JSON preserves own __proto__ keys across the browser automation transport.
const snapshot = async (page) =>
  JSON.parse(await page.evaluate(() => JSON.stringify(workflowFixture.draft)));
const count = (page) => page.evaluate(() => workflowFixture.actions.length);
const node = (page, id) => page.locator(`[data-testid="rf__node-${id}"]`);
const step = (page, id) => page.locator(`[data-workflow-step="${id}"]`);
async function fitAll(page) {
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await expect
    .poll(() =>
      page.locator(".react-flow__node").evaluateAll((nodes) =>
        nodes.every((element) => {
          const node = element.getBoundingClientRect(),
            canvas = element.closest(".react-flow").getBoundingClientRect();
          return (
            node.x >= canvas.x &&
            node.y >= canvas.y &&
            node.right <= canvas.right &&
            node.bottom <= canvas.bottom
          );
        }),
      ),
    )
    .toBe(true);
}

async function connectStep(page, source, port, target) {
  const row = step(page, source).locator("..");
  await row
    .getByRole("combobox", { name: new RegExp(`^${port} destination`) })
    .selectOption(target);
  await row.getByRole("button", { name: new RegExp(`^Connect ${port} from`) }).click();
}

for (const mode of ["production", "development"]) {
  test(`steps connect both branches, converge, reject cycles, preserve omitted values (${mode})`, async () => {
    const browser = await chromium.launch();
    try {
      const { page, errors } = await mount(browser, { width: 320, mode });
      await expect(page.getByRole("button", { name: "Steps", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      assert.equal(await page.locator(".react-flow").count(), 0);
      await connectStep(page, "condition", "yes", "delay");
      await connectStep(page, "condition", "no", "email");
      await connectStep(page, "delay", "next", "email");
      assert.equal(
        await page.getByRole("list", { name: "Workflow steps" }).locator(":scope > li").count(),
        6,
      );
      assert.equal(
        (await snapshot(page)).graph.edges.filter((edge) => edge.target === "email").length,
        2,
      );
      await step(page, "email")
        .locator("..")
        .getByRole("button", { name: /^Disconnect next/ })
        .click();
      const targets = await step(page, "email")
        .locator("..")
        .getByRole("combobox")
        .locator("option")
        .evaluateAll((options) => options.map((option) => option.value));
      assert.ok(
        !targets.includes("condition") &&
          !targets.includes("delay") &&
          !targets.includes("email") &&
          !targets.includes("trigger"),
      );
      assert.equal(
        Object.hasOwn(
          (await snapshot(page)).graph.nodes.find((n) => n.id === "condition").config,
          "value",
        ),
        false,
      );
      await page.getByLabel("Step type").selectOption("condition");
      await page.getByRole("button", { name: "Add step", exact: true }).click();
      const added = (await snapshot(page)).graph.nodes.find((n) => n.id.startsWith("node_"));
      assert.equal(Object.hasOwn(added.config, "value"), false);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await page.getByRole("button", { name: "Redo", exact: true }).click();
      assert.equal(
        Object.hasOwn(
          (await snapshot(page)).graph.nodes.find((n) => n.id === added.id).config,
          "value",
        ),
        false,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      const tooSmall = await page
        .locator("section button, section select")
        .evaluateAll(
          (controls) => controls.filter((el) => el.getBoundingClientRect().height < 44).length,
        );
      assert.equal(tooSmall, 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}

test("real canvas completes one move, syncs undo/redo and auto layout, preserves view selection", async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await mount(browser);
    await fitAll(page);
    await expect(node(page, "condition")).toBeVisible();
    assert.equal(await node(page, "trigger").locator(".react-flow__handle.target").count(), 0);
    assert.equal(await node(page, "end").locator(".react-flow__handle.source").count(), 0);
    assert.equal(await node(page, "condition").locator(".react-flow__handle.source").count(), 2);
    await node(page, "condition").focus();
    await page.keyboard.press("Enter");
    const start = await node(page, "condition").evaluate((el) => el.style.transform);
    const before = await count(page);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => count(page)).toBe(before + 1);
    const moved = await node(page, "condition").evaluate((el) => el.style.transform);
    assert.notEqual(moved, start);
    await page.keyboard.press("Control+z");
    await expect
      .poll(() => node(page, "condition").evaluate((el) => el.style.transform))
      .toBe(start);
    await page.keyboard.press("Control+Shift+z");
    await expect
      .poll(() => node(page, "condition").evaluate((el) => el.style.transform))
      .toBe(moved);
    const box = await node(page, "condition").boundingBox();
    const beforeDrag = await count(page);
    await page.mouse.move(box.x + 35, box.y + 35);
    await page.mouse.down();
    await page.mouse.move(box.x + 95, box.y + 80, { steps: 8 });
    assert.equal(await count(page), beforeDrag);
    await page.mouse.up();
    await expect.poll(() => count(page)).toBe(beforeDrag + 1);
    const state = await snapshot(page);
    await page.getByRole("button", { name: "Steps", exact: true }).click();
    await expect(step(page, "condition")).toHaveAttribute("aria-pressed", "true");
    assert.deepEqual(await snapshot(page), state);
    await page.setViewportSize({ width: 900, height: 1000 });
    await expect(page.getByRole("button", { name: "Steps", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await expect(node(page, "condition")).toHaveClass(/selected/);
    await page.getByRole("button", { name: "Auto layout", exact: true }).click();
    await expect
      .poll(() => node(page, "condition").evaluate((el) => el.style.transform))
      .toBe(start);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("deletion cleans incident edges/layout and restores focus; validation focuses nodes", async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await mount(browser);
    await fitAll(page);
    await expect(node(page, "email")).toBeVisible();
    await node(page, "email").click();
    await page.getByRole("button", { name: "Delete selected step" }).click();
    await expect(page.getByRole("button", { name: "Add step", exact: true })).toBeFocused();
    const draft = await snapshot(page);
    assert.ok(!draft.graph.nodes.some((n) => n.id === "email"));
    assert.ok(!draft.graph.edges.some((e) => e.target === "email" || e.source === "email"));
    assert.equal(Object.hasOwn(draft.layout.positions, "email"), false);
    await expect(page.getByRole("status").filter({ hasText: "Deleted Email" })).toBeVisible();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    assert.ok((await snapshot(page)).graph.nodes.some((node) => node.id === "email"));
    await expect(
      page.getByRole("status").filter({ hasText: "Undid the last change." }),
    ).toBeVisible();
    await expect(page.getByText(/Deleted Email/)).toHaveCount(0);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Redid the last change." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add step", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(
      page.getByRole("status").filter({ hasText: "Undid the last change." }),
    ).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(
      page.getByRole("status").filter({ hasText: "Redid the last change." }),
    ).toBeVisible();

    await page.evaluate(() =>
      workflowFixture.setIssues([
        {
          code: "incomplete",
          message: "Choose a comparison value.",
          node_id: "condition",
          edge_id: null,
          field: "value",
        },
      ]),
    );
    await page.getByRole("button", { name: /Choose a comparison value/ }).click();
    await expect(node(page, "condition")).toBeFocused();
    await page.getByRole("button", { name: "Steps", exact: true }).click();
    await page.getByRole("button", { name: /Choose a comparison value/ }).click();
    await expect(step(page, "condition")).toBeFocused();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("disabled blocks all edits and history while retaining navigation and native text undo", async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await mount(browser);
    await fitAll(page);
    await expect(node(page, "condition")).toBeVisible();
    await node(page, "condition").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowRight");
    await page.getByRole("checkbox", { name: "Disable editing" }).check();
    const before = await snapshot(page);
    const actions = await count(page);
    await node(page, "condition").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Control+z");
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Steps", exact: true }).click();
    await step(page, "email").click();
    await expect(step(page, "email")).toHaveAttribute("aria-pressed", "true");
    await expect(
      step(page, "email")
        .locator("..")
        .getByRole("button", { name: /^Disconnect/ }),
    ).toBeDisabled();
    assert.deepEqual(await snapshot(page), before);
    assert.equal(await count(page), actions);
    await page.getByRole("checkbox", { name: "Disable editing" }).uncheck();
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Native input inside editor fixture");
      document.querySelector("section").append(input);
    });
    const input = page.getByRole("textbox", { name: "Native input inside editor fixture" });
    await input.fill("native undo");
    await input.press("Control+z");
    assert.deepEqual(await snapshot(page), before);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("draft repair handles ID collisions, dangling connections, and missing or duplicate triggers", async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await mount(browser, { width: 600 });
    const draft = structuredClone(initialGraph);
    draft.graph.edges[0].id = "candidate_connection";
    draft.graph.edges.push({ id: "missing", source: "constructor", target: "email", port: "next" });
    draft.graph.edges.push({
      id: "missing_target",
      source: "delay",
      target: "__proto__",
      port: "next",
    });
    await page.evaluate((draft) => workflowFixture.reset(draft), draft);
    await connectStep(page, "condition", "yes", "email");
    await expect(page.getByRole("button", { name: "Remove unattached connection" })).toBeVisible();
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await expect(node(page, "delay")).toBeVisible();
    await page.getByRole("button", { name: "Steps", exact: true }).click();
    await page.getByRole("button", { name: "Remove unattached connection" }).click();
    await step(page, "delay")
      .locator("..")
      .getByRole("button", { name: /^Disconnect next/ })
      .click();
    assert.ok(
      !(await snapshot(page)).graph.edges.some(
        (e) => e.source === "constructor" || e.target === "__proto__",
      ),
    );
    draft.graph.nodes = draft.graph.nodes.filter((n) => n.type !== "trigger");
    draft.graph.edges = [];
    await page.evaluate((draft) => workflowFixture.reset(draft), draft);
    await page.getByLabel("Step type").selectOption("trigger");
    await page.getByRole("button", { name: "Add step", exact: true }).click();
    assert.equal((await snapshot(page)).graph.nodes.filter((n) => n.type === "trigger").length, 1);
    const duplicate = structuredClone(initialGraph);
    duplicate.graph.nodes.push({
      id: "trigger_two",
      type: "trigger",
      config: { event_type: null, program_id: null },
    });
    await page.evaluate((draft) => workflowFixture.reset(draft), duplicate);
    await step(page, "trigger_two").click();
    await page.getByRole("button", { name: "Delete selected step" }).click();
    assert.equal((await snapshot(page)).graph.nodes.filter((n) => n.type === "trigger").length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("canvas handles connect canonical yes/no ports and announce a rejected cycle", async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await mount(browser);
    await fitAll(page);
    async function dragConnection(source, port, target) {
      const from = await node(page, source).locator(`[data-handleid="${port}"]`).boundingBox();
      const to = await node(page, target).locator(".react-flow__handle.target").boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
      await page.mouse.up();
    }
    await dragConnection("condition", "yes", "delay");
    await expect.poll(() => count(page)).toBe(1);
    await dragConnection("condition", "no", "email");
    await expect.poll(() => count(page)).toBe(2);
    assert.deepEqual(
      (await snapshot(page)).graph.edges
        .filter((edge) => edge.source === "condition")
        .map((edge) => edge.port)
        .sort(),
      ["no", "yes"],
    );
    await dragConnection("delay", "next", "condition");
    await expect(page.getByRole("alert")).toContainText("cycle");
    assert.equal(await count(page), 2);
    await node(page, "trigger").focus();
    await page.keyboard.press("Delete");
    await expect(page.getByRole("alert")).toContainText("trigger cannot be removed");
    assert.equal(await count(page), 2);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("edge selection survives replacement in either array order", async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await mount(browser);
    await fitAll(page);
    for (const id of ["follow_end", "trigger_condition", "email_end", "follow_end"]) {
      const edge = page.locator(`[data-testid="rf__edge-${id}"]`);
      await edge.focus();
      await page.keyboard.press("Enter");
      await expect(edge).toHaveClass(/selected/);
      await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
    }
    assert.equal(await count(page), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("step names stay stable through branching, disconnect, movement, view and history edits", async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await mount(browser, { width: 600 });
    const draft = structuredClone(initialGraph);
    draft.graph.nodes.push({
      id: "email_two",
      type: "email",
      config: {
        recipient: null,
        subject_template: "Second message",
        body_template: "",
        reply_to_email: "",
      },
    });
    await page.evaluate((value) => workflowFixture.reset(value), draft);
    await expect(step(page, "email_two")).toBeVisible();
    const labels = () =>
      page
        .locator("[data-workflow-step]")
        .evaluateAll((steps) =>
          Object.fromEntries(
            steps.map((el) => [el.dataset.workflowStep, el.querySelector("strong").textContent]),
          ),
        );
    const before = await labels();
    assert.equal(before.trigger, "Trigger 1");
    assert.equal(before.condition, "Condition 1");
    assert.equal(before.email, "Email 1");
    assert.equal(before.email_two, "Email 2");
    const status = page.locator('section [role="status"]');
    await connectStep(page, "condition", "yes", "email");
    assert.deepEqual(await labels(), before);
    await expect(status).toHaveText(`Connected yes from ${before.condition} to ${before.email}.`);
    await connectStep(page, "condition", "no", "email_two");
    assert.deepEqual(await labels(), before);
    await expect(status).toHaveText(
      `Connected no from ${before.condition} to ${before.email_two}.`,
    );
    await step(page, "condition")
      .locator("..")
      .getByRole("button", { name: /^Disconnect yes/ })
      .click();
    assert.deepEqual(await labels(), before);
    await expect(status).toHaveText(`Disconnected yes from ${before.condition}.`);
    for (const action of ["Undo", "Redo", "Undo", "Auto layout"]) {
      await page.getByRole("button", { name: action, exact: true }).click();
      assert.deepEqual(await labels(), before);
    }
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await expect(node(page, "condition")).toBeVisible();
    for (const [id, label] of Object.entries(before)) {
      assert.ok((await node(page, id).getAttribute("aria-label")).startsWith(`${label}.`));
      await expect(node(page, id).locator("strong")).toHaveText(label);
    }
    await node(page, "condition").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowRight");
    await expect(node(page, "condition").locator("strong")).toHaveText(before.condition);
    await page.getByRole("button", { name: "Steps", exact: true }).click();
    assert.deepEqual(await labels(), before);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test(
  "fixture shutdown bounds an unresponsive child and preserves genuine failures",
  { timeout: 5000 },
  async () => {
    const signals = new EventEmitter();
    const stubborn = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const completed = settleFixtureChild(stubborn, { stopSignals: signals, graceMs: 100 });
    try {
      await once(stubborn.stdout, "data");
      signals.emit("SIGINT");
      await completed;
      assert.equal(stubborn.signalCode, "SIGKILL");
      assert.equal(signals.listenerCount("SIGINT"), 0);
      assert.equal(signals.listenerCount("SIGTERM"), 0);
      assert.throws(() => process.kill(stubborn.pid, 0), { code: "ESRCH" });
    } finally {
      if (stubborn.exitCode === null && stubborn.signalCode === null) stubborn.kill("SIGKILL");
    }
    const failureSignals = new EventEmitter();
    const failed = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
    await assert.rejects(
      settleFixtureChild(failed, { stopSignals: failureSignals }),
      /Next exited 7/,
    );
    assert.equal(failureSignals.listenerCount("SIGINT"), 0);
    assert.equal(failureSignals.listenerCount("SIGTERM"), 0);
  },
);

for (const prototypeId of ["constructor", "toString", "__proto__"]) {
  test(`real canvas preserves finite geometry with stationary and moved ${prototypeId}`, async () => {
    const browser = await chromium.launch();
    try {
      const { page, errors } = await mount(browser);
      const draft = structuredClone(initialGraph);
      draft.graph.nodes.find((entry) => entry.id === "end").id = prototypeId;
      draft.graph.edges.forEach((edge) => {
        if (edge.target === "end") edge.target = prototypeId;
      });
      await page.evaluate((value) => workflowFixture.reset(value), draft);
      await fitAll(page);
      await expect(node(page, prototypeId)).toBeVisible();
      await expect(node(page, prototypeId)).toHaveAttribute(
        "aria-label",
        "End 1. Finish this branch",
      );
      await expect(page.locator(".react-flow__edge-path")).toHaveCount(draft.graph.edges.length);
      const assertFiniteEdges = async () => {
        await expect(page.locator(".react-flow__edge-path")).toHaveCount(draft.graph.edges.length);
        const paths = await page
          .locator(".react-flow__edge-path")
          .evaluateAll((edges) => edges.map((edge) => edge.getAttribute("d")));
        assert.equal(paths.length, draft.graph.edges.length, JSON.stringify({ paths, errors }));
        for (const path of paths) {
          assert.ok(path && !/NaN|undefined|Infinity/.test(path), `Invalid edge geometry: ${path}`);
        }
      };
      for (const movedId of ["condition", prototypeId]) {
        await node(page, movedId).focus();
        await page.keyboard.press("Enter");
        const before = await snapshot(page);
        const actionCount = await count(page);
        const originalTransform = await node(page, movedId).evaluate(
          (element) => element.style.transform,
        );
        const box = await node(page, movedId).boundingBox();
        const hit = await page.evaluate(({ x, y }) => {
          const element = document.elementFromPoint(x + 35, y + 35);
          return {
            node: element?.closest(".react-flow__node")?.getAttribute("data-id"),
            element: element?.outerHTML,
            viewport: document.querySelector(".react-flow__viewport")?.getAttribute("style"),
          };
        }, box);
        assert.equal(hit.node, movedId, JSON.stringify({ hit, box }));
        await page.mouse.move(box.x + 35, box.y + 35);
        await page.mouse.down();
        await page.mouse.move(box.x + 85, box.y + 70, { steps: 12 });
        assert.notEqual(
          await node(page, movedId).evaluate((element) => element.style.transform),
          originalTransform,
        );
        assert.deepEqual(await snapshot(page), before);
        assert.equal(await count(page), actionCount);
        await assertFiniteEdges();
        assert.deepEqual(errors, []);
        await page.mouse.up();
        await expect.poll(() => count(page)).toBe(actionCount + 1);
        const after = await snapshot(page);
        assert.ok(
          await page.evaluate(
            (id) => Object.hasOwn(workflowFixture.draft.layout.positions, id),
            movedId,
          ),
        );
        assert.ok(Object.hasOwn(after.layout.positions, movedId));
        assert.ok(Number.isFinite(after.layout.positions[movedId].x));
        assert.ok(Number.isFinite(after.layout.positions[movedId].y));
        assert.deepEqual(
          await page.evaluate(() => {
            const action = workflowFixture.actions.at(-1);
            return { kind: action.kind, node_id: action.node_id };
          }),
          { kind: "commit_position", node_id: movedId },
        );
        await assertFiniteEdges();
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await expect.poll(() => snapshot(page)).toEqual(before);
        await assertFiniteEdges();
        await page.getByRole("button", { name: "Redo", exact: true }).click();
        await expect.poll(() => snapshot(page)).toEqual(after);
        await assertFiniteEdges();
        assert.deepEqual(errors, []);
      }
    } finally {
      await browser.close();
    }
  });
}

test("initial camera is readable and explicit Fit View shows all six nodes without editing", async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await mount(browser);
    const viewport = () =>
      page.locator(".react-flow__viewport").evaluate((element) => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
        return { x: matrix.e, y: matrix.f, zoom: matrix.a };
      });
    await expect.poll(async () => (await viewport()).zoom).toBe(0.9);
    const original = await snapshot(page);
    const margin = await node(page, "trigger").evaluate((element) => {
      const node = element.getBoundingClientRect(),
        canvas = element.closest(".react-flow").getBoundingClientRect();
      return { x: node.x - canvas.x, y: node.y - canvas.y, width: node.width };
    });
    assert.ok(
      Math.abs(margin.x - 24) < 0.1 &&
        Math.abs(margin.y - 24) < 0.1 &&
        Math.abs(margin.width - 216) < 0.1,
      JSON.stringify(margin),
    );
    await fitAll(page);
    await expect.poll(async () => (await viewport()).zoom).toBeLessThan(0.9);
    const inside = await page.locator(".react-flow__node").evaluateAll((nodes) =>
      nodes.every((element) => {
        const node = element.getBoundingClientRect(),
          canvas = element.closest(".react-flow").getBoundingClientRect();
        return (
          node.x >= canvas.x &&
          node.y >= canvas.y &&
          node.right <= canvas.right &&
          node.bottom <= canvas.bottom
        );
      }),
    );
    assert.equal(inside, true);
    assert.deepEqual(await snapshot(page), original);
    assert.equal(await count(page), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

for (const mode of ["production", "development"])
  test(`actual dimensions survive fresh presentation props without canonical edits or camera changes (${mode})`, async () => {
    const browser = await chromium.launch();
    try {
      const { page, errors } = await mount(browser, { mode, instrumentMeasurements: true });
      const currentNodes = () => page.evaluate(() => workflowMeasurements.renders.at(-1).nodes);
      const measured = async () =>
        (await currentNodes()).length === initialGraph.graph.nodes.length &&
        (await currentNodes()).every(
          (node) => node.measured?.width > 0 && node.measured?.height > 0,
        );
      await expect.poll(measured).toBe(true);
      assert.equal(await count(page), 0);
      assert.equal(await page.evaluate(() => workflowFixture.history.past.length), 0);
      const initial = await page.evaluate(() =>
        structuredClone({
          renders: workflowMeasurements.renders,
          dimensions: workflowMeasurements.dimensions,
        }),
      );
      assert.ok(initial.renders[0].nodes.every((node) => node.measured === null));
      await page.evaluate(() =>
        workflowFixture.edit({
          kind: "update_config",
          node_id: "condition",
          update: {
            type: "condition",
            config: {
              field: "program.id",
              operator: "eq",
              value: "71000000-0000-4000-8000-000000000001",
            },
          },
        }),
      );
      await expect
        .poll(
          async () =>
            (await snapshot(page)).graph.nodes.find((node) => node.id === "condition").config
              .operator,
        )
        .toBe("eq");
      await page.getByRole("button", { name: "Zoom Out", exact: true }).click();
      const camera = () =>
        page
          .locator(".react-flow__viewport")
          .evaluate((element) => getComputedStyle(element).transform);
      await expect
        .poll(() =>
          page
            .locator(".react-flow__viewport")
            .evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a),
        )
        .toBeCloseTo(0.75, 6);
      const beforeCamera = await camera();
      const beforeHistory = await page.evaluate(() => structuredClone(workflowFixture.history));
      const beforeActions = await count(page);
      const beforeRenders = await page.evaluate(() => workflowMeasurements.renders.length);
      const catalog = JSON.parse(
        readFileSync(
          new URL("../src/lib/generated/workflow-preview-catalog.json", import.meta.url),
          "utf8",
        ),
      );
      for (let index = 0; index < 10; index++) {
        await page.evaluate(
          ({ catalog, index }) => {
            const next = structuredClone(catalog);
            next.triggers["lead.created"].label = "Fresh lead label " + index;
            workflowFixture.setPresentation({
              catalog: next,
              references: {
                "program.id": {
                  status: "ready",
                  choices: [
                    { id: "71000000-0000-4000-8000-000000000001", label: "Fresh program " + index },
                  ],
                },
              },
            });
            workflowFixture.setIssues(
              index % 2
                ? [
                    {
                      code: "fixture",
                      message: "Fresh issue " + index,
                      node_id: "condition",
                      edge_id: null,
                      field: null,
                    },
                  ]
                : [],
            );
          },
          { catalog, index },
        );
        await expect
          .poll(
            async () => (await currentNodes()).find((node) => node.id === "trigger").data.summary,
          )
          .toBe("Fresh lead label " + index);
        await expect
          .poll(
            async () => (await currentNodes()).find((node) => node.id === "condition").data.summary,
          )
          .toBe("Program Is Fresh program " + index);
        assert.equal(
          (await currentNodes()).find((node) => node.id === "condition").data.issue,
          index % 2 === 1,
        );
        await expect(page.locator(".react-flow__edge-path")).toHaveCount(
          initialGraph.graph.edges.length,
        );
        for (const path of await page
          .locator(".react-flow__edge-path")
          .evaluateAll((edges) => edges.map((edge) => edge.getAttribute("d"))))
          assert.ok(path && !/NaN|undefined|Infinity/.test(path));
      }
      const observed = await page.evaluate(() => ({
        renders: workflowMeasurements.renders,
        dimensions: workflowMeasurements.dimensions,
        dom: [...document.querySelectorAll(".react-flow__node")].map((node) => ({
          id: node.dataset.id,
          width: node.offsetWidth,
          height: node.offsetHeight,
        })),
      }));
      for (const rendered of observed.renders)
        for (const node of rendered.nodes) {
          if (node.measured === null) continue;
          const actual = observed.dimensions
            .slice(0, rendered.eventCount)
            .findLast((change) => change.id === node.id);
          assert.deepEqual(
            node.measured,
            actual?.dimensions,
            `No preceding actual dimensions for ${node.id}`,
          );
        }
      for (const node of observed.renders.at(-1).nodes) {
        const dom = observed.dom.find((entry) => entry.id === node.id);
        assert.deepEqual(node.measured, { width: dom.width, height: dom.height });
      }
      assert.ok(
        observed.renders.length - beforeRenders <= 40,
        `Unbounded presentation renders: ${observed.renders.length - beforeRenders}`,
      );
      assert.deepEqual(
        await page.evaluate(() => structuredClone(workflowFixture.history)),
        beforeHistory,
      );
      assert.equal(await count(page), beforeActions);
      assert.equal(await camera(), beforeCamera);
      const renderCount = await page.evaluate(() => {
        const actual = [
          ...new Map(workflowMeasurements.dimensions.map((change) => [change.id, change])).values(),
        ];
        const before = workflowMeasurements.renders.length;
        for (let index = 0; index < 10; index++) workflowMeasurements.notify(actual);
        return before;
      });
      assert.ok(
        (await page.evaluate(() => workflowMeasurements.renders.length)) <= renderCount + 2,
        "Equal actual measurements must settle without repeated renders",
      );
      assert.deepEqual(
        await page.evaluate(() => structuredClone(workflowFixture.history)),
        beforeHistory,
      );
      assert.equal(await camera(), beforeCamera);
      await page.evaluate(() => workflowFixture.edit({ kind: "remove_node", node_id: "email" }));
      await expect
        .poll(async () => (await currentNodes()).some((node) => node.id === "email"))
        .toBe(false);
      const removalRenders = await page.evaluate(() => workflowMeasurements.renders.length);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(measured).toBe(true);
      const readded = await page.evaluate(
        (index) =>
          workflowMeasurements.renders
            .slice(index)
            .find((render) => render.nodes.some((node) => node.id === "email"))
            .nodes.find((node) => node.id === "email"),
        removalRenders,
      );
      assert.equal(readded.measured, null, "Removed IDs must not retain dimensions when re-added");
      await expect(page.locator(".react-flow__edge-path")).toHaveCount(
        initialGraph.graph.edges.length,
      );
      assert.equal(await count(page), beforeActions + 1);
      assert.deepEqual(await snapshot(page), beforeHistory.present);
      assert.equal(await camera(), beforeCamera);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });

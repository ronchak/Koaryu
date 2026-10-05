import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { bundleWorkflowGraph, workflowGraphCss } from "./helpers/workflow-graph-mounted.mjs";
import { initialGraph, settleFixtureChild } from "./helpers/workflow-graph-fixture.mjs";

const bundles = new Map();
async function mount(browser, { width = 1200, mode = "production" } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    route.request().url() === "http://localhost/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: workflowGraphCss });
  if (!bundles.has(mode)) bundles.set(mode, bundleWorkflowGraph(mode));
  await page.addScriptTag({ content: bundles.get(mode) });
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
const snapshot = (page) => page.evaluate(() => workflowFixture.draft);
const count = (page) => page.evaluate(() => workflowFixture.actions.length);
const node = (page, id) => page.locator(`[data-testid="rf__node-${id}"]`);
const step = (page, id) => page.locator(`[data-workflow-step="${id}"]`);
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
    await expect(node(page, "email")).toBeVisible();
    await node(page, "email").click();
    await page.getByRole("button", { name: "Delete selected step" }).click();
    await expect(page.getByRole("button", { name: "Add step", exact: true })).toBeFocused();
    const draft = await snapshot(page);
    assert.ok(!draft.graph.nodes.some((n) => n.id === "email"));
    assert.ok(!draft.graph.edges.some((e) => e.target === "email" || e.source === "email"));
    assert.equal(Object.hasOwn(draft.layout.positions, "email"), false);
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
    draft.graph.edges.push({ id: "missing", source: "gone", target: "email", port: "next" });
    draft.graph.edges.push({ id: "missing_target", source: "delay", target: "gone", port: "next" });
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
      !(await snapshot(page)).graph.edges.some((e) => e.source === "gone" || e.target === "gone"),
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

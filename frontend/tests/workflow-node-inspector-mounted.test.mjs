import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import {
  bundleWorkflowInspector,
  workflowInspectorCss,
} from "./helpers/workflow-node-inspector-mounted.mjs";
import {
  backendUnicodeDraft,
  catalog,
  references,
} from "./helpers/workflow-node-inspector-fixture.mjs";
import { initialGraph } from "./helpers/workflow-graph-fixture.mjs";
import { canonicalWorkflowDraft } from "../src/lib/automation-workflow-model.ts";
const bundles = new Map();
const program = references["program.id"].choices[0].id;
const rank = references["promotion.rank_id"].choices[0].id;
const missing = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function withFixture(run, { width = 600, mode = "production" } = {}) {
  const browser = await chromium.launch();
  try {
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
    await page.addStyleTag({ content: workflowInspectorCss });
    if (!bundles.has(mode)) bundles.set(mode, bundleWorkflowInspector(mode));
    await page.addScriptTag({ content: bundles.get(mode) });
    await page.waitForFunction(() => window.workflowFixture);
    await run(page, page.getByRole("complementary"));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
const config = (page, id = "condition") =>
  page.evaluate((id) => workflowFixture.draft.graph.nodes.find((n) => n.id === id).config, id);
const actions = (page) => page.evaluate(() => workflowFixture.actions);
const select = (page, id) => page.getByLabel("Inspect synthetic step").selectOption(id);
async function reset(page, change) {
  const draft = structuredClone(initialGraph);
  change(draft);
  await page.evaluate((draft) => workflowFixture.reset(draft), draft);
  await expect
    .poll(() => page.evaluate(() => workflowFixture.draft))
    .toEqual(canonicalWorkflowDraft(draft));
}

for (const mode of ["production", "development"])
  test(`all six node forms are controlled, labeled and fit 320px (${mode})`, async () => {
    await withFixture(
      async (page, panel) => {
        await expect(panel.getByRole("heading", { name: "Condition settings" })).toBeFocused();
        await panel
          .getByLabel("Comparison field", { exact: true })
          .selectOption("lead.unconverted");
        await panel.getByLabel("Comparison operator").selectOption("eq");
        await panel.getByLabel("Comparison value", { exact: true }).selectOption("false");
        assert.deepEqual(await config(page), {
          field: "lead.unconverted",
          operator: "eq",
          value: false,
        });
        assert.equal((await actions(page)).length, 3);
        assert.deepEqual((await actions(page)).at(-1), {
          kind: "update_config",
          node_id: "condition",
          update: {
            type: "condition",
            config: { field: "lead.unconverted", operator: "eq", value: false },
          },
        });
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        assert.equal(Object.hasOwn(await config(page), "value"), false);
        await page.getByRole("button", { name: "Redo", exact: true }).click();
        await expect(panel.getByLabel("Comparison value", { exact: true })).toHaveValue("false");
        for (const [id, title] of [
          ["trigger", "Trigger"],
          ["delay", "Delay"],
          ["email", "Email"],
          ["follow", "Lead follow-up"],
          ["end", "End"],
        ]) {
          await page.locator(`[data-workflow-step="${id}"]`).click();
          await expect(panel.getByRole("heading", { name: `${title} settings` })).toBeFocused();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          assert.equal(
            await panel
              .locator("button,input,select,textarea,summary")
              .evaluateAll(
                (nodes) => nodes.filter((n) => n.getBoundingClientRect().height < 44).length,
              ),
            0,
          );
        }
        await expect(panel).toContainText("This branch finishes");
        await expect(panel.locator("input,select,textarea")).toHaveCount(0);
        await panel.getByRole("button", { name: "Close settings" }).click();
        await expect(panel).toContainText("Select a step");
      },
      { width: 320, mode },
    );
  });

test("nullable enum and UUID choose explicit No value while clear omits it", async () => {
  await withFixture(async (page, panel) => {
    await reset(page, (draft) => {
      draft.graph.nodes[0].config.event_type = "invoice.overdue";
    });
    await panel
      .getByLabel("Comparison field", { exact: true })
      .selectOption("invoice.collection_method");
    await panel.getByLabel("Comparison operator").selectOption("eq");
    assert.equal(Object.hasOwn(await config(page), "value"), false);
    await panel.getByLabel("Comparison value", { exact: true }).selectOption("null");
    assert.equal((await config(page)).value, null);
    await panel.getByRole("button", { name: "Clear value", exact: true }).click();
    assert.equal(Object.hasOwn(await config(page), "value"), false);
    await reset(page, (draft) => {
      draft.graph.nodes[0].config.event_type = "student.promoted";
    });
    await panel.getByLabel("Comparison field", { exact: true }).selectOption("program.id");
    await panel.getByLabel("Comparison operator").selectOption("neq");
    await panel.getByLabel("Comparison value", { exact: true }).selectOption("null");
    assert.equal((await config(page)).value, null);
    await panel
      .getByLabel("Comparison value", { exact: true })
      .selectOption(JSON.stringify(program));
    assert.equal((await config(page)).value, program);
    await panel.getByLabel("Comparison field", { exact: true }).selectOption("promotion.rank_id");
    assert.equal(Object.hasOwn(await config(page), "value"), false);
    await panel.getByLabel("Comparison value", { exact: true }).selectOption(JSON.stringify(rank));
    assert.equal((await config(page)).value, rank);
    assert.equal(
      await panel
        .getByLabel("Comparison value", { exact: true })
        .locator('option[value="null"]')
        .count(),
      0,
    );
    await panel.getByRole("button", { name: "Clear comparison" }).click();
    assert.deepEqual(await config(page), { field: null, operator: null });
  });
});

test("references can disappear or load without erasing values; membership repair is explicit", async () => {
  await withFixture(async (page, panel) => {
    await reset(page, (draft) => {
      draft.graph.nodes.find((n) => n.id === "condition").config = {
        field: "program.id",
        operator: "eq",
        value: missing,
      };
    });
    await expect(panel.getByLabel("Comparison value", { exact: true })).toContainText(
      `Unavailable: ${missing}`,
    );
    await panel.getByLabel("Comparison operator").selectOption("neq");
    assert.equal((await config(page)).value, missing);
    await panel
      .getByLabel("Comparison value", { exact: true })
      .selectOption(JSON.stringify(program));
    await page.evaluate(() =>
      workflowFixture.setReferences({ "program.id": { status: "loading", choices: [] } }),
    );
    await expect(panel).toContainText("Reference choices are loading");
    await panel.getByLabel("Comparison operator").selectOption("eq");
    assert.equal((await config(page)).value, program);
    await expect(panel.getByLabel("Comparison value", { exact: true })).toContainText(
      `Unavailable: ${program}`,
    );
    await reset(page, (draft) => {
      draft.graph.nodes.find((n) => n.id === "condition").config = {
        field: "program.id",
        operator: "in",
        value: [missing, program],
      };
    });
    await panel.getByLabel("Comparison operator").selectOption("not_in");
    assert.deepEqual((await config(page)).value, [missing, program]);
    await panel.getByRole("button", { name: `Remove comparison value 1: ${missing}` }).click();
    assert.deepEqual((await config(page)).value, [program]);
    await panel.getByRole("button", { name: `Remove comparison value 1: ${program}` }).click();
    assert.equal(Object.hasOwn(await config(page), "value"), false);
    await panel.getByLabel("Add comparison value").selectOption(JSON.stringify(program));
    assert.deepEqual((await config(page)).value, [program]);
    await page.evaluate(() => workflowFixture.setReferences({}));
    await panel.getByLabel("Comparison operator").selectOption("in");
    assert.deepEqual((await config(page)).value, [program]);
    await expect(panel).toContainText("Reference choices are unavailable");
    await expect(panel.locator('input[type="text"]')).toHaveCount(0);
  });
});

test("trigger changes preserve downstream stale config, program filter and offset for repair", async () => {
  await withFixture(async (page, panel) => {
    await reset(page, (draft) => {
      draft.graph.nodes[0].config = {
        event_type: "trial.upcoming",
        program_id: program,
        offset_minutes: -1440,
      };
      draft.graph.nodes.find((n) => n.id === "condition").config = {
        field: "trial.status",
        operator: "eq",
        value: "scheduled",
      };
      draft.graph.nodes.find((n) => n.id === "delay").config = {
        mode: "until",
        field: "trial.starts_at",
        offset_minutes: -60,
      };
      draft.graph.nodes.find((n) => n.id === "email").config.body_template =
        "See you {{trial_start}} {{constructor}}";
    });
    const before = await page.evaluate(() =>
      workflowFixture.draft.graph.nodes.filter((n) => n.type !== "trigger"),
    );
    await select(page, "trigger");
    await panel.getByLabel("Trigger event").selectOption("invoice.overdue");
    assert.deepEqual(await config(page, "trigger"), {
      event_type: "invoice.overdue",
      program_id: program,
      offset_minutes: -1440,
    });
    assert.deepEqual(
      await page.evaluate(() =>
        workflowFixture.draft.graph.nodes.filter((n) => n.type !== "trigger"),
      ),
      before,
    );
    await expect(panel).toContainText("does not support a program filter");
    await panel.getByRole("button", { name: "Clear filter" }).click();
    await panel.getByRole("button", { name: "Remove offset" }).click();
    assert.deepEqual(await config(page, "trigger"), {
      event_type: "invoice.overdue",
      program_id: null,
    });
    await select(page, "condition");
    await expect(panel).toContainText("saved field is unavailable");
    await panel.getByRole("button", { name: "Clear comparison" }).click();
    await select(page, "delay");
    await expect(panel.getByLabel("Event time", { exact: true })).toContainText(
      "Unavailable: Trial start",
    );
    await panel.getByRole("button", { name: "Clear event time" }).click();
    assert.equal((await config(page, "delay")).field, null);
    await select(page, "email");
    await expect(panel).toContainText("saved recipient policy is unavailable");
    await expect(panel).toContainText("Unavailable placeholders: {{trial_start}}, {{constructor}}");
    await expect(panel.getByLabel("Message", { exact: true })).toHaveValue(
      "See you {{trial_start}} {{constructor}}",
    );
    await panel.getByLabel("Recipient policy").selectOption("invoice_payer");
    await panel.getByLabel("Insert variable into subject").selectOption("invoice_number");
    assert.ok((await config(page, "email")).subject_template.endsWith("{{invoice_number}}"));
    await panel.getByLabel("Reply-to email").fill("reply@example.test");
    await panel.getByLabel("Reply-to email").fill("");
    assert.equal((await config(page, "email")).reply_to_email, "");
    await expect(panel.getByLabel("Reply-to email")).not.toHaveAttribute("maxlength");
    await expect(panel.getByLabel("Subject", { exact: true })).not.toHaveAttribute("maxlength");
    await expect(panel.getByLabel("Message", { exact: true })).not.toHaveAttribute("maxlength");
    await select(page, "follow");
    await expect(panel).toContainText("does not support lead follow-up");
    assert.equal((await config(page, "follow")).note, "Call back");
  });
});

test("duration, upcoming and follow-up blanks use their distinct canonical empty values", async () => {
  await withFixture(async (page, panel) => {
    await select(page, "delay");
    await panel.getByLabel("Duration in minutes").fill("");
    assert.deepEqual(await config(page, "delay"), { mode: "duration", minutes: null });
    await panel.getByLabel("Duration in minutes").fill("0");
    assert.equal((await config(page, "delay")).minutes, 0);
    const before = (await actions(page)).length;
    for (const invalid of ["-1", "129601", "1.5"])
      await panel.getByLabel("Duration in minutes").fill(invalid);
    assert.equal((await actions(page)).length, before);
    await select(page, "trigger");
    await panel.getByLabel("Trigger event").selectOption("trial.upcoming");
    assert.equal(Object.hasOwn(await config(page, "trigger"), "offset_minutes"), false);
    await panel.getByLabel("Minutes before event").pressSequentially("1440");
    assert.equal((await config(page, "trigger")).offset_minutes, -1440);
    await panel.getByLabel("Minutes before event").fill("");
    assert.equal(Object.hasOwn(await config(page, "trigger"), "offset_minutes"), false);
    await panel.getByLabel("Program filter").selectOption(program);
    assert.equal((await config(page, "trigger")).program_id, program);
    await select(page, "follow");
    await panel.getByLabel("Follow-up due in days").fill("");
    assert.equal((await config(page, "follow")).due_in_days, null);
    await panel.getByLabel("Follow-up due in days").fill("90");
    assert.equal((await config(page, "follow")).due_in_days, 90);
    await panel.getByLabel("Follow-up note").fill("Call next week");
    assert.equal((await config(page, "follow")).note, "Call next week");
    await expect(panel.getByLabel("Follow-up note")).not.toHaveAttribute("maxlength");
  });
});

test("until timing explicitly controls sign and clearing magnitude returns to zero", async () => {
  await withFixture(async (page, panel) => {
    await reset(page, (draft) => {
      draft.graph.nodes[0].config.event_type = "trial.scheduled";
    });
    await select(page, "delay");
    await panel.getByLabel("Delay mode").selectOption("until");
    assert.deepEqual(await config(page, "delay"), {
      mode: "until",
      field: null,
      offset_minutes: 0,
    });
    await panel.getByLabel("Event time", { exact: true }).selectOption("trial.starts_at");
    await panel.getByLabel("Timing", { exact: true }).selectOption("before");
    assert.equal((await config(page, "delay")).offset_minutes, -1);
    await panel.getByLabel("Offset in minutes", { exact: true }).fill("129600");
    assert.equal((await config(page, "delay")).offset_minutes, -129600);
    await panel.getByLabel("Timing", { exact: true }).selectOption("after");
    assert.equal((await config(page, "delay")).offset_minutes, 129600);
    await panel.getByLabel("Offset in minutes", { exact: true }).fill("");
    await expect(panel.getByLabel("Timing", { exact: true })).toHaveValue("at");
    assert.equal((await config(page, "delay")).offset_minutes, 0);
    await panel.getByLabel("Timing", { exact: true }).selectOption("after");
    assert.equal((await config(page, "delay")).offset_minutes, 1);
    await expect(panel).toContainText("event or studio timezone");
    await expect(panel).toContainText("obsolete pre-event reminder is skipped");
    await panel.getByLabel("Delay mode").selectOption("duration");
    assert.deepEqual(await config(page, "delay"), { mode: "duration", minutes: null });
  });
});

test("missing, duplicate and prototype trigger/field IDs remain repairable; future types are honest", async () => {
  await withFixture(async (page, panel) => {
    for (const scenario of ["missing", "duplicate", "constructor", "toString", "__proto__"]) {
      await reset(page, (draft) => {
        if (scenario === "missing") draft.graph.nodes.shift();
        else if (scenario === "duplicate")
          draft.graph.nodes.push({ ...draft.graph.nodes[0], id: "other_trigger" });
        else draft.graph.nodes[0].config.event_type = scenario;
        draft.graph.nodes.find((n) => n.id === "condition").config = {
          field: "constructor",
          operator: "eq",
          value: false,
        };
      });
      await expect(panel.getByLabel("Comparison field", { exact: true })).toContainText(
        "Unavailable: constructor",
      );
      await expect(panel.getByLabel("Comparison value", { exact: true })).toBeDisabled();
      await expect(panel).toContainText("event-specific settings");
      await panel.getByRole("button", { name: "Clear comparison" }).click();
      assert.deepEqual(await config(page), { field: null, operator: null });
    }
    await reset(page, (draft) => {
      draft.graph.nodes.find((n) => n.id === "condition").config = {
        field: "future.amount",
        operator: "gt",
        value: 42,
      };
    });
    const future = structuredClone(catalog);
    future.fields["future.amount"] = {
      id: "future.amount",
      label: "Future amount",
      value_type: "number",
      operators: ["eq", "gt"],
      nullable: false,
    };
    future.triggers["lead.created"].field_ids.push("future.amount");
    await page.evaluate((value) => workflowFixture.setCatalog(value), future);
    await expect(panel).toContainText("field type is not supported");
    assert.equal((await config(page)).value, 42);
    await panel.getByRole("button", { name: "Clear comparison" }).click();
    assert.equal(Object.hasOwn(await config(page), "value"), false);
  });
});

test("issues attach to fields and summary; disabled retains navigation and close", async () => {
  await withFixture(async (page, panel) => {
    await page.evaluate(() =>
      workflowFixture.setIssues([
        {
          code: "unfinished",
          node_id: "condition",
          edge_id: null,
          field: "config.value",
          message: "Select a comparison value before validation.",
        },
      ]),
    );
    const value = panel.getByLabel("Comparison value", { exact: true });
    await expect(value).toHaveAttribute("aria-invalid", "true");
    await expect(value).toHaveAccessibleDescription(/Select a comparison value before validation/);
    await expect(panel.getByRole("region", { name: "Step issues" })).toContainText(
      "Select a comparison value before validation.",
    );
    await page.getByLabel("Disable editing", { exact: true }).check();
    const before = await actions(page);
    for (const id of ["trigger", "condition", "delay", "email", "follow", "end"]) {
      await select(page, id);
      for (const element of await panel
        .locator("fieldset input,fieldset select,fieldset textarea,fieldset button")
        .all())
        await expect(element).toBeDisabled();
    }
    assert.deepEqual(await actions(page), before);
    await panel.getByRole("button", { name: "Close settings" }).click();
    await expect(panel).toContainText("Select a step");
  });
});

test("warning text remains readable in both app themes", async () => {
  await withFixture(
    async (page, panel) => {
      await page.evaluate(() =>
        workflowFixture.setIssues([
          {
            code: "unfinished",
            node_id: "condition",
            edge_id: null,
            field: "value",
            message: "Choose a comparison value.",
          },
        ]),
      );
      for (const theme of ["light", "dark"]) {
        await page.getByLabel("Fixture theme").selectOption(theme);
        const ratio = await panel
          .getByText("Choose a comparison value.", { exact: true })
          .last()
          .evaluate((element) => {
            const luminance = (color) => {
              const channels = color
                .match(/[\d.]+/g)
                .slice(0, 3)
                .map((value) => Number(value) / 255)
                .map((value) =>
                  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
                );
              return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
            };
            const text = luminance(getComputedStyle(element).color),
              background = luminance(getComputedStyle(element.closest("aside")).backgroundColor);
            return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
          });
        assert.ok(ratio >= 4.5, `${theme} contrast ratio ${ratio}`);
      }
    },
    { width: 320 },
  );
});

const serializedConfig = async (page, id) =>
  JSON.parse(await page.locator("[data-graph-json]").textContent()).graph.nodes.find(
    (node) => node.id === id,
  ).config;

test("actual backend Unicode draft displays intact and persists edits through undo/redo", async () => {
  await withFixture(async (page, panel) => {
    await page.getByRole("button", { name: "Load backend Unicode draft" }).click();
    const original = backendUnicodeDraft.graph.nodes.find((node) => node.id === "email").config
      .subject_template;
    const subject = panel.getByLabel("Subject", { exact: true });
    await expect(subject).toHaveValue(original);
    assert.equal(Array.from(original).length, 150);
    assert.equal((await serializedConfig(page, "email")).subject_template, original);
    await subject.pressSequentially("🥋");
    assert.equal((await serializedConfig(page, "email")).subject_template, original + "🥋");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(subject).toHaveValue(original);
    assert.equal((await serializedConfig(page, "email")).subject_template, original);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(subject).toHaveValue(original + "🥋");
    assert.equal((await serializedConfig(page, "email")).subject_template, original + "🥋");
  });
});

test("text controls accept astral limits and keep max+1 out of the canonical graph", async () => {
  await withFixture(async (page, panel) => {
    for (const [id, label, key, limit] of [
      ["email", "Subject", "subject_template", 200],
      ["email", "Message", "body_template", 5000],
      ["follow", "Follow-up note", "note", 1000],
      ["email", "Reply-to email", "reply_to_email", 254],
    ]) {
      await select(page, id);
      const input = panel.getByLabel(label, { exact: true });
      await expect(input).not.toHaveAttribute("maxlength");
      const start = "🥋".repeat(limit - 1);
      await input.fill(start);
      assert.equal((await serializedConfig(page, id))[key], start);
      await input.pressSequentially("🥋");
      const maximum = "🥋".repeat(limit);
      await expect(input).toHaveValue(maximum);
      assert.equal((await serializedConfig(page, id))[key], maximum);
      const before = (await actions(page)).length;
      await input.pressSequentially("🥋");
      await expect(input).toHaveValue(maximum);
      assert.equal((await serializedConfig(page, id))[key], maximum);
      assert.equal((await actions(page)).length, before);
      const mixedMaximum = "🥋".repeat(limit - 3) + "Ae\u0301";
      await input.fill(mixedMaximum + "🥋");
      await expect(input).toHaveValue(mixedMaximum);
      assert.equal((await serializedConfig(page, id))[key], mixedMaximum);
      assert.equal(Array.from((await serializedConfig(page, id))[key]).length, limit);
    }
  });
});

test("variable append uses codepoint space and never inserts a partial placeholder", async () => {
  await withFixture(async (page, panel) => {
    await select(page, "email");
    const placeholder = "{{studio_name}}";
    for (const [label, key, limit] of [
      ["Subject", "subject_template", 200],
      ["Message", "body_template", 5000],
    ]) {
      const input = panel.getByLabel(label, { exact: true });
      const picker = panel.getByLabel(`Insert variable into ${label.toLowerCase()}`);
      const prefix = "🥋".repeat(limit - placeholder.length);
      await input.fill(prefix);
      await expect(picker.locator('option[value="studio_name"]')).toHaveJSProperty(
        "disabled",
        false,
      );
      await picker.selectOption("studio_name");
      await expect(input).toHaveValue(prefix + placeholder);
      assert.equal((await serializedConfig(page, "email"))[key], prefix + placeholder);
      assert.equal(Array.from((await serializedConfig(page, "email"))[key]).length, limit);
      await expect(picker.locator('option[value="studio_name"]')).toHaveJSProperty(
        "disabled",
        true,
      );
      await input.fill(prefix + "🥋");
      await expect(picker.locator('option[value="studio_name"]')).toHaveJSProperty(
        "disabled",
        true,
      );
      assert.equal((await serializedConfig(page, "email"))[key], prefix + "🥋");
    }
  });
});

test("known unavailable choices retain readable labels and their IDs when the trigger returns", async () => {
  await withFixture(async (page, panel) => {
    await reset(page, (draft) => {
      draft.graph.nodes[0].config = { event_type: "trial.scheduled", program_id: program };
      draft.graph.nodes.find((node) => node.id === "condition").config = {
        field: "program.id",
        operator: "eq",
        value: program,
      };
      draft.graph.nodes.find((node) => node.id === "delay").config = {
        mode: "until",
        field: "trial.starts_at",
        offset_minutes: -60,
      };
    });
    const original = await page.evaluate(() => workflowFixture.draft);
    await select(page, "trigger");
    await panel.getByLabel("Trigger event").selectOption("invoice.overdue");
    const cases = [
      ["trigger", "Program filter", program, "Junior program"],
      ["condition", "Comparison field", "program.id", "Program"],
      ["condition", "Comparison operator", "eq", "Is"],
      ["condition", "Comparison value", JSON.stringify(program), "Junior program"],
      ["email", "Recipient policy", "lead_or_guardian", "Lead or guardian"],
      ["delay", "Event time", "trial.starts_at", "Trial start"],
    ];
    for (const [id, label, value, knownLabel] of cases) {
      await select(page, id);
      const control = panel.getByLabel(label, { exact: true });
      await expect(control).toHaveValue(value);
      const option = control.locator("option").filter({ hasText: `Unavailable: ${knownLabel}` });
      await expect(option).toHaveCount(1);
      await expect(option).toHaveJSProperty("disabled", true);
    }
    assert.equal((await config(page, "trigger")).program_id, program);
    assert.equal((await actions(page)).length, 1);
    await select(page, "trigger");
    await panel.getByLabel("Trigger event").selectOption("trial.scheduled");
    for (const [id, label, value, knownLabel] of cases) {
      await select(page, id);
      const control = panel.getByLabel(label, { exact: true });
      await expect(control).toHaveValue(value);
      const selectedOption = control.locator("option:checked");
      await expect(selectedOption).toHaveText(knownLabel);
      await expect(selectedOption).toHaveJSProperty("disabled", false);
    }
    assert.deepEqual(await page.evaluate(() => workflowFixture.draft), original);
    assert.equal((await actions(page)).length, 2);
  });
});

test("unknown saved IDs stay identifiable and clearable without borrowing another choice's label", async () => {
  await withFixture(async (page, panel) => {
    await reset(page, (draft) => {
      draft.graph.nodes[0].config = { event_type: "invoice.overdue", program_id: missing };
      draft.graph.nodes.find((node) => node.id === "condition").config = {
        field: "constructor",
        operator: "__proto__",
        value: missing,
      };
      draft.graph.nodes.find((node) => node.id === "email").config.recipient = "constructor";
      draft.graph.nodes.find((node) => node.id === "delay").config = {
        mode: "until",
        field: "toString",
        offset_minutes: 0,
      };
    });
    for (const [id, label, value] of [
      ["trigger", "Program filter", missing],
      ["condition", "Comparison field", "constructor"],
      ["condition", "Comparison operator", "__proto__"],
      ["condition", "Comparison value", missing],
      ["email", "Recipient policy", "constructor"],
      ["delay", "Event time", "toString"],
    ]) {
      await select(page, id);
      await expect(panel.getByLabel(label, { exact: true }).locator("option:checked")).toHaveText(
        `Unavailable: ${value}`,
      );
    }
    assert.equal((await actions(page)).length, 0);
    await select(page, "trigger");
    await panel.getByRole("button", { name: "Clear filter" }).click();
    assert.equal((await config(page, "trigger")).program_id, null);
    await select(page, "condition");
    await panel.getByRole("button", { name: "Clear comparison" }).click();
    assert.deepEqual(await config(page), { field: null, operator: null });
    await select(page, "email");
    await panel.getByLabel("Recipient policy").selectOption("");
    assert.equal((await config(page, "email")).recipient, null);
    await select(page, "delay");
    await panel.getByRole("button", { name: "Clear event time" }).click();
    assert.equal((await config(page, "delay")).field, null);
  });
});

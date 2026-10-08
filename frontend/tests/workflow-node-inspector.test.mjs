import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addConditionMember,
  catalogEntry,
  changeConditionField,
  changeConditionOperator,
  clearConditionValue,
  conditionOperators,
  conditionValueChoices,
  parseWorkflowInteger,
  removeConditionMember,
  supportedConditionField,
  unsupportedTemplateVariables,
  validConditionValue,
  workflowApplicability,
  workflowReferenceLabel,
  workflowReferences,
  workflowTemplateVariables,
} from "../src/lib/automation-workflow-catalog.ts";
import {
  canonicalWorkflowDraft,
  createWorkflowHistory,
  editWorkflowHistory,
  undoWorkflow,
  redoWorkflow,
} from "../src/lib/automation-workflow-model.ts";
import {
  catalog,
  catalogSourceSha,
  references,
} from "./helpers/workflow-node-inspector-fixture.mjs";
import { initialGraph } from "./helpers/workflow-graph-fixture.mjs";
const program = references["program.id"].choices[0].id;
const missing = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

for (const trigger of Object.values(catalog.triggers)) {
  test(`actual catalog applicability: ${trigger.id}`, () => {
    const draft = structuredClone(initialGraph);
    draft.graph.nodes[0].config.event_type = trigger.id;
    const result = workflowApplicability(draft, catalog);
    assert.equal(result.reason, null);
    assert.deepEqual(
      result.fields.map((item) => item.id),
      trigger.field_ids,
    );
    assert.deepEqual(
      result.recipients.map((item) => item.id),
      trigger.recipient_ids,
    );
    assert.deepEqual(
      result.variables.map((item) => item.id),
      trigger.template_variables,
    );
    assert.deepEqual(
      result.delayFields.map((item) => item.id),
      trigger.delay_fields,
    );
    assert.equal(result.trigger.supports_program_filter, !trigger.id.startsWith("invoice."));
    assert.equal(result.trigger.supports_offset, trigger.id.endsWith(".upcoming"));
  });
}
test("catalog provenance and real availability exclusions remain explicit", () => {
  assert.equal(catalogSourceSha, "a5d0e643d7ec1c9c44a99664cb1d59fc352c8bcb");
  assert.equal(Object.keys(catalog.triggers).length, 12);
  assert.ok(!catalog.triggers["student.enrolled"].field_ids.includes("program.id"));
  for (const trigger of ["trial.completed", "trial.no_show"])
    assert.deepEqual(catalog.triggers[trigger].delay_fields, []);
  assert.equal(catalog.variables.studio_name.fallback, null);
  assert.equal(catalog.variables.recipient_name.fallback, "there");
});

test("saved reference labels match exact supplied IDs without making choices available", () => {
  for (const status of ["ready", "loading", "unavailable"]) {
    const current = { "program.id": { status, choices: references["program.id"].choices } };
    assert.equal(workflowReferenceLabel(current, "program.id", program), "Junior program");
    assert.equal(workflowReferenceLabel(current, "program.id", missing), undefined);
    assert.equal(workflowReferenceLabel(current, "promotion.rank_id", program), undefined);
    assert.equal(workflowReferenceLabel(current, "constructor", program), undefined);
    assert.equal(
      workflowReferences(current, "program.id").choices.length,
      status === "ready" ? 2 : 0,
    );
  }
  assert.equal(workflowReferenceLabel(Object.create(references), "program.id", program), undefined);
});
test("missing, duplicate and prototype-named trigger events offer no dependent choices", () => {
  for (const state of ["absent", "duplicate", "constructor", "toString", "__proto__", null]) {
    const draft = structuredClone(initialGraph);
    if (state === "absent") draft.graph.nodes.shift();
    else if (state === "duplicate")
      draft.graph.nodes.push({ ...draft.graph.nodes[0], id: "trigger2" });
    else draft.graph.nodes[0].config.event_type = state;
    const result = workflowApplicability(draft, catalog);
    assert.equal(result.trigger, undefined);
    assert.ok(result.reason);
    for (const key of ["fields", "recipients", "variables", "delayFields"])
      assert.deepEqual(result[key], []);
  }
  for (const id of ["constructor", "__proto__", "toString"])
    assert.equal(catalogEntry(catalog.fields, id), undefined);
  assert.deepEqual(workflowReferences({}, "constructor"), { status: "unavailable", choices: [] });
});
test("boolean false, omitted values and nullable enum/UUID null stay distinct through history", () => {
  const bool = catalog.fields["lead.unconverted"];
  assert.equal(validConditionValue(false, bool, "eq", references), true);
  assert.equal(validConditionValue(null, bool, "eq", references), false);
  for (const field of [catalog.fields["program.id"], catalog.fields["invoice.collection_method"]]) {
    assert.equal(validConditionValue(undefined, field, "eq", references), false);
    assert.equal(validConditionValue(null, field, "eq", references), true);
    assert.equal(validConditionValue([null], field, "in", references), false);
  }
  let history = createWorkflowHistory(initialGraph);
  const changed = editWorkflowHistory(history, {
    kind: "update_config",
    node_id: "condition",
    update: { type: "condition", config: { field: "program.id", operator: "eq", value: null } },
  });
  assert.ok(changed.ok);
  history = changed.history;
  const restored = undoWorkflow(history).present.graph.nodes.find(
    (n) => n.id === "condition",
  ).config;
  assert.equal(Object.hasOwn(restored, "value"), false);
  assert.equal(
    redoWorkflow(undoWorkflow(history)).present.graph.nodes.find((n) => n.id === "condition").config
      .value,
    null,
  );
});
test("explicit field changes reset only incompatible operators and values", () => {
  assert.deepEqual(
    changeConditionField(
      { field: "lead.stage", operator: "in", value: ["inquiry"] },
      catalog.fields["lead.unconverted"],
      references,
    ),
    { field: "lead.unconverted", operator: null },
  );
  assert.deepEqual(
    changeConditionField(
      { field: "student.on_hold", operator: "eq", value: false },
      catalog.fields["student.is_minor"],
      references,
    ),
    { field: "student.is_minor", operator: "eq", value: false },
  );
  assert.deepEqual(
    changeConditionField(
      { field: "lead.stage", operator: "eq", value: "inquiry" },
      catalog.fields["trial.status"],
      references,
    ),
    { field: "trial.status", operator: "eq" },
  );
  assert.deepEqual(
    changeConditionField(
      { field: "program.id", operator: "eq", value: missing },
      undefined,
      references,
    ),
    { field: null, operator: null },
  );
});
test("operator changes preserve removed or loading references until explicit repair", () => {
  for (const value of [program, missing]) {
    for (const status of ["ready", "loading", "unavailable"]) {
      const current = {
        "program.id": {
          status,
          choices: status === "ready" ? references["program.id"].choices : [],
        },
      };
      assert.equal(
        conditionValueChoices(catalog.fields["program.id"], current).some((c) => c.value === value),
        status === "ready" && value === program,
      );
      for (const [from, to] of [
        ["eq", "neq"],
        ["neq", "eq"],
      ]) {
        assert.deepEqual(
          changeConditionOperator(
            { field: "program.id", operator: from, value },
            to,
            catalog.fields["program.id"],
          ),
          { field: "program.id", operator: to, value },
        );
      }
      for (const [from, to] of [
        ["in", "not_in"],
        ["not_in", "in"],
      ]) {
        assert.deepEqual(
          changeConditionOperator(
            { field: "program.id", operator: from, value: [value] },
            to,
            catalog.fields["program.id"],
          ),
          { field: "program.id", operator: to, value: [value] },
        );
      }
    }
  }
  assert.deepEqual(
    changeConditionOperator(
      { field: "program.id", operator: "eq", value: missing },
      "in",
      catalog.fields["program.id"],
    ),
    { field: "program.id", operator: "in" },
  );
});
test("membership add uses typed choices, caps at 100 and preserves individually removable stale members", () => {
  const field = catalog.fields["program.id"];
  const config = { field: field.id, operator: "in", value: [missing] };
  assert.deepEqual(addConditionMember(config, program, field, references).value, [
    missing,
    program,
  ]);
  for (const value of [true, 1, missing, "not-a-uuid", null])
    assert.equal(
      addConditionMember({ field: field.id, operator: "in" }, value, field, references),
      undefined,
    );
  assert.equal(
    addConditionMember({ ...config, value: Array(100).fill(missing) }, program, field, references),
    undefined,
  );
  assert.equal(addConditionMember(config, program, field, {}), undefined);
  assert.equal(
    addConditionMember(
      { field: "lead.unconverted", operator: "in" },
      false,
      catalog.fields["lead.unconverted"],
      references,
    ),
    undefined,
  );
  assert.equal(
    addConditionMember({ field: "promotion.rank_id", operator: "in" }, program, field, references),
    undefined,
  );
  assert.deepEqual(removeConditionMember(config, 0), { field: field.id, operator: "in" });
  assert.deepEqual(clearConditionValue(config), { field: field.id, operator: "in" });
  assert.equal(validConditionValue([], field, "in", references), false);
  assert.deepEqual(
    workflowReferences(
      { "program.id": { status: "ready", choices: [{ id: "malformed", label: "Invalid" }] } },
      "program.id",
    ).choices,
    [],
  );
});
test("future field types remain unsupported without invented controls", () => {
  const field = {
    id: "future",
    label: "Future field",
    value_type: "number",
    operators: ["eq", "gt"],
    nullable: true,
  };
  assert.equal(supportedConditionField(field), false);
  assert.deepEqual(conditionOperators(field), []);
  assert.deepEqual(conditionValueChoices(field, references), []);
  assert.deepEqual(
    changeConditionField({ field: "future", operator: "gt", value: 5 }, field, references),
    { field: "future", operator: null },
  );
});
test("bounded numeric parsing never returns malformed values", () => {
  for (const value of ["", " ", "1.1", "NaN", "Infinity", "1e2", "129601", "-1"])
    assert.equal(parseWorkflowInteger(value, 0, 129600), undefined);
  assert.equal(parseWorkflowInteger("0", 0, 129600), 0);
  assert.equal(parseWorkflowInteger("129600", 0, 129600), 129600);
  assert.equal(parseWorkflowInteger("-129600", -129600, -1), -129600);
  assert.equal(parseWorkflowInteger("0", -129600, -1), undefined);
});
test("placeholder discovery reports unknown names and retains source text", () => {
  const text =
    "Hi {{recipient_name}}, {{trial_start}} {{ constructor }} {{bad.name}} {{trial_start}}";
  assert.deepEqual(workflowTemplateVariables(text), [
    "recipient_name",
    "trial_start",
    "constructor",
    "bad.name",
  ]);
  const variables = workflowApplicability(initialGraph, catalog).variables;
  assert.deepEqual(unsupportedTemplateVariables(text, variables), [
    "trial_start",
    "constructor",
    "bad.name",
  ]);
  const draft = structuredClone(initialGraph);
  draft.graph.nodes.find((n) => n.type === "email").config.body_template = text;
  assert.equal(
    canonicalWorkflowDraft(draft).graph.nodes.find((n) => n.type === "email").config.body_template,
    text,
  );
});

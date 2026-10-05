import type { WorkflowSnapshot } from "./automation-workflow-model.ts";
import type {
  WorkflowConfigByType,
  WorkflowScalar,
  WorkflowSimulationEntityType,
} from "./automation-workflow-types.ts";

// Local catalog definitions until generated API aliases are available.
export type WorkflowCatalogChoice = { readonly id: string; readonly label: string };
export type WorkflowCatalogTrigger = WorkflowCatalogChoice & {
  readonly subject_kind: "student" | "promotion" | "lead" | "trial" | "invoice" | "belt_test";
  readonly simulation_entity_type: WorkflowSimulationEntityType;
  readonly recipient_ids: readonly string[];
  readonly field_ids: readonly string[];
  readonly template_variables: readonly string[];
  readonly supports_offset: boolean;
  readonly supports_program_filter: boolean;
  readonly delay_fields: readonly string[];
  readonly supports_lead_follow_up: boolean;
};
export type WorkflowCatalogField = WorkflowCatalogChoice & {
  readonly value_type: "boolean" | "enum" | "uuid" | "number" | "datetime" | "string";
  readonly operators: readonly string[];
  readonly nullable: boolean;
  readonly values?: readonly string[];
};
export type WorkflowCatalogVariable = WorkflowCatalogChoice & {
  readonly value_type: "string";
  readonly fallback: string | null;
};
export type WorkflowCatalogDelayField = WorkflowCatalogChoice & {
  readonly value_type: "datetime";
  readonly trigger_ids: readonly string[];
};
export type WorkflowCatalogChoices = {
  readonly triggers: Readonly<Record<string, WorkflowCatalogTrigger>>;
  readonly fields: Readonly<Record<string, WorkflowCatalogField>>;
  readonly recipients: Readonly<Record<string, WorkflowCatalogChoice>>;
  readonly variables: Readonly<Record<string, WorkflowCatalogVariable>>;
  readonly delay_fields: Readonly<Record<string, WorkflowCatalogDelayField>>;
};
export type WorkflowReferenceChoices = Partial<
  Record<
    "program.id" | "promotion.rank_id",
    {
      readonly status: "loading" | "ready" | "unavailable";
      readonly choices: readonly WorkflowCatalogChoice[];
    }
  >
>;
export type ConditionConfig = Readonly<Omit<WorkflowConfigByType["condition"], "value">> & {
  readonly value?: WorkflowScalar | readonly WorkflowScalar[];
};

export function catalogEntry<T>(
  entries: Readonly<Record<string, T>>,
  id: string | null | undefined,
): T | undefined {
  return id != null && Object.prototype.hasOwnProperty.call(entries, id) ? entries[id] : undefined;
}
function listed<T>(entries: Readonly<Record<string, T>>, ids: readonly string[]): T[] {
  return ids.flatMap((id) => {
    const item = catalogEntry(entries, id);
    return item ? [item] : [];
  });
}
export function workflowApplicability(draft: WorkflowSnapshot, catalog: WorkflowCatalogChoices) {
  const triggers = draft.graph.nodes.filter((node) => node.type === "trigger");
  const trigger =
    triggers.length === 1
      ? catalogEntry(catalog.triggers, triggers[0].config.event_type)
      : undefined;
  const reason =
    triggers.length === 0
      ? "Add a trigger to choose event-specific settings."
      : triggers.length > 1
        ? "Keep one trigger to choose event-specific settings."
        : !trigger
          ? "Choose a supported trigger event to choose event-specific settings."
          : null;
  return {
    trigger,
    reason,
    fields: trigger ? listed(catalog.fields, trigger.field_ids) : [],
    recipients: trigger ? listed(catalog.recipients, trigger.recipient_ids) : [],
    variables: trigger ? listed(catalog.variables, trigger.template_variables) : [],
    delayFields: trigger
      ? listed(catalog.delay_fields, trigger.delay_fields).filter((field) =>
          field.trigger_ids.includes(trigger.id),
        )
      : [],
  };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function workflowReferences(references: WorkflowReferenceChoices, field: string | null) {
  const entry =
    field === "program.id" || field === "promotion.rank_id"
      ? catalogEntry(references, field)
      : undefined;
  return {
    status: entry?.status ?? "unavailable",
    choices:
      entry?.status === "ready" ? entry.choices.filter((choice) => UUID.test(choice.id)) : [],
  };
}
// A supplied label can describe a saved ID even while its choices are unavailable.
// This lookup is display-only; workflowReferences still controls new selections.
export function workflowReferenceLabel(
  references: WorkflowReferenceChoices,
  field: string | null,
  id: string | null,
): string | undefined {
  const entry =
    field === "program.id" || field === "promotion.rank_id"
      ? catalogEntry(references, field)
      : undefined;
  return entry?.choices.find((choice) => choice.id === id)?.label;
}
export function supportedConditionField(field: WorkflowCatalogField | undefined) {
  return field !== undefined && ["boolean", "enum", "uuid"].includes(field.value_type);
}
export function conditionOperators(field: WorkflowCatalogField | undefined): string[] {
  if (!supportedConditionField(field)) return [];
  return field!.operators.filter(
    (operator) =>
      ["eq", "neq"].includes(operator) ||
      (field!.value_type !== "boolean" && ["in", "not_in"].includes(operator)),
  );
}
export function conditionValueChoices(
  field: WorkflowCatalogField | undefined,
  references: WorkflowReferenceChoices,
): { value: Exclude<WorkflowScalar, null>; label: string }[] {
  if (field?.value_type === "boolean")
    return [
      { value: true, label: "Yes" },
      { value: false, label: "No" },
    ];
  if (field?.value_type === "enum")
    return (field.values ?? []).map((value) => ({ value, label: value.replaceAll("_", " ") }));
  if (field?.value_type === "uuid")
    return workflowReferences(references, field.id).choices.map((choice) => ({
      value: choice.id,
      label: choice.label,
    }));
  return [];
}
export function validConditionValue(
  value: ConditionConfig["value"],
  field: WorkflowCatalogField | undefined,
  operator: string | null,
  references: WorkflowReferenceChoices,
): boolean {
  if (!field || !conditionOperators(field).includes(operator ?? "")) return false;
  const choices = conditionValueChoices(field, references);
  const scalar = (entry: unknown) => choices.some((choice) => choice.value === entry);
  if (operator === "in" || operator === "not_in")
    return Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(scalar);
  return value === null ? field.nullable : scalar(value);
}
export function clearConditionValue(config: ConditionConfig): WorkflowConfigByType["condition"] {
  return { field: config.field, operator: config.operator };
}
export function changeConditionField(
  config: ConditionConfig,
  field: WorkflowCatalogField | undefined,
  references: WorkflowReferenceChoices,
): WorkflowConfigByType["condition"] {
  const next = {
    field: field?.id ?? null,
    operator: conditionOperators(field).includes(config.operator ?? "") ? config.operator : null,
  };
  return validConditionValue(config.value, field, next.operator, references)
    ? {
        ...next,
        value: Array.isArray(config.value) ? [...config.value] : (config.value as WorkflowScalar),
      }
    : next;
}
export function changeConditionOperator(
  config: ConditionConfig,
  operator: string | null,
  field: WorkflowCatalogField | undefined,
): WorkflowConfigByType["condition"] {
  const next = {
    field: config.field,
    operator: conditionOperators(field).includes(operator ?? "") ? operator : null,
  };
  const membership = next.operator === "in" || next.operator === "not_in";
  // A same-field operator edit does not resolve an unavailable saved reference.
  // Preserve values of the same shape for explicit repair, including stale members.
  return next.operator !== null &&
    config.value !== undefined &&
    membership === Array.isArray(config.value)
    ? {
        ...next,
        value: Array.isArray(config.value) ? [...config.value] : (config.value as WorkflowScalar),
      }
    : next;
}
export function removeConditionMember(
  config: ConditionConfig,
  index: number,
): WorkflowConfigByType["condition"] {
  const values = Array.isArray(config.value)
    ? config.value.filter((_, position) => index !== position)
    : [];
  return values.length
    ? { ...clearConditionValue(config), value: values }
    : clearConditionValue(config);
}
export function addConditionMember(
  config: ConditionConfig,
  value: Exclude<WorkflowScalar, null>,
  field: WorkflowCatalogField | undefined,
  references: WorkflowReferenceChoices,
): WorkflowConfigByType["condition"] | undefined {
  if (
    field?.id !== config.field ||
    !conditionOperators(field).includes(config.operator ?? "") ||
    !["in", "not_in"].includes(config.operator ?? "") ||
    !conditionValueChoices(field, references).some((choice) => choice.value === value)
  )
    return undefined;
  // Keep stale members available for individual repair; never turn a stale scalar into a list.
  if (config.value !== undefined && !Array.isArray(config.value)) return undefined;
  const values = Array.isArray(config.value) ? [...config.value] : [];
  if (values.length >= 100 || values.includes(value)) return undefined;
  return { ...clearConditionValue(config), value: [...values, value] };
}
export function parseWorkflowInteger(text: string, min: number, max: number): number | undefined {
  if (!/^-?\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}
export function workflowTemplateVariables(template: string): string[] {
  return [
    ...new Set([...template.matchAll(/{{\s*([^{}]*?)\s*}}/g)].map((match) => match[1].trim())),
  ];
}
export function unsupportedTemplateVariables(
  template: string,
  variables: readonly WorkflowCatalogVariable[],
): string[] {
  return workflowTemplateVariables(template).filter(
    (id) => !variables.some((variable) => variable.id === id),
  );
}

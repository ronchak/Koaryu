// Accepted Domains b6fb0c0393bc4d50ca25d432c24cdd72d7fd200e.
// Generated artifact SHA256 60c6bafa7d7b1b58364c55eec40c8a49492f1d5bf377bbfba67caf39ba32d20b.
import type {
  ApiConditionNode_Output,
  ApiDelayNode_Output,
  ApiEmailNode_Output,
  ApiEndNode,
  ApiLeadFollowUpNode_Output,
  ApiTriggerNode_Output,
  ApiWorkflowCatalogResponse,
  ApiWorkflowCreate,
  ApiWorkflowDetail,
  ApiWorkflowGraph_Output,
  ApiWorkflowLayout_Output,
  ApiWorkflowListResponse,
  ApiWorkflowOperationResponse,
  ApiWorkflowSummary,
  ApiWorkflowSave,
  ApiWorkflowValidate,
  ApiWorkflowValidationIssue,
  ApiWorkflowValidationResult,
} from "../../src/types/generated/api-contracts";
import type {
  WorkflowCatalogResponse,
  WorkflowConfigByType,
  WorkflowCreateRequest,
  WorkflowDetail,
  WorkflowDraft,
  WorkflowGraph,
  WorkflowLayout,
  WorkflowListResponse,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowOperationResponse,
  WorkflowScalar,
  WorkflowSummary,
  WorkflowSaveRequest,
  WorkflowValidateRequest,
  WorkflowValidationResponse,
  ValidationIssue,
} from "../../src/lib/automation-workflow-types.ts";
import type {
  ConditionConfig,
  WorkflowCatalogField,
} from "../../src/lib/automation-workflow-catalog.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Optional<T, Key extends keyof T> = Omit<T, Key> extends T ? true : false;

// Strict compile proof catches missing output branches, weakened fields and accidental input aliases.
export type GeneratedOutputParity = [
  Assert<Equal<WorkflowGraph, ApiWorkflowGraph_Output>>,
  Assert<Equal<WorkflowLayout, ApiWorkflowLayout_Output>>,
  Assert<Equal<WorkflowDetail, ApiWorkflowDetail>>,
  Assert<Equal<WorkflowSummary, ApiWorkflowSummary>>,
  Assert<Equal<WorkflowListResponse, ApiWorkflowListResponse>>,
  Assert<Equal<WorkflowOperationResponse, ApiWorkflowOperationResponse>>,
  Assert<Equal<WorkflowCatalogResponse, ApiWorkflowCatalogResponse>>,
  Assert<Equal<WorkflowValidationResponse, ApiWorkflowValidationResult>>,
  Assert<Equal<ValidationIssue, ApiWorkflowValidationIssue>>,
  Assert<Equal<Extract<WorkflowNode, { type: "trigger" }>, ApiTriggerNode_Output>>,
  Assert<Equal<Extract<WorkflowNode, { type: "condition" }>, ApiConditionNode_Output>>,
  Assert<Equal<Extract<WorkflowNode, { type: "delay" }>, ApiDelayNode_Output>>,
  Assert<Equal<Extract<WorkflowNode, { type: "email" }>, ApiEmailNode_Output>>,
  Assert<Equal<Extract<WorkflowNode, { type: "lead_follow_up" }>, ApiLeadFollowUpNode_Output>>,
  Assert<Equal<Extract<WorkflowNode, { type: "end" }>, ApiEndNode>>,
  Assert<
    Equal<WorkflowNodeType, "trigger" | "condition" | "delay" | "email" | "lead_follow_up" | "end">
  >,
  Assert<Equal<WorkflowGraph["schema_version"], 1>>,
  Assert<Equal<WorkflowScalar, string | number | boolean | null>>,
  Assert<Equal<WorkflowConfigByType["end"], Record<string, never>>>,
  Assert<Equal<WorkflowConfigByType["trigger"]["event_type"], string | null>>,
  Assert<Equal<WorkflowConfigByType["condition"]["field"], string | null>>,
  Assert<Equal<WorkflowConfigByType["email"]["recipient"], string | null>>,
  Assert<Equal<WorkflowConfigByType["lead_follow_up"]["due_in_days"], number | null>>,
  Assert<Equal<Optional<WorkflowLayout, "positions">, false>>,
  Assert<Equal<Optional<WorkflowConfigByType["condition"], "value">, true>>,
  Assert<Equal<Optional<WorkflowConfigByType["trigger"], "offset_minutes">, true>>,
  Assert<Equal<Optional<WorkflowCatalogField, "values">, true>>,
  Assert<
    Equal<
      Extract<WorkflowConfigByType["condition"]["value"], unknown[]>[number],
      string | number | boolean
    >
  >,
  Assert<
    Equal<Extract<ConditionConfig["value"], readonly unknown[]>[number], string | number | boolean>
  >,
  Assert<Equal<WorkflowCatalogField["value_type"], "boolean" | "enum" | "uuid">>,
  Assert<Equal<WorkflowCatalogField["operators"][number], "eq" | "neq" | "in" | "not_in">>,
];

export const outputNodes = {
  trigger: { id: "trigger", type: "trigger", config: { event_type: null, program_id: null } },
  condition: { id: "condition", type: "condition", config: { field: null, operator: null } },
  delay: { id: "delay", type: "delay", config: { mode: "duration", minutes: null } },
  email: {
    id: "email",
    type: "email",
    config: { recipient: null, subject_template: "", body_template: "", reply_to_email: "" },
  },
  lead_follow_up: {
    id: "follow_up",
    type: "lead_follow_up",
    config: { due_in_days: null, note: "" },
  },
  end: { id: "end", type: "end", config: {} },
} satisfies { [Kind in WorkflowNodeType]: Extract<WorkflowNode, { type: Kind }> };
export const untilOutputNode = {
  id: "until",
  type: "delay",
  config: { mode: "until", field: null, offset_minutes: 0 },
} satisfies ApiDelayNode_Output;
export const generatedOutputGraph: ApiWorkflowGraph_Output = {
  schema_version: 1,
  nodes: Object.values(outputNodes),
  edges: [],
};
export const canonicalOutputDraft: WorkflowDraft = {
  graph: generatedOutputGraph,
  layout: { positions: {} },
};
export const outputGraphFromEditor: ApiWorkflowGraph_Output = canonicalOutputDraft.graph;
export const canonicalCreate: WorkflowCreateRequest = {
  operation_id: "60000000-0000-4000-8000-000000000001",
  name: "All generated output branches",
  description: "",
  ...canonicalOutputDraft,
};
export const backendCreateInput: ApiWorkflowCreate = canonicalCreate;

export const canonicalValidation: WorkflowValidateRequest = canonicalOutputDraft;
export const backendValidationInput: ApiWorkflowValidate = canonicalValidation;

export const canonicalSave: WorkflowSaveRequest = { ...canonicalCreate, expected_revision: 1 };
export const backendSaveInput: ApiWorkflowSave = canonicalSave;

import type {
  ApiWorkflowCatalogResponse,
  ApiWorkflowCreate,
  ApiWorkflowDetail,
  ApiWorkflowGraph_Output,
  ApiWorkflowLayout_Output,
  ApiWorkflowLifecycleRequest,
  ApiWorkflowListResponse,
  ApiWorkflowOperationResponse,
  ApiWorkflowPosition,
  ApiWorkflowPublish,
  ApiWorkflowSave,
  ApiWorkflowSummary,
  ApiWorkflowValidate,
  ApiWorkflowValidationIssue,
  ApiWorkflowValidationResult,
} from "../types/generated/api-contracts";

// Canonical editor data uses the server's emitted output fields, including nullable defaults.
export type WorkflowGraph = Pick<ApiWorkflowGraph_Output, keyof ApiWorkflowGraph_Output>;
export type WorkflowNode = WorkflowGraph["nodes"][number];
export type WorkflowNodeType = WorkflowNode["type"];
export type WorkflowConfigByType = {
  [Kind in WorkflowNodeType]: Extract<WorkflowNode, { type: Kind }>["config"];
};
export type WorkflowScalar = Exclude<
  WorkflowConfigByType["condition"]["value"],
  unknown[] | undefined
>;
export type WorkflowNodeUpdate = {
  [Kind in WorkflowNodeType]: { type: Kind; config: WorkflowConfigByType[Kind] };
}[WorkflowNodeType];
export type WorkflowEdge = WorkflowGraph["edges"][number];
export type WorkflowPort = WorkflowEdge["port"];
export type WorkflowPosition = ApiWorkflowPosition;
export type WorkflowLayout = ApiWorkflowLayout_Output;
export type WorkflowDraft = { graph: WorkflowGraph; layout: WorkflowLayout };

export type ValidationIssue = ApiWorkflowValidationIssue;
export type WorkflowValidationResponse = ApiWorkflowValidationResult;
export type WorkflowDetail = ApiWorkflowDetail;
// HTTP accepts defaults on input; this editor always submits its complete canonical draft.
export type WorkflowCreateRequest = Omit<ApiWorkflowCreate, keyof WorkflowDraft> & WorkflowDraft;
export type WorkflowSaveRequest = Omit<ApiWorkflowSave, keyof WorkflowDraft> & WorkflowDraft;
export type WorkflowCommandRequest = ApiWorkflowLifecycleRequest;
export type WorkflowPublishRequest = ApiWorkflowPublish;
export type WorkflowValidateRequest = Omit<ApiWorkflowValidate, keyof WorkflowDraft> &
  Pick<WorkflowDraft, "graph"> &
  Partial<Pick<WorkflowDraft, "layout">>;

export type WorkflowCommand = ApiWorkflowOperationResponse["command"];
export type WorkflowSummary = ApiWorkflowSummary;
export type WorkflowListResponse = ApiWorkflowListResponse;
export type WorkflowOperationResponse = ApiWorkflowOperationResponse;
export type WorkflowCatalogResponse = ApiWorkflowCatalogResponse;

// Simulation DTOs remain local until the separately owned simulation API is generated.
export type WorkflowSimulationEntityType =
  | "student"
  | "promotion"
  | "lead"
  | "trial_appointment"
  | "invoice"
  | "payment"
  | "belt_test_recipient";
export type WorkflowSimulationContext =
  | { kind: "synthetic" }
  | { kind: "entity"; entity_type: WorkflowSimulationEntityType; entity_id: string };
export type WorkflowSimulateRequest = {
  graph: WorkflowGraph;
  context: WorkflowSimulationContext;
};
export type WorkflowSimulationOutcome =
  | "entered"
  | "matched"
  | "not_matched"
  | "waiting"
  | "would_send"
  | "would_follow_up"
  | "skipped"
  | "completed";
export type WorkflowActionKind = "email" | "lead_follow_up";
export type WorkflowSimulationTrace = {
  node_id: string;
  outcome: WorkflowSimulationOutcome;
  edge_id: string | null;
  reason: string | null;
  scheduled_at: string | null;
  action_kind: WorkflowActionKind | null;
  rendered_subject: string | null;
  rendered_body: string | null;
};
export type WorkflowSimulationAction = {
  node_id: string;
  scheduled_at: string | null;
  action_kind: WorkflowActionKind;
  reason: string | null;
};
export type WorkflowSimulationResponse = WorkflowValidationResponse & {
  trace: WorkflowSimulationTrace[];
  next_actions: WorkflowSimulationAction[];
  reference_time: string;
  future_conditions_rechecked: true;
};

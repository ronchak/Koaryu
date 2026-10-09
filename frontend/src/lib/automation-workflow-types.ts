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
  ApiWorkflowSimulationRequest,
  ApiWorkflowSimulationResponse,
  ApiWorkflowSimulationTrace,
  ApiWorkflowSimulationAction,
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

export type WorkflowSimulationContext = ApiWorkflowSimulationRequest["context"];
export type WorkflowSimulationEntityType = Extract<
  WorkflowSimulationContext,
  { kind: "entity" }
>["entity_type"];
export type WorkflowSimulateRequest = Omit<ApiWorkflowSimulationRequest, "graph"> & {
  graph: WorkflowGraph;
};
export type WorkflowSimulationOutcome = ApiWorkflowSimulationTrace["outcome"];
export type WorkflowActionKind = ApiWorkflowSimulationAction["action_kind"];
export type WorkflowSimulationTrace = ApiWorkflowSimulationTrace;
export type WorkflowSimulationAction = ApiWorkflowSimulationAction;
export type WorkflowSimulationResponse = ApiWorkflowSimulationResponse;

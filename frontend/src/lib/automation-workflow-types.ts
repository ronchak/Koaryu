// Local contract definitions until the backend generates the workflow API aliases.
export type WorkflowScalar = string | number | boolean | null;
export type WorkflowPort = "next" | "yes" | "no";

export type WorkflowConfigByType = {
  trigger: { event_type: string | null; program_id: string | null; offset_minutes?: number };
  condition: {
    field: string | null;
    operator: string | null;
    value: WorkflowScalar | WorkflowScalar[];
  };
  delay:
    | { mode: "duration"; minutes: number | null }
    | { mode: "until"; field: string | null; offset_minutes: number };
  email: {
    recipient: string | null;
    subject_template: string;
    body_template: string;
    reply_to_email: string;
  };
  lead_follow_up: { due_in_days: number | null; note: string };
  end: Record<string, never>;
};
export type WorkflowNodeType = keyof WorkflowConfigByType;
export type WorkflowNode = {
  [Kind in WorkflowNodeType]: { id: string; type: Kind; config: WorkflowConfigByType[Kind] };
}[WorkflowNodeType];
export type WorkflowNodeUpdate = {
  [Kind in WorkflowNodeType]: { type: Kind; config: WorkflowConfigByType[Kind] };
}[WorkflowNodeType];
export type WorkflowEdge = { id: string; source: string; target: string; port: WorkflowPort };
export type WorkflowGraph = { schema_version: 1; nodes: WorkflowNode[]; edges: WorkflowEdge[] };
export type WorkflowPosition = { x: number; y: number };
export type WorkflowLayout = { positions: Record<string, WorkflowPosition> };
export type WorkflowDraft = { graph: WorkflowGraph; layout: WorkflowLayout };

export type ValidationIssue = {
  code: string;
  message: string;
  node_id: string | null;
  edge_id: string | null;
  field: string | null;
};
export type WorkflowValidationResponse = { valid: boolean; issues: ValidationIssue[] };
export type WorkflowDetail = {
  id: string;
  name: string;
  description: string;
  status: "draft" | "active" | "paused" | "archived";
  revision: number;
  draft_graph: WorkflowGraph;
  draft_layout: WorkflowLayout;
  validation_issues: ValidationIssue[];
  published_version_id: string | null;
  published_version_number: number | null;
  published_at: string | null;
  updated_at: string;
  has_unpublished_changes: boolean;
  pending_run_count: number;
  sending_run_count: number;
};
export type WorkflowCreateRequest = WorkflowDraft & {
  operation_id: string;
  name: string;
  description: string;
};
export type WorkflowSaveRequest = WorkflowCreateRequest & { expected_revision: number };
export type WorkflowCommandRequest = { operation_id: string; expected_revision: number };
export type WorkflowPublishRequest = WorkflowCommandRequest & { cancel_pending?: boolean };
export type WorkflowValidateRequest = { graph: WorkflowGraph; layout?: WorkflowLayout };

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

import { ApiError } from "./api.ts";
import { checkedWorkflowBody } from "./automation-workflow-api.ts";
import { canonicalWorkflowDraft, workflowTextLength } from "./automation-workflow-model.ts";
import { isAppointmentInstant } from "./appointment-time.ts";
import type { WorkflowGraph, WorkflowSimulationContext } from "./automation-workflow-types.ts";
import type {
  ApiRunCancelOperationResponse,
  ApiTestEmailOperationResponse,
  ApiWorkflowEmailAttemptSummary,
  ApiWorkflowRunCancelRequest,
  ApiWorkflowRunDetail,
  ApiWorkflowRunListResponse,
  ApiWorkflowRunStep,
  ApiWorkflowRunSummary,
  ApiWorkflowSimulationRequest,
  ApiWorkflowSimulationResponse,
  ApiWorkflowSimulationTrace,
  ApiWorkflowTestEmailRequest,
  ApiWorkflowTestEmailResponse,
} from "../types/generated/api-contracts";

export type WorkflowRunIdentity = Readonly<{
  studioId: string;
  workflowId: string;
  runId?: string;
}>;
export type WorkflowActivityReceiptIdentity =
  | Readonly<{
      command: "run.cancel";
      operationId: string;
      studioId: string;
      workflowId: string;
      runId: string;
    }>
  | Readonly<{
      command: "test_email.create";
      operationId: string;
      testDeliveryId?: string;
    }>;
export type WorkflowTestDeliveryIdentity = Readonly<{
  operationId: string;
  testDeliveryId?: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const BODY_CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const NODE_TYPES = ["trigger", "condition", "delay", "email", "lead_follow_up", "end"];
const RUN_STATES = [
  "queued",
  "waiting",
  "claimed",
  "running",
  "sending",
  "completed",
  "cancelled",
  "failed",
  "unknown",
];
const PENDING = ["queued", "waiting", "claimed", "running"];
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function shape(value: unknown, keys: string): value is Record<string, unknown> {
  const fields = keys.split(" ");
  return (
    record(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" && value.length === 36 && UUID.test(value);
const sameUuid = (value: unknown, expected: unknown) =>
  uuid(value) && uuid(expected) && value.toLowerCase() === expected.toLowerCase();
const integer = (value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const oneOf = (value: unknown, values: readonly string[]): value is string =>
  typeof value === "string" && values.includes(value);
const text = (value: unknown, max = Infinity, min = 0): value is string =>
  typeof value === "string" && workflowTextLength(value) >= min && workflowTextLength(value) <= max;
const graphId = (value: unknown): value is string =>
  typeof value === "string" && value === value.trim() && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const reason = (value: unknown) =>
  value === null ||
  (typeof value === "string" && value === value.trim() && /^[a-z][a-z0-9_]{0,79}$/.test(value));
const instant = (value: unknown) => value === null || isAppointmentInstant(value);
function rows(value: unknown, max: number): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
  );
}
// Dates establish whole UTC seconds only. Fraction strings retain all supplied precision.
function compareInstants(left: string, right: string): number {
  const seconds = Math.floor(Date.parse(left) / 1000) - Math.floor(Date.parse(right) / 1000);
  if (seconds !== 0) return Math.sign(seconds);
  const a = /\.(\d+)/.exec(left)?.[1] ?? "";
  const b = /\.(\d+)/.exec(right)?.[1] ?? "";
  const precision = Math.max(a.length, b.length);
  const first = a.padEnd(precision, "0"),
    second = b.padEnd(precision, "0");
  return first < second ? -1 : first > second ? 1 : 0;
}
function mailbox(value: unknown): boolean {
  if (!text(value, 254, 1) || /[^\x21-\x7e]/.test(value) || value !== value.toLowerCase())
    return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  const labels = domain.split(".");
  return (
    local.length >= 1 &&
    local.length <= 64 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) &&
    !local.startsWith(".") &&
    !local.endsWith(".") &&
    !local.includes("..") &&
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}
function runIdentity(identity: WorkflowRunIdentity): boolean {
  return (
    record(identity) &&
    uuid(identity.studioId) &&
    uuid(identity.workflowId) &&
    (identity.runId === undefined || uuid(identity.runId))
  );
}
function requestGraph(graph: WorkflowGraph): WorkflowGraph {
  const canonical = canonicalWorkflowDraft({ graph, layout: { positions: {} } }).graph;
  for (const node of canonical.nodes) {
    const choices =
      node.type === "trigger"
        ? [node.config.event_type]
        : node.type === "condition"
          ? [node.config.field, node.config.operator]
          : node.type === "email"
            ? [node.config.recipient]
            : node.type === "delay" && node.config.mode === "until"
              ? [node.config.field]
              : [];
    if (
      !graphId(node.id) ||
      (node.type === "trigger" &&
        node.config.program_id !== null &&
        !uuid(node.config.program_id)) ||
      choices.some((choice) => choice !== null && !text(choice, 100)) ||
      (node.type === "condition" &&
        Array.isArray(node.config.value) &&
        node.config.value.length > 100)
    )
      throw new ApiError("Invalid workflow request configuration.", 422);
    if (node.type === "email") {
      const reply = node.config.reply_to_email;
      if (
        !text(reply, 254) ||
        /[^\x00-\x7f]/.test(reply) ||
        (reply.replace(/ /g, "") !== "" && !mailbox(reply.replace(/^ +| +$/g, "").toLowerCase()))
      )
        throw new ApiError("Invalid workflow reply-to address.", 422);
    }
  }
  if (canonical.edges.some((edge) => ![edge.id, edge.source, edge.target].every(graphId)))
    throw new ApiError("Invalid workflow edge identity.", 422);
  // Match the request model's JSON restrictions without imposing a stored-graph byte limit.
  const pending: unknown[] = [canonical];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.includes("\0") || /[\uD800-\uDFFF]/u.test(value))
        throw new ApiError("Invalid workflow request text.", 422);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new ApiError("Invalid workflow request number.", 422);
    } else if (Array.isArray(value)) {
      if (!rows(value, Infinity)) throw new ApiError("Invalid workflow request list.", 422);
      pending.push(...value);
    } else if (record(value)) pending.push(...Object.values(value));
  }
  return canonical;
}

export function isWorkflowSimulationContext(value: unknown): value is WorkflowSimulationContext {
  return (
    (shape(value, "kind") && value.kind === "synthetic") ||
    (shape(value, "kind entity_type entity_id") &&
      value.kind === "entity" &&
      oneOf(value.entity_type, [
        "student",
        "promotion",
        "lead",
        "trial_appointment",
        "invoice",
        "payment",
        "belt_test_recipient",
      ]) &&
      uuid(value.entity_id))
  );
}
export function buildWorkflowSimulationRequest(
  graph: WorkflowGraph,
  context: WorkflowSimulationContext,
): ApiWorkflowSimulationRequest & { graph: WorkflowGraph } {
  if (!isWorkflowSimulationContext(context)) throw new ApiError("Invalid simulation context.", 422);
  return checkedWorkflowBody({
    graph: requestGraph(graph),
    context:
      context.kind === "synthetic"
        ? { kind: "synthetic" }
        : {
            kind: "entity",
            entity_type: context.entity_type,
            entity_id: context.entity_id.toLowerCase(),
          },
  });
}
function simulationTrace(value: unknown): value is ApiWorkflowSimulationTrace {
  if (
    !shape(
      value,
      "node_id outcome edge_id reason scheduled_at action_kind rendered_subject rendered_body",
    ) ||
    !graphId(value.node_id) ||
    !oneOf(value.outcome, [
      "entered",
      "matched",
      "not_matched",
      "waiting",
      "would_send",
      "would_follow_up",
      "skipped",
      "completed",
    ]) ||
    !(value.edge_id === null || graphId(value.edge_id)) ||
    !reason(value.reason) ||
    !instant(value.scheduled_at)
  )
    return false;
  const action =
    value.outcome === "would_send"
      ? "email"
      : value.outcome === "would_follow_up"
        ? "lead_follow_up"
        : null;
  if (
    value.action_kind !== action ||
    (oneOf(value.outcome, ["waiting", "completed"]) && value.edge_id !== null) ||
    (!oneOf(value.outcome, ["waiting", "skipped"]) && value.reason !== null)
  )
    return false;
  return value.outcome === "would_send"
    ? text(value.rendered_subject, 200) &&
        !CONTROL.test(value.rendered_subject) &&
        text(value.rendered_body, 20000) &&
        !BODY_CONTROL.test(value.rendered_body)
    : value.rendered_subject === null && value.rendered_body === null;
}
export function isWorkflowSimulationResponse(
  value: unknown,
  submittedGraph: WorkflowGraph,
): value is ApiWorkflowSimulationResponse {
  if (
    !shape(value, "valid issues trace next_actions reference_time future_conditions_rechecked") ||
    typeof value.valid !== "boolean" ||
    !rows(value.issues, Infinity) ||
    !value.issues.every(
      (issue) =>
        shape(issue, "code message node_id edge_id field") &&
        text(issue.code) &&
        text(issue.message) &&
        [issue.node_id, issue.edge_id, issue.field].every((item) => item === null || text(item)),
    ) ||
    !rows(value.trace, 40) ||
    !value.trace.every(simulationTrace) ||
    !rows(value.next_actions, 40) ||
    !isAppointmentInstant(value.reference_time) ||
    value.future_conditions_rechecked !== true ||
    value.valid !== (value.issues.length === 0)
  )
    return false;
  if (!value.valid) return value.trace.length === 0 && value.next_actions.length === 0;
  if (
    !value.trace.length ||
    new Set(value.trace.map((row) => row.node_id)).size !== value.trace.length
  )
    return false;
  let graph: WorkflowGraph;
  try {
    graph = canonicalWorkflowDraft({ graph: submittedGraph, layout: { positions: {} } }).graph;
  } catch {
    return false;
  }
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const triggers = graph.nodes.filter((node) => node.type === "trigger");
  if (triggers.length !== 1 || triggers[0].id !== value.trace[0].node_id) return false;
  const outcomes = new Map([
    ["trigger", ["entered", "waiting", "skipped"]],
    ["condition", ["matched", "not_matched", "waiting"]],
    ["delay", ["entered", "waiting"]],
    ["email", ["would_send", "skipped", "waiting"]],
    ["lead_follow_up", ["would_follow_up"]],
    ["end", ["completed"]],
  ]);
  for (const [index, row] of value.trace.entries()) {
    const node = nodes.get(row.node_id);
    if (
      !node ||
      !outcomes.get(node.type)?.includes(row.outcome) ||
      (node.type !== "delay" && row.scheduled_at !== null)
    )
      return false;
    const stop =
      row.outcome === "waiting" ||
      row.outcome === "completed" ||
      (node.type === "trigger" && row.outcome === "skipped");
    if (stop) {
      if (row.edge_id !== null || index !== value.trace.length - 1) return false;
    } else {
      const edge = row.edge_id === null ? undefined : edges.get(row.edge_id);
      const port =
        row.outcome === "matched" ? "yes" : row.outcome === "not_matched" ? "no" : "next";
      if (
        !edge ||
        edge.source !== row.node_id ||
        edge.port !== port ||
        value.trace[index + 1]?.node_id !== edge.target
      )
        return false;
    }
  }
  const actions = value.trace.filter((row) => row.action_kind !== null);
  return (
    actions.length === value.next_actions.length &&
    value.next_actions.every(
      (action, index) =>
        shape(action, "node_id scheduled_at action_kind reason") &&
        action.node_id === actions[index].node_id &&
        action.action_kind === actions[index].action_kind &&
        action.scheduled_at === null &&
        action.reason === null,
    )
  );
}

function runSummary(value: unknown, identity: WorkflowRunIdentity): value is ApiWorkflowRunSummary {
  if (
    !shape(
      value,
      "id studio_id workflow_id version_id version_number event_type subject_kind subject_id subject_label state revision current_node_id next_due_at reason cancel_requested_at cancel_reason can_cancel created_at updated_at",
    ) ||
    !uuid(value.id) ||
    !sameUuid(value.studio_id, identity.studioId) ||
    !sameUuid(value.workflow_id, identity.workflowId) ||
    (identity.runId !== undefined && !sameUuid(value.id, identity.runId)) ||
    !uuid(value.version_id) ||
    !integer(value.version_number) ||
    !integer(value.revision) ||
    !oneOf(value.event_type, [
      "student.enrolled",
      "student.promoted",
      "lead.created",
      "lead.stage_changed",
      "trial.scheduled",
      "trial.completed",
      "trial.no_show",
      "trial.upcoming",
      "invoice.overdue",
      "invoice.payment_failed",
      "belt_test.approved",
      "belt_test.upcoming",
    ]) ||
    !oneOf(value.subject_kind, ["student", "promotion", "lead", "trial", "invoice", "belt_test"]) ||
    !uuid(value.subject_id) ||
    !text(value.subject_label, 240, 1) ||
    !oneOf(value.state, RUN_STATES) ||
    !graphId(value.current_node_id) ||
    !instant(value.next_due_at) ||
    !reason(value.reason) ||
    !instant(value.cancel_requested_at) ||
    !reason(value.cancel_reason) ||
    !isAppointmentInstant(value.created_at) ||
    !isAppointmentInstant(value.updated_at)
  )
    return false;
  const pending = PENDING.includes(value.state),
    intent = value.cancel_requested_at !== null;
  return (
    pending === (value.next_due_at !== null) &&
    intent === (value.cancel_reason !== null) &&
    value.can_cancel === ((pending || value.state === "sending") && !intent)
  );
}
function runStep(value: unknown): value is ApiWorkflowRunStep {
  if (
    !shape(
      value,
      "id sequence node_id node_type outcome edge_id reason scheduled_at entered_at finished_at",
    ) ||
    !uuid(value.id) ||
    !integer(value.sequence, 1, 40) ||
    !graphId(value.node_id) ||
    !oneOf(value.node_type, NODE_TYPES) ||
    !oneOf(value.outcome, [
      "entered",
      "matched",
      "not_matched",
      "waiting",
      "sending",
      "accepted",
      "skipped",
      "failed",
      "unknown",
      "cancelled",
      "completed",
    ]) ||
    !(value.edge_id === null || graphId(value.edge_id)) ||
    !reason(value.reason) ||
    !instant(value.scheduled_at) ||
    !isAppointmentInstant(value.entered_at) ||
    !(value.finished_at === null || isAppointmentInstant(value.finished_at))
  )
    return false;
  return (
    oneOf(value.outcome, ["entered", "waiting", "sending"]) === (value.finished_at === null) &&
    (value.finished_at === null || compareInstants(value.finished_at, value.entered_at) >= 0)
  );
}
function emailAttempt(value: unknown): value is ApiWorkflowEmailAttemptSummary {
  if (
    !shape(
      value,
      "id node_id attempt_number state reason recipient_email recipient_kind began_at settled_at submission_evidence failure_scope",
    ) ||
    !uuid(value.id) ||
    !graphId(value.node_id) ||
    !integer(value.attempt_number, 1, 3) ||
    !oneOf(value.state, ["sending", "accepted", "failed", "unknown"]) ||
    !reason(value.reason) ||
    !mailbox(value.recipient_email) ||
    !oneOf(value.recipient_kind, [
      "student",
      "guardian",
      "lead",
      "invoice_payer",
      "assigned_staff",
    ]) ||
    !isAppointmentInstant(value.began_at) ||
    !(value.settled_at === null || isAppointmentInstant(value.settled_at))
  )
    return false;
  const evidence = new Map([
    ["sending", []],
    ["accepted", ["accepted"]],
    ["failed", ["not_submitted", "rejected"]],
    ["unknown", ["unknown"]],
  ]);
  const scopes = new Map([
    ["sending", []],
    ["accepted", []],
    ["failed", ["sender_auth", "sender_transient", "message", "unclassified"]],
    ["unknown", ["unclassified"]],
  ]);
  return (
    (value.state === "sending") === (value.settled_at === null) &&
    (value.settled_at === null || compareInstants(value.settled_at, value.began_at) >= 0) &&
    (value.submission_evidence === null ||
      oneOf(value.submission_evidence, evidence.get(value.state)!)) &&
    (value.failure_scope === null || oneOf(value.failure_scope, scopes.get(value.state)!))
  );
}
export function isWorkflowRunPage(
  value: unknown,
  identity: WorkflowRunIdentity,
  limit: number,
): value is ApiWorkflowRunListResponse {
  if (
    !runIdentity(identity) ||
    identity.runId !== undefined ||
    !integer(limit, 1, 100) ||
    !shape(value, "items next_cursor has_more") ||
    !rows(value.items, limit) ||
    !value.items.every((item) => runSummary(item, identity)) ||
    !(value.next_cursor === null || text(value.next_cursor, 512, 1)) ||
    value.has_more !== (value.next_cursor !== null) ||
    (value.has_more && !value.items.length)
  )
    return false;
  const ids = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    const id = item.id.toLowerCase(),
      previous = value.items[index - 1];
    if (ids.has(id)) return false;
    ids.add(id);
    if (previous) {
      const order = compareInstants(previous.created_at, item.created_at);
      if (order < 0 || (order === 0 && previous.id.toLowerCase() <= id)) return false;
    }
  }
  return true;
}
export function isWorkflowRunDetail(
  value: unknown,
  identity: WorkflowRunIdentity,
): value is ApiWorkflowRunDetail {
  if (
    !runIdentity(identity) ||
    !shape(value, "run steps attempts") ||
    !runSummary(value.run, identity) ||
    !rows(value.steps, 40) ||
    !value.steps.every(runStep) ||
    !rows(value.attempts, 120) ||
    !value.attempts.every(emailAttempt)
  )
    return false;
  const stepIds = new Set<string>(),
    nodeIds = new Set<string>();
  const emailSteps = new Map<string, number>();
  let sequence = 0;
  for (const step of value.steps) {
    const id = step.id.toLowerCase();
    if (step.sequence <= sequence || stepIds.has(id) || nodeIds.has(step.node_id)) return false;
    sequence = step.sequence;
    stepIds.add(id);
    nodeIds.add(step.node_id);
    if (step.node_type === "email") emailSteps.set(step.node_id, step.sequence);
  }
  const attemptIds = new Set<string>(),
    ordinals = new Set<string>();
  let priorStep = 0,
    priorOrdinal = 0;
  for (const attempt of value.attempts) {
    const step = emailSteps.get(attempt.node_id),
      id = attempt.id.toLowerCase();
    const ordinal = `${attempt.node_id}:${attempt.attempt_number}`;
    if (
      step === undefined ||
      attemptIds.has(id) ||
      ordinals.has(ordinal) ||
      step < priorStep ||
      (step === priorStep && attempt.attempt_number <= priorOrdinal)
    )
      return false;
    attemptIds.add(id);
    ordinals.add(ordinal);
    priorStep = step;
    priorOrdinal = attempt.attempt_number;
  }
  return true;
}
export function buildWorkflowRunCancel(
  operationId: string,
  baseline: Readonly<ApiWorkflowRunDetail>,
): ApiWorkflowRunCancelRequest {
  if (
    !uuid(operationId) ||
    !record(baseline) ||
    !record(baseline.run) ||
    !isWorkflowRunDetail(baseline, {
      studioId: baseline.run.studio_id,
      workflowId: baseline.run.workflow_id,
      runId: baseline.run.id,
    }) ||
    !baseline.run.can_cancel ||
    !integer(baseline.run.revision, 1, Number.MAX_SAFE_INTEGER - 1)
  )
    throw new ApiError("This run cannot be cancelled from the supplied version.", 422);
  return checkedWorkflowBody({
    operation_id: operationId.toLowerCase(),
    expected_revision: baseline.run.revision,
  });
}
export function isWorkflowRunCancelResult(
  value: unknown,
  baseline: Readonly<ApiWorkflowRunDetail>,
): value is ApiWorkflowRunDetail {
  if (!record(baseline) || !record(baseline.run)) return false;
  const identity = {
    studioId: baseline.run.studio_id,
    workflowId: baseline.run.workflow_id,
    runId: baseline.run.id,
  };
  return (
    isWorkflowRunDetail(baseline, identity) &&
    baseline.run.can_cancel &&
    integer(baseline.run.revision, 1, Number.MAX_SAFE_INTEGER - 1) &&
    isWorkflowRunDetail(value, identity) &&
    sameUuid(value.run.version_id, baseline.run.version_id) &&
    value.run.version_number === baseline.run.version_number &&
    value.run.revision === baseline.run.revision + 1 &&
    !value.run.can_cancel &&
    value.run.cancel_requested_at !== null &&
    value.run.cancel_reason !== null
  );
}
export function buildWorkflowTestEmail(
  operationId: string,
  graph: WorkflowGraph,
  emailNodeId: string,
): ApiWorkflowTestEmailRequest & { graph: WorkflowGraph } {
  if (!uuid(operationId) || !graphId(emailNodeId))
    throw new ApiError("Invalid test email request.", 422);
  const canonical = requestGraph(graph);
  if (
    !canonical.nodes.some((node) => node.id === emailNodeId && node.type === "email") ||
    canonical.nodes.some(
      (node) =>
        node.type === "email" &&
        (CONTROL.test(node.config.subject_template) ||
          BODY_CONTROL.test(node.config.body_template)),
    )
  )
    throw new ApiError("Select an email node with plain text templates.", 422);
  return checkedWorkflowBody({
    operation_id: operationId.toLowerCase(),
    graph: canonical,
    email_node_id: emailNodeId,
  });
}
export function isWorkflowTestDelivery(
  value: unknown,
  expected: WorkflowTestDeliveryIdentity,
): value is ApiWorkflowTestEmailResponse {
  return (
    record(expected) &&
    uuid(expected.operationId) &&
    (expected.testDeliveryId === undefined || uuid(expected.testDeliveryId)) &&
    shape(value, "operation_id test_delivery_id state") &&
    sameUuid(value.operation_id, expected.operationId) &&
    uuid(value.test_delivery_id) &&
    (expected.testDeliveryId === undefined ||
      sameUuid(value.test_delivery_id, expected.testDeliveryId)) &&
    oneOf(value.state, ["queued", "sending", "accepted", "failed", "unknown"])
  );
}
export function isWorkflowActivityReceipt(
  value: unknown,
  expected: WorkflowActivityReceiptIdentity,
): value is ApiRunCancelOperationResponse | ApiTestEmailOperationResponse {
  if (
    !record(expected) ||
    !uuid(expected.operationId) ||
    !shape(value, "operation_id state entity_id committed_at command entity_type result") ||
    !sameUuid(value.operation_id, expected.operationId) ||
    value.state !== "committed" ||
    !uuid(value.entity_id) ||
    !isAppointmentInstant(value.committed_at) ||
    value.command !== expected.command
  )
    return false;
  if (expected.command === "run.cancel") {
    return (
      uuid(expected.runId) &&
      value.entity_type === "workflow_run" &&
      sameUuid(value.entity_id, expected.runId) &&
      isWorkflowRunDetail(value.result, expected) &&
      !value.result.run.can_cancel &&
      value.result.run.cancel_requested_at !== null &&
      value.result.run.cancel_reason !== null
    );
  }
  return (
    expected.command === "test_email.create" &&
    value.entity_type === "test_delivery" &&
    isWorkflowTestDelivery(value.result, expected) &&
    value.result.state === "queued" &&
    sameUuid(value.entity_id, value.result.test_delivery_id)
  );
}

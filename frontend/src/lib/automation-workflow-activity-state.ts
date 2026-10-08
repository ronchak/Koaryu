import type {
  ApiWorkflowRunDetail,
  ApiWorkflowRunListResponse,
  ApiWorkflowTestEmailResponse,
  ApiWorkflowSimulationResponse,
} from "../types/generated/api-contracts";
import type { WorkflowGraph, WorkflowSimulationContext } from "./automation-workflow-types.ts";

export type WorkflowActivityTarget =
  | Readonly<{ kind: "run"; workflowId: string; runId: string }>
  | Readonly<{ kind: "test"; workflowId: string }>;
export type WorkflowActivityRead<T> =
  Readonly<{ status: "ready"; value: T; isCurrent(): boolean }> | Readonly<{ status: "stale" }>;
export type WorkflowActivityStatus =
  | "submitting"
  | "unknown"
  | "checking"
  | "confirmed_needs_refresh"
  | "confirmed"
  | "unavailable"
  | "rejected"
  | "storage_blocked";
export type WorkflowActivityOperation = Readonly<{
  operationId: string;
  target: WorkflowActivityTarget;
  status: WorkflowActivityStatus;
  locked: boolean;
  message: string | null;
  isCurrent(): boolean;
}> &
  (
    | Readonly<{ command: "run.cancel"; current: ApiWorkflowRunDetail | null }>
    | Readonly<{
        command: "test_email.create";
        emailNodeId: string;
        current: ApiWorkflowTestEmailResponse | null;
      }>
  );
export type WorkflowActivitySnapshot = Readonly<{
  operations: ReadonlyMap<string, WorkflowActivityOperation>;
  storage: Readonly<{
    status: "inactive" | "ready" | "blocked";
    message: string | null;
    isCurrent(): boolean;
  }>;
}>;
export interface WorkflowActivity {
  getSnapshot(): WorkflowActivitySnapshot;
  subscribe(listener: () => void): () => void;
  pendingOperation(target: WorkflowActivityTarget): WorkflowActivityOperation | undefined;
  checkStorage(): Promise<void>;
  invalidateSimulation(): void;
  simulate(
    workflowId: string,
    graph: WorkflowGraph,
    context: WorkflowSimulationContext,
  ): Promise<WorkflowActivityRead<ApiWorkflowSimulationResponse>>;
  listRuns(
    workflowId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<WorkflowActivityRead<ApiWorkflowRunListResponse>>;
  getRun(workflowId: string, runId: string): Promise<WorkflowActivityRead<ApiWorkflowRunDetail>>;
  cancelRun(current: Readonly<ApiWorkflowRunDetail>): Promise<void>;
  createTest(workflowId: string, graph: WorkflowGraph, emailNodeId: string): Promise<void>;
  checkResult(target: WorkflowActivityTarget): Promise<void>;
  createAnotherTest(
    workflowId: string,
    graph: WorkflowGraph,
    emailNodeId: string,
    priorOperationId: string,
  ): Promise<void>;
  dismissTestResult(workflowId: string, priorOperationId: string): Promise<void>;
}

export const WORKFLOW_ACTIVITY_JOURNAL_KEY = "koaryu-workflow-activity-v1";
export const WORKFLOW_ACTIVITY_JOURNAL_LIMIT = 100;
export type WorkflowActivityMarker =
  | Readonly<{
      operation_id: string;
      command: "run.cancel";
      owner_user_id: string;
      owner_studio_id: string;
      target: Readonly<{ kind: "run"; workflowId: string; runId: string }>;
    }>
  | Readonly<{
      operation_id: string;
      command: "test_email.create";
      owner_user_id: string;
      owner_studio_id: string;
      target: Readonly<{ kind: "test"; workflowId: string }>;
      email_node_id: string;
      test_delivery_id?: string;
    }>;

const STORAGE_ERROR = "Workflow activity recovery storage is unavailable. Check storage access.";
function unavailable(): never {
  throw new Error(STORAGE_ERROR);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return (
    object(value) &&
    Reflect.ownKeys(value).length === expected.length &&
    expected.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    })
  );
}
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    unavailable();
  return value.toLowerCase();
}
function target(value: unknown): WorkflowActivityTarget {
  if (keys(value, ["kind", "workflowId"]) && value.kind === "test")
    return Object.freeze({ kind: "test", workflowId: uuid(value.workflowId) });
  if (keys(value, ["kind", "workflowId", "runId"]) && value.kind === "run")
    return Object.freeze({
      kind: "run",
      workflowId: uuid(value.workflowId),
      runId: uuid(value.runId),
    });
  return unavailable();
}
export function workflowActivityTargetKey(value: WorkflowActivityTarget): string {
  const normalized = target(value);
  return normalized.kind === "run"
    ? `run:${normalized.workflowId}:${normalized.runId}`
    : `test:${normalized.workflowId}`;
}
function marker(value: unknown): WorkflowActivityMarker {
  if (!object(value)) unavailable();
  const command = Object.getOwnPropertyDescriptor(value, "command");
  if (!command || !("value" in command)) unavailable();
  const shared = ["operation_id", "command", "owner_user_id", "owner_studio_id", "target"];
  const hasAlias = Object.hasOwn(value, "test_delivery_id");
  const fields =
    command.value === "run.cancel"
      ? shared
      : [...shared, "email_node_id", ...(hasAlias ? ["test_delivery_id"] : [])];
  if (!keys(value, fields)) unavailable();
  const normalized = target(value.target);
  const common = {
    operation_id: uuid(value.operation_id),
    owner_user_id: uuid(value.owner_user_id),
    owner_studio_id: uuid(value.owner_studio_id),
  };
  if (value.command === "run.cancel" && normalized.kind === "run")
    return Object.freeze({ ...common, command: "run.cancel", target: normalized });
  if (
    value.command !== "test_email.create" ||
    normalized.kind !== "test" ||
    typeof value.email_node_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(value.email_node_id)
  )
    unavailable();
  return Object.freeze({
    ...common,
    command: "test_email.create",
    target: normalized,
    email_node_id: value.email_node_id,
    ...(hasAlias ? { test_delivery_id: uuid(value.test_delivery_id) } : {}),
  });
}
function entries(value: unknown): readonly WorkflowActivityMarker[] {
  if (
    !Array.isArray(value) ||
    value.length > WORKFLOW_ACTIVITY_JOURNAL_LIMIT ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    unavailable();
  const operations = new Set<string>(),
    targets = new Set<string>(),
    result: WorkflowActivityMarker[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor)) unavailable();
    const item = marker(descriptor.value);
    const ownerTarget = JSON.stringify([
      item.owner_user_id,
      item.owner_studio_id,
      workflowActivityTargetKey(item.target),
    ]);
    if (operations.has(item.operation_id) || targets.has(ownerTarget)) unavailable();
    operations.add(item.operation_id);
    targets.add(ownerTarget);
    result.push(item);
  }
  return Object.freeze(result);
}
export function parseWorkflowActivityJournal(
  raw: string | null,
): readonly WorkflowActivityMarker[] {
  try {
    if (raw === null) return Object.freeze([]);
    if (typeof raw !== "string") unavailable();
    const envelope: unknown = JSON.parse(raw);
    if (!keys(envelope, ["version", "entries"]) || envelope.version !== 1) unavailable();
    return entries(envelope.entries);
  } catch {
    return unavailable();
  }
}
export function serializeWorkflowActivityJournal(value: readonly WorkflowActivityMarker[]): string {
  try {
    return JSON.stringify({ version: 1, entries: entries(value) });
  } catch {
    return unavailable();
  }
}

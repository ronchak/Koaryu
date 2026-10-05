import { api, ApiError, CommandOutcomeUnknown } from "@/lib/api";
import { canonicalWorkflowDraft, validateWorkflow } from "./automation-workflow-model.ts";
import type {
  WorkflowCommandRequest,
  WorkflowCommand,
  WorkflowCatalogResponse,
  WorkflowListResponse,
  WorkflowOperationResponse,
  WorkflowCreateRequest,
  WorkflowDetail,
  WorkflowPublishRequest,
  WorkflowSaveRequest,
  WorkflowSimulateRequest,
  WorkflowSimulationContext,
  WorkflowSimulationResponse,
  WorkflowValidateRequest,
  WorkflowValidationResponse,
} from "./automation-workflow-types.ts";

const ROOT = "/automations/workflows";
const path = (id: string) => `${ROOT}/${encodeURIComponent(id)}`;
export const WORKFLOW_MAX_REQUEST_BYTES = 1_048_576;
export function checkedWorkflowBody<T>(body: T): T {
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > WORKFLOW_MAX_REQUEST_BYTES)
    throw new ApiError(
      "This workflow request exceeds the 1 MiB limit. Reduce its content before saving.",
      413,
    );
  return body;
}
const commandBody = ({ operation_id, expected_revision }: WorkflowCommandRequest) => ({
  operation_id,
  expected_revision,
});
export const workflowCreateBody = (request: WorkflowCreateRequest): WorkflowCreateRequest =>
  checkedWorkflowBody({
    operation_id: request.operation_id,
    name: request.name,
    description: request.description,
    ...canonicalWorkflowDraft(request),
  });

// Commands retain the caller's identity. Unknown outcomes are reconciled by readback, never retry.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && Number(value) >= min;
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const nullableString = (value: unknown) => value === null || typeof value === "string";
const timestamp = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const choice = (value: unknown) =>
  isRecord(value) && typeof value.id === "string" && typeof value.label === "string";
const choices = (value: unknown, valid: (item: unknown) => boolean) =>
  isRecord(value) &&
  Object.entries(value).every(([key, item]) => isRecord(item) && item.id === key && valid(item));
export function assertWorkflowCatalog(value: unknown): asserts value is WorkflowCatalogResponse {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    !isRecord(value.capabilities) ||
    typeof value.capabilities.can_start !== "boolean" ||
    typeof value.capabilities.can_test_email !== "boolean" ||
    !nullableString(value.capabilities.disabled_reason) ||
    !isRecord(value.limits) ||
    value.limits.max_nodes !== 40 ||
    value.limits.max_edges !== 60 ||
    value.limits.max_workflows !== 100 ||
    value.limits.max_active_workflows !== 25 ||
    value.limits.max_delay_minutes !== 129600 ||
    value.limits.max_request_bytes !== WORKFLOW_MAX_REQUEST_BYTES ||
    !isRecord(value.scheduler) ||
    typeof value.scheduler.enabled !== "boolean" ||
    value.scheduler.interval_seconds !== 60 ||
    !isRecord(value.delivery_status) ||
    !["disabled", "test", "live"].includes(String(value.delivery_status.mode)) ||
    typeof value.delivery_status.configured !== "boolean" ||
    typeof value.delivery_status.can_enable !== "boolean" ||
    typeof value.delivery_status.sender !== "string" ||
    !nullableString(value.delivery_status.test_recipient) ||
    !(
      value.delivery_status.reason === null ||
      (typeof value.delivery_status.reason === "string" &&
        ["setup_required", "sending_disabled", "authentication_required", "unavailable"].includes(
          value.delivery_status.reason,
        ))
    ) ||
    !choices(
      value.triggers,
      (item) =>
        isRecord(item) &&
        choice(item) &&
        ["student", "promotion", "lead", "trial", "invoice", "belt_test"].includes(
          String(item.subject_kind),
        ) &&
        [
          "student",
          "promotion",
          "lead",
          "trial_appointment",
          "invoice",
          "payment",
          "belt_test_recipient",
        ].includes(String(item.simulation_entity_type)) &&
        strings(item.recipient_ids) &&
        strings(item.field_ids) &&
        strings(item.template_variables) &&
        strings(item.delay_fields) &&
        typeof item.supports_offset === "boolean" &&
        typeof item.supports_program_filter === "boolean" &&
        typeof item.supports_lead_follow_up === "boolean",
    ) ||
    !choices(
      value.fields,
      (item) =>
        isRecord(item) &&
        choice(item) &&
        ["boolean", "enum", "uuid"].includes(String(item.value_type)) &&
        strings(item.operators) &&
        item.operators.every((operator) => ["eq", "neq", "in", "not_in"].includes(operator)) &&
        typeof item.nullable === "boolean" &&
        (item.values === undefined || strings(item.values)),
    ) ||
    !choices(value.recipients, choice) ||
    !choices(
      value.variables,
      (item) =>
        isRecord(item) &&
        choice(item) &&
        item.value_type === "string" &&
        nullableString(item.fallback),
    ) ||
    !choices(
      value.delay_fields,
      (item) =>
        isRecord(item) &&
        choice(item) &&
        item.value_type === "datetime" &&
        strings(item.trigger_ids),
    ) ||
    !Array.isArray(value.presets) ||
    !value.presets.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        typeof item.description === "string" &&
        validateWorkflow(item.graph, undefined, "draft").valid,
    )
  )
    throw new ApiError("Workflow catalog is unavailable. Reload before starting workflows.", 503);
  if (
    (value.capabilities.can_start &&
      (!value.delivery_status.can_enable || !value.scheduler.enabled)) ||
    (value.capabilities.can_test_email && !value.delivery_status.can_enable) ||
    (value.delivery_status.can_enable &&
      (!value.delivery_status.configured ||
        value.delivery_status.mode === "disabled" ||
        value.delivery_status.reason !== null))
  )
    throw new ApiError("Workflow capabilities are unavailable.", 503);
}
function validSummary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const publication = [
    value.published_version_id,
    value.published_version_number,
    value.published_at,
  ].map((item) => item !== null);
  if (
    publication.some(Boolean) !== publication.every(Boolean) ||
    (["active", "paused"].includes(String(value.status)) && !publication.every(Boolean)) ||
    (value.status === "draft" && publication.some(Boolean))
  )
    return false;
  return (
    isRecord(value) &&
    uuid(value.id) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    ["draft", "active", "paused", "archived"].includes(String(value.status)) &&
    integer(value.revision, 1) &&
    (value.published_version_id === null || uuid(value.published_version_id)) &&
    (value.published_version_number === null || integer(value.published_version_number, 1)) &&
    (value.published_at === null || timestamp(value.published_at)) &&
    timestamp(value.updated_at) &&
    typeof value.has_unpublished_changes === "boolean" &&
    integer(value.pending_run_count) &&
    integer(value.sending_run_count)
  );
}
export function assertWorkflowDetail(value: unknown, id?: string): asserts value is WorkflowDetail {
  if (
    !isRecord(value) ||
    !validSummary(value) ||
    (id !== undefined && value.id !== id) ||
    !isRecord(value.draft_layout) ||
    !isRecord(value.draft_layout.positions) ||
    !Array.isArray(value.validation_issues) ||
    !value.validation_issues.every(
      (issue) =>
        isRecord(issue) &&
        typeof issue.code === "string" &&
        typeof issue.message === "string" &&
        nullableString(issue.node_id) &&
        nullableString(issue.edge_id) &&
        nullableString(issue.field),
    )
  )
    throw new ApiError("Workflow response is unavailable. Check its status again.", 503);
  // Shape validation deliberately has no request-byte limit: stored drafts remain repairable.
  if (!validateWorkflow(value.draft_graph, value.draft_layout, "draft").valid)
    throw new ApiError("Workflow draft is unavailable.", 503);
}
export function assertWorkflowCommandResult(
  value: unknown,
  command: WorkflowCommand,
  id?: string,
  revision?: number,
): asserts value is WorkflowDetail {
  try {
    assertWorkflowDetail(value, id);
    const statuses: Record<WorkflowCommand, readonly string[]> = {
      "workflow.create": ["draft"],
      "workflow.save": ["draft", "active", "paused"],
      "workflow.publish": ["active", "paused"],
      "workflow.start": ["active"],
      "workflow.pause": ["paused"],
      "workflow.archive": ["archived"],
    };
    if (!statuses[command].includes(value.status)) throw new Error("Invalid command status");
    if (
      command === "workflow.create"
        ? value.revision !== 1 || value.status !== "draft"
        : revision !== undefined && value.revision !== revision + 1
    )
      throw new Error("Invalid command revision");
  } catch {
    throw new CommandOutcomeUnknown(
      undefined,
      "Confirmation did not match this workflow command. Check its receipt before continuing.",
    );
  }
}
export function isWorkflowCommand(value: unknown): value is WorkflowCommand {
  return (
    typeof value === "string" &&
    [
      "workflow.create",
      "workflow.save",
      "workflow.publish",
      "workflow.start",
      "workflow.pause",
      "workflow.archive",
    ].includes(value)
  );
}
export function assertWorkflowReceipt(
  value: unknown,
  expected: { operationId: string; command?: WorkflowCommand; id?: string },
): asserts value is WorkflowOperationResponse {
  if (
    !isRecord(value) ||
    value.operation_id !== expected.operationId ||
    value.state !== "committed" ||
    !isWorkflowCommand(value.command) ||
    (expected.command !== undefined && value.command !== expected.command) ||
    value.entity_type !== "workflow" ||
    !uuid(value.entity_id) ||
    (expected.id !== undefined && value.entity_id !== expected.id) ||
    !timestamp(value.committed_at)
  )
    throw new ApiError("Workflow receipt is unavailable. Check again before continuing.", 503);
  assertWorkflowCommandResult(value.result, value.command, value.entity_id);
}
async function result(
  promise: Promise<WorkflowDetail>,
  command: WorkflowCommand,
  id?: string,
  revision?: number,
) {
  const value = await promise;
  assertWorkflowCommandResult(value, command, id, revision);
  return value;
}
export function workflowSaveBody(request: WorkflowSaveRequest): WorkflowSaveRequest {
  return checkedWorkflowBody({
    ...workflowCreateBody(request),
    expected_revision: request.expected_revision,
  });
}
export const workflowApi = {
  catalog: async (token: string, signal?: AbortSignal) => {
    const value = await api.get<WorkflowCatalogResponse>("/automations/catalog", token, { signal });
    assertWorkflowCatalog(value);
    return value;
  },
  list: async (
    options: { cursor?: string; limit?: number },
    token: string,
    signal?: AbortSignal,
  ) => {
    if (
      (options.cursor?.length ?? 0) > 512 ||
      (options.limit !== undefined && (!integer(options.limit, 1) || options.limit > 100))
    )
      throw new ApiError("Invalid workflow page request.", 422);
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.cursor) query.set("cursor", options.cursor);
    const value = await api.get<WorkflowListResponse>(`${ROOT}?${query}`, token, { signal });
    if (
      !isRecord(value) ||
      !Array.isArray(value.items) ||
      value.items.length > 100 ||
      !value.items.every(
        (item) =>
          validSummary(item) &&
          timestamp(item.created_at) &&
          nullableString(item.trigger_event_type) &&
          nullableString(item.draft_trigger_event_type),
      ) ||
      !nullableString(value.next_cursor) ||
      (value.next_cursor?.length ?? 0) > 512 ||
      value.next_cursor === "" ||
      value.has_more !== (value.next_cursor !== null)
    )
      throw new ApiError("Workflow list is unavailable.", 503);
    return value;
  },
  operation: async (operationId: string, token: string, signal?: AbortSignal) => {
    const value = await api.get<WorkflowOperationResponse>(
      `/automations/operations/${encodeURIComponent(operationId)}`,
      token,
      { signal },
    );
    assertWorkflowReceipt(value, { operationId });
    return value;
  },
  detail: async (id: string, token: string, signal?: AbortSignal) => {
    const value = await api.get<WorkflowDetail>(path(id), token, { signal });
    assertWorkflowDetail(value, id);
    return value;
  },
  create: (request: WorkflowCreateRequest, token: string, signal?: AbortSignal) =>
    result(
      api.post<WorkflowDetail>(ROOT, workflowCreateBody(request), token, { signal }),
      "workflow.create",
    ),
  save: (id: string, request: WorkflowSaveRequest, token: string, signal?: AbortSignal) =>
    result(
      api.put<WorkflowDetail>(path(id), workflowSaveBody(request), token, { signal }),
      "workflow.save",
      id,
      request.expected_revision,
    ),
  validate: (request: WorkflowValidateRequest, token: string, signal?: AbortSignal) => {
    const draft = canonicalWorkflowDraft({
      graph: request.graph,
      layout: request.layout ?? { positions: {} },
    });
    return api.post<WorkflowValidationResponse>(
      `${ROOT}/validate`,
      checkedWorkflowBody({
        graph: draft.graph,
        ...(request.layout === undefined ? {} : { layout: draft.layout }),
      }),
      token,
      { signal },
    );
  },
  publish: (id: string, request: WorkflowPublishRequest, token: string, signal?: AbortSignal) =>
    result(
      api.post<WorkflowDetail>(
        `${path(id)}/publish`,
        checkedWorkflowBody({
          ...commandBody(request),
          cancel_pending: request.cancel_pending ?? false,
        }),
        token,
        { signal },
      ),
      "workflow.publish",
      id,
      request.expected_revision,
    ),
  start: (id: string, request: WorkflowCommandRequest, token: string, signal?: AbortSignal) =>
    result(
      api.post<WorkflowDetail>(
        `${path(id)}/start`,
        checkedWorkflowBody(commandBody(request)),
        token,
        { signal },
      ),
      "workflow.start",
      id,
      request.expected_revision,
    ),
  pause: (id: string, request: WorkflowCommandRequest, token: string, signal?: AbortSignal) =>
    result(
      api.post<WorkflowDetail>(
        `${path(id)}/pause`,
        checkedWorkflowBody(commandBody(request)),
        token,
        { signal },
      ),
      "workflow.pause",
      id,
      request.expected_revision,
    ),
  simulate: (id: string, request: WorkflowSimulateRequest, token: string, signal?: AbortSignal) => {
    const { graph } = canonicalWorkflowDraft({ graph: request.graph, layout: { positions: {} } });
    const context: WorkflowSimulationContext =
      request.context.kind === "synthetic"
        ? { kind: "synthetic" }
        : {
            kind: "entity",
            entity_type: request.context.entity_type,
            entity_id: request.context.entity_id,
          };
    return api.post<WorkflowSimulationResponse>(
      `${path(id)}/simulate`,
      checkedWorkflowBody({ graph, context }),
      token,
      {
        signal,
      },
    );
  },
  archive: (id: string, request: WorkflowCommandRequest, token: string, signal?: AbortSignal) =>
    result(
      api.post<WorkflowDetail>(
        `${path(id)}/archive`,
        checkedWorkflowBody(commandBody(request)),
        token,
        { signal },
      ),
      "workflow.archive",
      id,
      request.expected_revision,
    ),
};

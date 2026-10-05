import { api } from "@/lib/api";
import { canonicalWorkflowDraft } from "./automation-workflow-model.ts";
import type {
  WorkflowCommandRequest,
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
const commandBody = ({ operation_id, expected_revision }: WorkflowCommandRequest) => ({
  operation_id,
  expected_revision,
});
const createBody = (request: WorkflowCreateRequest): WorkflowCreateRequest => ({
  operation_id: request.operation_id,
  name: request.name,
  description: request.description,
  ...canonicalWorkflowDraft(request),
});

// Commands retain the caller's identity. Unknown outcomes are reconciled by readback, never retry.
export const workflowApi = {
  detail: (id: string, token: string, signal?: AbortSignal) =>
    api.get<WorkflowDetail>(path(id), token, { signal }),
  create: (request: WorkflowCreateRequest, token: string, signal?: AbortSignal) =>
    api.post<WorkflowDetail>(ROOT, createBody(request), token, { signal }),
  save: (id: string, request: WorkflowSaveRequest, token: string, signal?: AbortSignal) =>
    api.put<WorkflowDetail>(
      path(id),
      {
        ...createBody(request),
        expected_revision: request.expected_revision,
      },
      token,
      { signal },
    ),
  validate: (request: WorkflowValidateRequest, token: string, signal?: AbortSignal) => {
    const draft = canonicalWorkflowDraft({
      graph: request.graph,
      layout: request.layout ?? { positions: {} },
    });
    return api.post<WorkflowValidationResponse>(
      `${ROOT}/validate`,
      {
        graph: draft.graph,
        ...(request.layout === undefined ? {} : { layout: draft.layout }),
      },
      token,
      { signal },
    );
  },
  publish: (id: string, request: WorkflowPublishRequest, token: string, signal?: AbortSignal) =>
    api.post<WorkflowDetail>(
      `${path(id)}/publish`,
      {
        ...commandBody(request),
        cancel_pending: request.cancel_pending ?? false,
      },
      token,
      { signal },
    ),
  start: (id: string, request: WorkflowCommandRequest, token: string, signal?: AbortSignal) =>
    api.post<WorkflowDetail>(`${path(id)}/start`, commandBody(request), token, { signal }),
  pause: (id: string, request: WorkflowCommandRequest, token: string, signal?: AbortSignal) =>
    api.post<WorkflowDetail>(`${path(id)}/pause`, commandBody(request), token, { signal }),
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
    return api.post<WorkflowSimulationResponse>(`${path(id)}/simulate`, { graph, context }, token, {
      signal,
    });
  },
  archive: (id: string, request: WorkflowCommandRequest, token: string, signal?: AbortSignal) =>
    api.post<WorkflowDetail>(`${path(id)}/archive`, commandBody(request), token, { signal }),
};

// Catalog, operation receipt, workflow list and run adapters await generated backend DTOs.

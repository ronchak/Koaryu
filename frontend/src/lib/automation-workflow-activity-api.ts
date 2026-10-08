import { api, ApiError, CommandOutcomeUnknown } from "./api.ts";
import { workflowApi } from "./automation-workflow-api.ts";
import {
  buildWorkflowRunCancel,
  buildWorkflowSimulationRequest,
  buildWorkflowTestEmail,
  isWorkflowActivityReceipt,
  isWorkflowRunCancelResult,
  isWorkflowRunDetail,
  isWorkflowRunPage,
  isWorkflowSimulationResponse,
  isWorkflowTestDelivery,
} from "./automation-workflow-activity-contract.ts";
import type {
  WorkflowActivityReceiptIdentity,
  WorkflowRunIdentity,
  WorkflowTestDeliveryIdentity,
} from "./automation-workflow-activity-contract.ts";
import type { WorkflowGraph, WorkflowSimulateRequest } from "./automation-workflow-types.ts";
import type {
  ApiWorkflowRunDetail,
  ApiWorkflowTestEmailRequest,
} from "../types/generated/api-contracts";

const ROOT = "/automations";
function id(value: string): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw new ApiError("Invalid workflow activity identity.", 422);
  return value.toLowerCase();
}
function runIdentity(value: WorkflowRunIdentity): WorkflowRunIdentity {
  return {
    studioId: id(value.studioId),
    workflowId: id(value.workflowId),
    ...(value.runId === undefined ? {} : { runId: id(value.runId) }),
  };
}
function unavailable(): never {
  throw new ApiError("Workflow activity is unavailable. Check its status again.", 503);
}
async function read<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof SyntaxError) unavailable();
    throw error;
  }
}
function unknown(operationId: string): never {
  throw new CommandOutcomeUnknown(
    operationId,
    "Confirmation did not match this command. Check its receipt before continuing.",
  );
}

export const workflowActivityApi = {
  // Simulation is a read. The delegated POST transport can report an unknown outcome
  // for parse/network/5xx failures; callers must not start command receipt recovery.
  simulate: async (
    workflowId: string,
    request: WorkflowSimulateRequest,
    token: string,
    signal?: AbortSignal,
  ) => {
    const workflow = id(workflowId);
    const body = buildWorkflowSimulationRequest(request.graph, request.context);
    const graph = body.graph;
    const value = await workflowApi.simulate(workflow, { ...body, graph }, token, signal);
    if (!isWorkflowSimulationResponse(value, graph)) unavailable();
    return value;
  },
  listRuns: async (
    identity: WorkflowRunIdentity,
    options: { cursor?: string; limit?: number },
    token: string,
    signal?: AbortSignal,
  ) => {
    const expected = runIdentity(identity);
    const limit = options.limit === undefined ? 50 : options.limit,
      cursor = options.cursor;
    if (
      expected.runId !== undefined ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (cursor !== undefined &&
        (typeof cursor !== "string" ||
          Array.from(cursor).length < 1 ||
          Array.from(cursor).length > 512))
    )
      throw new ApiError("Invalid workflow run page request.", 422);
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) query.set("cursor", cursor);
    const value = await read(
      api.get<unknown>(
        `${ROOT}/workflows/${encodeURIComponent(expected.workflowId)}/runs?${query}`,
        token,
        { signal },
      ),
    );
    if (!isWorkflowRunPage(value, expected, limit)) unavailable();
    return value;
  },
  getRun: async (identity: Required<WorkflowRunIdentity>, token: string, signal?: AbortSignal) => {
    const expected = runIdentity(identity),
      run = id(identity.runId);
    const value = await read(
      api.get<unknown>(`${ROOT}/runs/${encodeURIComponent(run)}`, token, {
        signal,
      }),
    );
    if (!isWorkflowRunDetail(value, expected)) unavailable();
    return value;
  },
  cancelRun: async (
    baseline: Readonly<ApiWorkflowRunDetail>,
    operationId: string,
    token: string,
    signal?: AbortSignal,
  ) => {
    const operation = id(operationId);
    const body = buildWorkflowRunCancel(operation, baseline);
    const captured = structuredClone(baseline);
    const value = await api.post<unknown>(
      `${ROOT}/runs/${encodeURIComponent(id(captured.run.id))}/cancel`,
      body,
      token,
      { signal },
    );
    if (!isWorkflowRunCancelResult(value, captured)) unknown(operationId);
    return value;
  },
  getOperation: async (
    identity: WorkflowActivityReceiptIdentity,
    token: string,
    signal?: AbortSignal,
  ) => {
    const operationId = id(identity.operationId);
    let expected: WorkflowActivityReceiptIdentity;
    if (identity.command === "run.cancel") {
      expected = {
        command: "run.cancel",
        operationId,
        ...runIdentity(identity),
        runId: id(identity.runId),
      };
    } else if (identity.command === "test_email.create") {
      expected = {
        command: "test_email.create",
        operationId,
        ...(identity.testDeliveryId === undefined
          ? {}
          : { testDeliveryId: id(identity.testDeliveryId) }),
      };
    } else throw new ApiError("Invalid workflow activity command.", 422);
    const value = await read(
      api.get<unknown>(`${ROOT}/operations/${encodeURIComponent(operationId)}`, token, { signal }),
    );
    if (!isWorkflowActivityReceipt(value, expected)) unavailable();
    return value;
  },
  sendTestEmail: async (
    workflowId: string,
    request: Omit<ApiWorkflowTestEmailRequest, "graph"> & { graph: WorkflowGraph },
    token: string,
    signal?: AbortSignal,
  ) => {
    const workflow = id(workflowId),
      operation = request.operation_id;
    const body = buildWorkflowTestEmail(operation, request.graph, request.email_node_id);
    const expected = { operationId: body.operation_id };
    const value = await api.post<unknown>(
      `${ROOT}/workflows/${encodeURIComponent(workflow)}/test-email`,
      body,
      token,
      { signal },
    );
    if (!isWorkflowTestDelivery(value, expected)) unknown(operation);
    return value;
  },
  getTestDelivery: async (
    identity: Required<WorkflowTestDeliveryIdentity>,
    token: string,
    signal?: AbortSignal,
  ) => {
    const expected = {
      operationId: id(identity.operationId),
      testDeliveryId: id(identity.testDeliveryId),
    };
    const value = await read(
      api.get<unknown>(
        `${ROOT}/test-deliveries/${encodeURIComponent(expected.testDeliveryId)}`,
        token,
        { signal },
      ),
    );
    if (!isWorkflowTestDelivery(value, expected)) unavailable();
    return value;
  },
};

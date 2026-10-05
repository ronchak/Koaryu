import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { register } from "node:module";

register("./helpers/path-alias-loader.mjs", import.meta.url);
const { workflowApi } = await import("../src/lib/automation-workflow-api.ts");
const { ApiError, CommandOutcomeUnknown, api } = await import("../src/lib/api.ts");
const { initialWorkflowDraft, canonicalWorkflowDraft } =
  await import("../src/lib/automation-workflow-model.ts");
const nativeFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = nativeFetch;
});

const operation_id = "12d540e8-054a-4a27-acba-f507684320fc";
const command = { operation_id, expected_revision: 7 };
const token = "synthetic-token";
const id = "workflow/with ?characters";
const route = `/automations/workflows/${encodeURIComponent(id)}`;
function detail() {
  const draft = initialWorkflowDraft();
  return {
    id: "5aa8c5ca-d0f0-4f5e-a7ad-89c711f50365",
    name: "Welcome",
    description: "",
    status: "draft",
    revision: 8,
    draft_graph: draft.graph,
    draft_layout: draft.layout,
    validation_issues: [],
    published_version_id: null,
    published_version_number: null,
    published_at: null,
    updated_at: "2026-10-05T12:00:00Z",
    has_unpublished_changes: true,
    pending_run_count: 0,
    sending_run_count: 0,
  };
}
function capture(response = detail()) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ pathname: new URL(url).pathname, init });
    return Response.json(response);
  };
  return calls;
}
function assertRequest(call, method, suffix, body, controller) {
  assert.ok(call.pathname.endsWith(suffix), call.pathname);
  assert.equal(call.init.method, method);
  assert.equal(call.init.headers.Authorization, `Bearer ${token}`);
  assert.equal(call.init.headers["Content-Type"], "application/json");
  assert.deepEqual(call.init.body === undefined ? undefined : JSON.parse(call.init.body), body);
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.equal(call.init.signal.aborted, controller.signal.aborted);
}

test("create and save project draft JSON and forward operation/revision through authenticated transport", async () => {
  const response = detail();
  const calls = capture(response);
  const controller = new AbortController();
  const draft = initialWorkflowDraft();
  draft.graph.nodes[0].selected = true;
  const request = {
    operation_id,
    name: "Welcome",
    description: "Editable draft",
    ...draft,
    selection: "trigger_1",
  };
  const body = {
    operation_id,
    name: request.name,
    description: request.description,
    ...canonicalWorkflowDraft(draft),
  };
  assert.deepEqual(await workflowApi.create(request, token, controller.signal), response);
  assert.deepEqual(
    await workflowApi.save(id, { ...request, expected_revision: 7 }, token, controller.signal),
    response,
  );
  assert.equal(calls.length, 2);
  assertRequest(calls[0], "POST", "/automations/workflows", body, controller);
  assertRequest(calls[1], "PUT", route, { ...body, expected_revision: 7 }, controller);
  assert.equal(request.graph.nodes[0].selected, true);
});

test("validation uses fixed validate route and omits absent layout", async () => {
  const response = {
    valid: false,
    issues: [
      {
        code: "incomplete_config",
        message: "Choose a trigger.",
        node_id: "trigger_1",
        edge_id: null,
        field: "config.event_type",
      },
    ],
  };
  const calls = capture(response);
  const controller = new AbortController();
  const draft = initialWorkflowDraft();
  assert.deepEqual(await workflowApi.validate(draft, token, controller.signal), response);
  await workflowApi.validate({ graph: draft.graph }, token, controller.signal);
  assertRequest(
    calls[0],
    "POST",
    "/automations/workflows/validate",
    canonicalWorkflowDraft(draft),
    controller,
  );
  assertRequest(
    calls[1],
    "POST",
    "/automations/workflows/validate",
    { graph: canonicalWorkflowDraft(draft).graph },
    controller,
  );
});

test("publish defaults cancel_pending false and lifecycle commands preserve caller identity", async () => {
  const calls = capture();
  const controller = new AbortController();
  await workflowApi.publish(id, command, token, controller.signal);
  await workflowApi.publish(id, { ...command, cancel_pending: true }, token, controller.signal);
  assertRequest(
    calls[0],
    "POST",
    `${route}/publish`,
    { ...command, cancel_pending: false },
    controller,
  );
  assertRequest(
    calls[1],
    "POST",
    `${route}/publish`,
    { ...command, cancel_pending: true },
    controller,
  );
  for (const action of ["start", "pause", "archive"]) {
    await workflowApi[action](id, { ...command, unexpected: "discard" }, token, controller.signal);
    assertRequest(calls.at(-1), "POST", `${route}/${action}`, command, controller);
  }
  assert.equal(calls.length, 5);
});

test("detail GET encodes route ID and forwards token and signal", async () => {
  const response = detail();
  const calls = capture(response);
  const controller = new AbortController();
  assert.deepEqual(await workflowApi.detail(id, token, controller.signal), response);
  assertRequest(calls[0], "GET", route, undefined, controller);
});

test("409 stale revisions preserve ApiError without repeating the command", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ detail: "Stale revision" }, { status: 409 });
  };
  await assert.rejects(
    workflowApi.start(id, command, token),
    (error) =>
      error instanceof ApiError && error.status === 409 && error.message === "Stale revision",
  );
  assert.equal(calls, 1);
});

test("lost response yields one CommandOutcomeUnknown and never repeats or creates a new operation ID", async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    throw new TypeError("Synthetic connection loss");
  };
  await assert.rejects(workflowApi.publish(id, command, token), CommandOutcomeUnknown);
  assert.deepEqual(calls, [{ ...command, cancel_pending: false }]);
});

test("adapter preserves exact error objects raised by its transport", async () => {
  const nativePost = api.post;
  try {
    for (const error of [new ApiError("Stale revision", 409), new CommandOutcomeUnknown()]) {
      api.post = async () => {
        throw error;
      };
      await assert.rejects(workflowApi.start(id, command, token), (actual) => actual === error);
    }
  } finally {
    api.post = nativePost;
  }
});

test("caller abort reaches fetch and retains transport behavior for reads and dispatched commands", async () => {
  for (const action of ["detail", "start"]) {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Canceled", "AbortError")),
          { once: true },
        );
      });
    };
    const pending =
      action === "detail"
        ? workflowApi.detail(id, token, controller.signal)
        : workflowApi.start(id, command, token, controller.signal);
    controller.abort();
    await assert.rejects(
      pending,
      action === "detail" ? (error) => error.name === "AbortError" : CommandOutcomeUnknown,
    );
    assert.equal(calls, 1);
  }
});

test("already aborted mutation remains a caller AbortError before dispatch", async () => {
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.signal.aborted, true);
    throw new DOMException("Canceled", "AbortError");
  };
  await assert.rejects(
    workflowApi.start(id, command, token, controller.signal),
    (error) => error.name === "AbortError" && !(error instanceof CommandOutcomeUnknown),
  );
});

test("simulation sends only graph and server-derived context and preserves the typed trace", async () => {
  const response = {
    valid: true,
    issues: [],
    reference_time: "2026-10-05T12:00:00Z",
    future_conditions_rechecked: true,
    trace: [
      {
        node_id: "email_1",
        outcome: "would_send",
        edge_id: null,
        reason: null,
        scheduled_at: null,
        action_kind: "email",
        rendered_subject: "Hello",
        rendered_body: "Welcome",
      },
    ],
    next_actions: [{ node_id: "email_1", scheduled_at: null, action_kind: "email", reason: null }],
  };
  const calls = capture(response);
  const controller = new AbortController();
  const draft = initialWorkflowDraft();
  const graph = canonicalWorkflowDraft(draft).graph;
  assert.deepEqual(
    await workflowApi.simulate(
      id,
      { ...draft, context: { kind: "synthetic", reference_time: "override" }, operation_id },
      token,
      controller.signal,
    ),
    response,
  );
  assertRequest(
    calls[0],
    "POST",
    `${route}/simulate`,
    { graph, context: { kind: "synthetic" } },
    controller,
  );
  for (const entity_type of [
    "student",
    "promotion",
    "lead",
    "trial_appointment",
    "invoice",
    "payment",
    "belt_test_recipient",
  ]) {
    const context = {
      kind: "entity",
      entity_type,
      entity_id: "27fe882a-e3d9-48a1-b5e5-d0769a6495ef",
    };
    await workflowApi.simulate(
      id,
      {
        graph,
        context: { ...context, facts: { fake: true }, reference_time: "override" },
        reference_time: "override",
      },
      token,
      controller.signal,
    );
    assertRequest(calls.at(-1), "POST", `${route}/simulate`, { graph, context }, controller);
  }
});

// Emitted by WorkflowGraph.model_validate(raw).model_dump(mode="json").
// Core ba64e8dcb531ef05c0ddddbaa92d34e3e323fae8 and domains catalog
// 68648b6fb261b2bb0959a9df7ef5e1ddcc15bee9: draft valid, execution has only
// incomplete_config at condition/config.value. Tests require no Python or sibling checkout.
const coreOmittedValueGraph = {
  schema_version: 1,
  nodes: [
    { id: "trigger", type: "trigger", config: { event_type: "lead.created", program_id: null } },
    { id: "condition", type: "condition", config: { field: "lead.unconverted", operator: "eq" } },
    { id: "yes", type: "delay", config: { mode: "duration", minutes: 0 } },
    { id: "no", type: "delay", config: { mode: "duration", minutes: 0 } },
    { id: "end", type: "end", config: {} },
  ],
  edges: [
    { id: "e1", source: "trigger", target: "condition", port: "next" },
    { id: "e2", source: "condition", target: "yes", port: "yes" },
    { id: "e3", source: "condition", target: "no", port: "no" },
    { id: "e4", source: "yes", target: "end", port: "next" },
    { id: "e5", source: "no", target: "end", port: "next" },
  ],
};

test("create/save/simulate preserve omitted comparison and explicit null as distinct request data", async () => {
  const calls = capture();
  const controller = new AbortController();
  for (const explicitNull of [false, true]) {
    const graph = structuredClone(coreOmittedValueGraph);
    const config = graph.nodes.find((node) => node.id === "condition").config;
    if (explicitNull) {
      config.field = "program.id";
      config.value = null;
    }
    const request = {
      operation_id,
      name: "Incomplete condition",
      description: "",
      graph,
      layout: { positions: {} },
    };
    await workflowApi.create(request, token, controller.signal);
    await workflowApi.save(id, { ...request, expected_revision: 7 }, token, controller.signal);
    await workflowApi.simulate(
      id,
      { graph, context: { kind: "synthetic" } },
      token,
      controller.signal,
    );
    const expectedGraph = canonicalWorkflowDraft(request).graph;
    const body = {
      operation_id,
      name: request.name,
      description: "",
      graph: expectedGraph,
      layout: request.layout,
    };
    const recent = calls.slice(-3);
    assertRequest(recent[0], "POST", "/automations/workflows", body, controller);
    assertRequest(recent[1], "PUT", route, { ...body, expected_revision: 7 }, controller);
    assertRequest(
      recent[2],
      "POST",
      `${route}/simulate`,
      { graph: expectedGraph, context: { kind: "synthetic" } },
      controller,
    );
    for (const call of recent) {
      const sent = JSON.parse(call.init.body).graph.nodes.find(
        (node) => node.id === "condition",
      ).config;
      assert.equal(Object.hasOwn(sent, "value"), explicitNull);
      assert.deepEqual(sent, config);
    }
    assert.equal(Object.hasOwn(config, "value"), explicitNull);
  }
  assert.equal(calls.length, 6);
});

test("present undefined comparison fails before transport rather than being omitted from a command", () => {
  const calls = capture();
  const graph = structuredClone(coreOmittedValueGraph);
  graph.nodes.find((node) => node.id === "condition").config.value = undefined;
  const request = {
    operation_id,
    name: "Invalid comparison",
    description: "",
    graph,
    layout: { positions: {} },
  };
  assert.throws(() => workflowApi.create(request, token), /finite scalar/);
  assert.throws(
    () => workflowApi.save(id, { ...request, expected_revision: 7 }, token),
    /finite scalar/,
  );
  assert.throws(
    () => workflowApi.simulate(id, { graph, context: { kind: "synthetic" } }, token),
    /finite scalar/,
  );
  assert.equal(calls.length, 0);
});

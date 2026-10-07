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
const id = "5aa8c5ca-d0f0-4f5e-a7ad-89c711f50365";
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
    const action = new URL(url).pathname.split("/").at(-1);
    const status = { publish: "paused", start: "active", pause: "paused", archive: "archived" }[
      action
    ];
    return Response.json({
      ...response,
      ...(status
        ? {
            status,
            published_version_id: "20000000-0000-4000-8000-000000000001",
            published_version_number: 1,
            published_at: "2026-10-05T12:00:00Z",
          }
        : {}),
      ...(new URL(url).pathname.endsWith("/workflows") && init.method === "POST"
        ? { revision: 1, status: "draft" }
        : {}),
    });
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
  assert.deepEqual(await workflowApi.create(request, token, controller.signal), {
    ...response,
    revision: 1,
  });
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

const { sizedRequest, catalog, receipt, ids } =
  await import("./helpers/workflow-workspace-fixture.mjs");
const { WORKFLOW_MAX_REQUEST_BYTES, assertWorkflowReceipt } =
  await import("../src/lib/automation-workflow-api.ts");

test("complete canonical UTF-8 body accepts exact maximum and rejects max+1 before fetch", async () => {
  const request = sizedRequest(WORKFLOW_MAX_REQUEST_BYTES, operation_id);
  let seen;
  globalThis.fetch = async (_url, init) => {
    seen = init.body;
    return Response.json({ ...detail(), revision: 1 });
  };
  await workflowApi.create(request, token);
  assert.equal(Buffer.byteLength(seen), WORKFLOW_MAX_REQUEST_BYTES);
  const tooBig = sizedRequest(WORKFLOW_MAX_REQUEST_BYTES + 1, operation_id);
  seen = null;
  assert.throws(
    () => workflowApi.create(tooBig, token),
    (error) => error instanceof ApiError && error.status === 413,
  );
  assert.equal(seen, null);
  // The expected_revision field belongs to the same complete-body budget.
  assert.throws(
    () => workflowApi.save(id, { ...request, expected_revision: 7 }, token),
    (error) => error.status === 413,
  );
});

test("typed malformed 200, wrong target and command revision failures are unknown outcomes", async () => {
  for (const response of [{}, { ...detail(), id: ids.other }, { ...detail(), revision: 7 }]) {
    capture(response);
    await assert.rejects(
      workflowApi.save(
        id,
        {
          operation_id,
          name: "A",
          description: "",
          ...initialWorkflowDraft(),
          expected_revision: 7,
        },
        token,
      ),
      CommandOutcomeUnknown,
    );
  }
  globalThis.fetch = async () => Response.json({ ...detail(), revision: 1, status: "active" });
  await assert.rejects(
    workflowApi.create(
      { operation_id, name: "A", description: "", ...initialWorkflowDraft() },
      token,
    ),
    CommandOutcomeUnknown,
  );
});

test("catalog, bounded list and receipt reads preserve typed ownership without response fallback", async () => {
  capture(catalog);
  assert.deepEqual(await workflowApi.catalog(token), catalog);
  capture({ ...catalog, capabilities: { ...catalog.capabilities, can_start: 1 } });
  await assert.rejects(workflowApi.catalog(token), (error) => error.status === 503);
  const page = { items: [], next_cursor: null, has_more: false };
  let called;
  globalThis.fetch = async (url, init) => {
    called = { url, init };
    return Response.json(page);
  };
  assert.deepEqual(await workflowApi.list({}, token), page);
  assert.ok(called.url.endsWith("?limit=50"));
  await assert.rejects(workflowApi.list({ limit: 101 }, token), (error) => error.status === 422);
  await assert.rejects(
    workflowApi.list({ cursor: "x".repeat(513) }, token),
    (error) => error.status === 422,
  );
  capture({ ...page, has_more: true });
  await assert.rejects(workflowApi.list({}, token), (error) => error.status === 503);
  const result = { ...detail(), revision: 1 };
  const committed = receipt(operation_id, "workflow.create", result);
  capture(committed);
  assert.deepEqual(await workflowApi.operation(operation_id, token), committed);
  assert.throws(
    () => assertWorkflowReceipt(committed, { operationId: operation_id, command: "workflow.save" }),
    (error) => error.status === 503,
  );
  capture({ ...committed, entity_id: ids.other });
  await assert.rejects(workflowApi.operation(operation_id, token), CommandOutcomeUnknown);
});

test("wrong detail ownership is rejected after encoding the supplied path", async () => {
  const calls = capture();
  const unsafe = "workflow/with ?characters";
  await assert.rejects(workflowApi.detail(unsafe, token), (error) => error.status === 503);
  assert.ok(calls[0].pathname.endsWith(encodeURIComponent(unsafe)));
});

test("actual server413/422 are definite rejections with the submitted operation identity", async () => {
  for (const status of [413, 422]) {
    let sent;
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(init.body);
      return Response.json({ detail: "Rejected" }, { status });
    };
    await assert.rejects(
      workflowApi.create(
        { operation_id, name: "Draft", description: "", ...initialWorkflowDraft() },
        token,
      ),
      (error) => error instanceof ApiError && error.status === status,
    );
    assert.equal(sent.operation_id, operation_id);
  }
});

test("generated output fixtures retain all six node branches, nullable fields and omissions through transport", async () => {
  const { canonicalCreate, untilOutputNode } =
    await import("./helpers/workflow-workspace-contract-fixture.ts");
  const request = structuredClone(canonicalCreate);
  request.graph.nodes.push(structuredClone(untilOutputNode));
  const response = {
    ...detail(),
    revision: 1,
    draft_graph: request.graph,
    draft_layout: request.layout,
  };
  const calls = capture(response);
  const result = await workflowApi.create(request, token);
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(
    new Set(sent.graph.nodes.map((node) => node.type)),
    new Set(["trigger", "condition", "delay", "email", "lead_follow_up", "end"]),
  );
  for (const graph of [result.draft_graph, sent.graph]) {
    const nodes = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
    assert.equal(nodes.trigger.config.event_type, null);
    assert.equal(nodes.trigger.config.program_id, null);
    assert.equal(Object.hasOwn(nodes.trigger.config, "offset_minutes"), false);
    assert.equal(nodes.condition.config.field, null);
    assert.equal(nodes.condition.config.operator, null);
    assert.equal(Object.hasOwn(nodes.condition.config, "value"), false);
    assert.equal(nodes.delay.config.minutes, null);
    assert.equal(nodes.until.config.field, null);
    assert.equal(nodes.until.config.offset_minutes, 0);
    assert.equal(nodes.email.config.recipient, null);
    assert.equal(nodes.email.config.reply_to_email, "");
    assert.equal(nodes.follow_up.config.due_in_days, null);
    assert.deepEqual(nodes.end.config, {});
  }
});

test("catalog transport rejects incompatible field types/operators instead of asserting generated wire metadata", async () => {
  const base = {
    id: "field",
    label: "Field",
    value_type: "enum",
    operators: ["eq"],
    nullable: false,
    values: ["allowed"],
  };
  for (const field of [
    { ...base, value_type: "number" },
    { ...base, value_type: "datetime" },
    { ...base, value_type: "string" },
    { ...base, operators: ["gt"] },
    { ...base, operators: ["eq", "unknown"] },
  ]) {
    capture({ ...catalog, fields: { field } });
    await assert.rejects(
      workflowApi.catalog(token),
      (error) => error instanceof ApiError && error.status === 503,
    );
  }
  for (const values of [undefined, ["allowed"]]) {
    const field = { ...base };
    if (values === undefined) delete field.values;
    else field.values = values;
    capture({ ...catalog, fields: { field } });
    const returned = await workflowApi.catalog(token);
    assert.equal(Object.hasOwn(returned.fields.field, "values"), values !== undefined);
    assert.deepEqual(returned.fields.field.values, values);
  }
});

test("generated condition scalar null, false and zero remain present in canonical request and response", async () => {
  const { canonicalCreate } = await import("./helpers/workflow-workspace-contract-fixture.ts");
  for (const value of [null, false, 0]) {
    const request = structuredClone(canonicalCreate);
    request.graph.nodes.find((node) => node.type === "condition").config.value = value;
    const calls = capture({
      ...detail(),
      revision: 1,
      draft_graph: request.graph,
      draft_layout: request.layout,
    });
    const response = await workflowApi.create(request, token);
    const sent = JSON.parse(calls[0].init.body).graph.nodes.find(
      (node) => node.type === "condition",
    ).config;
    const returned = response.draft_graph.nodes.find((node) => node.type === "condition").config;
    assert.equal(Object.hasOwn(sent, "value"), true);
    assert.equal(sent.value, value);
    assert.equal(returned.value, value);
  }
});

const { assertWorkflowCatalog, assertWorkflowDetail } =
  await import("../src/lib/automation-workflow-api.ts");

function enumCatalog() {
  return {
    ...structuredClone(catalog),
    triggers: {
      event: {
        id: "event",
        label: "Event",
        subject_kind: "lead",
        simulation_entity_type: "lead",
        recipient_ids: [],
        field_ids: [],
        template_variables: [],
        delay_fields: [],
        supports_offset: false,
        supports_program_filter: false,
        supports_lead_follow_up: false,
      },
    },
    fields: {
      field: {
        id: "field",
        label: "Field",
        value_type: "enum",
        operators: ["eq"],
        nullable: false,
      },
    },
  };
}
const malformedEnums = (value) => [[value], { value }, null, 0];
const unavailable = (error) => error instanceof ApiError && error.status === 503;
const enumBoundaries = [
  {
    label: "detail status",
    valid: "draft",
    make: (value) => ({ ...detail(), status: value }),
    check: assertWorkflowDetail,
  },
  {
    label: "delivery mode",
    valid: "disabled",
    make: (value) => {
      const response = enumCatalog();
      response.delivery_status.mode = value;
      return response;
    },
    check: assertWorkflowCatalog,
  },
  {
    label: "trigger subject kind",
    valid: "lead",
    make: (value) => {
      const response = enumCatalog();
      response.triggers.event.subject_kind = value;
      return response;
    },
    check: assertWorkflowCatalog,
  },
  {
    label: "trigger simulation entity type",
    valid: "lead",
    make: (value) => {
      const response = enumCatalog();
      response.triggers.event.simulation_entity_type = value;
      return response;
    },
    check: assertWorkflowCatalog,
  },
  {
    label: "field value type",
    valid: "enum",
    make: (value) => {
      const response = enumCatalog();
      response.fields.field.value_type = value;
      return response;
    },
    check: assertWorkflowCatalog,
  },
];

for (const boundary of enumBoundaries) {
  test(`${boundary.label} rejects malformed JSON enums as unavailable reads`, async () => {
    for (const value of malformedEnums(boundary.valid)) {
      const response = boundary.make(value);
      assert.throws(() => boundary.check(response), unavailable);
      let reads = 0;
      globalThis.fetch = async () => {
        reads++;
        return Response.json(response);
      };
      await assert.rejects(
        boundary.label === "detail status"
          ? workflowApi.detail(id, token)
          : workflowApi.catalog(token),
        unavailable,
      );
      assert.equal(reads, 1);
    }
  });
}

test("enum validation rejects boxed strings and objects without invoking coercion", () => {
  for (const boundary of enumBoundaries) {
    let coerced = 0;
    const value = {
      [Symbol.toPrimitive]() {
        coerced++;
        return boundary.valid;
      },
      toString() {
        coerced++;
        return boundary.valid;
      },
    };
    assert.throws(() => boundary.check(boundary.make(value)), unavailable);
    assert.equal(coerced, 0, boundary.label);
    assert.throws(() => boundary.check(boundary.make(Object(boundary.valid))), unavailable);
  }
});

test("coerced disabled delivery mode cannot claim ready capabilities", async () => {
  const response = enumCatalog();
  response.delivery_status = {
    ...response.delivery_status,
    mode: ["disabled"],
    configured: true,
    can_enable: true,
    reason: null,
  };
  response.scheduler.enabled = true;
  response.capabilities = { can_start: true, can_test_email: true, disabled_reason: null };
  assert.throws(() => assertWorkflowCatalog(response), unavailable);
  globalThis.fetch = async () => Response.json(response);
  await assert.rejects(workflowApi.catalog(token), unavailable);
  response.delivery_status.mode = "disabled";
  assert.throws(() => assertWorkflowCatalog(response), unavailable);
  for (const mode of ["test", "live"]) {
    response.delivery_status.mode = mode;
    assert.doesNotThrow(() => assertWorkflowCatalog(response));
    assert.deepEqual(await workflowApi.catalog(token), response);
  }
});

test("valid status and catalog enum strings retain their values", async () => {
  for (const status of ["draft", "active", "paused", "archived"]) {
    const response = { ...detail(), status };
    if (status === "active" || status === "paused") {
      response.published_version_id = ids.other;
      response.published_version_number = 1;
      response.published_at = response.updated_at;
    }
    globalThis.fetch = async () => Response.json(response);
    assert.equal((await workflowApi.detail(id, token)).status, status);
  }
  const allowed = [
    ["delivery mode", ["disabled", "test", "live"]],
    ["trigger subject kind", ["student", "promotion", "lead", "trial", "invoice", "belt_test"]],
    [
      "trigger simulation entity type",
      [
        "student",
        "promotion",
        "lead",
        "trial_appointment",
        "invoice",
        "payment",
        "belt_test_recipient",
      ],
    ],
    ["field value type", ["boolean", "enum", "uuid"]],
  ];
  for (const [label, values] of allowed)
    for (const value of values) {
      const boundary = enumBoundaries.find((item) => item.label === label);
      const response = boundary.make(value);
      globalThis.fetch = async () => Response.json(response);
      assert.deepEqual(await workflowApi.catalog(token), response);
    }
});

test("list summaries reject malformed status enums without retrying", async () => {
  for (const status of malformedEnums("draft")) {
    const item = {
      ...detail(),
      status,
      created_at: detail().updated_at,
      trigger_event_type: null,
      draft_trigger_event_type: null,
    };
    delete item.draft_graph;
    delete item.draft_layout;
    delete item.validation_issues;
    let reads = 0;
    globalThis.fetch = async () => {
      reads++;
      return Response.json({ items: [item], next_cursor: null, has_more: false });
    };
    await assert.rejects(workflowApi.list({}, token), unavailable);
    assert.equal(reads, 1);
  }
});

test("malformed command status stays unknown and retains one reservation without mutation replay", async () => {
  const { createWorkflowWorkspace, WORKFLOW_JOURNAL_KEY } =
    await import("../src/lib/automation-workflow-workspace-controller.ts");
  const { fixture, owner } = await import("./helpers/workflow-workspace-fixture.mjs");
  for (const status of malformedEnums("draft")) {
    const f = fixture();
    f.dependencies.api = workflowApi;
    const w = createWorkflowWorkspace({ mode: "live", owner, token }, f.dependencies);
    w.openNew(ids.draft);
    const calls = [];
    globalThis.fetch = async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return Response.json({ ...detail(), revision: 1, status });
    };
    const handle = w.submit("workflow.create");
    await handle.settled;
    const operation = w.getSnapshot().operations[`draft:${ids.draft}`];
    assert.equal(operation.status, "unknown");
    assert.equal(operation.locked, true);
    assert.equal(operation.operationId, handle.operationId);
    assert.equal(w.getSnapshot().editor.workflowId, null);
    assert.equal(w.submit("workflow.create"), handle);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operation_id, handle.operationId);
    const entries = JSON.parse(f.saved.get(WORKFLOW_JOURNAL_KEY)).entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].operation_id, handle.operationId);
  }
});

test("already strict command, reason and operator enum checks continue rejecting nonstrings", () => {
  for (const value of malformedEnums("workflow.create")) {
    assert.throws(
      () =>
        assertWorkflowReceipt(
          {
            ...receipt(operation_id, "workflow.create", { ...detail(), revision: 1 }),
            command: value,
          },
          { operationId: operation_id },
        ),
      unavailable,
    );
  }
  for (const value of malformedEnums("setup_required")) {
    const response = enumCatalog();
    response.delivery_status.reason = value;
    // Null is an allowed reason, unlike the other malformed enum values.
    if (value === null) assert.doesNotThrow(() => assertWorkflowCatalog(response));
    else assert.throws(() => assertWorkflowCatalog(response), unavailable);
  }
  for (const value of malformedEnums("eq")) {
    const response = enumCatalog();
    response.fields.field.operators = [value];
    assert.throws(() => assertWorkflowCatalog(response), unavailable);
  }
});

test("configured recovery test capability survives a closed sender and disabled worker", async () => {
  for (const mode of ["test", "live"]) {
    for (const reason of ["authentication_required", "unavailable"]) {
      const response = enumCatalog();
      response.delivery_status = {
        ...response.delivery_status,
        mode,
        configured: true,
        can_enable: false,
        reason,
      };
      response.scheduler.enabled = false;
      response.capabilities = {
        can_start: false,
        can_test_email: true,
        disabled_reason: "Normal email is blocked.",
      };
      assert.doesNotThrow(() => assertWorkflowCatalog(response));
      globalThis.fetch = async () => Response.json(response);
      assert.deepEqual(await workflowApi.catalog(token), response);
      for (const change of [{ configured: false }, { mode: "disabled" }]) {
        const invalid = structuredClone(response);
        Object.assign(invalid.delivery_status, change);
        assert.throws(() => assertWorkflowCatalog(invalid), unavailable);
      }
      response.capabilities.can_start = true;
      assert.throws(() => assertWorkflowCatalog(response), unavailable);
    }
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { register } from "node:module";
register("./helpers/path-alias-loader.mjs", import.meta.url);
const { workflowActivityApi: activity } =
  await import("../src/lib/automation-workflow-activity-api.ts");
const { ApiError, CommandOutcomeUnknown, api } = await import("../src/lib/api.ts");
const { buildWorkflowSimulationRequest, buildWorkflowTestEmail } =
  await import("../src/lib/automation-workflow-activity-contract.ts");
const { WORKFLOW_MAX_REQUEST_BYTES } = await import("../src/lib/automation-workflow-api.ts");
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/workflow-activity-contracts.json", import.meta.url), "utf8"),
);
const clone = structuredClone,
  ids = fixture.ids,
  token = "synthetic-token";
const identity = { studioId: ids.studio, workflowId: ids.workflow, runId: ids.run };
const listIdentity = { studioId: ids.studio, workflowId: ids.workflow };
const testIdentity = { operationId: ids.operation, testDeliveryId: ids.delivery };
const receiptIdentity = { command: "test_email.create", ...testIdentity };
const cancelIdentity = { command: "run.cancel", operationId: ids.operation, ...identity };
const simulation = fixture.simulations[0],
  baseline = fixture.cancellation.baseline;
const nativeFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = nativeFetch;
});
function capture(response, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return Response.json(response, { status });
  };
  return calls;
}
function held() {
  const calls = [];
  let finish;
  globalThis.fetch = (url, init) => {
    calls.push({ url: new URL(url), init });
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  return { calls, resolve: (body) => finish(Response.json(body)) };
}
const readFailure = (error) =>
  error instanceof ApiError &&
  error.status === 503 &&
  /Workflow activity is unavailable/.test(error.message);
const unknown = (operationId) => (error) =>
  error instanceof CommandOutcomeUnknown && error.requestId === operationId;
const simulateRequest = () => ({ graph: clone(simulation.graph), context: { kind: "synthetic" } });
const routes = [
  [
    "simulate",
    () => activity.simulate(ids.workflow, simulateRequest(), token),
    simulation.response,
    "POST",
    `/workflows/${ids.workflow}/simulate`,
  ],
  [
    "list",
    () => activity.listRuns(listIdentity, {}, token),
    fixture.page,
    "GET",
    `/workflows/${ids.workflow}/runs`,
  ],
  ["detail", () => activity.getRun(identity, token), baseline, "GET", `/runs/${ids.run}`],
  [
    "cancel",
    () => activity.cancelRun(baseline, ids.operation, token),
    fixture.cancellation.result,
    "POST",
    `/runs/${ids.run}/cancel`,
  ],
  [
    "cancel_receipt",
    () => activity.getOperation(cancelIdentity, token),
    fixture.receipts[0],
    "GET",
    `/operations/${ids.operation}`,
  ],
  [
    "test_receipt",
    () => activity.getOperation(receiptIdentity, token),
    fixture.receipts.at(-1),
    "GET",
    `/operations/${ids.operation}`,
  ],
  [
    "send_test",
    () => activity.sendTestEmail(ids.workflow, fixture.test_request, token),
    fixture.deliveries[0],
    "POST",
    `/workflows/${ids.workflow}/test-email`,
  ],
  [
    "test_current",
    () => activity.getTestDelivery(testIdentity, token),
    fixture.deliveries[2],
    "GET",
    `/test-deliveries/${ids.delivery}`,
  ],
];
for (const [name, invoke, response, method, suffix] of routes) {
  test(`${name} returns actual typed fixture with one authenticated request`, async () => {
    const calls = capture(response);
    assert.deepEqual(await invoke(), response);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, `/api/v1/automations${suffix}`);
    assert.equal(calls[0].init.method, method);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    if (name === "list") assert.equal(calls[0].url.search, "?limit=50");
    if (method === "GET") assert.equal(calls[0].init.body, undefined);
    if (name === "cancel")
      assert.deepEqual(JSON.parse(calls[0].init.body), fixture.cancellation.request);
    if (name === "simulate")
      assert.deepEqual(
        JSON.parse(calls[0].init.body),
        buildWorkflowSimulationRequest(simulation.graph, { kind: "synthetic" }),
      );
    if (name === "send_test")
      assert.deepEqual(
        JSON.parse(calls[0].init.body),
        buildWorkflowTestEmail(ids.operation, simulation.graph, "hasOwnProperty"),
      );
  });
}

test("list keeps opaque cursor bytes, canonical UUID path and primitive limit during held I/O", async () => {
  const expected = { studioId: ids.studio.toUpperCase(), workflowId: ids.workflow.toUpperCase() };
  const options = { limit: 1, cursor: " +/=&?# 🥋 " };
  const pending = held();
  const promise = activity.listRuns(expected, options, token);
  expected.studioId = ids.subject;
  expected.workflowId = ids.subject;
  options.limit = 100;
  options.cursor = "changed";
  pending.resolve(fixture.page);
  assert.deepEqual(await promise, fixture.page);
  assert.equal(pending.calls.length, 1);
  const url = pending.calls[0].url;
  assert.equal(url.pathname, `/api/v1/automations/workflows/${ids.workflow}/runs`);
  assert.equal(url.search, `?${new URLSearchParams({ limit: "1", cursor: " +/=&?# 🥋 " })}`);
});

test("simulation snapshots the exact canonical submitted graph before I/O", async () => {
  for (const forged of [false, true]) {
    const request = simulateRequest(),
      pending = held();
    const submitted = buildWorkflowSimulationRequest(request.graph, request.context);
    const promise = activity.simulate(ids.workflow.toUpperCase(), request, token);
    const old = "hasOwnProperty",
      replacement = "new_email";
    request.graph.nodes.find((node) => node.id === old).id = replacement;
    request.graph.edges.forEach((edge) => {
      if (edge.source === old) edge.source = replacement;
      if (edge.target === old) edge.target = replacement;
    });
    request.context.kind = "entity";
    request.context.entity_id = ids.subject;
    const response = clone(simulation.response);
    if (forged) {
      response.trace[3].node_id = replacement;
      response.next_actions[0].node_id = replacement;
    }
    pending.resolve(response);
    if (forged) await assert.rejects(promise, readFailure);
    else assert.deepEqual(await promise, simulation.response);
    assert.deepEqual(JSON.parse(pending.calls[0].init.body), submitted);
    assert.equal(pending.calls.length, 1);
  }
});

test("cancellation captures baseline identity, version and revision before I/O", async () => {
  for (const forged of [false, true]) {
    const current = clone(baseline),
      pending = held(),
      operation = ids.operation.toUpperCase();
    const promise = activity.cancelRun(current, operation, token);
    current.run.id = ids.subject;
    current.run.workflow_id = ids.subject;
    current.run.studio_id = ids.subject;
    current.run.version_id = ids.subject;
    current.run.version_number = 42;
    current.run.revision = 90;
    current.attempts = [];
    const response = clone(fixture.cancellation.result);
    if (forged)
      Object.assign(response.run, current.run, {
        revision: 91,
        can_cancel: false,
        cancel_requested_at: baseline.run.created_at,
        cancel_reason: "operator_cancelled",
      });
    pending.resolve(response);
    if (forged) await assert.rejects(promise, unknown(operation));
    else assert.deepEqual(await promise, response);
    assert.equal(pending.calls.length, 1);
    assert.equal(pending.calls[0].url.pathname, `/api/v1/automations/runs/${ids.run}/cancel`);
    assert.deepEqual(JSON.parse(pending.calls[0].init.body), fixture.cancellation.request);
  }
});

test("held reads snapshot every caller-owned expected identity", async () => {
  const cases = [
    [identity, (expected) => activity.getRun(expected, token), baseline],
    [cancelIdentity, (expected) => activity.getOperation(expected, token), fixture.receipts[0]],
    [
      receiptIdentity,
      (expected) => activity.getOperation(expected, token),
      fixture.receipts.at(-1),
    ],
    [testIdentity, (expected) => activity.getTestDelivery(expected, token), fixture.deliveries[2]],
  ];
  for (const [original, invoke, response] of cases) {
    const expected = clone(original),
      pending = held(),
      promise = invoke(expected);
    for (const key of Object.keys(expected)) expected[key] = ids.subject;
    pending.resolve(response);
    assert.deepEqual(await promise, response);
    assert.equal(pending.calls.length, 1);
  }
});

test("test dispatch captures original operation/body and rejects retargeted current delivery", async () => {
  for (const forged of [false, true]) {
    const request = clone(fixture.test_request);
    request.operation_id = ids.operation.toUpperCase();
    request.destination = "never-send@example.com";
    request.context = { entity_id: ids.subject };
    request.expected_revision = 42;
    const expected = buildWorkflowTestEmail(
      request.operation_id,
      request.graph,
      request.email_node_id,
    );
    const pending = held(),
      promise = activity.sendTestEmail(ids.workflow, request, token);
    request.operation_id = ids.subject;
    request.email_node_id = "changed";
    request.graph.nodes = [];
    const response = clone(fixture.deliveries[0]);
    if (forged) response.operation_id = ids.subject;
    pending.resolve(response);
    if (forged) await assert.rejects(promise, unknown(ids.operation.toUpperCase()));
    else assert.deepEqual(await promise, response);
    assert.deepEqual(JSON.parse(pending.calls[0].init.body), expected);
    assert.equal(pending.calls.length, 1);
  }
});

test("actual finite large graph scalar is submitted once and semantic invalid200 remains a response", async () => {
  const response = fixture.simulations.find((item) => item.name === "invalid_graph").response;
  const calls = capture(response),
    graph = fixture.graphs.large_finite;
  assert.equal(graph.nodes.find((node) => node.type === "condition").config.value, 1e20);
  assert.deepEqual(
    await activity.simulate(ids.workflow, { graph, context: { kind: "synthetic" } }, token),
    response,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    JSON.parse(calls[0].init.body).graph.nodes.find((node) => node.type === "condition").config
      .value,
    1e20,
  );
});

test("malformed200 null is503 for reads and unknown for commands, never404 or an automatic retry", async () => {
  for (const [name, invoke] of routes) {
    const calls = capture(null);
    await assert.rejects(
      invoke(),
      ["cancel", "send_test"].includes(name) ? unknown(ids.operation) : readFailure,
    );
    assert.equal(calls.length, 1, name);
  }
});

test("wrong identity and malformed current/receipt state fail closed with the expected classification", async () => {
  const wrongRun = clone(baseline);
  wrongRun.run.studio_id = ids.subject;
  capture(wrongRun);
  await assert.rejects(activity.getRun(identity, token), readFailure);
  capture({ ...fixture.deliveries[0], operation_id: ids.subject });
  await assert.rejects(
    activity.sendTestEmail(ids.workflow, fixture.test_request, token),
    unknown(ids.operation),
  );
  const receipt = clone(fixture.receipts.at(-1));
  receipt.result.state = "accepted";
  capture(receipt);
  await assert.rejects(activity.getOperation(receiptIdentity, token), readFailure);
});

test("known HTTP errors propagate with one request and no receipt chaining or authentication renewal", async () => {
  for (const status of [401, 402, 403, 404, 409, 413, 422]) {
    for (const [, invoke] of routes) {
      const calls = capture({ detail: "Synthetic rejection" }, status);
      await assert.rejects(
        invoke(),
        (error) => error instanceof ApiError && error.status === status,
      );
      assert.equal(calls.length, 1);
    }
  }
  const original = api.get,
    failure = new ApiError("Synthetic failure", 503);
  api.get = async () => {
    throw failure;
  };
  try {
    await assert.rejects(activity.getRun(identity, token), (error) => error === failure);
  } finally {
    api.get = original;
  }
});

test("invalid local identity, cursor, limits and exhausted CAS fail before any fetch", async () => {
  const calls = capture(null),
    unsafe = clone(baseline);
  unsafe.run.revision = Number.MAX_SAFE_INTEGER;
  const invalid = [
    () => activity.simulate("../other", simulateRequest(), token),
    () => activity.getRun({ ...identity, runId: "__proto__" }, token),
    () => activity.listRuns(identity, {}, token),
    () => activity.cancelRun(unsafe, ids.operation, token),
    () => activity.getTestDelivery({ ...testIdentity, testDeliveryId: "../other" }, token),
    () => activity.getOperation({ ...receiptIdentity, command: "workflow.create" }, token),
    () =>
      activity.sendTestEmail(ids.workflow, { ...fixture.test_request, operation_id: "bad" }, token),
  ];
  for (const limit of [0, 101, NaN, Infinity, 1.5, "5", null])
    invalid.push(() => activity.listRuns(listIdentity, { limit }, token));
  for (const cursor of ["", "x".repeat(513), null, []])
    invalid.push(() => activity.listRuns(listIdentity, { cursor }, token));
  for (const invoke of invalid) await assert.rejects(invoke());
  assert.equal(calls.length, 0);
});

test("complete UTF8 request size is checked before simulation or test-email transport", async () => {
  const graph = clone(simulation.graph);
  graph.nodes = [graph.nodes.find((node) => node.type === "email")];
  graph.edges = [];
  for (let index = 1; index < 40; index++)
    graph.nodes.push({
      id: `condition_${index}`,
      type: "condition",
      config: { field: null, operator: null, value: Array(100).fill("🥋".repeat(500)) },
    });
  assert.ok(new TextEncoder().encode(JSON.stringify(graph)).length > WORKFLOW_MAX_REQUEST_BYTES);
  const calls = capture(null);
  for (const invoke of [
    () => activity.simulate(ids.workflow, { graph, context: { kind: "synthetic" } }, token),
    () =>
      activity.sendTestEmail(
        ids.workflow,
        { operation_id: ids.operation, graph, email_node_id: "hasOwnProperty" },
        token,
      ),
  ])
    await assert.rejects(invoke(), (error) => error instanceof ApiError && error.status === 413);
  assert.equal(calls.length, 0);
});

test("abort reaches the single request and preserves read versus dispatched-command transport semantics", async () => {
  for (const mutation of [false, true]) {
    const controller = new AbortController();
    let requests = 0;
    globalThis.fetch = (_url, init) => {
      requests++;
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("Canceled", "AbortError")),
        ),
      );
    };
    const promise = mutation
      ? activity.cancelRun(baseline, ids.operation, token, controller.signal)
      : activity.getRun(identity, token, controller.signal);
    controller.abort();
    await assert.rejects(promise, (error) =>
      mutation ? error instanceof CommandOutcomeUnknown : error.name === "AbortError",
    );
    assert.equal(requests, 1);
  }
});

test("exact whole-request UTF8 byte maximum is accepted and one extra byte is rejected", async () => {
  for (const kind of ["simulation", "test_email"]) {
    const graph = clone(simulation.graph);
    graph.nodes = [graph.nodes.find((node) => node.type === "email")];
    graph.edges = [];
    for (let index = 0; index < 6; index++)
      graph.nodes.push({
        id: `condition_${index}`,
        type: "condition",
        config: { field: null, operator: null, value: Array(100).fill("") },
      });
    const body =
      kind === "simulation"
        ? buildWorkflowSimulationRequest(graph, { kind: "synthetic" })
        : buildWorkflowTestEmail(ids.operation, graph, "hasOwnProperty");
    let remaining =
      WORKFLOW_MAX_REQUEST_BYTES - new TextEncoder().encode(JSON.stringify(body)).length;
    let unused;
    for (const node of body.graph.nodes.filter((item) => item.type === "condition")) {
      for (let index = 0; index < node.config.value.length; index++) {
        const emojis = Math.min(500, Math.floor(remaining / 4));
        node.config.value[index] = emojis ? "🥋".repeat(emojis) : "x".repeat(remaining);
        remaining -= new TextEncoder().encode(node.config.value[index]).length;
        if (remaining === 0 && node.config.value[index] === "") unused = [node.config.value, index];
      }
    }
    assert.equal(remaining, 0);
    assert.equal(new TextEncoder().encode(JSON.stringify(body)).length, WORKFLOW_MAX_REQUEST_BYTES);
    const response =
      kind === "simulation" ? fixture.simulations.at(-1).response : fixture.deliveries[0];
    let calls = capture(response);
    const invoke = () =>
      kind === "simulation"
        ? activity.simulate(ids.workflow, body, token)
        : activity.sendTestEmail(ids.workflow, body, token);
    assert.deepEqual(await invoke(), response);
    assert.equal(calls.length, 1);
    assert.equal(new TextEncoder().encode(calls[0].init.body).length, WORKFLOW_MAX_REQUEST_BYTES);
    unused[0][unused[1]] = "x";
    calls = capture(response);
    await assert.rejects(invoke(), (error) => error instanceof ApiError && error.status === 413);
    assert.equal(calls.length, 0);
  }
});

test("non-JSON successful GET bodies produce fixed safe503 without leaking parser data", async () => {
  for (const [, invoke, , method] of routes.filter((route) => route[3] === "GET")) {
    assert.equal(method, "GET");
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("private broken {", { status: 200 });
    };
    await assert.rejects(
      invoke(),
      (error) => readFailure(error) && !error.message.includes("private"),
    );
    assert.equal(calls, 1);
  }
});

test("simulation remains a read: inherited raw JSON, network and5xx failures never start receipt recovery", async () => {
  for (const failure of ["json", "network", "server"]) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: new URL(url), init });
      if (failure === "network") throw new TypeError("Synthetic network loss");
      return failure === "json"
        ? new Response("not JSON", { status: 200 })
        : Response.json({ detail: "Synthetic unavailable" }, { status: 503 });
    };
    await assert.rejects(
      activity.simulate(ids.workflow, simulateRequest(), token),
      CommandOutcomeUnknown,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, `/api/v1/automations/workflows/${ids.workflow}/simulate`);
    assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)), ["graph", "context"]);
  }
});

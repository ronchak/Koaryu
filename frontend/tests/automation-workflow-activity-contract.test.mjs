import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { register } from "node:module";
import ts from "typescript";

register("./helpers/path-alias-loader.mjs", import.meta.url);
const contract = await import("../src/lib/automation-workflow-activity-contract.ts");
const { canonicalWorkflowDraft } = await import("../src/lib/automation-workflow-model.ts");
const { ApiError } = await import("../src/lib/api.ts");
const {
  isWorkflowSimulationContext,
  buildWorkflowSimulationRequest,
  isWorkflowSimulationResponse,
  isWorkflowRunPage,
  isWorkflowRunDetail,
  buildWorkflowRunCancel,
  isWorkflowRunCancelResult,
  buildWorkflowTestEmail,
  isWorkflowTestDelivery,
  isWorkflowActivityReceipt,
} = contract;
// Synthetic wire values emitted by the actual current Pydantic schemas. Tests need no Git history or Python.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/workflow-activity-contracts.json", import.meta.url), "utf8"),
);
const clone = structuredClone;
const ids = fixture.ids;
const identity = { studioId: ids.studio, workflowId: ids.workflow, runId: ids.run };
const listIdentity = { studioId: ids.studio, workflowId: ids.workflow };
const deliveryIdentity = { operationId: ids.operation, testDeliveryId: ids.delivery };
const cancelIdentity = { command: "run.cancel", operationId: ids.operation, ...identity };
const testIdentity = { command: "test_email.create", ...deliveryIdentity };
const full = fixture.simulations[0];
const base = fixture.cancellation.baseline;
const changedUuid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const canonical = (graph) => canonicalWorkflowDraft({ graph, layout: { positions: {} } }).graph;

for (const specimen of fixture.simulations) {
  test(`actual simulation serialization and graph path: ${specimen.name}`, () => {
    const before = clone(specimen);
    assert.equal(isWorkflowSimulationResponse(specimen.response, specimen.graph), true);
    assert.deepEqual(specimen, before);
  });
}
for (const category of ["runs", "steps", "attempts"]) {
  test(`all actual ${category} states and nullable evidence survive the closed guard`, () => {
    for (const specimen of fixture[category]) {
      assert.equal(isWorkflowRunDetail(specimen.detail, identity), true, specimen.name);
    }
  });
}
for (const specimen of fixture.model_negatives) {
  test(`actual model rejects ${specimen.name}; frontend rejects its typed response`, () => {
    const guards = {
      run: (value) => isWorkflowRunDetail(value, identity),
      simulation: (value) => isWorkflowSimulationResponse(value, full.graph),
      cancel_receipt: (value) => isWorkflowActivityReceipt(value, cancelIdentity),
      test_receipt: (value) => isWorkflowActivityReceipt(value, testIdentity),
    };
    assert.equal(guards[specimen.kind](specimen.value), false);
  });
}

test("actual simulation contexts are closed and UUID comparisons accept case only after validation", () => {
  for (const request of fixture.simulation_requests) {
    assert.equal(isWorkflowSimulationContext(request.context), true);
    assert.deepEqual(buildWorkflowSimulationRequest(request.graph, request.context), {
      ...request,
      graph: canonical(request.graph),
    });
  }
  const context = { kind: "entity", entity_type: "student", entity_id: ids.subject.toUpperCase() };
  assert.equal(buildWorkflowSimulationRequest(full.graph, context).context.entity_id, ids.subject);
  for (const invalid of [
    null,
    [],
    {},
    { kind: "synthetic", entity_id: ids.subject },
    { kind: ["synthetic"] },
    { kind: "entity", entity_type: ["student"], entity_id: ids.subject },
    { ...context, entity_id: "constructor" },
    { ...context, entity_type: "constructor" },
    { ...context, entity_id: ` ${ids.subject}` },
    { ...context, entity_id: null },
  ]) {
    assert.equal(isWorkflowSimulationContext(invalid), false);
    assert.throws(() => buildWorkflowSimulationRequest(full.graph, invalid));
  }
});

test("scalar omission, explicit null, false, zero and arrays preserve actual serializer output", () => {
  for (const request of fixture.scalar_requests) {
    assert.deepEqual(buildWorkflowSimulationRequest(request.graph, request.context), {
      graph: canonical(request.graph),
      context: request.context,
    });
  }
  const condition = (graph) => graph.nodes.find((node) => node.type === "condition").config;
  assert.equal(Object.hasOwn(condition(fixture.graphs.omitted), "value"), false);
  assert.equal(condition(fixture.graphs.null).value, null);
  assert.equal(condition(fixture.graphs.false).value, false);
  assert.equal(condition(fixture.graphs.zero).value, 0);
});

test("incomplete shape-valid graph can be submitted and its semantic invalid result remains a response", () => {
  const graph = clone(fixture.graphs.all);
  graph.nodes.find((node) => node.type === "trigger").config.event_type = null;
  const request = buildWorkflowSimulationRequest(graph, { kind: "synthetic" });
  assert.equal(request.graph.nodes.find((node) => node.type === "trigger").config.event_type, null);
  const invalid = fixture.simulations.find((item) => item.name === "invalid_graph").response;
  assert.equal(isWorkflowSimulationResponse(invalid, graph), true);
});

test("simulation validates the returned path without reevaluating conditions, source facts or future dates", () => {
  const graph = clone(full.graph);
  graph.nodes.find((node) => node.type === "condition").config.value = false;
  graph.nodes.find((node) => node.type === "delay").config.minutes = 400;
  graph.nodes.find((node) => node.type === "trigger").config.event_type = "trial.upcoming";
  assert.equal(isWorkflowSimulationResponse(full.response, graph), true);
  for (const specimen of fixture.simulations.filter((item) => item.name.includes("waiting"))) {
    assert.equal(isWorkflowSimulationResponse(specimen.response, graph), true);
  }
});

test("nullable simulation fields must be present and closed, including each action and issue", () => {
  const checks = [
    [full.response, (value) => isWorkflowSimulationResponse(value, full.graph)],
    [
      full.response.trace[3],
      (value) => {
        const response = clone(full.response);
        response.trace[3] = value;
        return isWorkflowSimulationResponse(response, full.graph);
      },
    ],
    [
      full.response.next_actions[0],
      (value) => {
        const response = clone(full.response);
        response.next_actions[0] = value;
        return isWorkflowSimulationResponse(response, full.graph);
      },
    ],
    [
      fixture.simulations.at(-1).response.issues[0],
      (value) => {
        const response = clone(fixture.simulations.at(-1).response);
        response.issues[0] = value;
        return isWorkflowSimulationResponse(response, full.graph);
      },
    ],
  ];
  for (const [source, guard] of checks) {
    for (const key of Object.keys(source)) {
      const value = clone(source);
      delete value[key];
      assert.equal(guard(value), false, key);
    }
    assert.equal(guard({ ...source, unexpected: null }), false);
    const inherited = Object.create(source);
    assert.equal(guard(inherited), false);
  }
});

test("simulation rejects path breaks, illegal outcomes, repeated nodes and action substitutions", () => {
  const edits = [
    (r) => r.trace.reverse(),
    (r) => r.trace.push(clone(r.trace.at(-1))),
    (r) => {
      r.trace[1].edge_id = "edge_no";
    },
    (r) => {
      r.trace[0].node_id = "not-a-node";
    },
    (r) => {
      r.trace[2].outcome = "would_follow_up";
      r.trace[2].action_kind = "lead_follow_up";
    },
    (r) => {
      r.trace[0].scheduled_at = r.reference_time;
    },
    (r) => {
      r.trace[0].reason = "unavailable";
    },
    (r) => {
      r.trace[0].rendered_subject = "unexpected";
    },
    (r) => {
      r.trace[1].outcome = "waiting";
    },
    (r) => {
      r.trace[3].action_kind = "lead_follow_up";
    },
    (r) => {
      r.next_actions.reverse();
    },
    (r) => {
      r.next_actions[0].reason = "unavailable";
    },
    (r) => {
      r.next_actions[0].scheduled_at = r.reference_time;
    },
    (r) => {
      r.valid = false;
    },
    (r) => {
      r.future_conditions_rechecked = 1;
    },
    (r) => {
      r.trace = [];
      r.next_actions = [];
    },
    (r) => {
      delete r.trace[1];
    },
    (r) => {
      delete r.next_actions[0];
    },
    (r) => {
      r.issues = Array(1);
    },
  ];
  for (const edit of edits) {
    const response = clone(full.response);
    edit(response);
    assert.equal(isWorkflowSimulationResponse(response, full.graph), false, edit.toString());
  }
  const graph = clone(full.graph);
  graph.edges[0].port = "yes";
  assert.equal(isWorkflowSimulationResponse(full.response, graph), false);
  graph.edges[0].port = "next";
  graph.edges[0].target = "end";
  assert.equal(isWorkflowSimulationResponse(full.response, graph), false);
});

test("rendered email Unicode boundaries count codepoints and plain text preserves LF/tab", () => {
  const response = clone(full.response),
    row = response.trace[3];
  row.rendered_subject = "🥋".repeat(200);
  row.rendered_body = "🥋".repeat(20000);
  assert.equal(isWorkflowSimulationResponse(response, full.graph), true);
  row.rendered_subject += "x";
  assert.equal(isWorkflowSimulationResponse(response, full.graph), false);
  row.rendered_subject = "";
  row.rendered_body += "x";
  assert.equal(isWorkflowSimulationResponse(response, full.graph), false);
  row.rendered_body = "line\n\ttab";
  assert.equal(isWorkflowSimulationResponse(response, full.graph), true);
  for (const control of ["\r", "\0", "\x1f", "\x7f", "\x85"]) {
    row.rendered_body = `a${control}b`;
    assert.equal(isWorkflowSimulationResponse(response, full.graph), false);
    row.rendered_body = "plain";
    row.rendered_subject = `a${control}b`;
    assert.equal(isWorkflowSimulationResponse(response, full.graph), false);
    row.rendered_subject = "";
  }
});

test("all enum guards reject arrays, boxed values and coercion objects without evaluating them", () => {
  const coercion = {
    toString() {
      throw new Error("must not coerce");
    },
  };
  for (const bad of [["queued"], new String("queued"), coercion, null, {}, 0]) {
    const detail = clone(base);
    detail.run.state = bad;
    assert.equal(isWorkflowRunDetail(detail, identity), false);
    detail.run.state = "queued";
    detail.steps[0].node_type = bad;
    assert.equal(isWorkflowRunDetail(detail, identity), false);
    detail.steps[0].node_type = "email";
    detail.attempts[0].state = bad;
    assert.equal(isWorkflowRunDetail(detail, identity), false);
    const simulation = clone(full.response);
    simulation.trace[0].outcome = bad;
    assert.equal(isWorkflowSimulationResponse(simulation, full.graph), false);
    assert.equal(
      isWorkflowTestDelivery({ ...fixture.deliveries[0], state: bad }, deliveryIdentity),
      false,
    );
  }
});

test("run, step and attempt records reject missing/extra/inherited wire fields", () => {
  for (const part of ["run", "step", "attempt"]) {
    const source = part === "run" ? base.run : part === "step" ? base.steps[0] : base.attempts[0];
    const guard = (value) => {
      const detail = clone(base);
      if (part === "run") detail.run = value;
      else detail[part === "step" ? "steps" : "attempts"][0] = value;
      return isWorkflowRunDetail(detail, identity);
    };
    for (const key of Object.keys(source)) {
      const value = clone(source);
      delete value[key];
      assert.equal(guard(value), false, `${part}.${key}`);
    }
    assert.equal(guard({ ...source, extra: null }), false);
    assert.equal(guard(Object.create(source)), false);
  }
  for (const value of [null, [], {}, { ...base, extra: true }])
    assert.equal(isWorkflowRunDetail(value, identity), false);
});

test("run identity comparison validates all UUIDs before case normalization", () => {
  const detail = clone(base);
  for (const key of ["id", "studio_id", "workflow_id", "version_id", "subject_id"])
    detail.run[key] = detail.run[key].toUpperCase();
  detail.steps[0].id = detail.steps[0].id.toUpperCase();
  detail.attempts[0].id = detail.attempts[0].id.toUpperCase();
  assert.equal(isWorkflowRunDetail(detail, identity), true);
  for (const key of ["studioId", "workflowId", "runId"]) {
    assert.equal(isWorkflowRunDetail(base, { ...identity, [key]: changedUuid }), false);
    assert.equal(isWorkflowRunDetail(base, { ...identity, [key]: "__proto__" }), false);
  }
  assert.equal(isWorkflowRunDetail(base, listIdentity), true);
  for (const key of ["id", "studio_id", "workflow_id", "version_id", "subject_id"]) {
    const value = clone(base);
    value.run[key] = "constructor";
    assert.equal(isWorkflowRunDetail(value, identity), false);
  }
});

test("history chronology is local, exact to fractions, offset-aware and free of a one-day duration limit", () => {
  const detail = clone(base);
  detail.steps[0].entered_at = "2020-01-01T00:00:00.1234567Z";
  detail.steps[0].finished_at = "2020-01-01T01:00:00.12345670+01:00";
  detail.attempts[0].began_at = "2010-01-01T00:00:00Z";
  detail.attempts[0].settled_at = "2040-01-01T00:00:00Z";
  detail.run.created_at = "2035-01-01T00:00:00Z";
  detail.run.updated_at = "2005-01-01T00:00:00Z";
  assert.equal(isWorkflowRunDetail(detail, identity), true);
  detail.steps[0].finished_at = "2020-01-01T00:00:00.1234566Z";
  assert.equal(isWorkflowRunDetail(detail, identity), false);
  detail.steps[0].finished_at = "2020-01-01T00:00:00.1234568Z";
  detail.attempts[0].began_at = "1969-12-31T23:59:59.0000002Z";
  detail.attempts[0].settled_at = "1969-12-31T23:59:59.0000001Z";
  assert.equal(isWorkflowRunDetail(detail, identity), false);
  detail.attempts[0].settled_at = "1969-12-31T23:59:59.00000020Z";
  assert.equal(isWorkflowRunDetail(detail, identity), true);
  for (const timestamp of [
    "2026-02-30T12:00:00Z",
    "2026-10-05",
    "2026-10-05T12:00:00",
    "0000-01-01T00:00:00Z",
    "2026-10-05T24:00:00Z",
    "2026-10-05T12:00:00+24:00",
  ]) {
    const invalid = clone(base);
    invalid.run.created_at = timestamp;
    assert.equal(isWorkflowRunDetail(invalid, identity), false, timestamp);
  }
});

test("stored history preserves server reason and evidence nullability without node-outcome or graph assumptions", () => {
  const detail = clone(base);
  detail.run.current_node_id = "constructor";
  detail.steps[0].node_id = "historical_email";
  detail.attempts[0].node_id = "historical_email";
  detail.steps[0].edge_id = "historical_edge";
  detail.steps[0].reason = "accepted_with_note";
  detail.attempts[0].reason = "legacy_reason";
  detail.attempts[0].submission_evidence = null;
  detail.attempts[0].failure_scope = null;
  assert.equal(isWorkflowRunDetail(detail, identity), true);
  detail.steps[0].node_type = "trigger";
  detail.steps[0].outcome = "accepted";
  detail.attempts = [];
  assert.equal(isWorkflowRunDetail(detail, identity), true);
});

test("history ordering, references, bounds and sparse arrays reject malformed snapshots", () => {
  const edits = [
    (d) => d.steps.push(clone(d.steps[0])),
    (d) => d.attempts.push(clone(d.attempts[0])),
    (d) => {
      d.steps[0].node_type = "condition";
    },
    (d) => {
      d.attempts[0].node_id = "__proto__";
    },
    (d) => {
      d.steps = Array(1);
    },
    (d) => {
      d.attempts = Array(1);
    },
    (d) => {
      d.steps[0].sequence = 41;
    },
    (d) => {
      d.attempts[0].attempt_number = 0;
    },
    (d) => {
      d.run.revision = Number.MAX_SAFE_INTEGER + 1;
    },
    (d) => {
      d.run.version_number = Infinity;
    },
    (d) => {
      d.run.revision = NaN;
    },
  ];
  for (const edit of edits) {
    const detail = clone(base);
    edit(detail);
    assert.equal(isWorkflowRunDetail(detail, identity), false);
  }
  const detail = clone(base);
  detail.attempts = [1, 2, 3].map((attempt_number) => ({
    ...base.attempts[0],
    attempt_number,
    id: `10000000-0000-4000-8000-00000000000${attempt_number}`,
  }));
  assert.equal(isWorkflowRunDetail(detail, identity), true);
  detail.attempts.reverse();
  assert.equal(isWorkflowRunDetail(detail, identity), false);
  detail.attempts = [];
  detail.steps = Array.from({ length: 40 }, (_, index) => ({
    ...base.steps[0],
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    sequence: index + 1,
    node_id: `node_${index}`,
  }));
  assert.equal(isWorkflowRunDetail(detail, identity), true);
  detail.steps.reverse();
  assert.equal(isWorkflowRunDetail(detail, identity), false);
  detail.steps.reverse();
  detail.steps.push({ ...base.steps[0], sequence: 41 });
  assert.equal(isWorkflowRunDetail(detail, identity), false);
});

test("normalized mailbox accepts actual ASCII grammar and rejects rather than repairs output", () => {
  for (const email of [
    fixture.cancellation.baseline.attempts[0].recipient_email,
    "a@b.c",
    `${"a".repeat(64)}@${"b".repeat(63)}.example`,
    "a.b+tag@a-1.example",
  ]) {
    const detail = clone(base);
    detail.attempts[0].recipient_email = email;
    assert.equal(isWorkflowRunDetail(detail, identity), true, email);
  }
  for (const email of [
    "User@example.com",
    "a@example.com ",
    " a@example.com",
    "name <a@example.com>",
    "ü@example.com",
    "a@localhost",
    ".a@example.com",
    "a.@example.com",
    "a..b@example.com",
    "a@-bad.example",
    "a@bad-.example",
    "a@bad..example",
    "a\n@example.com",
    `${"a".repeat(65)}@example.com`,
    `a@${"b".repeat(64)}.example`,
    "a@@example.com",
  ]) {
    const detail = clone(base);
    detail.attempts[0].recipient_email = email;
    assert.equal(isWorkflowRunDetail(detail, identity), false, email);
  }
});

test("run pages enforce identity, requested limit, UUID uniqueness and descending fractional keyset order", () => {
  assert.equal(isWorkflowRunPage(fixture.page, listIdentity, 1), true);
  const page = clone(fixture.page);
  page.items.push({ ...base.run, id: changedUuid, created_at: "2026-10-05T12:00:00.1234559Z" });
  assert.equal(isWorkflowRunPage(page, listIdentity, 2), true);
  assert.equal(isWorkflowRunPage(page, listIdentity, 1), false);
  assert.equal(isWorkflowRunPage(page, identity, 2), false);
  page.items[1].created_at = page.items[0].created_at;
  assert.equal(isWorkflowRunPage(page, listIdentity, 2), false);
  page.items.reverse();
  assert.equal(isWorkflowRunPage(page, listIdentity, 2), true);
  page.items[1].id = page.items[0].id.toUpperCase();
  assert.equal(isWorkflowRunPage(page, listIdentity, 2), false);
  for (const limit of [0, 101, 1.5, NaN, Infinity, "1"])
    assert.equal(isWorkflowRunPage(fixture.page, listIdentity, limit), false);
  for (const patch of [
    { has_more: false },
    { next_cursor: "" },
    { next_cursor: null },
    { items: [] },
    { items: Array(1) },
    { next_cursor: "x".repeat(513) },
  ]) {
    assert.equal(isWorkflowRunPage({ ...fixture.page, ...patch }, listIdentity, 50), false);
  }
  assert.equal(
    isWorkflowRunPage({ items: [], next_cursor: null, has_more: false }, listIdentity, 50),
    true,
  );
});

test("fresh cancellation binds revision/version and sending intent may retain attempts and sending state", () => {
  for (const [before, after] of [
    [base, fixture.cancellation.result],
    [fixture.cancellation.sending_baseline, fixture.cancellation.sending_result],
  ]) {
    assert.deepEqual(
      buildWorkflowRunCancel(ids.operation.toUpperCase(), before),
      fixture.cancellation.request,
    );
    assert.equal(isWorkflowRunCancelResult(after, before), true);
    const edits = {
      id: changedUuid,
      studio_id: changedUuid,
      workflow_id: changedUuid,
      version_id: changedUuid,
      version_number: 8,
      revision: before.run.revision,
      cancel_requested_at: null,
      cancel_reason: null,
      can_cancel: true,
    };
    for (const [key, value] of Object.entries(edits)) {
      const invalid = clone(after);
      invalid.run[key] = value;
      assert.equal(isWorkflowRunCancelResult(invalid, before), false, key);
    }
    assert.equal(isWorkflowRunCancelResult(after, after), false);
  }
  const unsafe = clone(base);
  unsafe.run.revision = Number.MAX_SAFE_INTEGER;
  assert.equal(isWorkflowRunDetail(unsafe, identity), true);
  assert.throws(() => buildWorkflowRunCancel(ids.operation, unsafe), ApiError);
  assert.throws(() => buildWorkflowRunCancel(ids.operation, fixture.cancellation.result), ApiError);
  assert.throws(() => buildWorkflowRunCancel("__proto__", base), ApiError);
});

test("original cancellation receipt has no fresh CAS requirement and current delivery differs from acknowledgment", () => {
  for (const receipt of fixture.receipts) {
    assert.equal(
      isWorkflowActivityReceipt(
        receipt,
        receipt.command === "run.cancel" ? cancelIdentity : testIdentity,
      ),
      true,
    );
  }
  const historical = clone(fixture.receipts[0]);
  historical.result.run.revision = 2;
  assert.equal(isWorkflowActivityReceipt(historical, cancelIdentity), true);
  for (const delivery of fixture.deliveries) {
    assert.equal(isWorkflowTestDelivery(delivery, deliveryIdentity), true);
    assert.equal(
      isWorkflowTestDelivery(delivery, { operationId: ids.operation.toUpperCase() }),
      true,
    );
    const receipt = clone(fixture.receipts.at(-1));
    receipt.result = delivery;
    assert.equal(isWorkflowActivityReceipt(receipt, testIdentity), delivery.state === "queued");
  }
  for (const expected of [
    { ...testIdentity, operationId: changedUuid },
    { ...testIdentity, testDeliveryId: changedUuid },
    { ...testIdentity, operationId: "constructor" },
  ]) {
    assert.equal(isWorkflowActivityReceipt(fixture.receipts.at(-1), expected), false);
  }
  const receipt = clone(fixture.receipts.at(-1));
  receipt.entity_id = changedUuid;
  assert.equal(isWorkflowActivityReceipt(receipt, testIdentity), false);
  for (const source of [fixture.deliveries[0], fixture.receipts[0], fixture.receipts.at(-1)]) {
    const guard = source.command
      ? (value) =>
          isWorkflowActivityReceipt(
            value,
            source.command === "run.cancel" ? cancelIdentity : testIdentity,
          )
      : (value) => isWorkflowTestDelivery(value, deliveryIdentity);
    for (const key of Object.keys(source)) {
      const invalid = clone(source);
      delete invalid[key];
      assert.equal(guard(invalid), false, key);
    }
    assert.equal(guard({ ...source, studio_id: ids.studio }), false);
  }
});

test("test builder selects a real email ID and emits only canonical command fields", () => {
  const graph = clone(full.graph);
  graph.nodes[3].selected = true;
  const body = buildWorkflowTestEmail(ids.operation.toUpperCase(), graph, "hasOwnProperty");
  assert.deepEqual(body, { ...fixture.test_request, graph: canonical(full.graph) });
  graph.nodes[3].config.subject_template = "changed";
  assert.equal(
    body.graph.nodes.find((node) => node.type === "email").config.subject_template,
    "Hi 🥋",
  );
  for (const node of ["__proto__", "constructor", "missing", "bad.node"])
    assert.throws(() => buildWorkflowTestEmail(ids.operation, full.graph, node));
  for (const control of ["\r", "\0", "\x85", "\x7f"]) {
    const invalid = clone(full.graph);
    invalid.nodes[3].config.body_template = `a${control}b`;
    assert.throws(() => buildWorkflowTestEmail(ids.operation, invalid, "hasOwnProperty"));
  }
});

test("builders reject sparse, nonfinite, undefined and invalid-Unicode data before producing JSON", () => {
  const edits = [
    (g) => {
      delete g.nodes[1];
    },
    (g) => {
      delete g.edges[0];
    },
    (g) => {
      g.nodes[1].config.value = Array(2);
    },
    (g) => {
      g.nodes[1].config.value = undefined;
    },
    (g) => {
      g.nodes[1].config.value = Infinity;
    },
    (g) => {
      g.nodes[1].config.value = NaN;
    },
    (g) => {
      g.nodes[3].config.body_template = "\ud800";
    },
    (g) => {
      g.nodes[3].config.body_template = "\udc00";
    },
    (g) => {
      g.nodes[1].config.value = "nul\0";
    },
  ];
  for (const edit of edits) {
    const graph = clone(full.graph);
    edit(graph);
    assert.throws(
      () => buildWorkflowSimulationRequest(graph, { kind: "synthetic" }),
      edit.toString(),
    );
    assert.throws(
      () => buildWorkflowTestEmail(ids.operation, graph, "hasOwnProperty"),
      edit.toString(),
    );
  }
});

test("strict TS preserves canonical graph subtype, generated result aliases and required identities", () => {
  const filename = fileURLToPath(new URL("./activity-type-proof.ts", import.meta.url));
  const source = `
    import { buildWorkflowSimulationRequest, buildWorkflowTestEmail, isWorkflowSimulationResponse } from "../src/lib/automation-workflow-activity-contract.ts";
    import { workflowActivityApi } from "../src/lib/automation-workflow-activity-api.ts";
    import type { WorkflowGraph, WorkflowSimulationContext, WorkflowSimulationTrace } from "../src/lib/automation-workflow-types.ts";
    import type { ApiWorkflowSimulationRequest, ApiWorkflowSimulationResponse, ApiWorkflowSimulationTrace, ApiWorkflowTestEmailRequest } from "../src/types/generated/api-contracts";
    declare const graph: WorkflowGraph;
    const context: WorkflowSimulationContext = {kind:"synthetic"};
    const simulation = buildWorkflowSimulationRequest(graph,context);
    const official: ApiWorkflowSimulationRequest = simulation;
    const canonical: WorkflowGraph = simulation.graph;
    const email = buildWorkflowTestEmail("id",graph,"email");
    const officialEmail: ApiWorkflowTestEmailRequest = email;
    const canonicalEmail: WorkflowGraph = email.graph;
    declare const trace: WorkflowSimulationTrace;
    const generatedTrace: ApiWorkflowSimulationTrace = trace;
    const accepted: Promise<ApiWorkflowSimulationResponse> = workflowActivityApi.simulate("id",simulation,"token");
    declare let unknown: unknown;
    if(isWorkflowSimulationResponse(unknown,graph)){ const response:ApiWorkflowSimulationResponse=unknown; }
    // @ts-expect-error required run identity
    workflowActivityApi.getRun({studioId:"s",workflowId:"w"},"token");
    // @ts-expect-error required delivery identity
    workflowActivityApi.getTestDelivery({operationId:"o"},"token");
    // @ts-expect-error test receipts carry no invented studio scope
    workflowActivityApi.getOperation({command:"test_email.create",operationId:"o",studioId:"s"},"token");
    // @ts-expect-error not a public context kind
    const invalid: WorkflowSimulationContext = {kind:"record",entity_id:"x"};
    // @ts-expect-error published response fields remain required
    const incomplete: WorkflowSimulationTrace = {node_id:"n",outcome:"entered"};
  `;
  const configPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    fileURLToPath(new URL("..", import.meta.url)),
  );
  const options = {
    ...parsed.options,
    noEmit: true,
    incremental: false,
    typeRoots: [fileURLToPath(new URL("../node_modules/@types", import.meta.url))],
  };
  const host = ts.createCompilerHost(options),
    original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, language, ...rest) =>
    path === filename
      ? ts.createSourceFile(path, source, language, true)
      : original(path, language, ...rest);
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }),
  );
});

test("actual 40-step/120-attempt history is accepted and malformed cross-step order is rejected", () => {
  assert.equal(isWorkflowRunDetail(fixture.history_limit, identity), true);
  assert.equal(isWorkflowRunDetail(fixture.long_history, identity), true);
  const over = clone(fixture.history_limit);
  over.attempts.push({ ...over.attempts.at(-1), id: changedUuid });
  assert.equal(isWorkflowRunDetail(over, identity), false);
  const reversed = clone(fixture.history_limit);
  [reversed.attempts[2], reversed.attempts[3]] = [reversed.attempts[3], reversed.attempts[2]];
  assert.equal(isWorkflowRunDetail(reversed, identity), false);
  const duplicate = clone(fixture.history_limit);
  duplicate.attempts[1].id = duplicate.attempts[0].id.toUpperCase();
  assert.equal(isWorkflowRunDetail(duplicate, identity), false);
  const steps = clone(fixture.history_limit);
  steps.steps[1].node_id = steps.steps[0].node_id;
  assert.equal(isWorkflowRunDetail(steps, identity), false);
});

for (const specimen of fixture.request_boundaries) {
  test(`actual request-model boundary: ${specimen.name}`, () => {
    const request = clone(specimen.request);
    if (!specimen.accepted) {
      assert.throws(() => buildWorkflowSimulationRequest(request.graph, request.context));
      assert.throws(() => buildWorkflowTestEmail(ids.operation, request.graph, "hasOwnProperty"));
      return;
    }
    const simulation = buildWorkflowSimulationRequest(request.graph, request.context);
    const email = buildWorkflowTestEmail(ids.operation, request.graph, "hasOwnProperty");
    assert.deepEqual(simulation.graph, canonical(request.graph));
    assert.deepEqual(email.graph, simulation.graph);
    assert.deepEqual(simulation.context, specimen.serialized.context);
    assert.equal(email.operation_id, specimen.test_serialized.operation_id);
    const reply = request.graph.nodes.find((node) => node.type === "email").config.reply_to_email;
    assert.equal(
      email.graph.nodes.find((node) => node.type === "email").config.reply_to_email,
      reply,
    );
  });
}

test("UUID, graph and reason grammars reject trailing line terminators without regex-anchor coercion", () => {
  for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
    assert.equal(
      isWorkflowTestDelivery(fixture.deliveries[0], { operationId: ids.operation + suffix }),
      false,
    );
    assert.throws(() => buildWorkflowRunCancel(ids.operation + suffix, base));
    const detail = clone(base);
    detail.run.reason = "historical" + suffix;
    assert.equal(isWorkflowRunDetail(detail, identity), false);
    detail.run.reason = null;
    detail.steps[0].node_id += suffix;
    assert.equal(isWorkflowRunDetail(detail, identity), false);
    const graph = clone(full.graph);
    graph.nodes[0].id += suffix;
    assert.throws(() => buildWorkflowSimulationRequest(graph, { kind: "synthetic" }));
  }
});

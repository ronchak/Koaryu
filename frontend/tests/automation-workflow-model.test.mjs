import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKFLOW_LIMITS,
  automaticWorkflowLayout,
  canonicalWorkflowDraft,
  commitWorkflowPosition,
  createWorkflowHistory,
  defaultWorkflowConfig,
  editWorkflow,
  editWorkflowHistory,
  fillWorkflowPositions,
  initialWorkflowDraft,
  nextWorkflowId,
  redoWorkflow,
  serializeWorkflowDraft,
  undoWorkflow,
  validateWorkflow,
  workflowSteps,
} from "../src/lib/automation-workflow-model.ts";

function branched() {
  const graph = {
    schema_version: 1,
    nodes: [
      { id: "trigger", type: "trigger", config: { event_type: "lead.created", program_id: null } },
      {
        id: "condition",
        type: "condition",
        config: { field: "lead.stage", operator: "eq", value: "new" },
      },
      {
        id: "yes",
        type: "email",
        config: {
          recipient: "lead_or_guardian",
          subject_template: "Hello",
          body_template: "Welcome",
          reply_to_email: "",
        },
      },
      { id: "no", type: "lead_follow_up", config: { due_in_days: 2, note: "Contact lead" } },
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
  return { graph, layout: automaticWorkflowLayout(graph) };
}

const codes = (result) => result.issues.map(({ code }) => code);
const nodeById = (draft, id) => draft.graph.nodes.find((node) => node.id === id);

test("defaults preserve all nullable draft choices and initial trigger/end are shape safe", () => {
  assert.deepEqual(defaultWorkflowConfig("trigger"), { event_type: null, program_id: null });
  assert.deepEqual(defaultWorkflowConfig("condition"), {
    field: null,
    operator: null,
    value: null,
  });
  assert.deepEqual(defaultWorkflowConfig("delay"), { mode: "duration", minutes: null });
  assert.deepEqual(defaultWorkflowConfig("email"), {
    recipient: null,
    subject_template: "",
    body_template: "",
    reply_to_email: "",
  });
  assert.deepEqual(defaultWorkflowConfig("lead_follow_up"), { due_in_days: null, note: "" });
  assert.deepEqual(defaultWorkflowConfig("end"), {});
  const draft = initialWorkflowDraft();
  assert.equal(validateWorkflow(draft.graph, draft.layout, "draft").valid, true);
  assert.deepEqual(codes(validateWorkflow(draft.graph, draft.layout)), ["incomplete_config"]);
  assert.equal(draft.graph.edges[0].port, "next");
  const one = defaultWorkflowConfig("condition");
  one.value = ["mutated"];
  assert.equal(defaultWorkflowConfig("condition").value, null);
});

test("branched converging graph serializes only canonical graph/layout and roundtrips", () => {
  const original = branched();
  const transient = structuredClone(original);
  transient.graph.nodes.forEach((node) => {
    node.selected = true;
    node.position = { x: 999, y: 999 };
    node.measured = { width: 100 };
  });
  transient.graph.edges.forEach((edge) => {
    edge.animated = true;
    edge.sourceHandle = "fake";
  });
  transient.selection = "yes";
  transient.token = "not-persisted";
  const serialized = serializeWorkflowDraft(transient);
  for (const key of [
    "selected",
    "measured",
    "sourceHandle",
    "animated",
    "selection",
    "token",
    "source_port",
  ])
    assert.equal(serialized.includes(key), false);
  const result = JSON.parse(serialized);
  assert.deepEqual(result, canonicalWorkflowDraft(original));
  assert.equal(serializeWorkflowDraft(result), serialized);
  assert.deepEqual(
    result.graph.edges.filter((edge) => edge.source === "condition").map((edge) => edge.port),
    ["yes", "no"],
  );
  assert.equal(validateWorkflow(result.graph, result.layout).valid, true);
  result.graph.nodes.find((node) => node.type === "condition").config.value = ["changed"];
  assert.equal(nodeById(original, "condition").config.value, "new");
});

test("incomplete cyclic drafts stay saveable while execution issues have addresses", () => {
  const draft = branched();
  draft.graph.edges = draft.graph.edges.filter((edge) => edge.id !== "e4");
  draft.graph.edges.push({ id: "cycle", source: "yes", target: "condition", port: "next" });
  draft.graph.nodes.push({
    id: "isolated",
    type: "delay",
    config: { mode: "duration", minutes: null },
  });
  assert.equal(validateWorkflow(draft.graph, draft.layout, "draft").valid, true);
  assert.doesNotThrow(() => serializeWorkflowDraft(draft));
  const result = validateWorkflow(draft.graph, draft.layout);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "cycle" && issue.edge_id === "cycle"));
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "unreachable_node" && issue.node_id === "isolated",
    ),
  );
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "cannot_reach_end" && issue.node_id === "isolated",
    ),
  );
  assert.ok(
    result.issues.some((issue) => issue.field === "config.minutes" && issue.node_id === "isolated"),
  );
  for (const issue of result.issues)
    assert.deepEqual(Object.keys(issue).sort(), ["code", "edge_id", "field", "message", "node_id"]);
});

test("connection rejections are atomic for self, cycle, trigger, end, port, ID and occupied port", () => {
  const fixtures = [
    { id: "new", source: "yes", target: "yes", port: "next" },
    { id: "new", source: "no", target: "trigger", port: "next" },
    { id: "new", source: "end", target: "yes", port: "next" },
    { id: "new", source: "yes", target: "end", port: "yes" },
    { id: "e1", source: "yes", target: "end", port: "next" },
    { id: "new", source: "condition", target: "end", port: "yes" },
    { id: "new", source: "missing", target: "end", port: "next" },
  ];
  for (const edge of fixtures) {
    const draft = branched();
    const before = structuredClone(draft);
    const result = editWorkflow(draft, { kind: "connect", edge });
    assert.equal(result.ok, false);
    assert.ok(result.reason.length);
    assert.strictEqual(result.draft, draft);
    assert.deepEqual(draft, before);
  }
  const draft = branched();
  draft.graph.edges = draft.graph.edges.filter((edge) => edge.id !== "e4");
  const result = editWorkflow(draft, {
    kind: "connect",
    edge: { id: "cycle", source: "yes", target: "condition", port: "next" },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /cycle/);
  assert.equal(draft.graph.edges.length, 4);
});

test("disconnect/connect preserve branch ports and node deletion removes incident edges and layout", () => {
  const draft = branched();
  const disconnected = editWorkflow(draft, { kind: "disconnect", edge_id: "e2" });
  assert.equal(disconnected.ok, true);
  const connected = editWorkflow(disconnected.draft, {
    kind: "connect",
    edge: { id: "replacement", source: "condition", target: "end", port: "yes" },
  });
  assert.equal(connected.ok, true);
  assert.deepEqual(
    connected.draft.graph.edges.find((edge) => edge.id === "replacement"),
    { id: "replacement", source: "condition", target: "end", port: "yes" },
  );
  const removed = editWorkflow(draft, { kind: "remove_node", node_id: "condition" });
  assert.equal(removed.ok, true);
  assert.deepEqual(
    removed.draft.graph.edges.map((edge) => edge.id),
    ["e4", "e5"],
  );
  assert.equal(Object.hasOwn(removed.draft.layout.positions, "condition"), false);
  assert.equal(nodeById(draft, "condition").type, "condition");
  assert.equal(editWorkflow(draft, { kind: "remove_node", node_id: "trigger" }).ok, false);
  const incompatible = editWorkflow(draft, {
    kind: "update_config",
    node_id: "condition",
    update: { type: "delay", config: { mode: "duration", minutes: 2 } },
  });
  assert.equal(incompatible.ok, false);
  assert.deepEqual(
    draft.graph.edges.map((edge) => edge.port),
    ["next", "yes", "no", "next", "next"],
  );
});

test("node addition, config updates and completed moves isolate caller data", () => {
  const draft = branched();
  const node = {
    id: "node_1",
    type: "condition",
    config: { field: null, operator: "in", value: ["new"] },
  };
  const added = editWorkflow(draft, { kind: "add_node", node, position: { x: 42, y: 50 } });
  assert.equal(added.ok, true);
  node.config.value.push("mutated");
  assert.deepEqual(nodeById(added.draft, "node_1").config.value, ["new"]);
  assert.equal(nextWorkflowId(added.draft.graph, "node"), "node_2");
  assert.equal(
    nextWorkflowId({ ...draft.graph, edges: [{ id: "edge_1" }, { id: "edge_3" }] }, "edge"),
    "edge_2",
  );
  const updated = editWorkflow(draft, {
    kind: "update_config",
    node_id: "condition",
    update: { type: "condition", config: { field: "lead.stage", operator: "eq", value: null } },
  });
  assert.equal(updated.ok, true);
  // Null eligibility for eq/neq comes from nullable catalog metadata.
  assert.equal(validateWorkflow(updated.draft.graph, updated.draft.layout).valid, true);
  const moved = commitWorkflowPosition(draft, "condition", { x: 20, y: 30 });
  assert.deepEqual(moved.draft.layout.positions.condition, { x: 20, y: 30 });
  assert.notDeepEqual(draft.layout.positions.condition, { x: 20, y: 30 });
});

test("history retains 50 snapshots, freezes deeply, skips no-ops and resets redo only after edits", () => {
  const input = branched();
  let history = createWorkflowHistory(input);
  const saved = history.present.graph.nodes[0].id;
  input.graph.nodes[0].id = "mutated";
  assert.equal(history.present.graph.nodes[0].id, saved);
  assert.throws(() => {
    history.present.graph.nodes[0].config.changed = true;
  }, TypeError);
  for (let x = 1; x <= 60; x++) {
    const result = editWorkflowHistory(history, {
      kind: "commit_position",
      node_id: "condition",
      position: { x, y: 0 },
    });
    assert.equal(result.ok, true);
    history = result.history;
  }
  assert.equal(history.past.length + 1 + history.future.length, WORKFLOW_LIMITS.history);
  const moved = history;
  history = undoWorkflow(history);
  assert.equal(history.present.layout.positions.condition.x, 59);
  const same = editWorkflowHistory(history, {
    kind: "commit_position",
    node_id: "condition",
    position: { x: 59, y: 0 },
  });
  assert.equal(same.changed, false);
  assert.strictEqual(same.history, history);
  assert.deepEqual(redoWorkflow(history), moved);
  const failed = editWorkflowHistory(history, { kind: "remove_node", node_id: "trigger" });
  assert.equal(failed.ok, false);
  assert.strictEqual(failed.history, history);
  const result = editWorkflowHistory(history, {
    kind: "commit_position",
    node_id: "condition",
    position: { x: 999, y: 0 },
  });
  assert.equal(result.history.future.length, 0);
  assert.strictEqual(redoWorkflow(result.history), result.history);
  let count = 0;
  while (history.past.length) {
    history = undoWorkflow(history);
    count++;
  }
  assert.equal(count, 48);
  assert.strictEqual(undoWorkflow(history), history);
});

test("layout and ordered inventory are deterministic across node/edge order and cycles", () => {
  const draft = branched();
  draft.graph.nodes.push(
    { id: "isolated", type: "end", config: {} },
    { id: "cycle_a", type: "delay", config: { mode: "duration", minutes: 0 } },
    { id: "cycle_b", type: "delay", config: { mode: "duration", minutes: 0 } },
  );
  draft.graph.edges.push(
    { id: "cycle1", source: "cycle_a", target: "cycle_b", port: "next" },
    { id: "cycle2", source: "cycle_b", target: "cycle_a", port: "next" },
  );
  const layout = automaticWorkflowLayout(draft.graph);
  const reversed = {
    ...draft.graph,
    nodes: [...draft.graph.nodes].reverse(),
    edges: [...draft.graph.edges].reverse(),
  };
  assert.deepEqual(automaticWorkflowLayout(reversed), layout);
  assert.equal(
    new Set(Object.values(layout.positions).map(({ x, y }) => `${x},${y}`)).size,
    draft.graph.nodes.length,
  );
  assert.ok(layout.positions.end.x > layout.positions.yes.x);
  const steps = workflowSteps(draft.graph);
  assert.equal(new Set(steps.map(({ node }) => node.id)).size, draft.graph.nodes.length);
  assert.deepEqual(workflowSteps(reversed), steps);
  assert.deepEqual(steps.find(({ node }) => node.id === "condition").outgoing, {
    yes: [{ edge_id: "e2", node_id: "yes" }],
    no: [{ edge_id: "e3", node_id: "no" }],
  });
  const filled = fillWorkflowPositions({
    graph: draft.graph,
    layout: { positions: { trigger: { x: 13, y: 7 } } },
  });
  assert.deepEqual(filled.layout.positions.trigger, { x: 13, y: 7 });
  assert.equal(Object.keys(filled.layout.positions).length, draft.graph.nodes.length);
  assert.deepEqual(filled.graph, canonicalWorkflowDraft({ ...draft, layout }).graph);
});

test("draft validation rejects malformed IDs, duplicate IDs, unknown shapes and graph bounds", () => {
  const cases = [
    [
      "unsupported_schema",
      (d) => {
        d.graph.schema_version = 2;
      },
    ],
    [
      "unsupported_node_type",
      (d) => {
        d.graph.nodes[0].type = "script";
      },
    ],
    [
      "unknown_field",
      (d) => {
        d.graph.nodes[0].config.code = "run()";
      },
    ],
    [
      "unknown_field",
      (d) => {
        d.graph.edges[0].source_port = "yes";
      },
    ],
    [
      "invalid_node_id",
      (d) => {
        d.graph.nodes[0].id = "bad id";
      },
    ],
    [
      "invalid_edge_id",
      (d) => {
        d.graph.edges[0].id = "x".repeat(65);
      },
    ],
    [
      "duplicate_node_id",
      (d) => {
        d.graph.nodes.push(structuredClone(d.graph.nodes[0]));
      },
    ],
    [
      "duplicate_edge_id",
      (d) => {
        d.graph.edges.push(structuredClone(d.graph.edges[0]));
      },
    ],
    [
      "unsupported_port",
      (d) => {
        d.graph.edges[0].port = "maybe";
      },
    ],
    [
      "node_limit",
      (d) => {
        d.graph.nodes = Array.from({ length: 41 }, (_, i) => ({
          id: `n${i}`,
          type: "end",
          config: {},
        }));
        d.layout.positions = {};
      },
    ],
    [
      "edge_limit",
      (d) => {
        d.graph.edges = Array.from({ length: 61 }, (_, i) => ({
          id: `e${i}`,
          source: "trigger",
          target: "end",
          port: "next",
        }));
      },
    ],
  ];
  for (const [expected, mutate] of cases) {
    const draft = branched();
    mutate(draft);
    const result = validateWorkflow(draft.graph, draft.layout, "draft");
    assert.equal(result.valid, false, expected);
    assert.ok(codes(result).includes(expected), expected);
  }
});

test("position validation accepts boundary, rejects unknown IDs, nonfinite and excessive positions", () => {
  const draft = branched();
  for (const value of [Infinity, NaN, 100001, -100001]) {
    draft.layout.positions.trigger.x = value;
    assert.ok(
      codes(validateWorkflow(draft.graph, draft.layout, "draft")).includes("invalid_position"),
    );
  }
  draft.layout.positions.trigger = { x: 100000, y: -100000 };
  assert.equal(validateWorkflow(draft.graph, draft.layout, "draft").valid, true);
  draft.layout.positions.missing = { x: 0, y: 0 };
  assert.ok(
    codes(validateWorkflow(draft.graph, draft.layout, "draft")).includes("unknown_layout_node"),
  );
});

test("config validation enforces ranges, finite scalar/string bounds, and exact delay alternatives", () => {
  const invalid = [
    ["trigger", { event_type: null, program_id: "bad", offset_minutes: 1 }],
    ["condition", { field: null, operator: "in", value: Array(101).fill("x") }],
    ["condition", { field: null, operator: null, value: "x".repeat(501) }],
    ["condition", { field: null, operator: null, value: [Infinity] }],
    ["condition", { field: null, operator: null, value: [{}] }],
    ["delay", { mode: "duration", minutes: -1 }],
    ["delay", { mode: "duration", minutes: 1.5 }],
    ["delay", { mode: "until", field: null, offset_minutes: 129601 }],
    ["delay", { mode: "duration", minutes: 1, field: null }],
    [
      "email",
      { recipient: null, subject_template: "x".repeat(201), body_template: "", reply_to_email: "" },
    ],
    [
      "email",
      {
        recipient: null,
        subject_template: "",
        body_template: "x".repeat(5001),
        reply_to_email: "",
      },
    ],
    ["lead_follow_up", { due_in_days: 91, note: "" }],
    ["lead_follow_up", { due_in_days: null, note: "x".repeat(1001) }],
    ["end", { extra: true }],
  ];
  for (const [type, config] of invalid)
    assert.equal(
      validateWorkflow(
        { schema_version: 1, nodes: [{ id: "n", type, config }], edges: [] },
        undefined,
        "draft",
      ).valid,
      false,
      `${type} ${JSON.stringify(config)}`,
    );
  for (const minutes of [0, 129600, null])
    assert.equal(
      validateWorkflow(
        {
          schema_version: 1,
          nodes: [{ id: "n", type: "delay", config: { mode: "duration", minutes } }],
          edges: [],
        },
        undefined,
        "draft",
      ).valid,
      true,
    );
  const draft = branched();
  nodeById(draft, "yes").config.reply_to_email = "invalid";
  assert.ok(codes(validateWorkflow(draft.graph, draft.layout)).includes("invalid_reply_to"));
});

test("execution guidance reports degrees, dangling edges and missing trigger/end without claiming catalog validity", () => {
  const draft = branched();
  draft.graph.edges.push({
    id: "duplicate_port",
    source: "condition",
    target: "missing",
    port: "yes",
  });
  draft.graph.edges.push({ id: "bad_end", source: "end", target: "trigger", port: "no" });
  const result = validateWorkflow(draft.graph, draft.layout);
  for (const code of [
    "port_degree",
    "dangling_target",
    "invalid_source_port",
    "incoming_trigger",
    "cycle",
  ])
    assert.ok(codes(result).includes(code), code);
  assert.deepEqual(codes(validateWorkflow({ schema_version: 1, nodes: [], edges: [] })), [
    "trigger_count",
    "missing_end",
  ]);
  const catalogUnknown = branched();
  nodeById(catalogUnknown, "trigger").config.event_type = "server.catalog.must.decide";
  assert.equal(validateWorkflow(catalogUnknown.graph, catalogUnknown.layout).valid, true);
});

test("validation handles null prototypes and prototype-like IDs without trusting inherited required fields", () => {
  const draft = branched();
  draft.graph.nodes.push({ id: "__proto__", type: "end", config: Object.create(null) });
  draft.layout.positions = Object.assign(Object.create(null), draft.layout.positions);
  draft.layout.positions.__proto__ = { x: 1, y: 2 };
  assert.equal(validateWorkflow(draft.graph, draft.layout, "draft").valid, true);
  const canonical = canonicalWorkflowDraft(draft);
  assert.equal(Object.hasOwn(canonical.layout.positions, "__proto__"), true);
  assert.deepEqual(canonical.layout.positions.__proto__, { x: 1, y: 2 });
  const inherited = Object.create({ schema_version: 1, nodes: [], edges: [] });
  assert.equal(validateWorkflow(inherited, undefined, "draft").valid, false);
  const inheritedConfig = branched();
  inheritedConfig.graph.nodes[0].config = Object.create({ event_type: null, program_id: null });
  assert.ok(
    codes(validateWorkflow(inheritedConfig.graph, inheritedConfig.layout, "draft")).includes(
      "missing_field",
    ),
  );
});

test("normal additions cannot duplicate the trigger and loaded duplicates can be repaired", () => {
  const draft = branched();
  const second = {
    id: "second_trigger",
    type: "trigger",
    config: defaultWorkflowConfig("trigger"),
  };
  assert.equal(editWorkflow(draft, { kind: "add_node", node: second }).ok, false);
  draft.graph.nodes.push(second);
  const repaired = editWorkflow(draft, { kind: "remove_node", node_id: "second_trigger" });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.draft.graph.nodes.filter(({ type }) => type === "trigger").length, 1);
  assert.equal(editWorkflow(repaired.draft, { kind: "remove_node", node_id: "trigger" }).ok, false);
});

test("equivalent config key order is a no-op with a redo branch intact", () => {
  let history = createWorkflowHistory(branched());
  history = editWorkflowHistory(history, {
    kind: "commit_position",
    node_id: "condition",
    position: { x: 99, y: 10 },
  }).history;
  history = undoWorkflow(history);
  const result = editWorkflowHistory(history, {
    kind: "update_config",
    node_id: "condition",
    update: { type: "condition", config: { value: "new", operator: "eq", field: "lead.stage" } },
  });
  assert.equal(result.changed, false);
  assert.strictEqual(result.history, history);
  assert.equal(result.history.future.length, 1);
});

test("upcoming trigger offset excludes zero and accepts the negative inclusive boundaries", () => {
  const draft = branched();
  const config = nodeById(draft, "trigger").config;
  config.event_type = "trial.upcoming";
  for (const offset of [-129600, -1]) {
    config.offset_minutes = offset;
    assert.equal(validateWorkflow(draft.graph, draft.layout, "draft").valid, true);
  }
  for (const offset of [-129601, 0, 1]) {
    config.offset_minutes = offset;
    assert.ok(
      codes(validateWorkflow(draft.graph, draft.layout, "draft")).includes("invalid_integer"),
    );
  }
});

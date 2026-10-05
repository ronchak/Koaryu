import type {
  ValidationIssue,
  WorkflowConfigByType,
  WorkflowDraft,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowLayout,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowNodeUpdate,
  WorkflowPort,
  WorkflowPosition,
  WorkflowValidationResponse,
} from "./automation-workflow-types.ts";

export const WORKFLOW_LIMITS = {
  nodes: 40,
  edges: 60,
  position: 100_000,
  conditionItems: 100,
  conditionString: 500,
  history: 50,
} as const;
type Frozen<T> = T extends object ? { readonly [Key in keyof T]: Frozen<T[Key]> } : T;
export type WorkflowSnapshot = Frozen<WorkflowDraft>;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NODE_TYPES: readonly WorkflowNodeType[] = [
  "trigger",
  "condition",
  "delay",
  "email",
  "lead_follow_up",
  "end",
];
const PORTS: readonly WorkflowPort[] = ["next", "yes", "no"];
const compareIds = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const scalar = (value: unknown) =>
  value === null ||
  typeof value === "boolean" ||
  (typeof value === "string" && value.length <= WORKFLOW_LIMITS.conditionString) ||
  (typeof value === "number" && Number.isFinite(value));

export function defaultWorkflowConfig<Kind extends WorkflowNodeType>(
  type: Kind,
): WorkflowConfigByType[Kind] {
  const defaults: WorkflowConfigByType = {
    trigger: { event_type: null, program_id: null },
    condition: { field: null, operator: null },
    delay: { mode: "duration", minutes: null },
    email: { recipient: null, subject_template: "", body_template: "", reply_to_email: "" },
    lead_follow_up: { due_in_days: null, note: "" },
    end: {},
  };
  return defaults[type];
}

export function initialWorkflowDraft(): WorkflowDraft {
  const graph: WorkflowGraph = {
    schema_version: 1,
    nodes: [
      { id: "trigger_1", type: "trigger", config: defaultWorkflowConfig("trigger") },
      { id: "end_1", type: "end", config: {} },
    ],
    edges: [{ id: "edge_1", source: "trigger_1", target: "end_1", port: "next" }],
  };
  return { graph, layout: automaticWorkflowLayout(graph) };
}

/** Checks local shape/completeness only. Catalog eligibility must be validated by the server. */
export function validateWorkflow(
  graph: unknown,
  layout?: unknown,
  mode: "draft" | "execution" = "execution",
): WorkflowValidationResponse {
  const issues: ValidationIssue[] = [];
  const issue = (
    code: string,
    message: string,
    field: string | null,
    node_id: string | null = null,
    edge_id: string | null = null,
  ) => {
    issues.push({ code, message, node_id, edge_id, field });
  };
  const shape = (
    value: unknown,
    required: string[],
    optional: string[],
    field: string,
    node: string | null = null,
    edge: string | null = null,
  ): value is Record<string, unknown> => {
    if (!record(value)) {
      issue("invalid_object", "Use an object for this value.", field, node, edge);
      return false;
    }
    for (const key of required) {
      if (!has(value, key))
        issue("missing_field", `Provide ${key}.`, `${field}.${key}`, node, edge);
    }
    for (const key of Object.keys(value)) {
      if (!required.includes(key) && !optional.includes(key))
        issue("unknown_field", `Remove unsupported field ${key}.`, `${field}.${key}`, node, edge);
    }
    return true;
  };
  const text = (value: unknown, field: string, node: string, nullable = false, max?: number) => {
    if (nullable && value === null) return;
    if (typeof value !== "string") issue("invalid_text", "Use text for this value.", field, node);
    else if (max !== undefined && value.length > max)
      issue("text_too_long", `Use at most ${max} characters.`, field, node);
  };
  const integer = (
    value: unknown,
    min: number,
    max: number,
    field: string,
    node: string,
    nullable = false,
  ) => {
    if (nullable && value === null) return;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
      issue("invalid_integer", `Use a whole number from ${min} to ${max}.`, field, node);
  };
  if (!shape(graph, ["schema_version", "nodes", "edges"], [], "graph"))
    return { valid: false, issues };
  if (graph.schema_version !== 1)
    issue("unsupported_schema", "Use workflow schema version 1.", "schema_version");
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  if (!Array.isArray(graph.nodes)) issue("invalid_nodes", "Provide a node list.", "nodes");
  if (!Array.isArray(graph.edges)) issue("invalid_edges", "Provide an edge list.", "edges");
  if (nodes.length > WORKFLOW_LIMITS.nodes) issue("node_limit", "Use at most 40 nodes.", "nodes");
  if (edges.length > WORKFLOW_LIMITS.edges) issue("edge_limit", "Use at most 60 edges.", "edges");
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const node of nodes) {
    const id = record(node) && typeof node.id === "string" ? node.id : null;
    if (!shape(node, ["id", "type", "config"], [], "node", id)) continue;
    if (typeof node.id !== "string" || !ID.test(node.id))
      issue(
        "invalid_node_id",
        "Use a node ID of 1 to 64 letters, digits, underscores or hyphens.",
        "id",
        id,
      );
    if (id !== null) {
      if (nodeIds.has(id)) issue("duplicate_node_id", "Node IDs must be unique.", "id", id);
      nodeIds.add(id);
    }
    if (!NODE_TYPES.includes(node.type as WorkflowNodeType)) {
      issue("unsupported_node_type", "Choose a supported node type.", "type", id);
      continue;
    }
    const nodeId = id ?? "";
    const config = node.config;
    switch (node.type) {
      case "trigger":
        if (shape(config, ["event_type", "program_id"], ["offset_minutes"], "config", id)) {
          text(config.event_type, "config.event_type", nodeId, true);
          if (
            config.program_id !== null &&
            (typeof config.program_id !== "string" || !UUID.test(config.program_id))
          )
            issue(
              "invalid_program_id",
              "Choose a program ID or leave the program filter empty.",
              "config.program_id",
              id,
            );
          if (has(config, "offset_minutes"))
            integer(config.offset_minutes, -129600, -1, "config.offset_minutes", nodeId);
        }
        break;
      case "condition":
        if (shape(config, ["field", "operator"], ["value"], "config", id)) {
          text(config.field, "config.field", nodeId, true);
          text(config.operator, "config.operator", nodeId, true);
          if (
            has(config, "value") &&
            !(scalar(config.value) || (Array.isArray(config.value) && config.value.every(scalar)))
          )
            issue(
              "invalid_condition_value",
              "Use finite scalar values with text no longer than 500 characters.",
              "config.value",
              id,
            );
          if (
            has(config, "value") &&
            (config.operator === "in" || config.operator === "not_in") &&
            Array.isArray(config.value) &&
            config.value.length > WORKFLOW_LIMITS.conditionItems
          )
            issue(
              "condition_value_limit",
              "Choose at most 100 comparison values.",
              "config.value",
              id,
            );
        }
        break;
      case "delay":
        if (!record(config)) {
          issue("invalid_object", "Provide a delay configuration.", "config", id);
        } else if (config.mode === "duration") {
          shape(config, ["mode", "minutes"], [], "config", id);
          integer(config.minutes, 0, 129600, "config.minutes", nodeId, true);
        } else if (config.mode === "until") {
          shape(config, ["mode", "field", "offset_minutes"], [], "config", id);
          text(config.field, "config.field", nodeId, true);
          integer(config.offset_minutes, -129600, 129600, "config.offset_minutes", nodeId);
        } else
          issue(
            "unsupported_delay_mode",
            "Choose duration or until for the delay.",
            "config.mode",
            id,
          );
        break;
      case "email":
        if (
          shape(
            config,
            ["recipient", "subject_template", "body_template", "reply_to_email"],
            [],
            "config",
            id,
          )
        ) {
          text(config.recipient, "config.recipient", nodeId, true);
          text(config.subject_template, "config.subject_template", nodeId, false, 200);
          text(config.body_template, "config.body_template", nodeId, false, 5000);
          text(config.reply_to_email, "config.reply_to_email", nodeId);
        }
        break;
      case "lead_follow_up":
        if (shape(config, ["due_in_days", "note"], [], "config", id)) {
          integer(config.due_in_days, 0, 90, "config.due_in_days", nodeId, true);
          text(config.note, "config.note", nodeId, false, 1000);
        }
        break;
      case "end":
        shape(config, [], [], "config", id);
        break;
    }
  }
  for (const edge of edges) {
    const id = record(edge) && typeof edge.id === "string" ? edge.id : null;
    if (!shape(edge, ["id", "source", "target", "port"], [], "edge", null, id)) continue;
    for (const key of ["id", "source", "target"]) {
      if (typeof edge[key] !== "string" || !ID.test(edge[key]))
        issue(
          "invalid_edge_id",
          "Use IDs of 1 to 64 letters, digits, underscores or hyphens.",
          key,
          null,
          id,
        );
    }
    if (id !== null) {
      if (edgeIds.has(id)) issue("duplicate_edge_id", "Edge IDs must be unique.", "id", null, id);
      edgeIds.add(id);
    }
    if (!PORTS.includes(edge.port as WorkflowPort))
      issue("unsupported_port", "Choose next, yes or no as the source port.", "port", null, id);
  }
  if (layout !== undefined && shape(layout, ["positions"], [], "layout")) {
    if (!record(layout.positions))
      issue("invalid_positions", "Provide node positions as an object.", "layout.positions");
    else
      for (const [id, position] of Object.entries(layout.positions)) {
        if (!nodeIds.has(id))
          issue(
            "unknown_layout_node",
            "Remove the position for a missing node.",
            "layout.positions",
            id,
          );
        if (shape(position, ["x", "y"], [], "layout.positions", id)) {
          for (const axis of ["x", "y"]) {
            if (
              typeof position[axis] !== "number" ||
              !Number.isFinite(position[axis]) ||
              Math.abs(position[axis]) > WORKFLOW_LIMITS.position
            )
              issue(
                "invalid_position",
                "Use finite coordinates between -100000 and 100000.",
                `layout.positions.${axis}`,
                id,
              );
          }
        }
      }
  }
  if (issues.length || mode === "draft") return { valid: issues.length === 0, issues };
  const typed = graph as WorkflowGraph;
  const byId = new Map(typed.nodes.map((node) => [node.id, node]));
  const triggers = typed.nodes.filter((node) => node.type === "trigger");
  const ends = typed.nodes.filter((node) => node.type === "end");
  if (triggers.length !== 1) issue("trigger_count", "Use exactly one trigger.", "nodes");
  if (!ends.length) issue("missing_end", "Add at least one end node.", "nodes");
  for (const node of typed.nodes) {
    const outgoing = typed.edges.filter((edge) => edge.source === node.id);
    const ports = workflowPorts(node.type);
    for (const port of ports) {
      if (outgoing.filter((edge) => edge.port === port).length !== 1)
        issue(
          "port_degree",
          `Connect the ${port} port to exactly one node.`,
          `ports.${port}`,
          node.id,
        );
    }
    const required = (value: string | number | null, field: string) => {
      if (value === null || (typeof value === "string" && !value.trim()))
        issue("incomplete_config", "Choose a value before publishing.", `config.${field}`, node.id);
    };
    switch (node.type) {
      case "trigger":
        required(node.config.event_type, "event_type");
        break;
      case "condition":
        required(node.config.field, "field");
        required(node.config.operator, "operator");
        // Omission is unfinished; explicit null eligibility depends on the catalog.
        if (!has(node.config, "value"))
          issue(
            "incomplete_config",
            "Choose a comparison value before publishing.",
            "config.value",
            node.id,
          );
        else if (
          (node.config.operator === "in" || node.config.operator === "not_in") &&
          (!Array.isArray(node.config.value) || !node.config.value.length)
        )
          issue(
            "incomplete_config",
            "Choose one or more comparison values.",
            "config.value",
            node.id,
          );
        break;
      case "delay":
        if (node.config.mode === "duration") required(node.config.minutes, "minutes");
        else required(node.config.field, "field");
        break;
      case "email":
        required(node.config.recipient, "recipient");
        required(node.config.subject_template, "subject_template");
        required(node.config.body_template, "body_template");
        if (
          node.config.reply_to_email &&
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(node.config.reply_to_email)
        )
          issue(
            "invalid_reply_to",
            "Enter a valid reply-to email or leave it empty for the sender default.",
            "config.reply_to_email",
            node.id,
          );
        break;
      case "lead_follow_up":
        required(node.config.due_in_days, "due_in_days");
        break;
    }
  }
  for (const edge of typed.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source)
      issue("dangling_source", "Choose an existing source node.", "source", null, edge.id);
    if (!target)
      issue("dangling_target", "Choose an existing destination node.", "target", null, edge.id);
    if (source && !workflowPorts(source.type).includes(edge.port))
      issue(
        "invalid_source_port",
        "This node does not have that outgoing port.",
        "port",
        source.id,
        edge.id,
      );
    if (target?.type === "trigger")
      issue(
        "incoming_trigger",
        "A trigger cannot have an incoming connection.",
        "target",
        target.id,
        edge.id,
      );
    if (source && target && reachable(typed, edge.target).has(edge.source))
      issue("cycle", "Remove this connection to break the cycle.", "target", source.id, edge.id);
  }
  const fromTrigger = new Set(triggers.flatMap((node) => [...reachable(typed, node.id)]));
  const toEnd = new Set(ends.flatMap((node) => [...reachable(typed, node.id, true)]));
  for (const node of typed.nodes) {
    if (!fromTrigger.has(node.id))
      issue("unreachable_node", "Connect this node to the trigger.", null, node.id);
    if (!toEnd.has(node.id))
      issue("cannot_reach_end", "Connect a path from this node to an end.", null, node.id);
  }
  return { valid: issues.length === 0, issues };
}

export function workflowPorts(type: WorkflowNodeType): readonly WorkflowPort[] {
  return type === "condition" ? ["yes", "no"] : type === "end" ? [] : ["next"];
}

function reachable(graph: WorkflowSnapshot["graph"], start: string, reverse = false): Set<string> {
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of graph.edges) {
      if ((reverse ? edge.target : edge.source) === id)
        pending.push(reverse ? edge.source : edge.target);
    }
  }
  return visited;
}

/** Projects editor data onto the wire contract, excluding node/edge rendering state. */
export function canonicalWorkflowDraft(draft: WorkflowSnapshot): WorkflowDraft {
  const graph: WorkflowGraph = {
    schema_version: draft.graph.schema_version,
    nodes: draft.graph.nodes
      .map(
        ({ id, type, config }) =>
          ({
            id,
            type,
            config: Object.fromEntries(
              Object.entries(config)
                .sort(([a], [b]) => compareIds({ id: a }, { id: b }))
                .map(([key, value]) => [key, structuredClone(value)]),
            ),
          }) as WorkflowNode,
      )
      .sort(compareIds),
    edges: draft.graph.edges
      .map(({ id, source, target, port }) => ({ id, source, target, port }))
      .sort(compareIds),
  };
  const positions = Object.fromEntries(
    Object.entries(draft.layout.positions)
      .sort(([a], [b]) => compareIds({ id: a }, { id: b }))
      .map(([id, { x, y }]) => [id, { x, y }]),
  );
  const layout = { positions };
  const result = validateWorkflow(graph, layout, "draft");
  if (!result.valid) throw new Error(result.issues[0].message);
  return { graph, layout };
}

export function serializeWorkflowDraft(draft: WorkflowSnapshot): string {
  return JSON.stringify(canonicalWorkflowDraft(draft));
}

export function nextWorkflowId(graph: WorkflowSnapshot["graph"], kind: "node" | "edge"): string {
  const used = new Set((kind === "node" ? graph.nodes : graph.edges).map(({ id }) => id));
  let index = 1;
  while (used.has(`${kind}_${index}`)) index += 1;
  return `${kind}_${index}`;
}

export type WorkflowEdit =
  | { kind: "add_node"; node: WorkflowNode; position?: WorkflowPosition }
  | { kind: "update_config"; node_id: string; update: WorkflowNodeUpdate }
  | { kind: "remove_node"; node_id: string }
  | { kind: "connect"; edge: WorkflowEdge }
  | { kind: "disconnect"; edge_id: string }
  | { kind: "commit_position"; node_id: string; position: WorkflowPosition }
  | { kind: "auto_layout" };
export type WorkflowEditResult =
  | { ok: true; draft: WorkflowDraft; changed: boolean }
  | { ok: false; draft: WorkflowSnapshot; reason: string };

export function editWorkflow(draft: WorkflowSnapshot, edit: WorkflowEdit): WorkflowEditResult {
  const fail = (reason: string): WorkflowEditResult => ({ ok: false, draft, reason });
  let next: WorkflowDraft;
  try {
    next = canonicalWorkflowDraft(draft);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The draft has an invalid shape.");
  }
  const { graph, layout } = next;
  const node = "node_id" in edit ? graph.nodes.find(({ id }) => id === edit.node_id) : undefined;
  if ("node_id" in edit && !node) return fail("Choose an existing node.");
  switch (edit.kind) {
    case "add_node":
      if (edit.node.type === "trigger" && graph.nodes.some(({ type }) => type === "trigger"))
        return fail("The workflow already has a trigger.");
      if (graph.nodes.some(({ id }) => id === edit.node.id))
        return fail("Node IDs must be unique.");
      graph.nodes.push(structuredClone(edit.node));
      if (edit.position)
        Object.defineProperty(layout.positions, edit.node.id, {
          value: { ...edit.position },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      break;
    case "update_config":
      if (node!.type !== edit.update.type)
        return fail("Configuration updates must keep the node type.");
      graph.nodes = graph.nodes.map((existing) =>
        existing.id === edit.node_id
          ? { id: existing.id, ...structuredClone(edit.update) }
          : existing,
      );
      break;
    case "remove_node":
      if (
        node!.type === "trigger" &&
        graph.nodes.filter(({ type }) => type === "trigger").length === 1
      )
        return fail("The trigger cannot be removed.");
      graph.nodes = graph.nodes.filter(({ id }) => id !== edit.node_id);
      graph.edges = graph.edges.filter(
        ({ source, target }) => source !== edit.node_id && target !== edit.node_id,
      );
      delete layout.positions[edit.node_id];
      break;
    case "connect": {
      const edge = edit.edge;
      const source = graph.nodes.find(({ id }) => id === edge.source);
      const target = graph.nodes.find(({ id }) => id === edge.target);
      if (!source || !target) return fail("Choose existing source and destination nodes.");
      if (graph.edges.some(({ id }) => id === edge.id)) return fail("Edge IDs must be unique.");
      if (source.id === target.id) return fail("A node cannot connect to itself.");
      if (target.type === "trigger") return fail("A trigger cannot have an incoming connection.");
      if (!workflowPorts(source.type).includes(edge.port))
        return fail("This node does not have that outgoing port.");
      if (
        graph.edges.some(
          (existing) => existing.source === edge.source && existing.port === edge.port,
        )
      )
        return fail("That source port already has a connection.");
      if (reachable(graph, edge.target).has(edge.source))
        return fail("This connection would create a cycle.");
      graph.edges.push(structuredClone(edge));
      break;
    }
    case "disconnect":
      graph.edges = graph.edges.filter(({ id }) => id !== edit.edge_id);
      break;
    case "commit_position":
      Object.defineProperty(layout.positions, edit.node_id, {
        value: { ...edit.position },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      break;
    case "auto_layout":
      next.layout = automaticWorkflowLayout(graph);
      break;
  }
  const checked = validateWorkflow(graph, next.layout, "draft");
  if (!checked.valid) return fail(checked.issues[0].message);
  const canonical = canonicalWorkflowDraft(next);
  return {
    ok: true,
    draft: canonical,
    changed: serializeWorkflowDraft(draft) !== JSON.stringify(canonical),
  };
}

/** Commits only the completed drag. Renderers can keep transient positions outside this model. */
export function commitWorkflowPosition(
  draft: WorkflowSnapshot,
  node_id: string,
  position: WorkflowPosition,
): WorkflowEditResult {
  return editWorkflow(draft, { kind: "commit_position", node_id, position });
}

function orderedRanks(graph: WorkflowSnapshot["graph"]): Map<string, number> {
  const nodes = [...graph.nodes].sort(compareIds);
  const ids = new Set(nodes.map(({ id }) => id));
  const edges = graph.edges.filter(({ source, target }) => ids.has(source) && ids.has(target));
  const incoming = new Map(
    nodes.map(({ id }) => [id, edges.filter(({ target }) => target === id).length]),
  );
  const ranks = new Map<string, number>();
  const pending = nodes.filter(({ id }) => incoming.get(id) === 0).map(({ id }) => id);
  for (const id of pending) ranks.set(id, 0);
  while (pending.length) {
    pending.sort();
    const id = pending.shift()!;
    for (const edge of edges.filter(({ source }) => source === id).sort(compareIds)) {
      ranks.set(edge.target, Math.max(ranks.get(edge.target) ?? 0, ranks.get(id)! + 1));
      incoming.set(edge.target, incoming.get(edge.target)! - 1);
      if (incoming.get(edge.target) === 0) pending.push(edge.target);
    }
  }
  const residualRank = Math.max(-1, ...ranks.values()) + 1;
  for (const node of nodes) {
    if (incoming.get(node.id)! > 0) ranks.set(node.id, residualRank);
  }
  return ranks;
}

export function automaticWorkflowLayout(graph: WorkflowSnapshot["graph"]): WorkflowLayout {
  const ranks = orderedRanks(graph);
  const rows = new Map<number, number>();
  return {
    positions: Object.fromEntries(
      [...graph.nodes].sort(compareIds).map(({ id }) => {
        const rank = ranks.get(id)!;
        const row = rows.get(rank) ?? 0;
        rows.set(rank, row + 1);
        return [id, { x: rank * 300, y: row * 180 }];
      }),
    ),
  };
}

export function fillWorkflowPositions(draft: WorkflowSnapshot): WorkflowDraft {
  const next = canonicalWorkflowDraft(draft);
  const generated = automaticWorkflowLayout(next.graph);
  next.layout.positions = { ...generated.positions, ...next.layout.positions };
  return canonicalWorkflowDraft(next);
}

export type WorkflowStep = {
  node: WorkflowNode;
  rank: number;
  outgoing: Partial<Record<WorkflowPort, { edge_id: string; node_id: string }[]>>;
};

/** An ordered inventory with explicit branches, not a predicted execution sequence. */
export function workflowSteps(graph: WorkflowSnapshot["graph"]): WorkflowStep[] {
  const ranks = orderedRanks(graph);
  return [...graph.nodes]
    .sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)! || compareIds(a, b))
    .map((node) => {
      const outgoing: WorkflowStep["outgoing"] = {};
      for (const port of PORTS) {
        const destinations = graph.edges
          .filter((edge) => edge.source === node.id && edge.port === port)
          .sort(compareIds)
          .map((edge) => ({ edge_id: edge.id, node_id: edge.target }));
        if (destinations.length) outgoing[port] = destinations;
      }
      return { node: structuredClone(node) as WorkflowNode, rank: ranks.get(node.id)!, outgoing };
    });
}

export type WorkflowHistory = Frozen<{
  past: WorkflowDraft[];
  present: WorkflowDraft;
  future: WorkflowDraft[];
}>;
function freeze<T>(value: T): Frozen<T> {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as Frozen<T>;
}
export function createWorkflowHistory(draft: WorkflowSnapshot): WorkflowHistory {
  return freeze({ past: [], present: canonicalWorkflowDraft(draft), future: [] });
}
export type WorkflowHistoryResult =
  | { ok: true; history: WorkflowHistory; changed: boolean }
  | { ok: false; history: WorkflowHistory; reason: string };
export function editWorkflowHistory(
  history: WorkflowHistory,
  edit: WorkflowEdit,
): WorkflowHistoryResult {
  const result = editWorkflow(history.present, edit);
  if (!result.ok) return { ok: false, history, reason: result.reason };
  if (!result.changed) return { ok: true, history, changed: false };
  return {
    ok: true,
    changed: true,
    history: freeze({
      past: [...history.past, history.present].slice(-(WORKFLOW_LIMITS.history - 1)),
      present: result.draft,
      future: [],
    }),
  };
}
export function undoWorkflow(history: WorkflowHistory): WorkflowHistory {
  const present = history.past.at(-1);
  if (!present) return history;
  return freeze({
    past: history.past.slice(0, -1),
    present,
    future: [history.present, ...history.future],
  });
}
export function redoWorkflow(history: WorkflowHistory): WorkflowHistory {
  const present = history.future[0];
  if (!present) return history;
  return freeze({
    past: [...history.past, history.present],
    present,
    future: history.future.slice(1),
  });
}

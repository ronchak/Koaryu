import { initialWorkflowDraft } from "../../src/lib/automation-workflow-model.ts";
export const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  studio: "20000000-0000-4000-8000-000000000001",
  workflow: "30000000-0000-4000-8000-000000000001",
  draft: "40000000-0000-4000-8000-000000000001",
  other: "50000000-0000-4000-8000-000000000001",
};
export const owner = { userId: ids.user, studioId: ids.studio, role: "admin" };
export function detail(overrides = {}) {
  const draft = initialWorkflowDraft();
  return {
    id: ids.workflow,
    name: "Welcome",
    description: "A synthetic workflow",
    status: "draft",
    revision: 1,
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
    ...(["active", "paused"].includes(overrides.status)
      ? {
          published_version_id: ids.other,
          published_version_number: 1,
          published_at: "2026-10-05T12:00:00Z",
        }
      : {}),
    ...overrides,
  };
}
export const catalog = {
  schema_version: 1,
  triggers: {},
  fields: {},
  recipients: {},
  variables: {},
  delay_fields: {},
  presets: [],
  limits: {
    max_nodes: 40,
    max_edges: 60,
    max_workflows: 100,
    max_active_workflows: 25,
    max_delay_minutes: 129600,
    max_request_bytes: 1048576,
  },
  capabilities: {
    can_start: false,
    can_test_email: false,
    disabled_reason: "Sending is disabled.",
  },
  delivery_status: {
    mode: "disabled",
    configured: false,
    can_enable: false,
    sender: "",
    test_recipient: null,
    reason: "sending_disabled",
  },
  scheduler: { enabled: false, interval_seconds: 60 },
};
export function receipt(operationId, command = "workflow.create", result = detail()) {
  return {
    operation_id: operationId,
    state: "committed",
    command,
    entity_type: "workflow",
    entity_id: result.id,
    result,
    committed_at: "2026-10-05T12:00:00Z",
  };
}
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export const tick = () => new Promise((resolve) => setImmediate(resolve));
export function fixture() {
  const calls = [],
    auth = [],
    saved = new Map();
  let count = 0,
    activeStudio = ids.studio;
  const storage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
  const api = Object.fromEntries(
    [
      "catalog",
      "list",
      "detail",
      "create",
      "save",
      "publish",
      "start",
      "pause",
      "archive",
      "operation",
      "validate",
      "simulate",
    ].map((name) => [
      name,
      async (...args) => {
        calls.push({ name, args });
        if (name === "catalog") return structuredClone(catalog);
        if (name === "list") return { items: [], next_cursor: null, has_more: false };
        if (name === "validate")
          return {
            valid: false,
            issues: [
              {
                code: "incomplete",
                message: "Choose a trigger.",
                node_id: "trigger_1",
                edge_id: null,
                field: "config.event_type",
              },
            ],
          };
        if (name === "create")
          return detail({
            name: args[0].name,
            description: args[0].description,
            draft_graph: args[0].graph,
            draft_layout: args[0].layout,
          });
        if (["save", "publish", "start", "pause", "archive"].includes(name))
          return detail({ revision: args[1].expected_revision + 1 });
        return detail();
      },
    ]),
  );
  const dependencies = {
    api,
    storage: () => storage,
    uuid: () => `60000000-0000-4000-8000-${String(++count).padStart(12, "0")}`,
    activeStudio: () => activeStudio,
    capture: (_expected, invalidated) => {
      const abort = new AbortController();
      const entry = {
        isCurrent: () => !abort.signal.aborted,
        signal: abort.signal,
        dispose() {},
        invalidate() {
          abort.abort();
          invalidated();
        },
      };
      auth.push(entry);
      return entry;
    },
    invalidate: () => auth.forEach((entry) => entry.invalidate()),
  };
  return {
    dependencies,
    calls,
    saved,
    storage,
    auth,
    api,
    setStudio: (value) => {
      activeStudio = value;
    },
    get allocations() {
      return count;
    },
  };
}
// Build a shape-valid graph whose complete create request uses exactly the requested UTF-8 bytes.
export function sizedRequest(size, operation_id = "60000000-0000-4000-8000-000000000001") {
  const graph = {
    schema_version: 1,
    nodes: Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      type: "condition",
      config: { field: "lead.stage", operator: "in", value: Array(100).fill("") },
    })),
    edges: [],
  };
  const body = { operation_id, name: "Sized", description: "", graph, layout: { positions: {} } };
  let remaining = size - Buffer.byteLength(JSON.stringify(body));
  for (const node of graph.nodes)
    for (let i = 0; i < 100; i++) {
      const bytes = Math.min(2000, remaining);
      node.config.value[i] = "😀".repeat(Math.floor(bytes / 4)) + "a".repeat(bytes % 4);
      remaining -= bytes;
    }
  if (remaining !== 0) throw new Error("Fixture does not fit graph bounds");
  return body;
}

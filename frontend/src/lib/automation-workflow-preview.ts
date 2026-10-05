import snapshot from "./generated/workflow-preview-catalog.json";
import type {
  WorkflowCatalogResponse,
  WorkflowDetail,
  WorkflowSummary,
} from "./automation-workflow-types";
import type { WorkflowReferenceChoices } from "./automation-workflow-catalog";
import type { WorkflowPreviewSource } from "./automation-workflow-workspace-controller";

// The generator copies only the pure domain catalog. Readiness is always sample-only.
export const workflowPreviewCatalog = {
  ...snapshot,
  schema_version: 1,
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
    disabled_reason: "Sample workflows cannot send email or start.",
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
} as WorkflowCatalogResponse;

const timestamp = "2026-10-05T12:00:00Z";
const details: Record<string, WorkflowDetail> = {};
const items: WorkflowSummary[] = workflowPreviewCatalog.presets.slice(0, 2).map((preset, index) => {
  const id = `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  const detail: WorkflowDetail = {
    id,
    name: `Sample: ${preset.name}`,
    description: preset.description,
    status: "draft",
    revision: 1,
    draft_graph: preset.graph,
    draft_layout: { positions: {} },
    validation_issues: [],
    published_version_id: null,
    published_version_number: null,
    published_at: null,
    updated_at: timestamp,
    has_unpublished_changes: true,
    pending_run_count: 0,
    sending_run_count: 0,
  };
  details[id] = detail;
  return {
    ...detail,
    created_at: timestamp,
    trigger_event_type: null,
    draft_trigger_event_type:
      preset.graph.nodes.find((node) => node.type === "trigger")?.config.event_type ?? null,
  };
});
export const workflowPreviewSource: WorkflowPreviewSource = {
  catalog: workflowPreviewCatalog,
  list: { items, next_cursor: null, has_more: false },
  details,
};
export const workflowPreviewReferences: WorkflowReferenceChoices = {
  "program.id": {
    status: "ready",
    choices: [{ id: "71000000-0000-4000-8000-000000000001", label: "Sample adult program" }],
  },
  "promotion.rank_id": {
    status: "ready",
    choices: [{ id: "72000000-0000-4000-8000-000000000001", label: "Sample blue belt" }],
  },
};

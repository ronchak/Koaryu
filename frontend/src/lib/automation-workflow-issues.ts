import { workflowNodeLabels } from "./automation-workflow-model.ts";
import type { WorkflowSnapshot } from "./automation-workflow-model.ts";
import type { ValidationIssue, WorkflowNodeType } from "./automation-workflow-types.ts";

/**
 * One row of "Workflow checks": the step it belongs to, the setting it points at, and
 * what to do, in plain words. Rows are deduplicated so one blank field is one row.
 */
export type WorkflowIssueRow = {
  key: string;
  /** The step to select; connection issues select the connection's source step. */
  node_id: string | null;
  /** The inspector field to focus, such as `subject_template`, when the issue names one. */
  field: string | null;
  /** The step's name, such as "Email 2"; null for whole-workflow issues. */
  step: string | null;
  /** The setting's label, such as "Subject"; null for connections and whole-workflow issues. */
  setting: string | null;
  message: string;
  count: number;
};

const SETTINGS: Partial<Record<WorkflowNodeType, Record<string, string>>> = {
  trigger: {
    event_type: "Trigger event",
    program_id: "Program filter",
    offset_minutes: "Minutes before event",
  },
  condition: {
    field: "Comparison field",
    operator: "Comparison operator",
    value: "Comparison value",
  },
  delay: {
    mode: "Delay mode",
    minutes: "Duration",
    field: "Event time",
    offset_minutes: "Offset",
  },
  email: {
    recipient: "Recipient",
    subject_template: "Subject",
    body_template: "Message",
    reply_to_email: "Reply-to email",
  },
  lead_follow_up: { due_in_days: "Due in days", note: "Follow-up note" },
};

// Server and local validators both report a blank required setting as incomplete_config.
const INCOMPLETE: Partial<Record<WorkflowNodeType, Record<string, string>>> = {
  trigger: {
    event_type: "Choose what starts this workflow.",
    offset_minutes: "Choose how long before the event it runs.",
  },
  condition: {
    field: "Choose a field to compare.",
    operator: "Choose how to compare it.",
    value: "Choose a value to compare against.",
  },
  delay: {
    minutes: "Choose how long to wait.",
    field: "Choose the event time to wait for.",
  },
  email: {
    recipient: "Choose who receives this email.",
    subject_template: "Add a subject line.",
    body_template: "Write the message.",
  },
  lead_follow_up: { due_in_days: "Choose when the follow-up is due." },
};

const CONNECTIONS: Record<string, string | ((type: WorkflowNodeType | null) => string)> = {
  unreachable_node: "Not connected to the trigger yet.",
  no_path_to_end: "No path from here to an end step.",
  cannot_reach_end: "No path from here to an end step.",
  invalid_outgoing_ports: (type) =>
    type === "condition"
      ? "Connect both the Yes and No paths."
      : "Connect this step to what comes next.",
  port_degree: (type) =>
    type === "condition"
      ? "Connect both the Yes and No paths."
      : "Connect this step to what comes next.",
  cycle: "Remove the loop. A step cannot lead back to an earlier step.",
  trigger_count: "Add exactly one trigger.",
  end_required: "Add an end step.",
  missing_end: "Add an end step.",
};

// Server issues name settings as `config.<name>`; local editor issues may use the bare name.
const fieldName = (field: string | null, type: WorkflowNodeType | null): string | null => {
  if (!field) return null;
  const match = /^config\.([A-Za-z_]+)/.exec(field);
  if (match) return match[1];
  const bare = /^([A-Za-z_]+)(\[|$)/.exec(field)?.[1];
  return bare && type && SETTINGS[type] && Object.hasOwn(SETTINGS[type], bare) ? bare : null;
};

/**
 * Turns raw validation issues into deduplicated, named rows in the order the steps appear.
 * `order` lists node IDs in display order; unknown steps keep the server's order after them.
 */
export function describeWorkflowIssues(
  issues: readonly ValidationIssue[],
  graph: WorkflowSnapshot["graph"],
  order: readonly string[] = [],
): WorkflowIssueRow[] {
  const labels = workflowNodeLabels(graph);
  const types = new Map(graph.nodes.map((node) => [node.id, node.type]));
  const sources = new Map(graph.edges.map((edge) => [edge.id, edge.source]));
  const rows = new Map<string, WorkflowIssueRow>();
  for (const issue of issues) {
    const nodeId =
      issue.node_id && types.has(issue.node_id)
        ? issue.node_id
        : issue.edge_id && sources.has(issue.edge_id)
          ? sources.get(issue.edge_id)!
          : null;
    const type = nodeId ? (types.get(nodeId) ?? null) : null;
    const name = nodeId ? fieldName(issue.field, type) : null;
    const setting = type && name ? (SETTINGS[type]?.[name] ?? null) : null;
    const connection = CONNECTIONS[issue.code];
    const message =
      issue.code === "incomplete_config" && type && name && INCOMPLETE[type]?.[name]
        ? INCOMPLETE[type]![name]
        : typeof connection === "function"
          ? connection(type)
          : (connection ?? issue.message);
    const key = JSON.stringify([nodeId, setting, message]);
    const existing = rows.get(key);
    if (existing) existing.count += 1;
    else
      rows.set(key, {
        key,
        node_id: nodeId,
        field: setting ? name : null,
        step: nodeId ? (Object.hasOwn(labels, nodeId) ? labels[nodeId] : nodeId) : null,
        setting,
        message,
        count: 1,
      });
  }
  const rank = new Map(order.map((id, index) => [id, index]));
  const position = (row: WorkflowIssueRow) =>
    row.node_id === null ? -1 : (rank.get(row.node_id) ?? order.length);
  return [...rows.values()].sort((a, b) => position(a) - position(b));
}

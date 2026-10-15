import assert from "node:assert/strict";
import { test } from "node:test";
import { describeWorkflowIssues } from "../src/lib/automation-workflow-issues.ts";

const graph = {
  schema_version: 1,
  nodes: [
    { id: "trigger", type: "trigger", config: { event_type: "lead.created", program_id: null } },
    {
      id: "welcome",
      type: "email",
      config: { recipient: null, subject_template: "", body_template: "", reply_to_email: "" },
    },
    {
      id: "node_3",
      type: "email",
      config: { recipient: null, subject_template: "", body_template: "", reply_to_email: "" },
    },
    { id: "check", type: "condition", config: { field: null, operator: null } },
    { id: "end", type: "end", config: {} },
  ],
  edges: [
    { id: "trigger_next", source: "trigger", target: "welcome", port: "next" },
    { id: "welcome_next", source: "welcome", target: "end", port: "next" },
  ],
};
const issue = (code, message, node_id, field, edge_id = null) => ({
  code,
  message,
  node_id,
  edge_id,
  field,
});

test("a blank email yields one named row per distinct setting, with the step named and the field attached", () => {
  const rows = describeWorkflowIssues(
    [
      issue(
        "incomplete_config",
        "Choose a value before running this workflow.",
        "node_3",
        "config.recipient",
      ),
      issue(
        "incomplete_config",
        "Enter email subject and body text.",
        "node_3",
        "config.subject_template",
      ),
      issue(
        "incomplete_config",
        "Enter email subject and body text.",
        "node_3",
        "config.body_template",
      ),
      issue(
        "invalid_outgoing_ports",
        "Connect each required output exactly once.",
        "node_3",
        "edges",
      ),
      issue("unreachable_node", "Connect this node to the trigger.", "node_3", "edges"),
      issue("no_path_to_end", "Connect this node to an end node.", "node_3", "edges"),
    ],
    graph,
    ["trigger", "welcome", "node_3", "check", "end"],
  );
  assert.deepEqual(
    rows.map((row) => [row.step, row.setting, row.field, row.message]),
    [
      ["Email 2", "Recipient", "recipient", "Choose who receives this email."],
      ["Email 2", "Subject", "subject_template", "Add a subject line."],
      ["Email 2", "Message", "body_template", "Write the message."],
      ["Email 2", null, null, "Connect this step to what comes next."],
      ["Email 2", null, null, "Not connected to the trigger yet."],
      ["Email 2", null, null, "No path from here to an end step."],
    ],
  );
  assert.equal(new Set(rows.map((row) => row.message)).size, rows.length);
  assert.ok(rows.every((row) => row.node_id === "node_3"));
});

test("repeated reports of one problem collapse into a single row with a count", () => {
  const rows = describeWorkflowIssues(
    [
      issue(
        "invalid_edge_port",
        "Use one edge for each output supported by this node.",
        "check",
        "port",
        "a",
      ),
      issue(
        "invalid_edge_port",
        "Use one edge for each output supported by this node.",
        "check",
        "port",
        "b",
      ),
      issue(
        "incomplete_config",
        "Choose a value before running this workflow.",
        "check",
        "config.field",
      ),
      issue(
        "incomplete_config",
        "Choose a value before running this workflow.",
        "check",
        "config.field",
      ),
    ],
    graph,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.count, row.setting, row.message]),
    [
      [2, null, "Use one edge for each output supported by this node."],
      [2, "Comparison field", "Choose a field to compare."],
    ],
  );
});

test("whole-workflow issues come first, connection issues select their source step, unknown codes keep the server's words", () => {
  const rows = describeWorkflowIssues(
    [
      issue(
        "cycle",
        "Remove the cycle before running this workflow.",
        null,
        "edges",
        "welcome_next",
      ),
      issue("mystery", "Something only the server knows.", "welcome", "config.reply_to_email"),
      issue("trigger_count", "Add exactly one trigger.", null, "nodes"),
      issue(
        "incomplete_config",
        "Choose a value before running this workflow.",
        "trigger",
        "config.event_type",
      ),
    ],
    graph,
    ["trigger", "welcome", "node_3", "check", "end"],
  );
  assert.deepEqual(
    rows.map((row) => [row.step, row.setting, row.message]),
    [
      [null, null, "Add exactly one trigger."],
      ["Trigger 1", "Trigger event", "Choose what starts this workflow."],
      ["Email 1", null, "Remove the loop. A step cannot lead back to an earlier step."],
      ["Email 1", "Reply-to email", "Something only the server knows."],
    ],
  );
  assert.equal(rows[2].node_id, "welcome");
  assert.equal(rows[3].field, "reply_to_email");
});

test("prototype-named steps and unknown steps are described without throwing", () => {
  const odd = {
    ...graph,
    nodes: [...graph.nodes, { id: "__proto__", type: "end", config: {} }],
  };
  const rows = describeWorkflowIssues(
    [
      issue("no_path_to_end", "Connect this node to an end node.", "__proto__", "edges"),
      issue("incomplete_config", "Choose a value.", "constructor", "config.minutes"),
    ],
    odd,
  );
  // An unknown step cannot be selected, so its row reads as a whole-workflow issue and sorts first.
  assert.equal(rows[0].node_id, null);
  assert.equal(rows[0].step, null);
  assert.equal(rows[0].message, "Choose a value.");
  // Named steps order alphabetically, and "__proto__" sorts before "end".
  assert.equal(rows[1].step, "End 1");
  assert.equal(rows[1].node_id, "__proto__");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acknowledgeWorkflowOperation,
  newWorkflowEditor,
  editWorkflowEditor,
  workflowEditorDirty,
  observeWorkflowDetail,
  workflowDraftAddress,
} from "../src/lib/automation-workflow-workspace-state.ts";
import { detail, ids, sizedRequest } from "./helpers/workflow-workspace-fixture.mjs";

test("save A acknowledges its baseline while later edit B and history remain dirty", () => {
  let editor = newWorkflowEditor({ kind: "workflow", id: ids.workflow }, undefined, detail());
  editor = editWorkflowEditor(editor, { kind: "metadata", name: "A" });
  const generation = editor.generation;
  editor = editWorkflowEditor(editor, { kind: "metadata", name: "B" });
  const result = detail({ name: "A", revision: 2 });
  const next = acknowledgeWorkflowOperation(
    editor,
    { command: "workflow.save", target: editor.target, result },
    result,
    generation,
  );
  assert.equal(next.name, "B");
  assert.equal(next.baseline.name, "A");
  assert.equal(next.baseline.revision, 2);
  assert.equal(workflowEditorDirty(next), true);
  assert.equal(next.history, editor.history);
});

test("reads expose newer server conflict without replacing local edits and older observations are ignored", () => {
  const editor = editWorkflowEditor(
    newWorkflowEditor({ kind: "workflow", id: ids.workflow }, undefined, detail()),
    { kind: "metadata", name: "Local" },
  );
  const newer = observeWorkflowDetail(editor, detail({ revision: 3, name: "Other editor" }));
  assert.equal(newer.conflict, true);
  assert.equal(newer.name, "Local");
  assert.equal(newer.baseline.revision, 1);
  assert.equal(observeWorkflowDetail(newer, detail({ revision: 2 })), newer);
});

test("oversized stored graph loads and can be repaired without imposing an HTTP byte limit", () => {
  const body = sizedRequest(1_048_577);
  const stored = detail({ draft_graph: body.graph, draft_layout: body.layout });
  const editor = newWorkflowEditor({ kind: "workflow", id: ids.workflow }, undefined, stored);
  const repaired = editWorkflowEditor(editor, { kind: "remove_node", node_id: "c0" });
  assert.equal(repaired.history.present.graph.nodes.length, 5);
  assert.equal(workflowDraftAddress(ids.draft), `/automations/new?draft=${ids.draft}`);
});

test("a local draft UUID cannot acknowledge an unrelated workflow with the same UUID", () => {
  const editor = editWorkflowEditor(
    newWorkflowEditor(
      { kind: "workflow", id: ids.draft },
      undefined,
      detail({ id: ids.draft, name: "Existing B", revision: 7 }),
    ),
    { kind: "metadata", name: "Local B content" },
  );
  const created = detail({ name: "Created A" });
  const operation = {
    command: "workflow.create",
    target: { kind: "draft", id: ids.draft },
    result: created,
  };
  assert.equal(acknowledgeWorkflowOperation(editor, operation, created, 1), editor);
  assert.equal(editor.workflowId, ids.draft);
  assert.equal(editor.baseline.id, ids.draft);
  assert.equal(editor.latest.id, ids.draft);
  assert.equal(editor.name, "Local B content");
});

test("acknowledgement retains exact draft targets and confirmed workflow aliases", () => {
  const created = detail({ name: "Created A" });
  const create = {
    command: "workflow.create",
    target: { kind: "draft", id: ids.draft },
    result: created,
  };
  const local = newWorkflowEditor(create.target);
  assert.equal(
    acknowledgeWorkflowOperation(local, create, created, local.generation).workflowId,
    created.id,
  );
  const server = newWorkflowEditor({ kind: "workflow", id: created.id }, undefined, created);
  assert.equal(
    acknowledgeWorkflowOperation(server, create, detail({ revision: 2 })).latest.revision,
    2,
  );
  const linked = acknowledgeWorkflowOperation(local, create, created, local.generation);
  const saved = detail({ revision: 2, name: "Saved A" });
  assert.equal(
    acknowledgeWorkflowOperation(
      linked,
      { command: "workflow.save", target: { kind: "workflow", id: created.id }, result: saved },
      saved,
      linked.generation,
    ).baseline.revision,
    2,
  );
});

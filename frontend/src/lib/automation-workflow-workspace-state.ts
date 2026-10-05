import {
  canonicalWorkflowDraft,
  createWorkflowHistory,
  editWorkflowHistory,
  initialWorkflowDraft,
  redoWorkflow,
  undoWorkflow,
  type WorkflowEdit,
  type WorkflowHistory,
} from "./automation-workflow-model.ts";
import type {
  WorkflowCatalogResponse,
  WorkflowCommand,
  WorkflowDetail,
  WorkflowDraft,
  WorkflowListResponse,
  WorkflowValidationResponse,
} from "./automation-workflow-types.ts";

export type WorkflowTarget = { kind: "workflow" | "draft"; id: string };
export const workflowTargetKey = (target: WorkflowTarget) => `${target.kind}:${target.id}`;
export const workflowDraftAddress = (id: string) =>
  `/automations/new?draft=${encodeURIComponent(id)}`;
export type WorkflowContent = WorkflowDraft & { name: string; description: string };
export type WorkflowEditor = {
  target: WorkflowTarget;
  workflowId: string | null;
  name: string;
  description: string;
  history: WorkflowHistory;
  generation: number;
  baseline: WorkflowDetail | null;
  latest: WorkflowDetail | null;
  conflict: boolean;
  validation: { generation: number; result: WorkflowValidationResponse } | null;
};
export type WorkflowOperationStatus =
  | "submitting"
  | "unknown"
  | "checking_receipt"
  | "committed_needs_detail"
  | "resolved"
  | "definitely_rejected";
export type WorkflowOperation = {
  operationId: string;
  command: WorkflowCommand;
  target: WorkflowTarget;
  status: WorkflowOperationStatus;
  locked: boolean;
  result: WorkflowDetail | null;
  error: string | null;
};
export type WorkflowReadKind =
  "catalog" | "list" | "detail" | "validation" | "receipt" | "current_detail";
export type WorkflowRead = { sequence: number; loading: boolean; error: string | null };
export type WorkflowWorkspaceState = {
  mode: "live" | "preview";
  accessible: boolean;
  editor: WorkflowEditor | null;
  catalog: WorkflowCatalogResponse | null;
  list: WorkflowListResponse | null;
  operations: Readonly<Record<string, WorkflowOperation>>;
  reads: Record<WorkflowReadKind, WorkflowRead>;
};
export function initialWorkflowWorkspace(mode: "live" | "preview"): WorkflowWorkspaceState {
  const read = () => ({ sequence: 0, loading: false, error: null });
  return {
    mode,
    accessible: true,
    editor: null,
    catalog: null,
    list: null,
    operations: {},
    reads: {
      catalog: read(),
      list: read(),
      detail: read(),
      validation: read(),
      receipt: read(),
      current_detail: read(),
    },
  };
}
export function workflowEditorContent(editor: WorkflowEditor): WorkflowContent {
  return {
    name: editor.name,
    description: editor.description,
    ...canonicalWorkflowDraft(editor.history.present),
  };
}
function content(detail: WorkflowDetail): WorkflowContent {
  return {
    name: detail.name,
    description: detail.description,
    ...canonicalWorkflowDraft({ graph: detail.draft_graph, layout: detail.draft_layout }),
  };
}
export function workflowEditorDirty(editor: WorkflowEditor): boolean {
  return (
    editor.baseline === null ||
    JSON.stringify(workflowEditorContent(editor)) !== JSON.stringify(content(editor.baseline))
  );
}
export function newWorkflowEditor(
  target: WorkflowTarget,
  input?: WorkflowContent,
  detail?: WorkflowDetail,
): WorkflowEditor {
  const draft =
    input ??
    (detail
      ? content(detail)
      : { name: "Untitled workflow", description: "", ...initialWorkflowDraft() });
  return {
    target,
    workflowId: detail?.id ?? null,
    name: draft.name,
    description: draft.description,
    history: createWorkflowHistory(draft),
    generation: 0,
    baseline: detail ?? null,
    latest: detail ?? null,
    conflict: false,
    validation: null,
  };
}
export function editWorkflowEditor(
  editor: WorkflowEditor,
  change:
    | WorkflowEdit
    | { kind: "metadata"; name?: string; description?: string }
    | { kind: "undo" }
    | { kind: "redo" },
): WorkflowEditor {
  let next = editor;
  if (change.kind === "metadata")
    next = {
      ...editor,
      name: change.name ?? editor.name,
      description: change.description ?? editor.description,
    };
  else if (change.kind === "undo" || change.kind === "redo")
    next = {
      ...editor,
      history: change.kind === "undo" ? undoWorkflow(editor.history) : redoWorkflow(editor.history),
    };
  else {
    const result = editWorkflowHistory(editor.history, change);
    if (!result.ok) throw new Error(result.reason);
    next = { ...editor, history: result.history };
  }
  if (
    next.history === editor.history &&
    next.name === editor.name &&
    next.description === editor.description
  )
    return editor;
  return { ...next, generation: editor.generation + 1, validation: null };
}
export function observeWorkflowDetail(
  editor: WorkflowEditor,
  detail: WorkflowDetail,
): WorkflowEditor {
  if (editor.workflowId !== detail.id || detail.revision < (editor.latest?.revision ?? 0))
    return editor;
  // Reading newer server data is an observation, never an implicit discard.
  return {
    ...editor,
    latest: detail,
    conflict:
      editor.conflict || (editor.baseline !== null && detail.revision > editor.baseline.revision),
  };
}
export function acknowledgeWorkflowOperation(
  editor: WorkflowEditor,
  operation: WorkflowOperation,
  current: WorkflowDetail,
  submittedGeneration?: number,
  restored = false,
): WorkflowEditor {
  if (
    (workflowTargetKey(editor.target) !== workflowTargetKey(operation.target) &&
      (operation.target.kind !== "workflow" || editor.workflowId !== operation.target.id) &&
      editor.workflowId !== operation.result?.id) ||
    !operation.result
  )
    return editor;
  const result = operation.result;
  if (current.id !== result.id || current.revision < result.revision) return editor;
  if (
    restored &&
    operation.command === "workflow.create" &&
    editor.baseline === null &&
    submittedGeneration === editor.generation
  ) {
    // Reload retained only an identity marker. An untouched placeholder has no local content to preserve.
    return {
      ...newWorkflowEditor(editor.target, undefined, current),
      generation: editor.generation,
    };
  }
  const saves = operation.command === "workflow.create" || operation.command === "workflow.save";
  const alreadyObserved = (editor.baseline?.revision ?? 0) > result.revision;
  const baseline = saves && !alreadyObserved ? result : editor.baseline;
  const changedElsewhere =
    current.revision > Math.max(result.revision, editor.baseline?.revision ?? 0);
  const mayAcknowledgeContent =
    saves && !alreadyObserved && !changedElsewhere && submittedGeneration === editor.generation;
  const draft = canonicalWorkflowDraft({ graph: result.draft_graph, layout: result.draft_layout });
  return {
    ...editor,
    workflowId: result.id,
    name: mayAcknowledgeContent ? result.name : editor.name,
    description: mayAcknowledgeContent ? result.description : editor.description,
    history: mayAcknowledgeContent
      ? { ...editor.history, present: createWorkflowHistory(draft).present }
      : editor.history,
    // Lifecycle results advance CAS authority without replacing local content.
    baseline: saves
      ? baseline
      : baseline
        ? {
            ...baseline,
            revision: Math.max(baseline.revision, result.revision),
            status: baseline.revision > result.revision ? baseline.status : result.status,
          }
        : null,
    latest: current,
    conflict: changedElsewhere,
  };
}
export function fenceWorkflowWorkspace(state: WorkflowWorkspaceState): WorkflowWorkspaceState {
  return { ...initialWorkflowWorkspace(state.mode), accessible: false };
}

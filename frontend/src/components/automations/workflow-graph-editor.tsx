"use client";

import dynamic from "next/dynamic";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  editWorkflow,
  nextWorkflowId,
  workflowNodeLabels,
  workflowPorts,
  workflowSteps,
} from "@/lib/automation-workflow-model";
import type {
  WorkflowEdit,
  WorkflowInsertion,
  WorkflowSnapshot,
} from "@/lib/automation-workflow-model";
import { describeWorkflowIssues } from "@/lib/automation-workflow-issues";
import type { ValidationIssue } from "@/lib/automation-workflow-types";
import {
  catalogEntry,
  workflowReferenceLabel,
  type WorkflowCatalogChoices,
  type WorkflowReferenceChoices,
} from "@/lib/automation-workflow-catalog";
import { WorkflowChecksPanel, type WorkflowChecks } from "./workflow-checks";
import {
  StepList,
  addKinds,
  kindLabels,
  makeNode,
  upcomingLabel,
  type AddKind,
  type NodeText,
  type SubmitEdit,
} from "./workflow-step-list";
import styles from "./workflow-graph-editor.module.css";

export type { WorkflowChecks } from "./workflow-checks";

const WorkflowCanvas = dynamic(() => import("./workflow-canvas"), {
  ssr: false,
  loading: () => (
    <div
      className={`${styles.canvas} koaryu-skeleton-reveal bg-surface-raised`}
      role="status"
      aria-label="Loading graph"
    >
      <span className="sr-only">Loading graph</span>
    </div>
  ),
});

export type WorkflowGraphEditorProps = {
  draft: WorkflowSnapshot;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onEdit: (edit: WorkflowEdit) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  disabled?: boolean;
  issues: ValidationIssue[];
  checks?: WorkflowChecks;
  /** Select a step and move focus to one of its settings, when settings are shown nearby. */
  onFocusField?: (nodeId: string, field: string) => void;
  presentation?: {
    readonly catalog: WorkflowCatalogChoices;
    readonly references?: WorkflowReferenceChoices;
  };
};

function nodeSummary(
  node: WorkflowSnapshot["graph"]["nodes"][number],
  presentation?: WorkflowGraphEditorProps["presentation"],
): string {
  const catalog = presentation?.catalog;
  const references = presentation?.references ?? {};
  const valueLabel = (value: unknown, field: string | null): string => {
    if (value === undefined) return "Choose a value";
    if (value === null) return "No value";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (Array.isArray(value)) return value.map((item) => valueLabel(item, field)).join(", ");
    if (typeof value !== "string") return String(value);
    const metadata = catalog ? catalogEntry(catalog.fields, field) : undefined;
    return (
      workflowReferenceLabel(references, field, value) ??
      (metadata?.value_type === "enum" && metadata.values?.includes(value)
        ? value.replaceAll("_", " ")
        : value)
    );
  };
  const operators: Record<string, string> = {
    eq: "Is",
    neq: "Is not",
    in: "Is one of",
    not_in: "Is not one of",
  };
  switch (node.type) {
    case "trigger":
      return (
        (catalog ? catalogEntry(catalog.triggers, node.config.event_type)?.label : undefined) ??
        node.config.event_type ??
        "Choose a trigger event"
      );
    case "condition":
      return node.config.field && node.config.operator
        ? presentation
          ? `${catalogEntry(catalog!.fields, node.config.field)?.label ?? node.config.field} ${catalogEntry(operators, node.config.operator) ?? node.config.operator} ${valueLabel(node.config.value, node.config.field)}`
          : `${node.config.field} ${node.config.operator} ${"value" in node.config ? JSON.stringify(node.config.value) : "Choose a value"}`
        : "Choose a field, comparison, and value";
    case "delay":
      return node.config.mode === "duration"
        ? node.config.minutes === null
          ? "Choose a duration"
          : `Wait ${node.config.minutes} minutes`
        : `Wait until ${(catalog ? catalogEntry(catalog.delay_fields, node.config.field)?.label : undefined) ?? node.config.field ?? "an event time"} (${node.config.offset_minutes} minutes)`;
    case "email":
      return node.config.subject_template || "Write an email subject";
    case "lead_follow_up":
      return node.config.due_in_days === null
        ? "Choose when to follow up"
        : `Follow up in ${node.config.due_in_days} days`;
    case "end":
      return "Finish this branch";
  }
}

export function WorkflowGraphEditor({
  draft,
  selectedNodeId,
  onSelectNode,
  onEdit,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  disabled = false,
  issues,
  checks,
  onFocusField,
  presentation,
}: WorkflowGraphEditorProps) {
  // Steps is the readable surface on every screen; Graph is the map, one tap away.
  const [view, setView] = useState<"steps" | "graph">("steps");
  const [addKind, setAddKind] = useState<AddKind>("email");
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const undo = () => {
    setNotice({ message: "Undid the last change.", error: false });
    onUndo();
  };
  const redo = () => {
    setNotice({ message: "Redid the last change.", error: false });
    onRedo();
  };
  const root = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const kindId = useId();
  const headingId = useId();
  const text = useMemo<NodeText>(() => {
    const labels = workflowNodeLabels(draft.graph);
    return Object.fromEntries(
      draft.graph.nodes.map((node) => [
        node.id,
        { label: labels[node.id], summary: nodeSummary(node, presentation) },
      ]),
    );
  }, [draft.graph, presentation]);
  const steps = useMemo(() => workflowSteps(draft.graph), [draft.graph]);
  const rows = useMemo(
    () =>
      describeWorkflowIssues(
        issues,
        draft.graph,
        steps.map(({ node }) => node.id),
      ),
    [issues, draft.graph, steps],
  );
  const triggerCount = draft.graph.nodes.filter((node) => node.type === "trigger").length;
  const selected = draft.graph.nodes.find(({ id }) => id === selectedNodeId);
  // A selected step with one outgoing path takes new steps right after it.
  const anchor: WorkflowInsertion | null =
    selected && workflowPorts(selected.type).length === 1
      ? { node_id: selected.id, port: "next" }
      : null;
  const anchorContinues =
    anchor !== null &&
    draft.graph.edges.some((edge) => edge.source === anchor.node_id && edge.port === anchor.port);
  // The toolbar offers only what can be added here: one trigger, and no end between steps.
  const availableKinds = addKinds.filter(
    (kind) => (kind !== "trigger" || triggerCount === 0) && (kind !== "end" || !anchorContinues),
  );
  const effectiveKind = availableKinds.includes(addKind) ? addKind : "email";
  const submit = useCallback<SubmitEdit>(
    (edit, message) => {
      if (disabled) return false;
      const checked = editWorkflow(draft, edit);
      if (!checked.ok) {
        setNotice({ message: checked.reason, error: true });
        return false;
      }
      if (checked.changed) onEdit(edit);
      setNotice(message ? { message, error: false } : null);
      return true;
    },
    [disabled, draft, onEdit],
  );
  const addStep = () => {
    const node = makeNode(effectiveKind, nextWorkflowId(draft.graph, "node"));
    const label = upcomingLabel(draft.graph, node.type);
    const added =
      anchor && node.type !== "trigger"
        ? submit(
            { kind: "insert_node", node, after: anchor },
            `Added ${label} after ${text[anchor.node_id].label}.`,
          )
        : submit({ kind: "add_node", node }, `Added ${label}.`);
    if (added) onSelectNode(node.id);
  };
  const removeNode = useCallback(
    (id: string) => {
      if (
        submit(
          { kind: "remove_node", node_id: id },
          `Deleted ${text[id]?.label ?? "step"} and its connections.`,
        )
      ) {
        if (selectedNodeId === id) onSelectNode(null);
        addButton.current?.focus();
      }
    },
    [submit, text, selectedNodeId, onSelectNode],
  );
  const canvasEdit = useCallback(
    (edit: WorkflowEdit) => {
      const message =
        edit.kind === "connect"
          ? `Connected ${edit.edge.port} from ${text[edit.edge.source]?.label ?? "Missing step"} to ${text[edit.edge.target]?.label ?? "Missing step"}.`
          : edit.kind === "disconnect"
            ? "Connection removed."
            : undefined;
      return submit(edit, message);
    },
    [submit, text],
  );
  const reportError = useCallback((message: string) => setNotice({ message, error: true }), []);
  const handleKey = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.isContentEditable || target.closest("input, textarea, select")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (!disabled && event.shiftKey && canRedo) redo();
      else if (!disabled && !event.shiftKey && canUndo) undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      if (!disabled && canRedo) redo();
    }
  };
  const focusIssue = (id: string, field: string | null) => {
    onSelectNode(id);
    if (field && onFocusField) {
      onFocusField(id, field);
      return;
    }
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLElement>(
          view === "graph" ? `[data-testid="rf__node-${id}"]` : `[data-workflow-step="${id}"]`,
        )
        ?.focus(),
    );
  };
  return (
    <section
      ref={root}
      className={styles.editor}
      aria-labelledby={headingId}
      onKeyDown={handleKey}
      data-workflow-view={view}
    >
      <div className={styles.heading}>
        <h2 id={headingId}>Workflow steps</h2>
        <div className={styles.viewToggle} role="group" aria-label="Editor view">
          <button type="button" aria-pressed={view === "steps"} onClick={() => setView("steps")}>
            Steps
          </button>
          <button type="button" aria-pressed={view === "graph"} onClick={() => setView("graph")}>
            Graph
          </button>
        </div>
      </div>
      <div className={styles.toolbar} aria-label="Workflow actions">
        <div className={styles.addControl}>
          <label htmlFor={kindId}>Step type</label>
          <select
            id={kindId}
            value={effectiveKind}
            disabled={disabled}
            onChange={(event) => setAddKind(event.target.value as AddKind)}
          >
            {availableKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kindLabels[kind]}
              </option>
            ))}
          </select>
          <button ref={addButton} type="button" disabled={disabled} onClick={addStep}>
            Add step
          </button>
          {anchor && effectiveKind !== "trigger" ? (
            <span className={styles.addHint}>after {text[anchor.node_id].label}</span>
          ) : null}
        </div>
        <button
          type="button"
          disabled={disabled || !selected || (selected.type === "trigger" && triggerCount === 1)}
          onClick={() => selected && removeNode(selected.id)}
        >
          Delete selected step
        </button>
        {view === "graph" ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => submit({ kind: "auto_layout" }, "Steps arranged automatically.")}
          >
            Auto layout
          </button>
        ) : null}
        <button type="button" disabled={disabled || !canUndo} onClick={undo}>
          Undo
        </button>
        <button type="button" disabled={disabled || !canRedo} onClick={redo}>
          Redo
        </button>
      </div>
      <div
        className={styles.notice}
        role={notice?.error ? "alert" : "status"}
        aria-live={notice?.error ? "assertive" : "polite"}
      >
        {notice?.message ?? ""}
      </div>
      <WorkflowChecksPanel rows={rows} checks={checks} onFocusIssue={focusIssue} />
      {view === "graph" ? (
        <WorkflowCanvas
          draft={draft}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          onEdit={canvasEdit}
          onDeleteNode={removeNode}
          onError={reportError}
          disabled={disabled}
          text={text}
          issues={issues}
        />
      ) : (
        <StepList
          draft={draft}
          steps={steps}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          disabled={disabled}
          submit={submit}
          text={text}
          issues={issues}
        />
      )}
    </section>
  );
}

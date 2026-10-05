"use client";

import dynamic from "next/dynamic";
import { useCallback, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";
import {
  defaultWorkflowConfig,
  editWorkflow,
  nextWorkflowId,
  workflowPorts,
  workflowSteps,
} from "@/lib/automation-workflow-model";
import type { WorkflowEdit, WorkflowSnapshot } from "@/lib/automation-workflow-model";
import type {
  ValidationIssue,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowPort,
} from "@/lib/automation-workflow-types";
import styles from "./workflow-graph-editor.module.css";

const WorkflowCanvas = dynamic(() => import("./workflow-canvas"), {
  ssr: false,
  loading: () => <p role="status">Loading graph…</p>,
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
};

const kindLabels: Record<WorkflowNodeType, string> = {
  trigger: "Trigger",
  condition: "Condition",
  delay: "Delay",
  email: "Email",
  lead_follow_up: "Lead follow-up",
  end: "End",
};
const addKinds = ["trigger", "condition", "delay", "email", "lead_follow_up", "end"] as const;
type AddKind = (typeof addKinds)[number];
const subscribeWidth = (listener: () => void) => {
  const media = window.matchMedia("(min-width: 768px)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
};
const desktopWidth = () => window.matchMedia("(min-width: 768px)").matches;
const serverWidth = () => false;

function nodeSummary(node: WorkflowSnapshot["graph"]["nodes"][number]): string {
  switch (node.type) {
    case "trigger":
      return node.config.event_type ?? "Choose a trigger event";
    case "condition":
      return node.config.field && node.config.operator
        ? `${node.config.field} ${node.config.operator} ${"value" in node.config ? JSON.stringify(node.config.value) : "Choose a value"}`
        : "Choose a field, comparison, and value";
    case "delay":
      return node.config.mode === "duration"
        ? node.config.minutes === null
          ? "Choose a duration"
          : `Wait ${node.config.minutes} minutes`
        : `Wait until ${node.config.field ?? "an event time"} (${node.config.offset_minutes} minutes)`;
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

function makeNode(type: AddKind, id: string): WorkflowNode {
  switch (type) {
    case "trigger":
      return { id, type, config: defaultWorkflowConfig(type) };
    case "condition":
      return { id, type, config: defaultWorkflowConfig(type) };
    case "delay":
      return { id, type, config: defaultWorkflowConfig(type) };
    case "email":
      return { id, type, config: defaultWorkflowConfig(type) };
    case "lead_follow_up":
      return { id, type, config: defaultWorkflowConfig(type) };
    case "end":
      return { id, type, config: defaultWorkflowConfig(type) };
  }
}

type SubmitEdit = (edit: WorkflowEdit, message?: string) => boolean;
type NodeText = Record<string, { label: string; summary: string }>;

function PortControl({
  draft,
  source,
  port,
  text,
  disabled,
  submit,
}: {
  draft: WorkflowSnapshot;
  source: string;
  port: WorkflowPort;
  text: NodeText;
  disabled: boolean;
  submit: SubmitEdit;
}) {
  const [candidate, setCandidate] = useState("");
  const selectId = useId();
  const connections = draft.graph.edges.filter(
    (edge) => edge.source === source && edge.port === port,
  );
  const targets = useMemo(
    () =>
      draft.graph.nodes.filter(
        (node) =>
          editWorkflow(draft, {
            kind: "connect",
            edge: { id: nextWorkflowId(draft.graph, "edge"), source, target: node.id, port },
          }).ok,
      ),
    [draft, source, port],
  );
  const target = targets.some(({ id }) => id === candidate) ? candidate : "";
  return (
    <div className={styles.port}>
      {connections.length ? (
        connections.map((edge) => (
          <div className={styles.connection} key={edge.id}>
            <span>
              <strong>{port}</strong> → {text[edge.target]?.label ?? "Missing step"}
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                submit(
                  { kind: "disconnect", edge_id: edge.id },
                  `Disconnected ${port} from ${text[source].label}.`,
                )
              }
              aria-label={`Disconnect ${port} from ${text[source].label}`}
            >
              Disconnect
            </button>
          </div>
        ))
      ) : (
        <>
          <label htmlFor={selectId}>
            {port} destination for {text[source].label}
          </label>
          <div className={styles.connection}>
            <select
              id={selectId}
              value={target}
              disabled={disabled || targets.length === 0}
              onChange={(event) => setCandidate(event.target.value)}
            >
              <option value="">
                {targets.length ? "Choose a step" : "No available destination"}
              </option>
              {targets.map((node) => (
                <option key={node.id} value={node.id}>
                  {text[node.id].label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={disabled || !target}
              aria-label={`Connect ${port} from ${text[source].label}`}
              onClick={() => {
                if (
                  submit(
                    {
                      kind: "connect",
                      edge: { id: nextWorkflowId(draft.graph, "edge"), source, target, port },
                    },
                    `Connected ${port} from ${text[source].label} to ${text[target].label}.`,
                  )
                )
                  setCandidate("");
              }}
            >
              Connect
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function StepList({
  draft,
  selectedNodeId,
  onSelectNode,
  disabled,
  submit,
  text,
  issues,
}: {
  draft: WorkflowSnapshot;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  disabled: boolean;
  submit: SubmitEdit;
  text: NodeText;
  issues: ValidationIssue[];
}) {
  const steps = useMemo(() => workflowSteps(draft.graph), [draft.graph]);
  return (
    <div>
      <p className={styles.help}>
        Each step appears once. Branch destinations show where the workflow continues.
      </p>
      <ol className={styles.steps} aria-label="Workflow steps">
        {steps.map(({ node }) => (
          <li key={node.id} className={styles.step} data-selected={selectedNodeId === node.id}>
            <button
              type="button"
              className={styles.stepSelect}
              data-workflow-step={node.id}
              aria-pressed={selectedNodeId === node.id}
              onClick={() => onSelectNode(node.id)}
            >
              <strong>{text[node.id].label}</strong>
              <span>{text[node.id].summary}</span>
            </button>
            {issues.some(
              (issue) =>
                issue.node_id === node.id ||
                draft.graph.edges.some(
                  (edge) => edge.id === issue.edge_id && edge.source === node.id,
                ),
            ) ? (
              <p className={styles.issueBadge}>Needs attention</p>
            ) : null}
            {workflowPorts(node.type).map((port) => (
              <PortControl
                key={port}
                draft={draft}
                source={node.id}
                port={port}
                text={text}
                disabled={disabled}
                submit={submit}
              />
            ))}
          </li>
        ))}
      </ol>
      {draft.graph.edges
        .filter((edge) => {
          const source = draft.graph.nodes.find((node) => node.id === edge.source);
          return !source || !workflowPorts(source.type).includes(edge.port);
        })
        .map((edge) => (
          <div className={styles.port} key={edge.id}>
            <p>
              Unattached connection: {edge.port} → {text[edge.target]?.label ?? "Missing step"}
            </p>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                submit({ kind: "disconnect", edge_id: edge.id }, "Removed unattached connection.")
              }
            >
              Remove unattached connection
            </button>
          </div>
        ))}
    </div>
  );
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
}: WorkflowGraphEditorProps) {
  const wide = useSyncExternalStore(subscribeWidth, desktopWidth, serverWidth);
  const [choice, setChoice] = useState<"graph" | "steps" | null>(null);
  const view = choice ?? (wide ? "graph" : "steps");
  const [addKind, setAddKind] = useState<AddKind>("email");
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const root = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const kindId = useId();
  const headingId = useId();
  const text = useMemo(() => {
    const counts = new Map<WorkflowNodeType, number>();
    return Object.fromEntries(
      [...draft.graph.nodes]
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .map((node) => {
          const ordinal = (counts.get(node.type) ?? 0) + 1;
          counts.set(node.type, ordinal);
          return [
            node.id,
            { label: `${kindLabels[node.type]} ${ordinal}`, summary: nodeSummary(node) },
          ];
        }),
    );
  }, [draft.graph.nodes]);
  const triggerCount = draft.graph.nodes.filter((node) => node.type === "trigger").length;
  const availableKinds = addKinds.filter((kind) => kind !== "trigger" || triggerCount === 0);
  const effectiveKind = addKind === "trigger" && triggerCount > 0 ? "email" : addKind;
  const selected = draft.graph.nodes.find(({ id }) => id === selectedNodeId);
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
      if (!disabled && event.shiftKey && canRedo) onRedo();
      else if (!disabled && !event.shiftKey && canUndo) onUndo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      if (!disabled && canRedo) onRedo();
    }
  };
  const focusIssue = (id: string) => {
    onSelectNode(id);
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLElement>(
          view === "graph" ? `[data-testid="rf__node-${id}"]` : `[data-workflow-step="${id}"]`,
        )
        ?.focus(),
    );
  };
  return (
    <section ref={root} className={styles.editor} aria-labelledby={headingId} onKeyDown={handleKey}>
      <div className={styles.heading}>
        <h2 id={headingId}>Workflow structure</h2>
        <div className={styles.viewToggle} aria-label="Editor view">
          <button type="button" aria-pressed={view === "graph"} onClick={() => setChoice("graph")}>
            Graph
          </button>
          <button type="button" aria-pressed={view === "steps"} onClick={() => setChoice("steps")}>
            Steps
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
          <button
            ref={addButton}
            type="button"
            disabled={disabled}
            onClick={() => {
              const node = makeNode(effectiveKind, nextWorkflowId(draft.graph, "node"));
              if (submit({ kind: "add_node", node }, `Added ${kindLabels[node.type]}.`))
                onSelectNode(node.id);
            }}
          >
            Add step
          </button>
        </div>
        <button
          type="button"
          disabled={disabled || !selected || (selected.type === "trigger" && triggerCount === 1)}
          onClick={() => selected && removeNode(selected.id)}
        >
          Delete selected step
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => submit({ kind: "auto_layout" }, "Steps arranged automatically.")}
        >
          Auto layout
        </button>
        <button type="button" disabled={disabled || !canUndo} onClick={onUndo}>
          Undo
        </button>
        <button type="button" disabled={disabled || !canRedo} onClick={onRedo}>
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
      {issues.length ? (
        <div className={styles.issues} aria-label="Workflow validation issues">
          <p>Review these workflow issues:</p>
          <ul>
            {issues.map((issue, index) => {
              const nodeId =
                issue.node_id ??
                draft.graph.edges.find((edge) => edge.id === issue.edge_id)?.source;
              return (
                <li key={`${issue.code}-${index}`}>
                  {nodeId && Object.hasOwn(text, nodeId) ? (
                    <button type="button" onClick={() => focusIssue(nodeId)}>
                      {text[nodeId].label}
                      {issue.edge_id ? ` · connection ${issue.edge_id}` : ""}: {issue.message}
                    </button>
                  ) : (
                    <span>{issue.message}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
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
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          disabled={disabled}
          submit={submit}
          text={text}
          issues={issues}
        />
      )}
      {selected ? (
        <p className={styles.selectedText}>
          <strong>Selected: {text[selected.id].label}.</strong> {text[selected.id].summary}
        </p>
      ) : null}
    </section>
  );
}

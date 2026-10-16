"use client";

import dynamic from "next/dynamic";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  WORKFLOW_KIND_LABELS,
  defaultWorkflowConfig,
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
import type {
  ValidationIssue,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowPort,
} from "@/lib/automation-workflow-types";
import {
  catalogEntry,
  workflowReferenceLabel,
  type WorkflowCatalogChoices,
  type WorkflowReferenceChoices,
} from "@/lib/automation-workflow-catalog";
import styles from "./workflow-graph-editor.module.css";

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

/** What the workspace knows about server checks; absent when checks are unavailable. */
export type WorkflowChecks = {
  loading: boolean;
  error: boolean;
  /** The last check passed and the draft has not changed since. */
  passed: boolean;
  onCheck?: () => void;
};

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

const kindLabels = WORKFLOW_KIND_LABELS;
const addKinds = ["trigger", "condition", "delay", "email", "lead_follow_up", "end"] as const;
type AddKind = (typeof addKinds)[number];
const insertKinds = ["email", "delay", "condition", "lead_follow_up", "end"] as const;
const portWords: Record<WorkflowPort, string> = { next: "Then", yes: "Yes", no: "No" };

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

/** The name a step of this kind will get when added now: the next number of its kind. */
function upcomingLabel(graph: WorkflowSnapshot["graph"], type: WorkflowNodeType): string {
  return `${kindLabels[type]} ${graph.nodes.filter((node) => node.type === type).length + 1}`;
}

type SubmitEdit = (edit: WorkflowEdit, message?: string) => boolean;
type NodeText = Record<string, { label: string; summary: string }>;

/** Inserts a step after one port in one operation; the surrounding route stays connected. */
function InsertControl({
  draft,
  after,
  anchorLabel,
  connected,
  disabled,
  submit,
  onInserted,
}: {
  draft: WorkflowSnapshot;
  after: WorkflowInsertion;
  anchorLabel: string;
  connected: boolean;
  disabled: boolean;
  submit: SubmitEdit;
  onInserted: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const groupId = useId();
  const verb = connected ? "Insert" : "Add";
  const where = `after ${anchorLabel} (${portWords[after.port]})`;
  const kinds = insertKinds.filter((kind) => !connected || kind !== "end");
  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  return (
    <div className={styles.insert}>
      <button
        ref={toggle}
        type="button"
        className={styles.insertToggle}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={open ? groupId : undefined}
        aria-label={`${verb} step ${where}`}
        onClick={() => setOpen((value) => !value)}
      >
        {connected ? "Insert step" : "Add step here"}
      </button>
      {open ? (
        <div
          id={groupId}
          role="group"
          aria-label={`Step to ${verb.toLowerCase()} ${where}`}
          className={styles.insertKinds}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              data-kind={kind}
              onClick={() => {
                const node = makeNode(kind, nextWorkflowId(draft.graph, "node"));
                if (
                  submit(
                    { kind: "insert_node", node, after },
                    `${connected ? "Inserted" : "Added"} ${upcomingLabel(draft.graph, kind)} after ${anchorLabel}.`,
                  )
                ) {
                  setOpen(false);
                  onInserted(node.id);
                }
              }}
            >
              {kindLabels[kind]}
            </button>
          ))}
          <button type="button" data-variant="quiet" onClick={close}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PortControl({
  draft,
  source,
  port,
  text,
  disabled,
  submit,
  onInserted,
}: {
  draft: WorkflowSnapshot;
  source: string;
  port: WorkflowPort;
  text: NodeText;
  disabled: boolean;
  submit: SubmitEdit;
  onInserted: (id: string) => void;
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
  const label = text[source].label;
  const after: WorkflowInsertion = { node_id: source, port };
  return (
    <div className={styles.port} data-port={port}>
      {connections.length ? (
        connections.map((edge) => (
          <div className={styles.connection} key={edge.id}>
            <span className={styles.route}>
              <strong>{portWords[port]}</strong>
              <span aria-hidden="true"> → </span>
              <span className={styles.srOnly}> goes to </span>
              {text[edge.target]?.label ?? "Missing step"}
            </span>
            <InsertControl
              draft={draft}
              after={after}
              anchorLabel={label}
              connected
              disabled={disabled || connections.length > 1}
              submit={submit}
              onInserted={onInserted}
            />
            <button
              type="button"
              data-variant="quiet"
              disabled={disabled}
              onClick={() =>
                submit(
                  { kind: "disconnect", edge_id: edge.id },
                  `Disconnected ${port} from ${label}.`,
                )
              }
              aria-label={`Disconnect ${port} from ${label}`}
            >
              Disconnect
            </button>
          </div>
        ))
      ) : (
        <div className={styles.connection}>
          <span className={styles.route}>
            <strong>{portWords[port]}</strong>
            <span aria-hidden="true"> → </span>
          </span>
          <select
            id={selectId}
            aria-label={`${port} destination for ${label}`}
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
            aria-label={`Connect ${port} from ${label}`}
            onClick={() => {
              if (
                submit(
                  {
                    kind: "connect",
                    edge: { id: nextWorkflowId(draft.graph, "edge"), source, target, port },
                  },
                  `Connected ${port} from ${label} to ${text[target].label}.`,
                )
              )
                setCandidate("");
            }}
          >
            Connect
          </button>
          <InsertControl
            draft={draft}
            after={after}
            anchorLabel={label}
            connected={false}
            disabled={disabled}
            submit={submit}
            onInserted={onInserted}
          />
        </div>
      )}
    </div>
  );
}

function StepList({
  draft,
  steps,
  selectedNodeId,
  onSelectNode,
  disabled,
  submit,
  text,
  issues,
}: {
  draft: WorkflowSnapshot;
  steps: ReturnType<typeof workflowSteps>;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  disabled: boolean;
  submit: SubmitEdit;
  text: NodeText;
  issues: ValidationIssue[];
}) {
  return (
    <div>
      <p className={styles.help}>
        Steps run from the trigger down, and each one says where it goes next. Select a step to
        change its settings. Use Insert step to add one between two steps.
      </p>
      <ol className={styles.steps} aria-label="Workflow steps">
        {steps.map(({ node }) => (
          <li
            key={node.id}
            className={styles.step}
            data-kind={node.type}
            data-selected={selectedNodeId === node.id}
          >
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
                onInserted={onSelectNode}
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
  const availableKinds = addKinds.filter((kind) => kind !== "trigger" || triggerCount === 0);
  const effectiveKind = addKind === "trigger" && triggerCount > 0 ? "email" : addKind;
  const selected = draft.graph.nodes.find(({ id }) => id === selectedNodeId);
  // A selected step with one outgoing path takes new steps right after it.
  const anchor: WorkflowInsertion | null =
    selected && workflowPorts(selected.type).length === 1
      ? { node_id: selected.id, port: "next" }
      : null;
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
  const checksState = rows.length
    ? "issues"
    : checks?.loading
      ? "loading"
      : checks?.error
        ? "error"
        : checks?.passed
          ? "passed"
          : "idle";
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
        <button
          type="button"
          disabled={disabled}
          onClick={() => submit({ kind: "auto_layout" }, "Steps arranged automatically.")}
        >
          Auto layout
        </button>
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
      {checks || rows.length ? (
        <section className={styles.checks} aria-label="Workflow checks" data-state={checksState}>
          <div className={styles.checksHead}>
            <h3>Workflow checks</h3>
            {rows.length ? (
              <span className={styles.checksTag} data-tone="warn">
                {rows.length} to fix
              </span>
            ) : checks?.passed ? (
              <span className={styles.checksTag} data-tone="calm">
                Passed
              </span>
            ) : null}
            {checks?.onCheck ? (
              <button
                type="button"
                className={styles.checkButton}
                disabled={checks.loading}
                onClick={checks.onCheck}
              >
                Check workflow
              </button>
            ) : null}
          </div>
          {checks?.loading ? <p role="status">Checking the workflow...</p> : null}
          {checks?.error ? (
            <p role="alert">Checks could not be completed. Try Check workflow again.</p>
          ) : null}
          {rows.length ? (
            <ul className={styles.issueRows}>
              {rows.map((row) => (
                <li key={row.key}>
                  {row.node_id ? (
                    <button type="button" onClick={() => focusIssue(row.node_id!, row.field)}>
                      <span className={styles.issueWhere}>
                        <strong>{row.step}</strong>
                        {row.setting ? ` · ${row.setting}` : ""}
                      </span>
                      <span className={styles.issueWhat}>
                        {row.message}
                        {row.count > 1 ? ` (${row.count})` : ""}
                      </span>
                    </button>
                  ) : (
                    <span className={styles.issueWhat}>{row.message}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : checks && !checks.loading && !checks.error ? (
            <p>
              {checks.passed
                ? "Every step is complete and connected."
                : checks.onCheck
                  ? "Save an incomplete draft at any time. Check the workflow before publishing."
                  : "Checks run in your live studio."}
            </p>
          ) : null}
        </section>
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

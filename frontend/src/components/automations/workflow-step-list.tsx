"use client";

import { useId, useMemo, useRef, useState } from "react";
import {
  WORKFLOW_KIND_LABELS,
  defaultWorkflowConfig,
  editWorkflow,
  nextWorkflowId,
  workflowPorts,
  workflowSteps,
} from "@/lib/automation-workflow-model";
import type {
  WorkflowEdit,
  WorkflowInsertion,
  WorkflowSnapshot,
} from "@/lib/automation-workflow-model";
import type {
  ValidationIssue,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowPort,
} from "@/lib/automation-workflow-types";
import styles from "./workflow-graph-editor.module.css";

/*
 * Steps view: the readable surface of the editor. One card per step, in order from the
 * trigger, each naming where it goes next and offering to add a step right there.
 */

export const kindLabels = WORKFLOW_KIND_LABELS;
export const addKinds = [
  "trigger",
  "condition",
  "delay",
  "email",
  "lead_follow_up",
  "end",
] as const;
export type AddKind = (typeof addKinds)[number];
const insertKinds = ["email", "delay", "condition", "lead_follow_up", "end"] as const;
export const portWords: Record<WorkflowPort, string> = { next: "Then", yes: "Yes", no: "No" };

/** Applies an edit through the editor; returns whether it was accepted. */
export type SubmitEdit = (edit: WorkflowEdit, message?: string) => boolean;
export type NodeText = Record<string, { label: string; summary: string }>;

export function makeNode(type: AddKind, id: string): WorkflowNode {
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
export function upcomingLabel(graph: WorkflowSnapshot["graph"], type: WorkflowNodeType): string {
  return `${kindLabels[type]} ${graph.nodes.filter((node) => node.type === type).length + 1}`;
}

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
  // An end can only close an open path; it cannot sit between two steps.
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

export function StepList({
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
        Start at the trigger and follow Then, Yes or No to the next step. Select a step to change
        its settings. Insert step adds one in between.
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

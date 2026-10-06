"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import type {
  WorkflowActivity,
  WorkflowActivityRead,
} from "@/lib/automation-workflow-activity-state";
import type {
  WorkflowCatalogResponse,
  WorkflowGraph,
  WorkflowSimulationResponse,
} from "@/lib/automation-workflow-types";
import {
  WorkflowSimulationContextPicker,
  type WorkflowSimulationSelection,
} from "./workflow-simulation-context-picker";
import styles from "./workflow-workspace.module.css";

export type WorkflowSimulationPanelProps = {
  activity: WorkflowActivity;
  workflowId: string | null;
  graph: WorkflowGraph;
  catalog: WorkflowCatalogResponse | null;
  selection: WorkflowSimulationSelection | null;
  onSelectionChange(value: WorkflowSimulationSelection | null): void;
  onSelectNode(nodeId: string): void;
  isCurrent(): boolean;
  preview: boolean;
};
type Simulation = {
  read: Extract<WorkflowActivityRead<WorkflowSimulationResponse>, { status: "ready" }>;
  selection: WorkflowSimulationSelection;
};

const activityTimeFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "long",
  timeZone: "UTC",
});
const activityTime = (value: string) => (
  <time dateTime={value} title={value}>
    {activityTimeFormat.format(new Date(value))}
  </time>
);
const plainReason = (value: string) => value.replaceAll("_", " ");

export function WorkflowSimulationPanel({
  activity,
  workflowId,
  graph,
  catalog,
  selection,
  onSelectionChange,
  onSelectNode,
  isCurrent,
  preview,
}: WorkflowSimulationPanelProps) {
  const [result, setResult] = useState<Simulation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serial = useRef(0);
  const active = useRef(true);
  const latest = useRef({ selection, isCurrent });
  useLayoutEffect(() => {
    latest.current = { selection, isCurrent };
  });
  useEffect(() => {
    active.current = true;
    const counter = serial;
    return () => {
      active.current = false;
      counter.current++;
    };
  }, []);
  const triggers = graph.nodes.filter((node) => node.type === "trigger");
  const trigger = triggers.length === 1 ? triggers[0] : null;
  const event = trigger?.config.event_type;
  const metadata =
    event && catalog && Object.hasOwn(catalog.triggers, event) ? catalog.triggers[event] : null;
  const simulate = async () => {
    if (preview || !workflowId || !selection || !selection.isCurrent() || !isCurrent() || loading)
      return;
    const request = ++serial.current,
      captured = selection;
    const current = () =>
      active.current &&
      serial.current === request &&
      latest.current.isCurrent() &&
      latest.current.selection === captured &&
      captured.isCurrent();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const read = await activity.simulate(workflowId, graph, captured.context);
      if (current() && read.status === "ready" && read.isCurrent())
        setResult({ read, selection: captured });
    } catch (failure) {
      if (current())
        setError(
          failure instanceof ApiError && failure.status === 404
            ? "This record is unavailable. Choose another record and try again."
            : "Simulation could not be read. Check access and try again. No sample was sent.",
        );
    } finally {
      if (active.current && serial.current === request) setLoading(false);
    }
  };
  const output =
    result &&
    result.selection === selection &&
    result.selection.isCurrent() &&
    result.read.isCurrent() &&
    isCurrent()
      ? result.read.value
      : null;
  const nodeLabel = (id: string) => {
    const node = graph.nodes.find((item) => item.id === id);
    if (node?.type === "trigger") return metadata?.label || "Trigger";
    return node ? node.type.replaceAll("_", " ") : id;
  };
  const waiting = output?.trace.find((step) => step.outcome === "waiting");
  return (
    <section className={`${styles.sheet} ${styles.toolPanel}`} aria-label="Workflow simulation">
      <h2>Simulate workflow</h2>
      <p>Walk through the current graph without sending email or creating follow-ups.</p>
      {preview ? (
        <p className={styles.notice}>
          Simulation is available in your live studio. Preview uses sample workflows and does not
          load activity or customer records.
        </p>
      ) : (
        <>
          <WorkflowSimulationContextPicker
            entityType={metadata?.simulation_entity_type ?? null}
            value={selection}
            onChange={onSelectionChange}
            isCurrent={isCurrent}
            disabled={!workflowId || !isCurrent()}
          />
          {!workflowId ? <p>Save this workflow before simulating it.</p> : null}
          <div className={styles.actions}>
            <button
              disabled={
                !workflowId || !selection || !selection.isCurrent() || loading || !isCurrent()
              }
              onClick={() => void simulate()}
            >
              Simulate
            </button>
          </div>
        </>
      )}
      {loading ? <p role="status">Reading the current graph...</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {result && !output ? (
        <p role="status">
          The previous simulation is no longer current. Simulate again to review this graph and
          context.
        </p>
      ) : null}
      {output ? (
        <div className={styles.toolStack}>
          <p>Reference time: {activityTime(output.reference_time)}</p>
          <p>
            {output.valid
              ? "Graph checks passed for this simulation."
              : "This graph needs changes before it can run."}
          </p>
          {output.issues.length ? (
            <ul>
              {output.issues.map((issue, index) => (
                <li key={index}>
                  {issue.node_id ? (
                    <button onClick={() => onSelectNode(issue.node_id!)}>{issue.message}</button>
                  ) : (
                    issue.message
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          <h3>Visited path</h3>
          <ol className={styles.trace}>
            {output.trace.map((step, index) => {
              const edge = graph.edges.find((item) => item.id === step.edge_id);
              return (
                <li key={`${step.node_id}:${index}`}>
                  <button onClick={() => onSelectNode(step.node_id)}>
                    {nodeLabel(step.node_id)} · {step.outcome.replaceAll("_", " ")}
                  </button>
                  {step.edge_id ? <p>Selected branch: {edge?.port ?? step.edge_id}</p> : null}
                  {step.reason ? <p>Reason: {plainReason(step.reason)}</p> : null}
                  {step.scheduled_at ? <p>Scheduled: {activityTime(step.scheduled_at)}</p> : null}
                  {step.rendered_subject !== null ? (
                    <div className={styles.sampleText}>
                      <strong>Subject</strong>
                      <p>{step.rendered_subject}</p>
                    </div>
                  ) : null}
                  {step.rendered_body !== null ? (
                    <div className={styles.sampleText}>
                      <strong>Body</strong>
                      <pre>{step.rendered_body}</pre>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {waiting ? (
            <p className={styles.notice}>
              The trace stops at the first wait.
              {waiting.scheduled_at ? (
                <> Scheduled for {activityTime(waiting.scheduled_at)}.</>
              ) : (
                " Its scheduled time is unavailable."
              )}{" "}
              Future conditions will be checked later.
            </p>
          ) : null}
          <h3>Next actions returned</h3>
          {output.next_actions.length ? (
            <ul className={styles.toolRows}>
              {output.next_actions.map((action, index) => (
                <li key={`${action.node_id}:${index}`}>
                  <button onClick={() => onSelectNode(action.node_id)}>
                    {nodeLabel(action.node_id)} · {action.action_kind.replaceAll("_", " ")}
                  </button>
                  <p>
                    {action.scheduled_at ? (
                      <>Scheduled for {activityTime(action.scheduled_at)}</>
                    ) : (
                      "No future scheduled time returned"
                    )}
                  </p>
                  {action.reason ? <p>{plainReason(action.reason)}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>No next actions returned.</p>
          )}
        </div>
      ) : null}
      <p className={styles.muted}>
        Future conditions are rechecked when a run continues. Actual trigger timing, publication,
        duplicate prevention, and permission to send are checked separately.
      </p>
    </section>
  );
}

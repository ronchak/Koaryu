"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { workflowNodeLabels } from "@/lib/automation-workflow-model";
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
type Branches = Readonly<Record<string, "yes" | "no">>;
/** What the reviewer chose to assume for one walk; shown beside the trace it produced. */
type Assumptions = { waits: boolean; branches: Branches };
type Simulation = {
  read: Extract<WorkflowActivityRead<WorkflowSimulationResponse>, { status: "ready" }>;
  selection: WorkflowSimulationSelection;
  assumptions: Assumptions;
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
const pathWord = (outcome: "yes" | "no") => (outcome === "yes" ? "Yes" : "No");

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
  const [assumeWaits, setAssumeWaits] = useState(false);
  const [branches, setBranches] = useState<Branches>({});
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
  const labels = useMemo(() => workflowNodeLabels(graph), [graph]);
  const nodeById = (id: string) => graph.nodes.find((item) => item.id === id);
  const nodeLabel = (id: string) => {
    const node = nodeById(id);
    if (node?.type === "trigger" && metadata?.label) return metadata.label;
    return Object.hasOwn(labels, id) ? labels[id] : id;
  };
  // Only conditions still in the graph can be assumed; a deleted step drops out of the request.
  const activeBranches = (forced: Branches): Branches =>
    Object.fromEntries(Object.entries(forced).filter(([id]) => nodeById(id)?.type === "condition"));
  const simulate = async (next?: Partial<Assumptions>) => {
    const assumptions: Assumptions = {
      waits: next?.waits ?? assumeWaits,
      branches: activeBranches(next?.branches ?? branches),
    };
    if (next) {
      setAssumeWaits(assumptions.waits);
      setBranches(assumptions.branches);
    }
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
      const read = await activity.simulate(workflowId, graph, captured.context, {
        assume_waits_elapsed: assumptions.waits,
        branch_assumptions: Object.entries(assumptions.branches).map(([node_id, outcome]) => ({
          node_id,
          outcome,
        })),
      });
      if (current() && read.status === "ready" && read.isCurrent())
        setResult({ read, selection: captured, assumptions });
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
      ? result
      : null;
  const trace = output?.read.value;
  const waiting = trace?.trace.find((step) => step.outcome === "waiting");
  const waitingNode = waiting ? nodeById(waiting.node_id) : undefined;
  const hypothetical =
    output && (output.assumptions.waits || Object.keys(output.assumptions.branches).length > 0);
  const canRun = Boolean(workflowId) && Boolean(selection?.isCurrent()) && !loading && isCurrent();
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
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={assumeWaits}
              disabled={!workflowId}
              onChange={(event) => setAssumeWaits(event.target.checked)}
            />
            Assume every wait has passed, so later steps show too
          </label>
          <div className={styles.actions}>
            <button disabled={!canRun} onClick={() => void simulate()}>
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
      {output && trace ? (
        <div className={styles.toolStack}>
          <p>Reference time: {activityTime(trace.reference_time)}</p>
          {hypothetical ? (
            <div className={styles.notice} data-tone="sample" role="status">
              <p>
                <strong>Hypothetical trace.</strong>{" "}
                {output.assumptions.waits ? "Waits are assumed to have passed. " : ""}
                {Object.keys(output.assumptions.branches).length
                  ? "Marked conditions take the path you chose. "
                  : ""}
                A real run waits and rechecks the facts at each step.
              </p>
              <div className={styles.actions}>
                <button
                  disabled={!canRun}
                  onClick={() => void simulate({ waits: false, branches: {} })}
                >
                  Use real timing and facts
                </button>
              </div>
            </div>
          ) : null}
          <p>
            {trace.valid
              ? "Graph checks passed for this simulation."
              : "This graph needs changes before it can run."}
          </p>
          {trace.issues.length ? (
            <ul>
              {trace.issues.map((issue, index) => (
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
            {trace.trace.map((step, index) => {
              const edge = graph.edges.find((item) => item.id === step.edge_id);
              const node = nodeById(step.node_id);
              const assumedBranch = Object.hasOwn(output.assumptions.branches, step.node_id)
                ? output.assumptions.branches[step.node_id]
                : undefined;
              const decided = step.outcome === "matched" || step.outcome === "not_matched";
              return (
                <li key={`${step.node_id}:${index}`}>
                  <button onClick={() => onSelectNode(step.node_id)}>
                    {nodeLabel(step.node_id)} · {step.outcome.replaceAll("_", " ")}
                  </button>
                  {step.edge_id ? <p>Selected branch: {edge?.port ?? step.edge_id}</p> : null}
                  {step.reason ? <p>Reason: {plainReason(step.reason)}</p> : null}
                  {step.scheduled_at ? <p>Scheduled: {activityTime(step.scheduled_at)}</p> : null}
                  {node?.type === "delay" &&
                  step.outcome === "entered" &&
                  output.assumptions.waits ? (
                    <p className={styles.assumed}>Assumed to have passed.</p>
                  ) : null}
                  {node?.type === "condition" && (decided || step.outcome === "waiting") ? (
                    <div className={styles.actions}>
                      {assumedBranch ? (
                        <p className={styles.assumed}>Assumed {pathWord(assumedBranch)} path.</p>
                      ) : null}
                      {(decided ? [step.outcome === "matched" ? "no" : "yes"] : ["yes", "no"]).map(
                        (choice) => (
                          <button
                            key={choice}
                            disabled={!canRun}
                            onClick={() =>
                              void simulate({
                                branches: { ...branches, [step.node_id]: choice as "yes" | "no" },
                              })
                            }
                          >
                            {decided ? "Try" : "Assume"} the {pathWord(choice as "yes" | "no")} path
                          </button>
                        ),
                      )}
                    </div>
                  ) : null}
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
            <div className={styles.notice}>
              <p>
                The trace stops at the first wait.
                {waiting.scheduled_at ? (
                  <> Scheduled for {activityTime(waiting.scheduled_at)}.</>
                ) : (
                  " Its scheduled time is unavailable."
                )}{" "}
                Future conditions will be checked later.
              </p>
              {waitingNode?.type === "delay" ? (
                <div className={styles.actions}>
                  <button disabled={!canRun} onClick={() => void simulate({ waits: true })}>
                    Continue past this wait
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          <h3>Next actions returned</h3>
          {trace.next_actions.length ? (
            <ul className={styles.toolRows}>
              {trace.next_actions.map((action, index) => (
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

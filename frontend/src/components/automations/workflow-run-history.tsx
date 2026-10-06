"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError } from "@/lib/api";
import { ModalFrame } from "@/components/ui/modal-frame";
import type {
  WorkflowActivity,
  WorkflowActivityRead,
} from "@/lib/automation-workflow-activity-state";
import type {
  WorkflowCatalogResponse,
  WorkflowSimulationEntityType,
} from "@/lib/automation-workflow-types";
import type {
  ApiWorkflowRunDetail,
  ApiWorkflowRunListResponse,
} from "@/types/generated/api-contracts";
import type { WorkflowSimulationSelection } from "./workflow-simulation-context-picker";
import styles from "./workflow-workspace.module.css";

export type WorkflowRunHistoryProps = {
  activity: WorkflowActivity;
  workflowId: string | null;
  catalog: WorkflowCatalogResponse | null;
  simulationEntityType: WorkflowSimulationEntityType | null;
  onUseRecord(value: WorkflowSimulationSelection): void;
  isCurrent(): boolean;
  preview: boolean;
};
type Ready<T> = Extract<WorkflowActivityRead<T>, { status: "ready" }>;
type RunPage = {
  read: Ready<ApiWorkflowRunListResponse>;
  cursor?: string;
  back: (string | undefined)[];
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

export function WorkflowRunHistory({
  activity,
  workflowId,
  catalog,
  simulationEntityType,
  onUseRecord,
  isCurrent,
  preview,
}: WorkflowRunHistoryProps) {
  const snapshot = useSyncExternalStore(
    activity.subscribe,
    activity.getSnapshot,
    activity.getSnapshot,
  );
  const [page, setPage] = useState<RunPage | null>(null);
  const [detail, setDetail] = useState<Ready<ApiWorkflowRunDetail> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Ready<ApiWorkflowRunDetail> | null>(null);
  const [loading, setLoading] = useState(false),
    [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [detailError, setDetailError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const active = useRef(true),
    sequence = useRef(0),
    detailSequence = useRef(0),
    command = useRef(false);
  const latest = useRef({ isCurrent, workflowId });
  useLayoutEffect(() => {
    latest.current = { isCurrent, workflowId };
  });
  useEffect(() => {
    active.current = true;
    const listCounter = sequence,
      runCounter = detailSequence;
    return () => {
      active.current = false;
      listCounter.current++;
      runCounter.current++;
    };
  }, []);
  const current = () =>
    active.current && latest.current.isCurrent() && latest.current.workflowId === workflowId;
  const load = async (cursor?: string, back: (string | undefined)[] = []) => {
    if (preview || !workflowId || loading || !current()) return;
    const request = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const read = await activity.listRuns(workflowId, { limit: 50, cursor });
      if (current() && request === sequence.current && read.status === "ready" && read.isCurrent())
        setPage({ read, cursor, back });
    } catch {
      if (current() && request === sequence.current)
        setError(
          "History could not be refreshed. The previous page is still shown. Retry or return to the first page.",
        );
    } finally {
      if (active.current && request === sequence.current) setLoading(false);
    }
  };
  const open = async (runId: string) => {
    if (preview || !workflowId || reading || !current()) return;
    const request = ++detailSequence.current;
    setSelected(runId);
    setReading(true);
    setDetail(null);
    setDetailError(null);
    setConfirmation(null);
    try {
      const read = await activity.getRun(workflowId, runId);
      if (
        current() &&
        request === detailSequence.current &&
        read.status === "ready" &&
        read.isCurrent()
      )
        setDetail(read);
    } catch (failure) {
      if (current() && request === detailSequence.current)
        setDetailError(
          failure instanceof ApiError && failure.status === 404
            ? "This run is no longer available."
            : "Run details could not be refreshed. Try again.",
        );
    } finally {
      if (active.current && request === detailSequence.current) setReading(false);
    }
  };
  const perform = async (action: () => Promise<void>) => {
    if (preview || command.current || !current()) return;
    command.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch {
      if (current())
        setNotice(
          "This action could not be completed. Check current access and the previous action's result before continuing.",
        );
    } finally {
      command.current = false;
      if (active.current) setBusy(false);
    }
  };
  const operations = [...snapshot.operations.values()].filter(
    (item) =>
      item.command === "run.cancel" && item.target.workflowId === workflowId && item.isCurrent(),
  );
  const shown = detail?.isCurrent() && isCurrent() ? detail.value : null;
  const pending = operations.find(
    (item) => item.target.kind === "run" && item.target.runId === shown?.run.id && item.locked,
  );
  if (confirmation && (!confirmation.isCurrent() || !isCurrent())) setConfirmation(null);
  const modal = confirmation?.isCurrent() && isCurrent() ? confirmation : null;
  return (
    <section className={`${styles.sheet} ${styles.toolPanel}`} aria-label="Workflow run history">
      <h2>Run history</h2>
      <p>
        Each run belongs to the published version it started with. Accepted means the provider
        accepted the email, without confirming delivery.
      </p>
      {preview ? (
        <p className={styles.notice}>
          Run history and cancellation are available in your live studio.
        </p>
      ) : (
        <>
          {!workflowId ? <p>Save this workflow before loading its run history.</p> : null}
          <div className={styles.actions}>
            <button
              disabled={!workflowId || loading || !isCurrent()}
              onClick={() => void load(page?.cursor, page?.back)}
            >
              Load history
            </button>
            {error ? (
              <button
                disabled={loading || !isCurrent()}
                onClick={() => void load(page?.cursor, page?.back)}
              >
                Retry history
              </button>
            ) : null}
            <button disabled={!workflowId || loading || !isCurrent()} onClick={() => void load()}>
              Back to first page
            </button>
          </div>
        </>
      )}
      {loading ? <p role="status">Loading run history...</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {page ? (
        <>
          {!page.read.value.items.length ? <p>No runs on this page.</p> : null}
          <ul className={styles.toolRows}>
            {page.read.value.items.map((run) => {
              const trigger =
                catalog && Object.hasOwn(catalog.triggers, run.event_type)
                  ? catalog.triggers[run.event_type]
                  : null;
              const canUse =
                trigger?.simulation_entity_type === simulationEntityType &&
                simulationEntityType !== null;
              return (
                <li key={run.id}>
                  <p>
                    <strong>{run.subject_label}</strong> · Version {run.version_number} ·{" "}
                    {run.state}
                  </p>
                  <p>
                    {trigger?.label || run.event_type} · {activityTime(run.created_at)} · Ref{" "}
                    {run.id.slice(0, 8)}
                  </p>
                  <div className={styles.actions}>
                    <button
                      aria-busy={reading && selected === run.id}
                      disabled={!page.read.isCurrent() || !isCurrent()}
                      onClick={() => void open(run.id)}
                    >
                      View run {run.id.slice(0, 8)}
                    </button>
                    {canUse ? (
                      <button
                        disabled={!page.read.isCurrent() || !isCurrent()}
                        onClick={() => {
                          if (!page.read.isCurrent() || !current() || !simulationEntityType) return;
                          const origin = page.read;
                          onUseRecord({
                            context: {
                              kind: "entity",
                              entity_type: simulationEntityType,
                              entity_id: run.subject_id,
                            },
                            label: run.subject_label,
                            isCurrent: () => origin.isCurrent() && current(),
                          });
                        }}
                      >
                        Use this recent record
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className={styles.actions}>
            <button
              disabled={loading || !page.back.length || !isCurrent()}
              onClick={() => void load(page.back.at(-1), page.back.slice(0, -1))}
            >
              Previous runs
            </button>
            <button
              disabled={
                loading ||
                !page.read.isCurrent() ||
                !page.read.value.has_more ||
                !page.read.value.next_cursor ||
                !isCurrent()
              }
              onClick={() => void load(page.read.value.next_cursor!, [...page.back, page.cursor])}
            >
              Next runs
            </button>
          </div>
        </>
      ) : null}
      {reading ? <p role="status">Loading this run...</p> : null}
      {detailError ? <p role="alert">{detailError}</p> : null}
      {selected ? (
        <button disabled={reading || !isCurrent()} onClick={() => void open(selected)}>
          Refresh selected run
        </button>
      ) : null}
      {shown ? (
        <article className={styles.runDetail} aria-label="Selected run detail">
          <h3>
            {shown.run.subject_label} · Version {shown.run.version_number}
          </h3>
          <p>Run ref {shown.run.id.slice(0, 8)}</p>
          <p>Current state: {shown.run.state}</p>
          <p>
            Cancellation requested:{" "}
            {shown.run.cancel_requested_at
              ? activityTime(shown.run.cancel_requested_at)
              : "Not requested"}
          </p>
          {shown.run.cancel_reason ? (
            <p>Cancellation reason: {plainReason(shown.run.cancel_reason)}</p>
          ) : null}
          <p>
            Next due: {shown.run.next_due_at ? activityTime(shown.run.next_due_at) : "Unavailable"}
          </p>
          {shown.run.reason ? <p>Reason: {plainReason(shown.run.reason)}</p> : null}
          <button
            disabled={
              !shown.run.can_cancel ||
              Boolean(pending) ||
              busy ||
              snapshot.storage.status === "blocked" ||
              !isCurrent()
            }
            onClick={() => {
              if (detail?.isCurrent() && current() && !confirmation) setConfirmation(detail);
            }}
          >
            Cancel this run
          </button>
          <h4>Recorded steps</h4>
          <ol className={styles.trace}>
            {shown.steps.map((step) => (
              <li key={step.id}>
                <p>
                  {step.sequence}. {step.node_type} · {step.node_id} · {step.outcome}
                </p>
                <p>
                  {step.reason ? plainReason(step.reason) : "Reason unavailable"} · Branch{" "}
                  {step.edge_id ?? "unavailable"}
                </p>
                <p>
                  Entered {activityTime(step.entered_at)} · Finished{" "}
                  {step.finished_at ? activityTime(step.finished_at) : "unavailable"}
                </p>
                {step.scheduled_at ? <p>Scheduled {activityTime(step.scheduled_at)}</p> : null}
              </li>
            ))}
          </ol>
          <h4>Email attempts</h4>
          <ul className={styles.toolRows}>
            {shown.attempts.map((attempt) => (
              <li key={attempt.id}>
                <p>
                  Attempt {attempt.attempt_number} · Node {attempt.node_id} · {attempt.state}
                </p>
                <p>
                  Recipient: {attempt.recipient_email ?? "Unavailable"} ·{" "}
                  {attempt.recipient_kind ?? "Kind unavailable"}
                </p>
                <p>
                  Began {activityTime(attempt.began_at)} · Settled{" "}
                  {attempt.settled_at ? activityTime(attempt.settled_at) : "unavailable"}
                </p>
                <p>Reason: {attempt.reason ? plainReason(attempt.reason) : "Unavailable"}</p>
                <p>
                  Submission evidence:{" "}
                  {attempt.submission_evidence
                    ? plainReason(attempt.submission_evidence)
                    : "Unavailable"}{" "}
                  · Failure scope:{" "}
                  {attempt.failure_scope ? plainReason(attempt.failure_scope) : "Unavailable"}
                </p>
              </li>
            ))}
          </ul>
          {!shown.attempts.length ? <p>No recorded email attempts.</p> : null}
          <p className={styles.muted}>
            These node references describe the recorded version. An unknown result is not retried
            here.
          </p>
        </article>
      ) : null}
      {operations.length ? (
        <div className={styles.toolStack} aria-label="Cancellation results">
          <h3>Cancellation results</h3>
          {operations.map((operation) => (
            <div className={styles.notice} key={operation.operationId} role="status">
              <p>
                {operation.command === "run.cancel" && operation.current
                  ? operation.current.run.subject_label
                  : "Previous cancellation"}{" "}
                · Run ref{" "}
                {operation.target.kind === "run"
                  ? operation.target.runId.slice(0, 8)
                  : "unavailable"}
              </p>
              <p>
                {operation.status === "submitting"
                  ? "Requesting cancellation"
                  : operation.status === "checking"
                    ? "Checking cancellation"
                    : operation.status === "confirmed"
                      ? "Cancellation checked"
                      : "Review cancellation result"}
                {operation.command === "run.cancel" && operation.current
                  ? ` · Current run state: ${operation.current.run.state}`
                  : ""}
              </p>
              {operation.command === "run.cancel" && operation.current?.run.cancel_requested_at ? (
                <p>
                  Cancellation requested {activityTime(operation.current.run.cancel_requested_at)}.
                  An email already sending may still be accepted.
                </p>
              ) : null}
              {operation.message ? <p>{operation.message}</p> : null}
              {operation.status === "unavailable" ? (
                <p>The action was confirmed. Its current run is unavailable.</p>
              ) : null}
              {operation.locked ? (
                <button
                  disabled={
                    busy ||
                    operation.status === "submitting" ||
                    operation.status === "checking" ||
                    !operation.isCurrent()
                  }
                  onClick={() =>
                    void perform(() =>
                      operation.isCurrent()
                        ? activity.checkResult(operation.target)
                        : Promise.resolve(),
                    )
                  }
                >
                  Check cancellation result
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {notice ? <p role="alert">{notice}</p> : null}
      {modal ? (
        <ModalFrame
          ariaLabel="Cancel this run?"
          panelClassName={styles.toolModal}
          rootClassName={styles.toolModalRoot}
          onBackdropClick={() => setConfirmation(null)}
        >
          <h2>Cancel this run?</h2>
          <div className={styles.dialogBody}>
            <p>
              Request cancellation for {modal.value.run.subject_label}, version{" "}
              {modal.value.run.version_number}.
            </p>
            <p>
              An email already sending may still be accepted. Check the current result after
              cancellation.
            </p>
          </div>
          <div className={styles.actions}>
            <button onClick={() => setConfirmation(null)}>Keep reviewing</button>
            <button
              disabled={busy || !modal.isCurrent()}
              onClick={() => {
                const captured = modal;
                setConfirmation(null);
                setDetail(null);
                void perform(() =>
                  captured.isCurrent() ? activity.cancelRun(captured.value) : Promise.resolve(),
                );
              }}
            >
              Confirm cancellation
            </button>
          </div>
        </ModalFrame>
      ) : null}
    </section>
  );
}

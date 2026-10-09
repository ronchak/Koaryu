"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ModalFrame } from "@/components/ui/modal-frame";
import type { WorkflowActivity } from "@/lib/automation-workflow-activity-state";
import type { WorkflowGraph } from "@/lib/automation-workflow-types";
import styles from "./workflow-workspace.module.css";

export type WorkflowTestEmailPanelProps = {
  activity: WorkflowActivity;
  workflowId: string | null;
  graph: WorkflowGraph;
  emailNodeId: string | null;
  canTestEmail: boolean;
  disabledReason: string | null;
  isCurrent(): boolean;
  preview: boolean;
};
type Confirmation = {
  observedOperationId?: string;
  graph: WorkflowGraph;
  nodeId: string;
  workflowId: string;
  priorOperationId?: string;
  isCurrent(): boolean;
};

export function WorkflowTestEmailPanel({
  activity,
  workflowId,
  graph,
  emailNodeId,
  canTestEmail,
  disabledReason,
  isCurrent,
  preview,
}: WorkflowTestEmailPanelProps) {
  const snapshot = useSyncExternalStore(
    activity.subscribe,
    activity.getSnapshot,
    activity.getSnapshot,
  );
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(true),
    inFlight = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const selectedNode = graph.nodes.find((node) => node.id === emailNodeId);
  const currentNode = selectedNode?.type === "email" ? selectedNode : null;
  const operation = [...snapshot.operations.values()].find(
    (item) =>
      item.command === "test_email.create" &&
      item.target.workflowId === workflowId &&
      item.isCurrent(),
  );
  const sample = operation?.command === "test_email.create" ? operation.current : null;
  const terminal = sample && ["accepted", "failed", "unknown"].includes(sample.state);
  const blocked = snapshot.storage.status === "blocked";
  const locked = operation?.status === "submitting" || operation?.status === "checking";
  const canCreate =
    !preview &&
    Boolean(workflowId && currentNode && canTestEmail && isCurrent()) &&
    !blocked &&
    !busy &&
    !locked;
  const latest = useRef({ workflowId, operation, isCurrent, emailNodeId });
  useLayoutEffect(() => {
    latest.current = { workflowId, operation, isCurrent, emailNodeId };
  });
  const perform = async (run: () => Promise<void>) => {
    if (preview || inFlight.current || !isCurrent()) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await run();
    } catch {
      if (active.current && isCurrent())
        setNotice(
          "This action could not be completed. Review the current graph, access, storage, and previous result before continuing.",
        );
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  };
  const open = (another: boolean) => {
    if (
      !canCreate ||
      !workflowId ||
      !currentNode ||
      confirmation ||
      (another ? !terminal || !operation : operation?.locked)
    )
      return;
    const previous = operation?.operationId;
    setConfirmation({
      graph: structuredClone(graph),
      observedOperationId: previous,
      nodeId: currentNode.id,
      workflowId,
      ...(another ? { priorOperationId: previous } : {}),
      isCurrent: () =>
        isCurrent() &&
        latest.current.isCurrent() &&
        latest.current.workflowId === workflowId &&
        latest.current.emailNodeId === emailNodeId &&
        latest.current.operation?.operationId === previous,
    });
  };
  const matchesConfirmation =
    confirmation &&
    confirmation.workflowId === workflowId &&
    confirmation.nodeId === emailNodeId &&
    confirmation.observedOperationId === operation?.operationId &&
    isCurrent();
  if (confirmation && !matchesConfirmation) setConfirmation(null);
  const currentConfirmation = matchesConfirmation ? confirmation : null;
  const confirm = () => {
    const captured = currentConfirmation;
    setConfirmation(null);
    if (!captured) return;
    void perform(() =>
      captured.priorOperationId
        ? activity.createAnotherTest(
            captured.workflowId,
            captured.graph,
            captured.nodeId,
            captured.priorOperationId,
          )
        : activity.createTest(captured.workflowId, captured.graph, captured.nodeId),
    );
  };
  return (
    <section className={`${styles.sheet} ${styles.toolPanel}`} aria-label="Workflow sample email">
      <h2>Sample email</h2>
      <p>Send a sample to your verified account email. The message uses synthetic values.</p>
      {preview ? (
        <p className={styles.notice}>
          Sample email and result checks are available in your live studio. Preview sends nothing.
        </p>
      ) : (
        <>
          {!workflowId ? <p>Save this workflow before requesting a sample.</p> : null}
          {!currentNode ? (
            <p>Select an email node in the current graph to create a sample.</p>
          ) : (
            <p>Selected email: {currentNode.config.subject_template || currentNode.id}</p>
          )}
          {!canTestEmail ? (
            <p className={styles.notice}>
              {disabledReason?.trim() || "New sample emails are unavailable right now."}
            </p>
          ) : null}
          {!operation?.locked ? (
            <div className={styles.actions}>
              <button disabled={!canCreate} onClick={() => open(false)}>
                Send sample email
              </button>
            </div>
          ) : null}
          {operation ? (
            <div className={styles.toolStack} role="status">
              <p>
                Sample result:{" "}
                {sample?.state ??
                  (operation.status === "submitting"
                    ? "Requesting sample"
                    : operation.status === "checking"
                      ? "Checking sample"
                      : "Check previous sample")}
              </p>
              {operation.message ? <p>{operation.message}</p> : null}
              {sample?.state === "accepted" ? (
                <p>The provider accepted this sample. Delivery is not confirmed.</p>
              ) : null}
              {!terminal && operation.locked ? (
                <p>
                  This request remains reserved. Check its result before creating another sample.
                </p>
              ) : null}
              <div className={styles.actions}>
                <button
                  disabled={busy || locked || !operation.isCurrent()}
                  onClick={() => {
                    const captured = operation;
                    void perform(() =>
                      captured.isCurrent()
                        ? activity.checkResult(captured.target)
                        : Promise.resolve(),
                    );
                  }}
                >
                  Check sample result
                </button>
                {terminal ? (
                  <>
                    <button
                      disabled={busy || locked || !operation.isCurrent()}
                      onClick={() => {
                        const captured = operation;
                        void perform(() =>
                          captured.isCurrent()
                            ? activity.dismissTestResult(
                                captured.target.workflowId,
                                captured.operationId,
                              )
                            : Promise.resolve(),
                        );
                      }}
                    >
                      Dismiss sample result
                    </button>
                    <button disabled={!canCreate} onClick={() => open(true)}>
                      Create another sample
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
          {blocked ? (
            <div className={styles.notice} role="alert">
              <p>
                {snapshot.storage.message || "Workflow activity recovery storage is unavailable."}
              </p>
              <button
                disabled={busy || !isCurrent()}
                onClick={() => void perform(() => activity.checkStorage())}
              >
                Check storage
              </button>
            </div>
          ) : null}
        </>
      )}
      {busy ? <p role="status">Checking this action...</p> : null}
      {notice ? <p role="alert">{notice}</p> : null}
      {currentConfirmation ? (
        <ModalFrame
          ariaLabel={
            currentConfirmation.priorOperationId ? "Create another sample?" : "Send a sample email?"
          }
          panelClassName={styles.toolModal}
          rootClassName={styles.toolModalRoot}
          onBackdropClick={() => setConfirmation(null)}
        >
          <h2>
            {currentConfirmation.priorOperationId
              ? "Create another sample?"
              : "Send a sample email?"}
          </h2>
          <div className={styles.dialogBody}>
            <p>
              Send synthetic values from this captured email node to your verified account email.
            </p>
            {sample?.state === "unknown" ? (
              <p>
                The previous sample may have been accepted. This creates a separate sample and does
                not retry it.
              </p>
            ) : null}
            <p>If the graph changes, review it before requesting the sample again.</p>
          </div>
          <div className={styles.actions}>
            <button onClick={() => setConfirmation(null)}>Keep reviewing</button>
            <button disabled={!canCreate} onClick={confirm}>
              Confirm sample
            </button>
          </div>
        </ModalFrame>
      ) : null}
    </section>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkflowWorkspace as Owner } from "@/lib/automation-workflow-workspace-controller";
import {
  workflowDraftAddress,
  workflowEditorContent,
  workflowEditorDirty,
  type WorkflowContent,
} from "@/lib/automation-workflow-workspace-state";
import { initialWorkflowDraft, truncateWorkflowText } from "@/lib/automation-workflow-model";
import { catalogEntry } from "@/lib/automation-workflow-catalog";
import {
  WorkflowAccess,
  WorkflowConfirmation,
  useWorkflowSnapshot,
  workflowAddress,
} from "./workflow-workspace";
import styles from "./workflow-workspace.module.css";

export function WorkflowCatalogPanel() {
  return (
    <section className={styles.catalog} aria-label="Workflow catalog" data-workflow-catalog="true">
      <WorkflowAccess>{(owner) => <CatalogView owner={owner} />}</WorkflowAccess>
    </section>
  );
}
function CatalogView({ owner }: { owner: Owner }) {
  const state = useWorkflowSnapshot(owner);
  const router = useRouter();
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [attemptedCursor, setAttemptedCursor] = useState<string | undefined>();
  const pageSequence = useRef(0);
  const [copying, setCopying] = useState(false);
  const lifetime = useRef(0);
  useEffect(() => {
    lifetime.current += 1;
    if (owner.isCurrent()) void owner.loadCatalog().catch(() => {});
    if (owner.isCurrent()) void owner.loadList({ limit: 20 }).catch(() => {});
    return () => {
      lifetime.current += 1;
    };
  }, [owner]);
  const preview = state.mode === "preview";
  const prepare = (action: () => void) => {
    if (!owner.isCurrent()) return;
    if (state.editor && workflowEditorDirty(state.editor)) setPending(() => action);
    else action();
  };
  const create = (input?: WorkflowContent) => {
    const id = crypto.randomUUID();
    prepare(() => {
      if (!owner.isCurrent()) return;
      owner.openNew(id, input, true);
      router.push(workflowDraftAddress(id));
    });
  };
  const duplicate = (id: string) => {
    const draftId = crypto.randomUUID();
    prepare(() => {
      if (!owner.isCurrent()) return;
      const generation = lifetime.current;
      setCopying(true);
      setNotice(null);
      void owner
        .openWorkflow(id, true)
        .then((result) => {
          if (generation !== lifetime.current || !owner.isCurrent() || result !== "opened") return;
          const editor = owner.getSnapshot().editor!;
          owner.openNew(
            draftId,
            {
              ...workflowEditorContent(editor),
              name: truncateWorkflowText(`${editor.name} copy`, 120),
            },
            true,
          );
          router.push(workflowDraftAddress(draftId));
        })
        .catch(() => {
          if (generation === lifetime.current && owner.isCurrent())
            setNotice(
              "The saved draft could not be copied. Reload the workflow list and try again.",
            );
        })
        .finally(() => {
          if (generation === lifetime.current && owner.isCurrent()) setCopying(false);
        });
    });
  };
  const page = (next?: string) => {
    if (!owner.isCurrent()) return;
    const request = ++pageSequence.current;
    const generation = lifetime.current;
    setAttemptedCursor(next);
    void owner
      .loadList({ limit: 20, ...(next ? { cursor: next } : {}) })
      .then(() => {
        if (
          request === pageSequence.current &&
          generation === lifetime.current &&
          owner.isCurrent() &&
          !owner.getSnapshot().reads.list.error
        )
          setCursor(next);
      })
      .catch(() => {});
  };
  const pendingOperations = Object.values(state.operations).filter((operation) => operation.locked);
  return (
    <>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.muted}>{preview ? "Sample catalog" : "Custom workflows"}</p>
          <h2 id="workflow-catalog-title">Build your next workflow</h2>
        </div>
        <button
          disabled={copying}
          onClick={() =>
            create({ name: "Untitled workflow", description: "", ...initialWorkflowDraft() })
          }
        >
          New workflow
        </button>
      </div>
      {preview ? (
        <p className={styles.notice}>
          Sample only. Explore editable examples. Live saving, activation, and delivery are
          unavailable.
        </p>
      ) : null}
      {state.editor ? (
        <p className={styles.notice}>
          Your {workflowEditorDirty(state.editor) ? "unsaved " : ""}draft stays open while you
          browse. Reloading discards unsaved changes.{" "}
          <button
            onClick={() =>
              router.push(
                state.editor!.workflowId
                  ? workflowAddress(state.editor!.workflowId)
                  : workflowDraftAddress(state.editor!.target.id),
              )
            }
          >
            Continue editing {state.editor.name}
          </button>
        </p>
      ) : null}
      {pendingOperations.length ? (
        <div className={styles.notice}>
          <p>
            Some actions still need a result check. Their drafts remain available while you browse.
          </p>
          {pendingOperations.map((operation) => (
            <button
              key={operation.operationId}
              onClick={() =>
                router.push(
                  operation.target.kind === "draft"
                    ? workflowDraftAddress(operation.target.id)
                    : workflowAddress(operation.target.id),
                )
              }
            >
              Open pending workflow
            </button>
          ))}
        </div>
      ) : null}
      {notice ? <p role="alert">{notice}</p> : null}
      <section aria-label="Workflow templates">
        <h3>Start from a template</h3>
        {state.reads.catalog.loading && !state.catalog ? (
          <p role="status">Loading templates...</p>
        ) : null}
        {state.reads.catalog.error ? (
          <p role="alert">
            Templates could not be loaded.{" "}
            <button
              onClick={() => {
                if (owner.isCurrent()) void owner.loadCatalog().catch(() => {});
              }}
            >
              Reload templates
            </button>
          </p>
        ) : null}
        {state.catalog ? (
          <div className={styles.templates}>
            {state.catalog.presets.map((preset) => (
              <article className={styles.card} key={preset.id}>
                <h4>{preset.name}</h4>
                <p>{preset.description}</p>
                <button
                  disabled={copying}
                  onClick={() =>
                    create({
                      name: preset.name,
                      description: preset.description,
                      graph: preset.graph,
                      layout: { positions: {} },
                    })
                  }
                >
                  Use {preset.name}
                </button>
              </article>
            ))}
          </div>
        ) : null}
      </section>
      <section aria-label="Saved workflows">
        <div className={styles.sectionHeading}>
          <h3>{preview ? "Sample workflows" : "Saved workflows"}</h3>
          <button disabled={state.reads.list.loading || preview} onClick={() => page()}>
            Refresh list
          </button>
        </div>
        {state.reads.list.loading ? <p role="status">Loading workflows...</p> : null}
        {state.reads.list.error ? (
          <div className={styles.notice} role="alert">
            <p>This page of workflows could not be loaded.</p>
            <div className={styles.actions}>
              <button onClick={() => page(attemptedCursor)}>Retry page</button>
              <button onClick={() => page()}>Back to first page</button>
            </div>
          </div>
        ) : null}
        {state.list ? (
          state.list.items.length ? (
            <ul className={styles.workflowList}>
              {state.list.items.map((workflow) => {
                const event = workflow.published_version_number
                  ? workflow.trigger_event_type
                  : workflow.draft_trigger_event_type;
                const trigger = event
                  ? ((state.catalog && catalogEntry(state.catalog.triggers, event)?.label) ?? event)
                  : "Choose a trigger";
                return (
                  <li className={styles.card} key={workflow.id}>
                    <div className={styles.sectionHeading}>
                      <div>
                        <h4>
                          <button
                            disabled={copying}
                            onClick={() => router.push(workflowAddress(workflow.id))}
                          >
                            {workflow.name}
                          </button>
                        </h4>
                        <p>{workflow.description}</p>
                      </div>
                      <span className={styles.badge}>{workflow.status}</span>
                    </div>
                    <p>
                      {workflow.published_version_number
                        ? `Published version ${workflow.published_version_number}`
                        : "Draft trigger"}{" "}
                      · {trigger}
                    </p>
                    {workflow.has_unpublished_changes ? (
                      <p className={styles.muted}>Saved changes are not published</p>
                    ) : null}
                    <p className={styles.muted}>
                      {workflow.pending_run_count} waiting · {workflow.sending_run_count} sending
                    </p>
                    <button disabled={copying} onClick={() => duplicate(workflow.id)}>
                      Duplicate {workflow.name}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>No saved workflows yet. Choose a template or start with an empty draft.</p>
          )
        ) : null}
        <div className={styles.actions}>
          {cursor ? (
            <button disabled={state.reads.list.loading} onClick={() => page()}>
              First page
            </button>
          ) : null}
          {state.list?.has_more && !state.reads.list.error ? (
            <button
              disabled={state.reads.list.loading || copying}
              onClick={() => page(state.list!.next_cursor!)}
            >
              Next page
            </button>
          ) : null}
        </div>
      </section>
      {pending ? (
        <WorkflowConfirmation
          title="Discard your unsaved changes?"
          confirmLabel="Discard and continue"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const action = pending;
            setPending(null);
            action();
          }}
        >
          <p>
            Starting another draft replaces the draft you were editing. Any pending action keeps its
            result check.
          </p>
        </WorkflowConfirmation>
      ) : null}
    </>
  );
}

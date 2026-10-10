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
import {
  initialWorkflowDraft,
  truncateWorkflowText,
  workflowSteps,
} from "@/lib/automation-workflow-model";
import { catalogEntry } from "@/lib/automation-workflow-catalog";
import type { WorkflowGraph, WorkflowSummary } from "@/lib/automation-workflow-types";
import kit from "@/components/ui/horizon.module.css";
import {
  WorkflowAccess,
  WorkflowConfirmation,
  useWorkflowSnapshot,
  workflowAddress,
  workflowStatus,
} from "./workflow-workspace";
import styles from "./workflow-workspace.module.css";

const stepWords: Partial<Record<WorkflowGraph["nodes"][number]["type"], string>> = {
  condition: "Check",
  delay: "Wait",
  email: "Email",
  lead_follow_up: "Follow-up task",
};

/** A template read as a recipe: what starts it, then each step in order. */
function presetRecipe(graph: WorkflowGraph) {
  const steps = workflowSteps(graph).map(({ node }) => node);
  const trigger = steps.find((node) => node.type === "trigger");
  return {
    trigger: trigger?.type === "trigger" ? trigger.config.event_type : null,
    steps: steps.flatMap((node) =>
      stepWords[node.type] ? [{ kind: node.type, label: stepWords[node.type]! }] : [],
    ),
  };
}

function workflowTally(items: readonly WorkflowSummary[]) {
  const counts = new Map<WorkflowSummary["status"], number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const words: [WorkflowSummary["status"], string, string][] = [
    ["active", "active", "active"],
    ["paused", "paused", "paused"],
    ["draft", "draft", "drafts"],
    ["archived", "archived", "archived"],
  ];
  return words
    .filter(([status]) => counts.get(status))
    .map(([status, one, many]) => {
      const count = counts.get(status)!;
      return `${count} ${count === 1 ? one : many}`;
    })
    .join(" · ");
}

const editedFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const editedDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "recently" : editedFormat.format(date);
};

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
  const items = state.list?.items ?? [];
  return (
    <>
      {preview ? (
        <p className={styles.notice} data-tone="sample">
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
        <div className={styles.notice} data-tone="warn">
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
      {notice ? (
        <p className={styles.notice} data-tone="alert" role="alert">
          {notice}
        </p>
      ) : null}
      <section
        aria-label="Saved workflows"
        className={styles.panel}
        data-workflow-list={preview ? "sample" : "saved"}
      >
        <div className={styles.panelHead}>
          <div className={styles.panelTitles}>
            <h2>{preview ? "Sample workflows" : "Saved workflows"}</h2>
            <p className={styles.panelNote}>
              {state.list && items.length
                ? `${workflowTally(items)}${state.list.has_more || cursor ? " on this page" : ""}`
                : "What starts each workflow and whether it is on."}
            </p>
          </div>
          <button
            data-variant="quiet"
            disabled={state.reads.list.loading || preview}
            onClick={() => page()}
          >
            Refresh list
          </button>
        </div>
        {state.reads.list.loading ? (
          <p role="status" className={styles.panelStatus}>
            Loading workflows...
          </p>
        ) : null}
        {state.reads.list.error ? (
          <div className={styles.notice} data-tone="alert" role="alert">
            <p>This page of workflows could not be loaded.</p>
            <div className={styles.actions}>
              <button onClick={() => page(attemptedCursor)}>Retry page</button>
              <button onClick={() => page()}>Back to first page</button>
            </div>
          </div>
        ) : null}
        {state.list ? (
          items.length ? (
            <ul className={styles.workflowList}>
              {items.map((workflow) => {
                const event = workflow.published_version_number
                  ? workflow.trigger_event_type
                  : workflow.draft_trigger_event_type;
                const trigger = event
                  ? ((state.catalog && catalogEntry(state.catalog.triggers, event)?.label) ?? event)
                  : null;
                const status = workflowStatus[workflow.status] ?? {
                  label: workflow.status,
                  tone: "neutral" as const,
                };
                return (
                  <li className={styles.workflowRow} key={workflow.id} data-tone={status.tone}>
                    <div className={styles.rowMain}>
                      <div className={styles.rowTitle}>
                        <h3>
                          <button
                            className={styles.rowName}
                            disabled={copying}
                            onClick={() => router.push(workflowAddress(workflow.id))}
                          >
                            {workflow.name}
                          </button>
                        </h3>
                        <span className={kit.tag} data-tone={status.tone} data-dot="true">
                          {status.label}
                        </span>
                      </div>
                      <p className={styles.rowSentence}>
                        <span className={styles.when}>When</span>{" "}
                        {trigger ?? "No trigger chosen yet"}
                        {workflow.published_version_number ? null : (
                          <span className={styles.rowAside}> · draft trigger</span>
                        )}
                      </p>
                      {workflow.description ? (
                        <p className={styles.rowDescription}>{workflow.description}</p>
                      ) : null}
                      <p className={styles.rowMeta}>
                        <span>
                          {workflow.published_version_number
                            ? `Published version ${workflow.published_version_number}`
                            : "Not published yet"}
                        </span>
                        <span>
                          {workflow.pending_run_count} waiting · {workflow.sending_run_count}{" "}
                          sending
                        </span>
                        <span>Edited {editedDate(workflow.updated_at)}</span>
                      </p>
                      {workflow.has_unpublished_changes && workflow.published_version_number ? (
                        <p className={styles.rowFlag}>Saved changes are not published</p>
                      ) : null}
                    </div>
                    <div className={styles.rowActions}>
                      <button
                        data-variant="quiet"
                        disabled={copying}
                        onClick={() => duplicate(workflow.id)}
                      >
                        Duplicate<span className={styles.srOnly}> {workflow.name}</span>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className={`${kit.calm} ${styles.calm}`}>
              <div className={kit.calmText}>
                <strong>No saved workflows yet</strong>
                <span>Choose a template or start with an empty draft.</span>
              </div>
              <a className={styles.textLink} href="#workflow-templates">
                Browse templates
              </a>
            </div>
          )
        ) : null}
        {cursor || (state.list?.has_more && !state.reads.list.error) ? (
          <div className={styles.pager}>
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
        ) : null}
      </section>
      <section
        id="workflow-templates"
        aria-labelledby="workflow-catalog-title"
        className={styles.panel}
      >
        <div className={styles.panelHead}>
          <div className={styles.panelTitles}>
            <p className={styles.eyebrow}>{preview ? "Sample catalog" : "Custom workflows"}</p>
            <h2 id="workflow-catalog-title">Build your next workflow</h2>
            <p className={styles.panelNote}>
              Each choice opens a local draft. It is saved only when you choose Save draft.
            </p>
          </div>
          <button
            data-variant="primary"
            disabled={copying}
            onClick={() =>
              create({ name: "Untitled workflow", description: "", ...initialWorkflowDraft() })
            }
          >
            New workflow
          </button>
        </div>
        <section aria-label="Workflow templates">
          <h3 className={styles.subhead}>Start from a template</h3>
          {state.reads.catalog.loading && !state.catalog ? (
            <p role="status" className={styles.panelStatus}>
              Loading templates...
            </p>
          ) : null}
          {state.reads.catalog.error ? (
            <p className={styles.notice} data-tone="alert" role="alert">
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
              {state.catalog.presets.map((preset) => {
                const recipe = presetRecipe(preset.graph);
                const trigger = recipe.trigger
                  ? (catalogEntry(state.catalog!.triggers, recipe.trigger)?.label ?? recipe.trigger)
                  : null;
                return (
                  <article className={styles.card} key={preset.id}>
                    {trigger ? (
                      <p className={styles.templateWhen}>
                        <span className={styles.when}>When</span> {trigger}
                      </p>
                    ) : null}
                    <h4>{preset.name}</h4>
                    <p>{preset.description}</p>
                    {recipe.steps.length ? (
                      <ol className={styles.recipe} aria-label={`${preset.name} steps`}>
                        {recipe.steps.map((step, index) => (
                          <li key={index} data-kind={step.kind}>
                            <span>{step.label}</span>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    <button
                      className={styles.useTemplate}
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
                      Use<span className={styles.srOnly}> {preset.name}</span>
                      <span aria-hidden="true"> template</span>
                    </button>
                  </article>
                );
              })}
            </div>
          ) : null}
        </section>
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

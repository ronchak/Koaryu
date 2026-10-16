"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkflowWorkspace as Owner } from "@/lib/automation-workflow-workspace-controller";
import {
  workflowDraftAddress,
  workflowEditorContent,
  workflowEditorDirty,
  workflowTargetKey,
  type WorkflowContent,
} from "@/lib/automation-workflow-workspace-state";
import { truncateWorkflowText, workflowTextLength } from "@/lib/automation-workflow-model";
import type { WorkflowCommand } from "@/lib/automation-workflow-types";
import kit from "@/components/ui/horizon.module.css";
import { WorkflowSimulationPanel } from "./workflow-simulation-panel";
import { WorkflowRunHistory } from "./workflow-run-history";
import { WorkflowTestEmailPanel } from "./workflow-test-email-panel";
import type { WorkflowSimulationSelection } from "./workflow-simulation-context-picker";
import { WorkflowGraphEditor } from "./workflow-graph-editor";
import type { WorkflowChecks } from "./workflow-graph-editor";
import { WorkflowNodeInspector } from "./workflow-node-inspector";
import type { WorkflowFieldFocus } from "./workflow-node-inspector";
import {
  WorkflowAccess,
  WorkflowEditorPlaceholder,
  WorkflowOpeningPlaceholder,
  useWorkflowSnapshot,
  workflowAddress,
  workflowStatus,
} from "./workflow-access";
import { WorkflowConfirmation } from "./workflow-confirmation";
import { useWorkflowReferences } from "./use-workflow-references";
import styles from "./workflow-workspace.module.css";

export function WorkflowWorkspace({
  workflowId,
  draftId,
}: {
  workflowId?: string;
  draftId?: string;
}) {
  return (
    <WorkflowAccess editor>
      {(owner) => (
        <WorkspaceView
          key={`${workflowId ?? "draft"}:${draftId ?? ""}`}
          owner={owner}
          workflowId={workflowId}
          draftId={draftId}
        />
      )}
    </WorkflowAccess>
  );
}
function WorkspaceView({
  owner,
  workflowId,
  draftId,
}: {
  owner: Owner;
  workflowId?: string;
  draftId?: string;
}) {
  const state = useWorkflowSnapshot(owner);
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [focusField, setFocusField] = useState<WorkflowFieldFocus | null>(null);
  const focusToken = useRef(0);
  const select = useCallback((id: string | null) => {
    setFocusField(null);
    setSelected(id);
  }, []);
  const focusSetting = useCallback((nodeId: string, field: string) => {
    setSelected(nodeId);
    setFocusField({ nodeId, field, token: ++focusToken.current });
  }, []);
  const [opening, setOpening] = useState(true);
  const [switchRequired, setSwitchRequired] = useState(false);
  const [confirmation, setConfirmation] = useState<WorkflowCommand | "reload" | "duplicate" | null>(
    null,
  );
  const [cancelPending, setCancelPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const lifetime = useRef(0);
  useEffect(() => {
    lifetime.current += 1;
    return () => {
      lifetime.current += 1;
    };
  }, []);
  const open = useCallback(
    (discard = false) => {
      const generation = lifetime.current;
      const before = owner.getSnapshot().editor;
      const retained =
        before &&
        (workflowId
          ? before.workflowId === workflowId
          : before.target.kind === "draft" && before.target.id === draftId);
      return Promise.resolve()
        .then(() => {
          if (generation !== lifetime.current || !owner.isCurrent()) return "stale";
          return workflowId
            ? owner.openWorkflow(workflowId, discard)
            : owner.openNew(draftId!, undefined, discard);
        })
        .then(async (result) => {
          if (generation !== lifetime.current || !owner.isCurrent()) return;
          setNotice(null);
          setSwitchRequired(result === "discard_required");
          if (result === "opened" && retained && !discard && before.workflowId)
            await owner.loadDetail();
        })
        .catch(() => {
          if (generation === lifetime.current && owner.isCurrent()) {
            setSwitchRequired(false);
            setNotice(
              owner.getSnapshot().editor
                ? "This workflow could not be opened. Your retained draft is still available."
                : "This workflow could not be opened.",
            );
          }
        })
        .finally(() => {
          if (generation === lifetime.current && owner.isCurrent()) setOpening(false);
        });
    },
    [owner, workflowId, draftId],
  );
  useEffect(() => {
    void open();
    if (owner.isCurrent()) void owner.loadCatalog().catch(() => {});
  }, [open, owner]);
  const editor = state.editor;
  const matches =
    editor &&
    (workflowId
      ? editor.workflowId === workflowId
      : editor.target.kind === "draft" && editor.target.id === draftId);
  const targetKey = editor ? workflowTargetKey(editor.target) : null;
  const [observedTarget, setObservedTarget] = useState(targetKey);
  if (observedTarget !== targetKey) {
    setObservedTarget(targetKey);
    setConfirmation(null);
    setCancelPending(false);
  }
  const preview = state.mode === "preview";
  const toolGraph = editor ? workflowEditorContent(editor).graph : null;
  const triggers = toolGraph?.nodes.filter((node) => node.type === "trigger") ?? [];
  const eventType = triggers.length === 1 ? triggers[0].config.event_type : null;
  const simulationEntityType =
    eventType && state.catalog && Object.hasOwn(state.catalog.triggers, eventType)
      ? state.catalog.triggers[eventType].simulation_entity_type
      : null;
  const contextKey = JSON.stringify([targetKey, simulationEntityType]);
  const [context, setContext] = useState<{
    key: string;
    value: WorkflowSimulationSelection | null;
  }>(() => ({
    key: contextKey,
    value: {
      context: { kind: "synthetic" },
      label: "Synthetic sample",
      isCurrent: () => owner.isCurrent(),
    },
  }));
  if (context.key !== contextKey)
    setContext({
      key: contextKey,
      value: {
        context: { kind: "synthetic" },
        label: "Synthetic sample",
        isCurrent: () => owner.isCurrent(),
      },
    });
  useLayoutEffect(() => {
    if (!preview && owner.isCurrent() && owner.activity.getSnapshot().storage.isCurrent())
      owner.activity.invalidateSimulation();
  }, [owner, preview, contextKey]);
  const dirty = editor ? workflowEditorDirty(editor) : false;
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const returnToRetained = () => {
    if (editor)
      router.replace(
        editor.workflowId
          ? workflowAddress(editor.workflowId)
          : workflowDraftAddress(editor.target.id),
      );
    else router.replace("/automations");
  };
  if (switchRequired)
    return (
      <WorkflowConfirmation
        title="Discard your unsaved changes?"
        confirmLabel="Discard and open workflow"
        onCancel={returnToRetained}
        onConfirm={() => {
          void open(true);
        }}
      >
        <p>
          Opening another workflow replaces the draft you were editing. Pending actions will still
          keep their result checks.
        </p>
      </WorkflowConfirmation>
    );
  if (opening && !matches) return <WorkflowOpeningPlaceholder editor />;
  if (!editor || !matches)
    return (
      <div className={styles.notice}>
        <p role="alert">{notice ?? "This workflow is unavailable."}</p>
        <button
          onClick={() => {
            void open();
          }}
        >
          Reload workflow
        </button>
        <button onClick={returnToRetained}>
          {editor ? "Return to your draft" : "Back to catalog"}
        </button>
      </div>
    );
  const current = editor.latest;
  const commandTarget = editor.workflowId
    ? { kind: "workflow" as const, id: editor.workflowId }
    : editor.target;
  const operation = owner.pendingOperation(commandTarget);
  const lastOperation =
    operation ??
    state.operations[workflowTargetKey(commandTarget)] ??
    state.operations[workflowTargetKey(editor.target)];
  const archived = current?.status === "archived";
  const locked = Boolean(operation?.locked);
  const canCommand = !preview && !locked && !editor.conflict && !archived;
  const validMetadata =
    workflowTextLength(editor.name.trim()) >= 1 &&
    workflowTextLength(editor.name) <= 120 &&
    workflowTextLength(editor.description) <= 500;
  const issues =
    editor.validation?.result.issues ?? (dirty ? [] : (editor.baseline?.validation_issues ?? []));
  const ownsEditor = () =>
    owner.isCurrent() &&
    owner.getSnapshot().editor?.target.kind === editor.target.kind &&
    owner.getSnapshot().editor?.target.id === editor.target.id;
  const toolsCurrent = () =>
    ownsEditor() && (preview || owner.activity.getSnapshot().storage.isCurrent());
  const selectContext = (value: WorkflowSimulationSelection | null) => {
    if (!toolsCurrent()) return;
    if (!preview) owner.activity.invalidateSimulation();
    setContext({ key: contextKey, value });
  };
  const emailNode = toolGraph?.nodes.find((node) => node.id === selected && node.type === "email");
  const edit: Owner["edit"] = (change) => {
    if (ownsEditor()) owner.edit(change);
  };
  const submit = (command: WorkflowCommand) => {
    if (!ownsEditor()) return;
    setNotice(null);
    setConfirmation(null);
    try {
      void owner.submit(command, { cancelPending }).settled;
    } catch {
      setNotice(
        "This action could not be submitted. Your local changes are still here. Check access, saved changes, and any pending result before continuing.",
      );
    }
  };
  const checks: WorkflowChecks = {
    loading: state.reads.validation.loading,
    error: Boolean(state.reads.validation.error),
    passed: editor.validation?.result.valid === true,
    onCheck: preview
      ? undefined
      : () => {
          const generation = lifetime.current;
          void owner.validate().catch(() => {
            if (generation === lifetime.current && ownsEditor())
              setNotice("Validation is unavailable. Your draft is unchanged.");
          });
        },
  };
  const duplicate = () => {
    if (!ownsEditor()) return;
    const id = crypto.randomUUID();
    const input: WorkflowContent = {
      ...workflowEditorContent(editor),
      name: truncateWorkflowText(`${editor.name} copy`, 120),
    };
    owner.openNew(id, input, true);
    router.push(workflowDraftAddress(id));
    setConfirmation(null);
  };
  return (
    <div className={styles.workspace} data-workflow-workspace={preview ? "preview" : "live"}>
      <div className={styles.topline}>
        <button data-variant="back" onClick={() => router.push("/automations")}>
          ← All workflows
        </button>
        <span className={kit.tag}>{preview ? "Sample workspace" : "Workflow editor"}</span>
      </div>
      {preview ? (
        <p className={styles.notice} data-tone="sample">
          Sample only. Explore and edit these examples here. Saving, publishing, and sending are
          unavailable.
        </p>
      ) : null}
      <section className={`${styles.sheet} ${styles.details}`} aria-label="Workflow details">
        <div className={styles.facts} aria-label="Saved workflow status">
          <span
            className={kit.tag}
            data-tone={current ? workflowStatus[current.status]?.tone : "neutral"}
            data-dot="true"
          >
            {current ? (workflowStatus[current.status]?.label ?? current.status) : "Local draft"}
          </span>
          <span>
            {current?.published_version_number
              ? `Published version ${current.published_version_number}`
              : "No published version"}
          </span>
          <span>
            {current?.pending_run_count ?? 0} waiting · {current?.sending_run_count ?? 0} sending
          </span>
          <p className={styles.saveState} data-dirty={dirty ? "true" : undefined}>
            {dirty ? "Unsaved local changes" : "All local changes saved"}
            {current?.has_unpublished_changes ? " · Saved changes are not published" : ""}
          </p>
        </div>
        <div className={styles.metadata}>
          <label>
            Workflow name
            <input
              value={editor.name}
              disabled={archived}
              onChange={(event) =>
                edit({ kind: "metadata", name: truncateWorkflowText(event.target.value, 120) })
              }
              aria-invalid={!editor.name.trim()}
            />
            <small>{workflowTextLength(editor.name)} / 120 characters</small>
          </label>
          <label>
            Description
            <textarea
              value={editor.description}
              disabled={archived}
              onChange={(event) =>
                edit({
                  kind: "metadata",
                  description: truncateWorkflowText(event.target.value, 500),
                })
              }
            />
            <small>{workflowTextLength(editor.description)} / 500 characters</small>
          </label>
        </div>
        {editor.conflict ? (
          <p className={styles.notice} data-tone="alert" role="alert">
            This workflow changed since you opened it. Your edits are preserved. Review the current
            status, then discard and reload before making another change.
          </p>
        ) : null}
        <div className={styles.commandBar}>
          <div className={styles.actions}>
            <button
              data-variant="primary"
              disabled={!canCommand || !validMetadata || !dirty}
              onClick={() => submit(editor.workflowId ? "workflow.save" : "workflow.create")}
            >
              Save draft
            </button>
            <button
              disabled={!canCommand || !editor.workflowId || dirty}
              onClick={() => {
                setCancelPending(false);
                setConfirmation("workflow.publish");
              }}
            >
              Publish
            </button>
            <button
              disabled={
                !canCommand ||
                !current?.published_version_number ||
                current.status === "active" ||
                state.catalog?.capabilities.can_start !== true
              }
              onClick={() => setConfirmation("workflow.start")}
            >
              Start
            </button>
            <button
              disabled={
                !canCommand || !current?.published_version_number || current.status === "paused"
              }
              onClick={() => setConfirmation("workflow.pause")}
            >
              Pause
            </button>
          </div>
          <div className={styles.actions} data-group="secondary">
            <button
              data-variant="quiet"
              disabled={preview || !editor.workflowId || state.reads.detail.loading}
              onClick={() => {
                if (owner.isCurrent()) void owner.loadDetail().catch(() => {});
                if (owner.isCurrent()) void owner.loadCatalog().catch(() => {});
              }}
            >
              Refresh status
            </button>
            <button
              data-variant="quiet"
              disabled={locked || !editor.workflowId || opening}
              onClick={() => setConfirmation("reload")}
            >
              Discard and reload
            </button>
            <button
              data-variant="quiet"
              disabled={locked}
              onClick={() => setConfirmation("duplicate")}
            >
              Duplicate draft
            </button>
            <button
              data-variant="danger"
              disabled={!canCommand || !editor.workflowId}
              onClick={() => setConfirmation("workflow.archive")}
            >
              Archive
            </button>
          </div>
        </div>
        {!preview && state.catalog?.capabilities.can_start === false ? (
          <p className={styles.muted}>
            {state.catalog.capabilities.disabled_reason?.trim() ||
              "Starting is unavailable right now."}
          </p>
        ) : null}
        {state.reads.detail.error ? (
          <p role="alert">
            Current workflow status could not be refreshed. The last loaded status is shown.
          </p>
        ) : null}
        {notice ? <p role="alert">{notice}</p> : null}
        {lastOperation ? (
          <div className={styles.notice} role="status">
            {lastOperation.status === "resolved"
              ? "Action completed. Current workflow status is loaded."
              : lastOperation.status === "definitely_rejected"
                ? "The action was not accepted. Your changes are preserved."
                : lastOperation.status === "submitting"
                  ? "An action is still being confirmed. You can keep editing this draft."
                  : "The result is not confirmed yet. Check the previous action before saving or changing a workflow. Your current draft is preserved."}
            {lastOperation.locked && lastOperation.status !== "submitting" ? (
              <button
                disabled={
                  lastOperation.status === "checking_receipt" || state.reads.current_detail.loading
                }
                onClick={() => {
                  if (owner.isCurrent()) void owner.reconcile(lastOperation.target).catch(() => {});
                }}
              >
                Check result
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
      {state.reads.catalog.error ? (
        <div className={styles.notice} role="alert">
          Workflow choices could not be loaded. Your saved choices are preserved.{" "}
          <button
            onClick={() => {
              if (owner.isCurrent()) void owner.loadCatalog().catch(() => {});
            }}
          >
            Reload choices
          </button>
        </div>
      ) : null}
      {state.catalog ? (
        <EditorBody
          owner={owner}
          selected={selected}
          onSelect={select}
          focusField={focusField}
          onFocusField={focusSetting}
          checks={checks}
          issues={issues}
          disabled={Boolean(archived)}
        />
      ) : (
        <WorkflowEditorPlaceholder />
      )}
      {toolGraph ? (
        <div className={styles.workflowTools}>
          <WorkflowSimulationPanel
            activity={owner.activity}
            workflowId={editor.workflowId}
            graph={toolGraph}
            catalog={state.catalog}
            selection={context.value}
            onSelectionChange={selectContext}
            onSelectNode={select}
            isCurrent={toolsCurrent}
            preview={preview}
          />
          <WorkflowRunHistory
            activity={owner.activity}
            workflowId={editor.workflowId}
            catalog={state.catalog}
            simulationEntityType={simulationEntityType}
            onUseRecord={selectContext}
            isCurrent={toolsCurrent}
            preview={preview}
          />
          <WorkflowTestEmailPanel
            activity={owner.activity}
            workflowId={editor.workflowId}
            graph={toolGraph}
            emailNodeId={emailNode?.id ?? null}
            canTestEmail={state.catalog?.capabilities.can_test_email === true}
            disabledReason={state.catalog?.capabilities.disabled_reason ?? null}
            isCurrent={toolsCurrent}
            preview={preview}
          />
        </div>
      ) : null}
      {confirmation ? (
        <WorkflowConfirmation
          title={
            confirmation === "reload"
              ? "Discard and reload?"
              : confirmation === "duplicate"
                ? "Create a separate draft?"
                : `${confirmation.slice(9).replace(/^./, (c) => c.toUpperCase())} workflow?`
          }
          confirmLabel={
            confirmation === "reload"
              ? "Discard and reload"
              : confirmation === "duplicate"
                ? "Create local copy"
                : `Confirm ${confirmation.slice(9)}`
          }
          disabled={confirmation !== "reload" && confirmation !== "duplicate" && !canCommand}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            if (!ownsEditor()) return;
            if (confirmation === "reload") {
              setConfirmation(null);
              const id = editor.workflowId!;
              const generation = lifetime.current;
              setOpening(true);
              void owner
                .openWorkflow(id, true)
                .then((result) => {
                  if (
                    result === "opened" &&
                    generation === lifetime.current &&
                    owner.isCurrent() &&
                    draftId
                  )
                    router.replace(workflowAddress(id));
                })
                .catch(() => {
                  if (generation === lifetime.current && owner.isCurrent())
                    setNotice("Reload failed. Your retained content is unchanged.");
                })
                .finally(() => {
                  if (generation === lifetime.current && owner.isCurrent()) setOpening(false);
                });
            } else if (confirmation === "duplicate") duplicate();
            else submit(confirmation);
          }}
        >
          {confirmation === "workflow.publish" ? (
            <>
              <p>
                {current?.published_version_number
                  ? current.status === "active"
                    ? "Future events will use the new published version while this workflow stays active."
                    : "The new published version will stay paused until you start it."
                  : "The first published version starts paused. Publishing will not enroll past events."}{" "}
                Waiting runs keep their original published version unless you cancel them below.
              </p>
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={cancelPending}
                  onChange={(event) => setCancelPending(event.target.checked)}
                />
                Cancel pending runs from earlier versions
              </label>
            </>
          ) : confirmation === "workflow.start" ? (
            <p>
              Start published version {current?.published_version_number} for future events. Unsaved
              local edits are excluded.
            </p>
          ) : confirmation === "workflow.pause" ? (
            <p>
              Pause future work and cancel pending work. Email already in flight may still arrive.
            </p>
          ) : confirmation === "workflow.archive" ? (
            <p>
              Archive this workflow permanently and cancel pending work. Email already in flight may
              still arrive. An archived workflow can only be copied into a new draft.
            </p>
          ) : confirmation === "reload" ? (
            <p>
              Replace your local graph, layout, name, and description with the latest saved draft.
              This also clears local Undo history.
            </p>
          ) : (
            <p>
              Copy the current graph, layout, and text into a local draft. This draft gets a saved
              record only when you choose Save draft.
            </p>
          )}
        </WorkflowConfirmation>
      ) : null}
    </div>
  );
}

function EditorBody({
  owner,
  selected,
  onSelect,
  focusField,
  onFocusField,
  checks,
  issues,
  disabled,
}: {
  owner: Owner;
  selected: string | null;
  onSelect: (id: string | null) => void;
  focusField: WorkflowFieldFocus | null;
  onFocusField: (nodeId: string, field: string) => void;
  checks: WorkflowChecks;
  issues: Parameters<typeof WorkflowGraphEditor>[0]["issues"];
  disabled: boolean;
}) {
  const state = useWorkflowSnapshot(owner);
  const preview = state.mode === "preview";
  const { references, reloadRanks, reloadPrograms } = useWorkflowReferences(owner, preview);
  const editor = state.editor!;
  const selectedNode =
    selected !== null && editor.history.present.graph.nodes.some((node) => node.id === selected);
  // Closing settings unmounts the panel; focus goes back to the step it described.
  const grid = useRef<HTMLDivElement>(null);
  const closeSettings = () => {
    const id = selected;
    onSelect(null);
    requestAnimationFrame(() => {
      const root = grid.current;
      if (!root) return;
      const target =
        (id &&
          (root.querySelector<HTMLElement>(`[data-workflow-step="${id}"]`) ??
            root.querySelector<HTMLElement>(`[data-testid="rf__node-${id}"]`))) ||
        root.querySelector<HTMLElement>('[aria-label="Editor view"] button[aria-pressed="true"]');
      target?.focus();
    });
  };
  const edit: Owner["edit"] = (change) => {
    const current = owner.getSnapshot().editor;
    if (
      owner.isCurrent() &&
      current &&
      workflowTargetKey(current.target) === workflowTargetKey(editor.target)
    )
      owner.edit(change);
  };
  return (
    <>
      {!preview &&
      (references["promotion.rank_id"]?.status === "unavailable" ||
        references["program.id"]?.status === "unavailable") ? (
        <div className={styles.notice} role="alert">
          Some program or rank choices could not be loaded. Saved choices remain in the draft.
          <div className={styles.actions}>
            {references["promotion.rank_id"]?.status === "unavailable" ? (
              <button onClick={reloadRanks}>Reload ranks</button>
            ) : null}
            {references["program.id"]?.status === "unavailable" ? (
              <button onClick={reloadPrograms}>Reload programs</button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div ref={grid} className={styles.editorGrid} data-selected={selectedNode ? "true" : "false"}>
        <WorkflowGraphEditor
          draft={editor.history.present}
          selectedNodeId={selected}
          onSelectNode={onSelect}
          onEdit={edit}
          onUndo={() => edit({ kind: "undo" })}
          onRedo={() => edit({ kind: "redo" })}
          canUndo={editor.history.past.length > 0}
          canRedo={editor.history.future.length > 0}
          disabled={disabled}
          issues={issues}
          checks={checks}
          onFocusField={onFocusField}
          presentation={{ catalog: state.catalog!, references }}
        />
        {selectedNode ? (
          <WorkflowNodeInspector
            draft={editor.history.present}
            selectedNodeId={selected}
            onClose={closeSettings}
            onEdit={edit}
            disabled={disabled}
            issues={issues}
            focusField={focusField}
            docked
            catalog={state.catalog!}
            references={references}
          />
        ) : null}
      </div>
    </>
  );
}

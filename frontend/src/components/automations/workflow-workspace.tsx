"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useBeltStore, useConfigStore, useProgramStore, useStudioStore } from "@/lib/store";
import {
  getBrowserWorkflowWorkspace,
  type WorkflowWorkspace as Owner,
} from "@/lib/automation-workflow-workspace-controller";
import {
  workflowDraftAddress,
  workflowEditorContent,
  workflowEditorDirty,
  workflowTargetKey,
  type WorkflowContent,
} from "@/lib/automation-workflow-workspace-state";
import { truncateWorkflowText, workflowTextLength } from "@/lib/automation-workflow-model";
import {
  workflowPreviewSource,
  workflowPreviewReferences,
} from "@/lib/automation-workflow-preview";
import type { WorkflowCommand } from "@/lib/automation-workflow-types";
import type { WorkflowReferenceChoices } from "@/lib/automation-workflow-catalog";
import { WorkflowSimulationPanel } from "./workflow-simulation-panel";
import { WorkflowRunHistory } from "./workflow-run-history";
import { WorkflowTestEmailPanel } from "./workflow-test-email-panel";
import type { WorkflowSimulationSelection } from "./workflow-simulation-context-picker";
import { WorkflowGraphEditor } from "./workflow-graph-editor";
import { WorkflowNodeInspector } from "./workflow-node-inspector";
import styles from "./workflow-workspace.module.css";
import graphStyles from "./workflow-graph-editor.module.css";
import inspectorStyles from "./workflow-node-inspector.module.css";

export const validWorkflowId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const workflowAddress = (id: string) => {
  if (!validWorkflowId(id)) throw new Error("This workflow address is unavailable.");
  return `/automations/${id}`;
};
export const useWorkflowSnapshot = (owner: Owner) =>
  useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);

// The browser registry owns commands. A route owns only this subscription and its presentation.
export function WorkflowAccess({
  children,
  editor = false,
}: {
  children: (owner: Owner) => ReactNode;
  editor?: boolean;
}) {
  const { isPreviewMode, token, subscriptionRequired } = useConfigStore();
  const { identityReady, identityGeneration, currentRole, currentStudioId, currentUserId } =
    useStudioStore();
  if (!isPreviewMode && (!identityReady || subscriptionRequired))
    return <p role="status">Checking studio access...</p>;
  if (!isPreviewMode && currentRole !== "admin")
    return <p className={styles.notice}>An Admin can create and manage workflows.</p>;
  if (!isPreviewMode && (!token || !currentStudioId || !currentUserId))
    return <p role="status">Waiting for your studio...</p>;
  return (
    <BrowserOwner
      key={JSON.stringify([
        isPreviewMode,
        currentUserId,
        currentStudioId,
        currentRole,
        identityGeneration,
      ])}
      preview={isPreviewMode}
      token={token ?? ""}
      userId={currentUserId}
      studioId={currentStudioId ?? ""}
      editor={editor}
    >
      {children}
    </BrowserOwner>
  );
}
function BrowserOwner({
  preview,
  token,
  userId,
  studioId,
  editor,
  children,
}: {
  preview: boolean;
  token: string;
  userId: string;
  studioId: string;
  editor: boolean;
  children: (owner: Owner) => ReactNode;
}) {
  const [owner, setOwner] = useState<Owner | null>(null);
  const [failed, setFailed] = useState(false);
  const initialToken = useRef(token);
  useEffect(() => {
    try {
      setOwner(
        getBrowserWorkflowWorkspace(
          preview
            ? { mode: "preview", source: workflowPreviewSource }
            : {
                mode: "live",
                owner: { userId, studioId, role: "admin" },
                token: initialToken.current,
              },
        ),
      );
    } catch {
      setFailed(true);
    }
  }, [preview, studioId, userId]);
  useLayoutEffect(() => {
    owner?.updateToken(token);
  }, [owner, token]);
  if (failed)
    return <p role="alert">Verify your current studio access before opening workflows.</p>;
  return owner ? (
    <CurrentOwner owner={owner}>{children}</CurrentOwner>
  ) : (
    <WorkflowOpeningPlaceholder editor={editor} />
  );
}

function WorkflowEditorPlaceholder() {
  return (
    <div
      className={`${styles.editorGrid} koaryu-skeleton-reveal`}
      role="status"
      aria-label="Loading workflow canvas"
      aria-busy="true"
    >
      <div className={graphStyles.editor} aria-hidden="true">
        <div className={graphStyles.heading}>
          <h2>Workflow steps</h2>
        </div>
        <div className="mb-4 h-11 rounded bg-surface-raised" />
        <div className={`${graphStyles.canvas} bg-surface-raised`} />
      </div>
      <div className={inspectorStyles.inspector} aria-hidden="true">
        <div className={inspectorStyles.header}>
          <h2>Step settings</h2>
        </div>
        <div className={inspectorStyles.fields}>
          {[0, 1, 2].map((field) => (
            <div key={field} className="h-16 rounded bg-surface-raised" />
          ))}
        </div>
      </div>
    </div>
  );
}

function WorkflowOpeningPlaceholder({ editor }: { editor: boolean }) {
  const router = useRouter();
  const { isPreviewMode } = useConfigStore();
  if (!editor)
    return (
      <div
        className={`${styles.catalog} koaryu-skeleton-reveal`}
        role="status"
        aria-label="Opening workflows"
        aria-busy="true"
      >
        <div className={styles.templates} aria-hidden="true">
          {[0, 1, 2].map((card) => (
            <div key={card} className={`${styles.card} h-48 bg-surface-raised`} />
          ))}
        </div>
      </div>
    );
  return (
    <div className={styles.workspace}>
      <div className={styles.topline}>
        <button onClick={() => router.push("/automations")}>← All workflows</button>
        <span>{isPreviewMode ? "Sample workspace" : "Workflow editor"}</span>
      </div>
      {isPreviewMode ? (
        <p className={styles.notice}>
          Sample only. Explore and edit these examples here. Saving, publishing, and sending are
          unavailable.
        </p>
      ) : null}
      <section
        className={`${styles.sheet} koaryu-skeleton-reveal`}
        role="status"
        aria-label="Loading workflow"
        aria-busy="true"
      >
        <div className={styles.metadata} aria-hidden="true">
          <div className="space-y-2">
            <div className="h-5 w-32 rounded bg-surface-raised" />
            <div className="h-11 rounded bg-surface-raised" />
            <div className="h-4 w-28 rounded bg-surface-raised" />
          </div>
          <div className="space-y-2">
            <div className="h-5 w-32 rounded bg-surface-raised" />
            <div className="h-[70px] rounded bg-surface-raised" />
            <div className="h-4 w-28 rounded bg-surface-raised" />
          </div>
        </div>
        <div className="h-7 w-2/3 rounded bg-surface-raised" aria-hidden="true" />
        <div className="h-5 w-48 rounded bg-surface-raised" aria-hidden="true" />
        {[0, 1].map((row) => (
          <div key={row} className={styles.actions} aria-hidden="true">
            {[0, 1, 2].map((button) => (
              <div key={button} className="h-11 w-32 rounded bg-surface-raised" />
            ))}
          </div>
        ))}
      </section>
      <WorkflowEditorPlaceholder />
    </div>
  );
}
function CurrentOwner({
  owner,
  children,
}: {
  owner: Owner;
  children: (owner: Owner) => ReactNode;
}) {
  const state = useWorkflowSnapshot(owner);
  return state.accessible ? (
    children(owner)
  ) : (
    <p role="alert">Your studio access changed. Reload this page to continue.</p>
  );
}

export function WorkflowConfirmation({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  disabled = false,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        dialog.current?.close();
        onCancel();
      }}
    >
      <h2>{title}</h2>
      <div className={styles.dialogBody}>{children}</div>
      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => {
            dialog.current?.close();
            onCancel();
          }}
          autoFocus
        >
          Keep editing
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            dialog.current?.close();
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

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
          {editor ? "Return to retained draft" : "Back to catalog"}
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
        <button onClick={() => router.push("/automations")}>← All workflows</button>
        <span>{preview ? "Sample workspace" : "Workflow editor"}</span>
      </div>
      {preview ? (
        <p className={styles.notice}>
          Sample only. Explore and edit these examples here. Saving, publishing, and sending are
          unavailable.
        </p>
      ) : null}
      <section className={styles.sheet} aria-label="Workflow details">
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
        <div className={styles.facts} aria-label="Saved workflow status">
          <strong>{current?.status ?? "Local draft"}</strong>
          <span>
            {current?.published_version_number
              ? `Published version ${current.published_version_number}`
              : "No published version"}
          </span>
          <span>
            {current?.pending_run_count ?? 0} waiting · {current?.sending_run_count ?? 0} sending
          </span>
        </div>
        <p className={styles.muted}>
          {dirty ? "Unsaved local changes" : "All local changes saved"}
          {current?.has_unpublished_changes ? " · Saved changes are not published" : ""}
        </p>
        {editor.conflict ? (
          <p role="alert">
            This workflow changed since you opened it. Your edits are preserved. Review the current
            status, then discard and reload before making another change.
          </p>
        ) : null}
        <div className={styles.actions}>
          <button
            disabled={!canCommand || !validMetadata || !dirty}
            onClick={() => submit(editor.workflowId ? "workflow.save" : "workflow.create")}
          >
            Save draft
          </button>
          <button
            disabled={preview || state.reads.validation.loading}
            onClick={() => {
              const generation = lifetime.current;
              void owner.validate().catch(() => {
                if (generation === lifetime.current && ownsEditor())
                  setNotice("Validation is unavailable. Your draft is unchanged.");
              });
            }}
          >
            Check workflow
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
          <button
            disabled={!canCommand || !editor.workflowId}
            onClick={() => setConfirmation("workflow.archive")}
          >
            Archive
          </button>
          <button disabled={locked} onClick={() => setConfirmation("duplicate")}>
            Duplicate draft
          </button>
        </div>
        {!preview && state.catalog?.capabilities.can_start === false ? (
          <p className={styles.muted}>
            {state.catalog.capabilities.disabled_reason?.trim() ||
              "Starting is unavailable right now."}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button
            disabled={preview || !editor.workflowId || state.reads.detail.loading}
            onClick={() => {
              if (owner.isCurrent()) void owner.loadDetail().catch(() => {});
              if (owner.isCurrent()) void owner.loadCatalog().catch(() => {});
            }}
          >
            Refresh status
          </button>
          <button
            disabled={locked || !editor.workflowId || opening}
            onClick={() => setConfirmation("reload")}
          >
            Discard and reload
          </button>
        </div>
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
          onSelect={setSelected}
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
            onSelectNode={setSelected}
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
      <section className={styles.sheet} aria-label="Workflow checks">
        <h2>Workflow checks</h2>
        {state.reads.validation.error ? (
          <p role="alert">Checks could not be completed. Try Check workflow again.</p>
        ) : null}
        {issues.length ? (
          <ul>
            {issues.map((issue, index) => (
              <li key={index}>
                {issue.node_id ? (
                  <button onClick={() => setSelected(issue.node_id)}>{issue.message}</button>
                ) : (
                  issue.message
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>
            {editor.validation?.result.valid
              ? "Workflow checks passed."
              : "Save an incomplete draft at any time. Check the workflow before publishing."}
          </p>
        )}
      </section>
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
  issues,
  disabled,
}: {
  owner: Owner;
  selected: string | null;
  onSelect: (id: string | null) => void;
  issues: Parameters<typeof WorkflowGraphEditor>[0]["issues"];
  disabled: boolean;
}) {
  const state = useWorkflowSnapshot(owner);
  const { programs, programsLoaded, programsLoadError, programsUsageLoadError, refreshPrograms } =
    useProgramStore();
  const { refreshBeltLadders } = useBeltStore();
  const [ranks, setRanks] = useState<NonNullable<WorkflowReferenceChoices["promotion.rank_id"]>>({
    status: "loading",
    choices: [],
  });
  const [programRead, setProgramRead] = useState<"idle" | "loading" | "unavailable">("idle");
  const requestedPrograms = useRef(false);
  const sequence = useRef(0);
  const preview = state.mode === "preview";
  const loadRanks = useCallback(() => {
    if (!owner.isCurrent()) return Promise.resolve();
    const request = ++sequence.current;
    return refreshBeltLadders()
      .then((result) => {
        if (request !== sequence.current || !owner.isCurrent()) return;
        setRanks({
          status: "ready",
          choices: result.ladders.flatMap((ladder) =>
            ladder.ranks.map((rank) => ({ id: rank.id, label: `${ladder.name}: ${rank.name}` })),
          ),
        });
      })
      .catch(() => {
        if (request === sequence.current && owner.isCurrent())
          setRanks((previous) => ({ ...previous, status: "unavailable" }));
      });
  }, [owner, refreshBeltLadders]);
  useEffect(() => {
    if (!preview) void loadRanks();
    return () => {
      sequence.current += 1;
    };
  }, [preview, loadRanks]);
  const programLifetime = useRef(0);
  useEffect(() => {
    programLifetime.current += 1;
    return () => {
      programLifetime.current += 1;
    };
  }, []);
  const loadPrograms = useCallback(async () => {
    if (!owner.isCurrent()) return;
    const generation = programLifetime.current;
    setProgramRead("loading");
    try {
      await refreshPrograms({ includeArchived: true, force: true });
      if (generation === programLifetime.current && owner.isCurrent()) setProgramRead("idle");
    } catch {
      if (generation === programLifetime.current && owner.isCurrent())
        setProgramRead("unavailable");
    }
  }, [owner, refreshPrograms]);
  useEffect(() => {
    if (!preview && !programsLoaded && !programsLoadError && !requestedPrograms.current) {
      requestedPrograms.current = true;
      void loadPrograms();
    }
    return () => {
      requestedPrograms.current = false;
    };
  }, [preview, programsLoaded, programsLoadError, loadPrograms]);
  const references: WorkflowReferenceChoices = preview
    ? workflowPreviewReferences
    : {
        "program.id": {
          status:
            programRead === "loading"
              ? "loading"
              : programsLoadError || programsUsageLoadError || programRead === "unavailable"
                ? "unavailable"
                : programsLoaded
                  ? "ready"
                  : "loading",
          choices: programs
            .filter((program) => !program.archived_at)
            .map((program) => ({ id: program.id, label: program.name })),
        },
        "promotion.rank_id": ranks,
      };
  const editor = state.editor!;
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
      (ranks.status === "unavailable" || references["program.id"]?.status === "unavailable") ? (
        <div className={styles.notice} role="alert">
          Some program or rank choices could not be loaded. Saved choices remain in the draft.
          <div className={styles.actions}>
            {ranks.status === "unavailable" ? (
              <button
                onClick={() => {
                  setRanks((previous) => ({ ...previous, status: "loading" }));
                  void loadRanks();
                }}
              >
                Reload ranks
              </button>
            ) : null}
            {references["program.id"]?.status === "unavailable" ? (
              <button
                onClick={() => {
                  void loadPrograms();
                }}
              >
                Reload programs
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className={styles.editorGrid}>
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
          presentation={{ catalog: state.catalog!, references }}
        />
        <WorkflowNodeInspector
          draft={editor.history.present}
          selectedNodeId={selected}
          onClose={() => onSelect(null)}
          onEdit={edit}
          disabled={disabled}
          issues={issues}
          catalog={state.catalog!}
          references={references}
        />
      </div>
    </>
  );
}

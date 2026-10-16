"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useConfigStore, useStudioStore } from "@/lib/store";
import {
  getBrowserWorkflowWorkspace,
  type WorkflowWorkspace as Owner,
} from "@/lib/automation-workflow-workspace-controller";
import { workflowPreviewSource } from "@/lib/automation-workflow-preview";
import type { WorkflowSummary } from "@/lib/automation-workflow-types";
import kit from "@/components/ui/horizon.module.css";
import styles from "./workflow-workspace.module.css";
import graphStyles from "./workflow-graph-editor.module.css";

/*
 * Access to the browser workflow workspace: who may open it, the owner subscription, and
 * the placeholders shown while it opens. Shared by the catalog and the editor routes, so
 * the catalog page does not pull in the editor to get at them.
 */

export const validWorkflowId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const workflowAddress = (id: string) => {
  if (!validWorkflowId(id)) throw new Error("This workflow address is unavailable.");
  return `/automations/${id}`;
};
/** Status words for a workflow; the words carry the state and the tone only reinforces it. */
export const workflowStatus: Record<
  WorkflowSummary["status"],
  { label: string; tone: "alert" | "warn" | "calm" | "neutral" }
> = {
  active: { label: "Active", tone: "calm" },
  paused: { label: "Paused", tone: "warn" },
  draft: { label: "Draft", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
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

export function WorkflowEditorPlaceholder() {
  return (
    <div
      className={`${styles.editorGrid} koaryu-skeleton-reveal`}
      role="status"
      aria-label="Loading workflow steps"
      aria-busy="true"
    >
      <div className={graphStyles.editor} aria-hidden="true">
        <div className={graphStyles.heading}>
          <h2>Workflow steps</h2>
        </div>
        <div className="mb-4 h-11 rounded bg-surface-raised" />
        <ol className={graphStyles.steps}>
          {[0, 1, 2].map((row) => (
            <li key={row} className={graphStyles.step}>
              <div className="h-4 w-24 rounded bg-surface-hover" />
              <div className="mt-2 h-3 w-3/4 rounded bg-surface-hover" />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function WorkflowOpeningPlaceholder({ editor }: { editor: boolean }) {
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
        <button data-variant="back" onClick={() => router.push("/automations")}>
          ← All workflows
        </button>
        <span className={kit.tag}>{isPreviewMode ? "Sample workspace" : "Workflow editor"}</span>
      </div>
      {isPreviewMode ? (
        <p className={styles.notice} data-tone="sample">
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

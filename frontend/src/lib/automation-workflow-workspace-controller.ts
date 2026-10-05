"use client";

import { ApiError } from "@/lib/api";
import { captureAccessIdentity, invalidateAccessIdentity } from "@/lib/access-identity";
import { withCurrentLiveAuthRead } from "@/lib/store-action-types";
import { getActiveStudioIdCookie } from "@/lib/studio-state-cookie";
import {
  assertWorkflowCommandResult,
  assertWorkflowCatalog,
  assertWorkflowDetail,
  assertWorkflowReceipt,
  checkedWorkflowBody,
  isWorkflowCommand,
  workflowApi,
  workflowCreateBody,
  workflowSaveBody,
} from "./automation-workflow-api.ts";
import {
  acknowledgeWorkflowOperation,
  editWorkflowEditor,
  fenceWorkflowWorkspace,
  initialWorkflowWorkspace,
  newWorkflowEditor,
  observeWorkflowDetail,
  workflowEditorContent,
  workflowEditorDirty,
  workflowTargetKey,
  type WorkflowContent,
  type WorkflowOperation,
  type WorkflowReadKind,
  type WorkflowTarget,
  type WorkflowWorkspaceState,
} from "./automation-workflow-workspace-state.ts";
import type {
  WorkflowCatalogResponse,
  WorkflowCommand,
  WorkflowDetail,
  WorkflowListResponse,
} from "./automation-workflow-types.ts";

export const WORKFLOW_JOURNAL_KEY = "koaryu-workflow-operations-v1";
export const WORKFLOW_JOURNAL_LIMIT = 100;
export type WorkflowOwner = { userId: string; studioId: string; role: string };
type Marker = {
  operation_id: string;
  command: WorkflowCommand;
  target: WorkflowTarget;
  owner_user_id: string;
  owner_studio_id: string;
  workflow_id?: string;
};
type Authority = ReturnType<typeof captureAccessIdentity>;
export type WorkflowWorkspaceDependencies = {
  api: typeof workflowApi;
  capture: typeof captureAccessIdentity;
  invalidate: typeof invalidateAccessIdentity;
  activeStudio: typeof getActiveStudioIdCookie;
  storage: () => Pick<Storage, "getItem" | "setItem">;
  uuid: () => string;
};
const defaults: WorkflowWorkspaceDependencies = {
  api: workflowApi,
  capture: captureAccessIdentity,
  invalidate: invalidateAccessIdentity,
  activeStudio: getActiveStudioIdCookie,
  storage: () => window.sessionStorage,
  uuid: () => crypto.randomUUID(),
};
export type WorkflowPreviewSource = {
  catalog: WorkflowCatalogResponse;
  list: WorkflowListResponse;
  details: Readonly<Record<string, WorkflowDetail>>;
};
export type WorkflowWorkspaceOptions =
  | { mode: "live"; owner: WorkflowOwner; token: string }
  | { mode: "preview"; source: WorkflowPreviewSource };
export type WorkflowCommandHandle = {
  readonly operationId: string;
  readonly settled: Promise<void>;
};
type Pending = {
  marker: Marker;
  expectedRevision?: number;
  submittedGeneration?: number;
  restored?: boolean;
  handle: WorkflowCommandHandle;
  recovering: Promise<void> | null;
};
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function marker(value: unknown): value is Marker {
  return (
    record(value) &&
    [
      "command,operation_id,owner_studio_id,owner_user_id,target",
      "command,operation_id,owner_studio_id,owner_user_id,target,workflow_id",
    ].includes(Object.keys(value).sort().join()) &&
    uuid(value.operation_id) &&
    isWorkflowCommand(value.command) &&
    uuid(value.owner_user_id) &&
    uuid(value.owner_studio_id) &&
    record(value.target) &&
    Object.keys(value.target).sort().join() === "id,kind" &&
    uuid(value.target.id) &&
    (value.target.kind === "draft"
      ? value.command === "workflow.create" &&
        (value.workflow_id === undefined || uuid(value.workflow_id))
      : value.target.kind === "workflow" &&
        value.command !== "workflow.create" &&
        value.workflow_id === undefined)
  );
}
function readJournal(storage: Pick<Storage, "getItem" | "setItem">): Marker[] {
  const raw = storage.getItem(WORKFLOW_JOURNAL_KEY);
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (
    !record(value) ||
    Object.keys(value).sort().join() !== "entries,version" ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > WORKFLOW_JOURNAL_LIMIT ||
    !value.entries.every(marker) ||
    new Set(value.entries.map((entry) => entry.operation_id)).size !== value.entries.length ||
    new Set(
      value.entries.map((entry) =>
        JSON.stringify([
          entry.owner_user_id,
          entry.owner_studio_id,
          workflowTargetKey(entry.target),
        ]),
      ),
    ).size !== value.entries.length
  )
    throw new Error(
      "Workflow recovery records are unavailable. Restore access to this browser's session storage before submitting.",
    );
  return value.entries;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Workflow request failed.";

// A view owns a subscription; the browser registry owns this controller and its authority.
export function createWorkflowWorkspace(
  inputOptions: WorkflowWorkspaceOptions,
  dependencies: WorkflowWorkspaceDependencies = defaults,
) {
  const options =
    inputOptions.mode === "live"
      ? { ...inputOptions, owner: { ...inputOptions.owner } }
      : { mode: "preview" as const, source: structuredClone(inputOptions.source) };
  let state = freeze(initialWorkflowWorkspace(options.mode));
  let token = options.mode === "live" ? options.token : "";
  let authority: Authority | null = null;
  let mutationGeneration = 0;
  let editorGeneration = 0;
  const listeners = new Set<() => void>();
  const pending = new Map<string, Pending>();
  const update = (next: WorkflowWorkspaceState) => {
    state = freeze(next);
    for (const listener of [...listeners]) listener();
  };
  const fence = () => {
    token = "";
    authority?.dispose();
    authority = null;
    pending.clear();
    update(fenceWorkflowWorkspace(state));
  };
  if (options.mode === "live") {
    if (options.owner.role !== "admin" || !token)
      throw new Error("Current administrator access is required.");
    try {
      authority = dependencies.capture(options.owner, fence);
    } catch {
      throw new Error("Verify current administrator access before continuing.");
    }
    try {
      for (const entry of readJournal(dependencies.storage())) {
        if (
          entry.owner_user_id !== options.owner.userId ||
          entry.owner_studio_id !== options.owner.studioId
        )
          continue;
        const key = workflowTargetKey(entry.target);
        pending.set(key, {
          marker: entry,
          restored: true,
          handle: { operationId: entry.operation_id, settled: Promise.resolve() },
          recovering: null,
        });
        state = {
          ...state,
          operations: {
            ...state.operations,
            [key]: {
              operationId: entry.operation_id,
              command: entry.command,
              target: entry.target,
              status: "unknown",
              locked: true,
              result: null,
              error: null,
            },
          },
        };
      }
    } catch {
      // Reads and local edits remain available. Every dispatch rechecks storage.
    }
    state = freeze(state);
  } else {
    state = freeze({
      ...state,
      catalog: {
        ...structuredClone(options.source.catalog),
        capabilities: {
          can_start: false,
          can_test_email: false,
          disabled_reason: "Live actions are unavailable in preview.",
        },
      },
      list: structuredClone(options.source.list),
    });
  }
  const live = () => {
    if (options.mode !== "live") throw new Error("Live actions are unavailable in preview.");
    if (!state.accessible || !authority?.isCurrent() || !token || options.owner.role !== "admin")
      throw new Error("Verify current administrator access before continuing.");
    if (dependencies.activeStudio() !== options.owner.studioId) {
      dependencies.invalidate();
      fence();
      throw new Error("The active studio changed. Verify access before continuing.");
    }
    return { token, signal: authority.signal, current: authority.isCurrent };
  };
  const authFailure = (error: unknown, requestToken: string) => {
    if (
      requestToken === token &&
      error instanceof ApiError &&
      [401, 402, 403].includes(error.status)
    ) {
      dependencies.invalidate();
      fence();
    }
  };
  const operation = (key: string, id: string, patch: Partial<WorkflowOperation>) => {
    const existing = state.operations[key];
    if (!state.accessible || existing?.operationId !== id) return;
    update({ ...state, operations: { ...state.operations, [key]: { ...existing, ...patch } } });
  };
  const journal = (entry: Marker, remove = false) => {
    const storage = dependencies.storage();
    const entries = readJournal(storage);
    const exact = (other: Marker) =>
      other.operation_id === entry.operation_id &&
      other.command === entry.command &&
      other.owner_user_id === entry.owner_user_id &&
      other.owner_studio_id === entry.owner_studio_id &&
      workflowTargetKey(other.target) === workflowTargetKey(entry.target) &&
      other.workflow_id === entry.workflow_id;
    const matching = entries.find((other) => other.operation_id === entry.operation_id);
    if (matching && !exact(matching)) throw new Error("Workflow recovery identity does not match.");
    if (remove) {
      storage.setItem(
        WORKFLOW_JOURNAL_KEY,
        JSON.stringify({ version: 1, entries: entries.filter((other) => !exact(other)) }),
      );
    } else {
      if (matching) return;
      if (entries.length >= WORKFLOW_JOURNAL_LIMIT)
        throw new Error(
          "Resolve pending workflow operations before submitting another command. This browser holds 100 recovery records.",
        );
      if (
        entries.some(
          (other) =>
            other.owner_user_id === entry.owner_user_id &&
            other.owner_studio_id === entry.owner_studio_id &&
            workflowTargetKey(other.target) === workflowTargetKey(entry.target),
        )
      )
        throw new Error(
          "This workflow already has an unresolved operation. Check its receipt before continuing.",
        );
      storage.setItem(
        WORKFLOW_JOURNAL_KEY,
        JSON.stringify({ version: 1, entries: [...entries, entry] }),
      );
    }
    const confirmed = readJournal(storage);
    if (remove ? confirmed.some(exact) : !confirmed.some(exact))
      throw new Error("Workflow recovery record could not be persisted.");
  };
  const confirmCreateIdentity = (entry: Pending, result: WorkflowDetail) => {
    if (entry.marker.command !== "workflow.create") return;
    if (entry.marker.workflow_id !== undefined) {
      if (entry.marker.workflow_id !== result.id)
        throw new Error("The create receipt does not match this workflow recovery record.");
      return;
    }
    const storage = dependencies.storage();
    const entries = readJournal(storage);
    const previous = entries.find((item) => item.operation_id === entry.marker.operation_id);
    if (
      !previous ||
      previous.command !== "workflow.create" ||
      previous.owner_user_id !== entry.marker.owner_user_id ||
      previous.owner_studio_id !== entry.marker.owner_studio_id ||
      workflowTargetKey(previous.target) !== workflowTargetKey(entry.marker.target) ||
      (previous.workflow_id !== undefined && previous.workflow_id !== result.id)
    )
      throw new Error("Workflow recovery identity does not match.");
    const next = { ...entry.marker, workflow_id: result.id };
    storage.setItem(
      WORKFLOW_JOURNAL_KEY,
      JSON.stringify({
        version: 1,
        entries: entries.map((item) => (item.operation_id === next.operation_id ? next : item)),
      }),
    );
    const confirmed = readJournal(storage).find((item) => item.operation_id === next.operation_id);
    if (confirmed?.workflow_id !== result.id)
      throw new Error(
        "Workflow identity could not be persisted. Check its receipt before continuing.",
      );
    entry.marker = next;
  };
  const finish = (key: string, entry: Pending, status: "resolved" | "definitely_rejected") => {
    try {
      journal(entry.marker, true);
      operation(key, entry.marker.operation_id, { status, locked: false });
      if (pending.get(key) === entry) pending.delete(key);
    } catch (error) {
      operation(key, entry.marker.operation_id, {
        status: status === "resolved" ? "committed_needs_detail" : status,
        locked: true,
        error: message(error),
      });
    }
  };
  const beginRead = (kind: WorkflowReadKind) => {
    const request = live();
    const generation = mutationGeneration;
    const sequence = state.reads[kind].sequence + 1;
    update({
      ...state,
      reads: { ...state.reads, [kind]: { sequence, loading: true, error: null } },
    });
    return {
      ...request,
      current: () =>
        request.current() &&
        state.accessible &&
        state.reads[kind].sequence === sequence &&
        mutationGeneration === generation,
      finish(error: string | null = null) {
        if (
          !request.current() ||
          state.reads[kind].sequence !== sequence ||
          mutationGeneration !== generation
        )
          return;
        update({
          ...state,
          reads: { ...state.reads, [kind]: { sequence, loading: false, error } },
        });
      },
    };
  };
  const readWithFreshToken = <T>(
    request: ReturnType<typeof beginRead>,
    read: (token: string) => Promise<T>,
  ) =>
    withCurrentLiveAuthRead(
      () => {
        const fresh = live();
        request.token = fresh.token;
        return {
          token: fresh.token,
          isCurrent: request.current,
          canRetryAfterTokenChange: () => request.current() && token !== fresh.token,
        };
      },
      (attempt) => read(attempt.token),
      () => {},
    );
  const currentDetail = async (key: string, entry: Pending) => {
    const op = state.operations[key];
    if (!op?.result) return;
    const committed = op.result;
    const request = beginRead("current_detail");
    try {
      const current = await readWithFreshToken(request, (token) =>
        dependencies.api.detail(committed.id, token, request.signal),
      );
      if (!request.current() || pending.get(key) !== entry) return;
      assertWorkflowDetail(current, committed.id);
      const knownRevision =
        state.editor?.workflowId === current.id ? (state.editor.latest?.revision ?? 0) : 0;
      if (current.revision < Math.max(committed.revision, knownRevision))
        throw new Error(
          "Current workflow detail is older than the committed command. Check again.",
        );
      if (state.editor)
        update({
          ...state,
          editor: acknowledgeWorkflowOperation(
            state.editor,
            op,
            current,
            entry.submittedGeneration,
            entry.restored,
          ),
        });
      finish(key, entry, "resolved");
      request.finish();
    } catch (error) {
      if (!request.current()) return;
      operation(key, entry.marker.operation_id, {
        status: "committed_needs_detail",
        error: message(error),
      });
      request.finish(message(error));
      authFailure(error, request.token);
    }
  };
  const reservation = (target: WorkflowTarget) => {
    const key = workflowTargetKey(target);
    const exact = pending.get(key);
    if (exact) return [key, exact] as const;
    if (target.kind === "workflow")
      return [...pending.entries()].find(
        ([pendingKey, entry]) =>
          (entry.marker.workflow_id ?? state.operations[pendingKey]?.result?.id) === target.id,
      );
    return undefined;
  };
  const reconcile = (target: WorkflowTarget): Promise<void> => {
    live();
    const found = reservation(target);
    if (!found) return Promise.resolve();
    const [key, entry] = found;
    if (entry.recovering) return entry.recovering;
    if (state.operations[key].status === "submitting") return entry.handle.settled;
    const task = async () => {
      if (state.operations[key].status === "definitely_rejected") {
        finish(key, entry, "definitely_rejected");
        return;
      }
      if (state.operations[key].result) {
        await currentDetail(key, entry);
        return;
      }
      const request = beginRead("receipt");
      operation(key, entry.marker.operation_id, { status: "checking_receipt", error: null });
      try {
        const receipt = await readWithFreshToken(request, (token) =>
          dependencies.api.operation(entry.marker.operation_id, token, request.signal),
        );
        if (!request.current() || pending.get(key) !== entry) return;
        assertWorkflowReceipt(receipt, {
          operationId: entry.marker.operation_id,
          command: entry.marker.command,
          id:
            entry.marker.target.kind === "workflow"
              ? entry.marker.target.id
              : entry.marker.workflow_id,
        });
        confirmCreateIdentity(entry, receipt.result);
        operation(key, entry.marker.operation_id, {
          status: "committed_needs_detail",
          result: receipt.result,
        });
        request.finish();
        await currentDetail(key, entry);
      } catch (error) {
        if (!request.current()) return;
        operation(key, entry.marker.operation_id, { status: "unknown", error: message(error) });
        request.finish(message(error));
        authFailure(error, request.token);
      }
    };
    entry.recovering = task().finally(() => {
      if (pending.get(key) === entry) {
        if (state.operations[key]?.status === "checking_receipt")
          operation(key, entry.marker.operation_id, { status: "unknown" });
        entry.recovering = null;
      }
    });
    return entry.recovering;
  };
  const canSwitch = (target: WorkflowTarget, discard: boolean) =>
    !state.editor ||
    workflowTargetKey(state.editor.target) === workflowTargetKey(target) ||
    (target.kind === "workflow" && state.editor.workflowId === target.id) ||
    !workflowEditorDirty(state.editor) ||
    discard;
  const accessible = () => {
    if (!state.accessible) throw new Error("Verify current access before opening this workspace.");
  };
  const controller = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isCurrent: () =>
      options.mode === "preview" || Boolean(state.accessible && authority?.isCurrent()),
    updateToken(next: string) {
      if (options.mode === "live" && state.accessible && authority?.isCurrent()) token = next;
    },
    openNew(draftId: string, input?: WorkflowContent, discard = false) {
      accessible();
      if (!uuid(draftId)) throw new Error("A stable draft UUID is required.");
      const target: WorkflowTarget = { kind: "draft", id: draftId };
      if (!canSwitch(target, discard)) return "discard_required" as const;
      if (
        !discard &&
        state.editor &&
        workflowTargetKey(state.editor.target) === workflowTargetKey(target)
      )
        return "opened" as const;
      const recovery = pending.get(workflowTargetKey(target));
      if (recovery && recovery.submittedGeneration === undefined && input === undefined)
        recovery.submittedGeneration = editorGeneration + 1;
      const known = state.operations[workflowTargetKey(target)]?.result;
      update({
        ...state,
        editor: {
          ...newWorkflowEditor(target, known ? undefined : input, known ?? undefined),
          generation: ++editorGeneration,
        },
      });
      return "opened" as const;
    },
    async openWorkflow(id: string, discard = false) {
      accessible();
      const target: WorkflowTarget = { kind: "workflow", id };
      if (!canSwitch(target, discard)) return "discard_required" as const;
      if (
        !discard &&
        state.editor &&
        (state.editor.workflowId === id ||
          workflowTargetKey(state.editor.target) === workflowTargetKey(target))
      )
        return "opened" as const;
      if (options.mode === "preview") {
        const detail = options.source.details[id];
        if (!detail) throw new Error("This preview workflow is unavailable.");
        update({
          ...state,
          editor: {
            ...newWorkflowEditor(target, undefined, structuredClone(detail)),
            generation: ++editorGeneration,
          },
        });
        return "opened" as const;
      }
      const request = beginRead("detail");
      const previous = state.editor;
      const localGeneration = previous?.generation;
      try {
        const detail = await readWithFreshToken(request, (token) =>
          dependencies.api.detail(id, token, request.signal),
        );
        if (
          !request.current() ||
          state.editor !== previous ||
          state.editor?.generation !== localGeneration
        )
          return "stale" as const;
        assertWorkflowDetail(detail, id);
        update({
          ...state,
          editor: {
            ...newWorkflowEditor(target, undefined, detail),
            generation: ++editorGeneration,
          },
        });
        request.finish();
        return "opened" as const;
      } catch (error) {
        if (request.current()) {
          request.finish(message(error));
          authFailure(error, request.token);
        }
        throw error;
      } finally {
        request.finish();
      }
    },
    edit(change: Parameters<typeof editWorkflowEditor>[1]) {
      accessible();
      if (!state.editor) throw new Error("Open a workflow first.");
      const editor = editWorkflowEditor(state.editor, change);
      if (editor !== state.editor)
        update({ ...state, editor: { ...editor, generation: ++editorGeneration } });
    },
    async loadCatalog() {
      if (options.mode === "preview") return;
      const request = beginRead("catalog");
      try {
        const catalog = await readWithFreshToken(request, (token) =>
          dependencies.api.catalog(token, request.signal),
        );
        if (request.current()) {
          assertWorkflowCatalog(catalog);
          update({ ...state, catalog });
        }
      } catch (error) {
        if (request.current()) {
          request.finish(message(error));
          authFailure(error, request.token);
        }
      } finally {
        request.finish(state.reads.catalog.error);
      }
    },
    async loadList(page: { cursor?: string; limit?: number } = {}) {
      if (options.mode === "preview") return;
      const request = beginRead("list");
      try {
        const list = await readWithFreshToken(request, (token) =>
          dependencies.api.list(page, token, request.signal),
        );
        if (request.current()) update({ ...state, list });
      } catch (error) {
        if (request.current()) {
          request.finish(message(error));
          authFailure(error, request.token);
        }
      } finally {
        request.finish(state.reads.list.error);
      }
    },
    async loadDetail() {
      if (options.mode === "preview") return;
      const editor = state.editor;
      if (!editor?.workflowId) return;
      const request = beginRead("detail");
      try {
        const detail = await readWithFreshToken(request, (token) =>
          dependencies.api.detail(editor.workflowId!, token, request.signal),
        );
        if (
          request.current() &&
          state.editor &&
          workflowTargetKey(state.editor.target) === workflowTargetKey(editor.target)
        ) {
          assertWorkflowDetail(detail, editor.workflowId);
          update({ ...state, editor: observeWorkflowDetail(state.editor, detail) });
        }
      } catch (error) {
        if (request.current()) {
          request.finish(message(error));
          authFailure(error, request.token);
        }
      } finally {
        request.finish(state.reads.detail.error);
      }
    },
    async validate() {
      if (options.mode === "preview")
        throw new Error("Server validation is unavailable in preview.");
      const editor = state.editor;
      if (!editor) return;
      const { graph, layout } = workflowEditorContent(editor);
      const body = checkedWorkflowBody({ graph, layout });
      const request = beginRead("validation");
      try {
        const result = await readWithFreshToken(request, (token) =>
          dependencies.api.validate(body, token, request.signal),
        );
        if (
          request.current() &&
          state.editor?.generation === editor.generation &&
          workflowTargetKey(state.editor.target) === workflowTargetKey(editor.target)
        )
          update({
            ...state,
            editor: { ...state.editor, validation: { generation: editor.generation, result } },
          });
      } catch (error) {
        if (request.current()) {
          request.finish(message(error));
          authFailure(error, request.token);
        }
      } finally {
        request.finish(state.reads.validation.error);
      }
    },
    submit(
      command: WorkflowCommand,
      settings: { cancelPending?: boolean } = {},
    ): WorkflowCommandHandle {
      if (options.mode === "preview") throw new Error("Live actions are unavailable in preview.");
      accessible();
      const editor = state.editor;
      if (!editor) throw new Error("Open a workflow first.");
      // A recovered create still owns its logical draft until its current detail is known.
      const localPending = pending.get(workflowTargetKey(editor.target));
      if (localPending) return localPending.handle;
      const target: WorkflowTarget = editor.workflowId
        ? { kind: "workflow", id: editor.workflowId }
        : editor.target;
      const key = workflowTargetKey(target);
      const existing = reservation(target)?.[1];
      if (existing) return existing.handle;
      if (
        command === "workflow.create"
          ? Boolean(editor.workflowId) || target.kind !== "draft"
          : !editor.workflowId || !editor.baseline
      )
        throw new Error("This command does not match the current workflow.");
      if (editor.conflict)
        throw new Error(
          "This workflow changed on the server. Reload it explicitly before submitting.",
        );
      if (editor.latest?.status === "archived")
        throw new Error("Archived workflows cannot be changed. Duplicate it as a new draft.");
      if (command === "workflow.publish" && workflowEditorDirty(editor))
        throw new Error("Save or explicitly discard local changes before publishing.");
      if (command === "workflow.start" && state.catalog?.capabilities.can_start !== true)
        throw new Error(
          state.catalog?.capabilities.disabled_reason ?? "Starting workflows is unavailable.",
        );
      if (
        [...pending.values()].some(
          (entry) => entry.marker.command === "workflow.create" && !entry.marker.workflow_id,
        )
      )
        throw new Error(
          "Check the unresolved create receipt before submitting another workflow command.",
        );
      const operationId = dependencies.uuid();
      const revision = editor.baseline?.revision;
      const commandRequest = { operation_id: operationId, expected_revision: revision ?? 0 };
      const submitted = workflowEditorContent(editor);
      let dispatch: (token: string, signal: AbortSignal) => Promise<WorkflowDetail>;
      if (command === "workflow.create") {
        const body = workflowCreateBody({ operation_id: operationId, ...submitted });
        dispatch = (token, signal) => dependencies.api.create(body, token, signal);
      } else if (command === "workflow.save") {
        const body = workflowSaveBody({
          operation_id: operationId,
          ...submitted,
          expected_revision: revision!,
        });
        dispatch = (token, signal) => dependencies.api.save(target.id, body, token, signal);
      } else if (command === "workflow.publish") {
        const body = checkedWorkflowBody({
          ...commandRequest,
          cancel_pending: settings.cancelPending ?? false,
        });
        dispatch = (token, signal) => dependencies.api.publish(target.id, body, token, signal);
      } else {
        const body = checkedWorkflowBody(commandRequest);
        const action =
          command === "workflow.start"
            ? "start"
            : command === "workflow.pause"
              ? "pause"
              : "archive";
        dispatch = (token, signal) => dependencies.api[action](target.id, body, token, signal);
      }
      live();
      const entry: Pending = {
        marker: {
          operation_id: operationId,
          command,
          target,
          owner_user_id: options.owner.userId,
          owner_studio_id: options.owner.studioId,
        },
        expectedRevision: revision,
        submittedGeneration: editor.generation,
        handle: { operationId, settled: Promise.resolve() },
        recovering: null,
      };
      journal(entry.marker);
      pending.set(key, entry);
      mutationGeneration += 1;
      update({
        ...state,
        reads: Object.fromEntries(
          Object.entries(state.reads).map(([kind, read]) => [kind, { ...read, loading: false }]),
        ) as WorkflowWorkspaceState["reads"],
        operations: {
          ...state.operations,
          [key]: {
            operationId,
            command,
            target,
            status: "submitting",
            locked: true,
            result: null,
            error: null,
          },
        },
      });
      entry.handle = {
        operationId,
        settled: Promise.resolve().then(async () => {
          let request: ReturnType<typeof live>;
          try {
            request = live();
          } catch {
            return;
          }
          try {
            const result = await dispatch(request.token, request.signal);
            if (!request.current() || pending.get(key) !== entry) return;
            assertWorkflowCommandResult(
              result,
              command,
              command === "workflow.create" ? undefined : target.id,
              revision,
            );
            confirmCreateIdentity(entry, result);
            operation(key, operationId, { status: "committed_needs_detail", result });
            await currentDetail(key, entry);
          } catch (error) {
            if (!request.current() || pending.get(key) !== entry) return;
            if (error instanceof ApiError && [400, 404, 409, 413, 422].includes(error.status)) {
              if (error.status === 409 && state.editor?.workflowId === target.id)
                update({ ...state, editor: { ...state.editor, conflict: true } });
              operation(key, operationId, { status: "definitely_rejected", error: message(error) });
              finish(key, entry, "definitely_rejected");
            } else operation(key, operationId, { status: "unknown", error: message(error) });
            authFailure(error, request.token);
          }
        }),
      };
      return entry.handle;
    },
    reconcile,
  };
  return controller;
}
export type WorkflowWorkspace = ReturnType<typeof createWorkflowWorkspace>;
const browserOwners = new WeakMap<object, Map<string, WorkflowWorkspace>>();
export function getBrowserWorkflowWorkspace(options: WorkflowWorkspaceOptions): WorkflowWorkspace {
  if (typeof window === "undefined") throw new Error("Workflow workspaces belong to a browser.");
  let registry = browserOwners.get(window);
  if (!registry) {
    registry = new Map();
    browserOwners.set(window, registry);
  }
  const key =
    options.mode === "preview"
      ? "preview"
      : JSON.stringify([options.owner.userId, options.owner.studioId, options.owner.role]);
  let workspace = registry.get(key);
  if (!workspace?.isCurrent()) {
    workspace = createWorkflowWorkspace(options);
    registry.set(key, workspace);
  } else if (options.mode === "live") workspace.updateToken(options.token);
  return workspace;
}

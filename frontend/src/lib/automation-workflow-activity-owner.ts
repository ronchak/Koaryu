import { ApiError } from "./api.ts";
import { withCurrentLiveAuthRead } from "./store-action-types.ts";
import { workflowActivityApi } from "./automation-workflow-activity-api.ts";
import {
  buildWorkflowRunCancel,
  buildWorkflowSimulationRequest,
  buildWorkflowTestEmail,
  isWorkflowActivityReceipt,
  isWorkflowRunCancelResult,
  isWorkflowRunDetail,
  isWorkflowRunPage,
  isWorkflowSimulationResponse,
  isWorkflowTestDelivery,
} from "./automation-workflow-activity-contract.ts";
import { canonicalWorkflowDraft } from "./automation-workflow-model.ts";
import {
  WORKFLOW_ACTIVITY_JOURNAL_KEY,
  parseWorkflowActivityJournal,
  serializeWorkflowActivityJournal,
  workflowActivityTargetKey,
  type WorkflowActivity,
  type WorkflowActivityMarker,
  type WorkflowActivityOperation,
  type WorkflowActivityRead,
  type WorkflowActivitySnapshot,
  type WorkflowActivityStatus,
  type WorkflowActivityTarget,
} from "./automation-workflow-activity-state.ts";
import type { WorkflowGraph } from "./automation-workflow-types.ts";
import type {
  ApiWorkflowRunDetail,
  ApiWorkflowTestEmailResponse,
} from "../types/generated/api-contracts";

export type WorkflowActivityParent = {
  mode: "live" | "preview";
  owner: Readonly<{ userId: string; studioId: string; role: string }> | null;
  live(): { token: string; signal: AbortSignal; current(): boolean };
  isCurrent(): boolean;
  tokenChanged(previous: string): boolean;
  authFailure(error: unknown, requestToken: string): void;
  subscribe(listener: () => void): () => void;
  notify(): void;
  editor(): Readonly<{ workflowId: string | null; graph: WorkflowGraph | null }>;
  canTestEmail(): boolean;
};
export type WorkflowActivityOwnerDependencies = {
  api: typeof workflowActivityApi;
  storage(): Pick<Storage, "getItem" | "setItem">;
  uuid(): string;
};
type Entry = {
  marker: WorkflowActivityMarker;
  status: WorkflowActivityStatus;
  reserved: boolean;
  acknowledged: boolean;
  rejected: boolean;
  current: ApiWorkflowRunDetail | ApiWorkflowTestEmailResponse | null;
  message: string | null;
  work: Promise<void> | null;
  aliasCandidate?: WorkflowActivityMarker;
  invoked: boolean;
  transition?: StorageTransition;
};
type StorageTransition =
  | Readonly<{
      kind: "cleanup";
      before: WorkflowActivityMarker;
      attempt: { started: boolean };
      status: "confirmed" | "unavailable" | "rejected" | "dismissed";
    }>
  | Readonly<{
      kind: "replacement";
      before: WorkflowActivityMarker;
      after: WorkflowActivityMarker;
      candidate: Entry;
      attempt: { started: boolean };
    }>;
const STORAGE = "Workflow activity recovery storage is unavailable. Check storage access.";
const READ = "Workflow activity could not be loaded. Try again.";
const UNKNOWN = "The result is not confirmed. Check its result before continuing.";
const REFRESH = "The action was confirmed. Check again to load its current state.";
const REJECTED = "The action was not accepted. Review the current state before trying again.";
const PREVIEW = "Live actions are unavailable in preview.";
const ACCESS = "Verify current administrator access before continuing.";
const INTENT = "Verify the previous sample's terminal result before creating or dismissing it.";
const UNKNOWN_SAMPLE = "The previous sample may have been accepted and will not be retried.";
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw new ApiError("Invalid workflow activity identity.", 422);
  return value.toLowerCase();
}
const same = (left: WorkflowActivityMarker, right: WorkflowActivityMarker) =>
  serializeWorkflowActivityJournal([left]) === serializeWorkflowActivityJournal([right]);
const terminal = (entry: Entry) =>
  entry.marker.command === "test_email.create" &&
  entry.current !== null &&
  "state" in entry.current &&
  ["accepted", "failed", "unknown"].includes(entry.current.state);
const denied = (error: unknown) =>
  error instanceof ApiError && [401, 402, 403].includes(error.status);
function invalidResponse(): never {
  throw new ApiError(READ, 503);
}

// This child borrows the workspace authority, editor and listener set.
export function createWorkflowActivityOwner(
  parent: WorkflowActivityParent,
  dependencies: WorkflowActivityOwnerDependencies,
): { activity: WorkflowActivity; observeEditor(): void; fence(): void } {
  const entries = new Map<string, Entry>();
  const generations = new Map<string, number>();
  const authorityDenials = new WeakSet<Error>();
  let active = true,
    simulationGeneration = 0,
    editorIdentity = "",
    storageStatus: WorkflowActivitySnapshot["storage"]["status"] = "inactive";
  let snapshot: WorkflowActivitySnapshot;
  const live = () => {
    if (parent.mode === "preview") throw new Error(PREVIEW);
    if (!active || !parent.isCurrent()) throw new Error(ACCESS);
    return parent.live();
  };
  const current = () => {
    if (!active || parent.mode !== "live" || !parent.isCurrent()) return false;
    try {
      return live().current();
    } catch {
      return false;
    }
  };
  const owned = (entry: Entry) =>
    current() && entries.get(workflowActivityTargetKey(entry.marker.target)) === entry;
  const operation = (entry: Entry): WorkflowActivityOperation => {
    const shared = {
      operationId: entry.marker.operation_id,
      target: structuredClone(entry.marker.target),
      status: entry.status,
      locked: entry.reserved,
      message: entry.message,
      isCurrent: () => owned(entry),
    };
    return freeze(
      entry.marker.command === "run.cancel"
        ? {
            ...shared,
            command: "run.cancel" as const,
            current: structuredClone(entry.current) as ApiWorkflowRunDetail | null,
          }
        : {
            ...shared,
            command: "test_email.create" as const,
            emailNodeId: entry.marker.email_node_id,
            current: structuredClone(entry.current) as ApiWorkflowTestEmailResponse | null,
          },
    );
  };
  const publish = (notify = true) => {
    snapshot = Object.freeze({
      operations: Object.freeze(
        new Map([...entries].map(([key, entry]) => [key, operation(entry)])),
      ),
      storage: Object.freeze({
        status: storageStatus,
        message: storageStatus === "blocked" ? STORAGE : null,
        isCurrent: current,
      }),
    });
    if (notify) parent.notify();
  };
  const block = () => {
    storageStatus = "blocked";
    publish();
  };
  const patch = (entry: Entry, status: WorkflowActivityStatus, message: string | null = null) => {
    if (!owned(entry)) return;
    entry.status = status;
    entry.message = message;
    publish();
  };
  const owner = () => {
    live();
    if (!parent.owner || parent.owner.role !== "admin") throw new Error(ACCESS);
    return { user: uuid(parent.owner.userId), studio: uuid(parent.owner.studioId) };
  };
  const belongs = (marker: WorkflowActivityMarker) => {
    const identity = owner();
    return marker.owner_user_id === identity.user && marker.owner_studio_id === identity.studio;
  };
  const readJournal = () => {
    live();
    const storage = dependencies.storage();
    const journal = parseWorkflowActivityJournal(storage.getItem(WORKFLOW_ACTIVITY_JOURNAL_KEY));
    live();
    return { storage, journal };
  };
  const coherent = (
    journal: readonly WorkflowActivityMarker[],
    alternate?: WorkflowActivityMarker,
  ) => {
    for (const entry of entries.values()) {
      if (!entry.reserved) continue;
      const stored = journal.find((item) => item.operation_id === entry.marker.operation_id);
      if (
        !stored ||
        (!same(stored, entry.marker) &&
          !(alternate?.operation_id === entry.marker.operation_id && same(stored, alternate)))
      )
        throw new Error(STORAGE);
    }
  };
  const restored = (marker: WorkflowActivityMarker): Entry => {
    const acknowledged = marker.command === "test_email.create" && !!marker.test_delivery_id;
    return {
      marker,
      status: acknowledged ? "confirmed_needs_refresh" : "unknown",
      reserved: true,
      acknowledged,
      rejected: false,
      current: null,
      message: acknowledged ? REFRESH : UNKNOWN,
      work: null,
      invoked: true,
    };
  };
  const inspectStorage = (notify = true) => {
    try {
      const { journal } = readJournal();
      coherent(journal);
      for (const marker of journal) {
        if (!belongs(marker)) continue;
        const key = workflowActivityTargetKey(marker.target);
        if (!entries.get(key)?.reserved) entries.set(key, restored(marker));
      }
      storageStatus = "ready";
      publish(notify);
      return true;
    } catch {
      if (current()) {
        storageStatus = "blocked";
        publish(notify);
      }
      return false;
    }
  };
  const writeJournal = (
    storage: Pick<Storage, "getItem" | "setItem">,
    next: readonly WorkflowActivityMarker[],
    guard: () => boolean,
    attempt?: { started: boolean },
  ) => {
    const encoded = serializeWorkflowActivityJournal(next);
    live();
    if (!guard()) throw new Error(STORAGE);
    if (attempt) attempt.started = true;
    storage.setItem(WORKFLOW_ACTIVITY_JOURNAL_KEY, encoded);
    live();
    if (!guard()) throw new Error(STORAGE);
    const verified = parseWorkflowActivityJournal(storage.getItem(WORKFLOW_ACTIVITY_JOURNAL_KEY));
    live();
    if (!guard()) throw new Error(STORAGE);
    const ordered = (items: readonly WorkflowActivityMarker[]) =>
      serializeWorkflowActivityJournal(
        [...items].sort((a, b) => a.operation_id.localeCompare(b.operation_id)),
      );
    if (ordered(verified) !== ordered(next)) throw new Error(STORAGE);
  };
  // Each transition verifies the full journal so another owner's valid metadata survives.
  const persist = (
    before: WorkflowActivityMarker | null,
    after: WorkflowActivityMarker | null,
    guard: () => boolean = current,
    alternate?: WorkflowActivityMarker,
    attempt?: { started: boolean },
  ) => {
    try {
      const { storage, journal } = readJournal();
      coherent(journal, alternate);
      if (
        before &&
        !journal.some((item) => same(item, before) || (alternate && same(item, alternate)))
      )
        throw new Error(STORAGE);
      const next = journal.filter((item) => !before || item.operation_id !== before.operation_id);
      if (after) next.push(after);
      writeJournal(storage, next, guard, attempt);
      storageStatus = "ready";
    } catch {
      if (current()) block();
      throw new Error(STORAGE);
    }
  };
  const marker = (
    target: WorkflowActivityTarget,
    operationId: string,
    emailNodeId?: string,
  ): WorkflowActivityMarker => {
    const identity = owner();
    const shared = {
      operation_id: uuid(operationId),
      owner_user_id: identity.user,
      owner_studio_id: identity.studio,
    };
    return parseWorkflowActivityJournal(
      serializeWorkflowActivityJournal([
        target.kind === "run"
          ? { ...shared, command: "run.cancel", target }
          : { ...shared, command: "test_email.create", target, email_node_id: emailNodeId! },
      ]),
    )[0];
  };
  const read = async <T>(
    isCurrent: () => boolean,
    request: ReturnType<typeof live>,
    run: (token: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    let requestToken = request.token;
    try {
      return await withCurrentLiveAuthRead(
        () => {
          if (!isCurrent()) throw new Error(ACCESS);
          const fresh = live();
          requestToken = fresh.token;
          return {
            token: fresh.token,
            isCurrent,
            canRetryAfterTokenChange: () => isCurrent() && parent.tokenChanged(fresh.token),
          };
        },
        (attempt) => run(attempt.token, request.signal),
        () => {},
      );
    } catch (error) {
      // A stale request must not revoke replacement authority. Preserve a real denial
      // after authFailure fences this owner; callers still need its original status.
      if (isCurrent()) {
        if (denied(error) && error instanceof Error && !parent.tokenChanged(requestToken))
          authorityDenials.add(error);
        parent.authFailure(error, requestToken);
      }
      throw error;
    }
  };
  const publicRead = async <T>(
    resource: string,
    run: (token: string, signal: AbortSignal) => Promise<T>,
    valid: (value: unknown) => value is T,
    extraCurrent: () => boolean = () => true,
  ): Promise<WorkflowActivityRead<T>> => {
    const request = live(),
      generation = (generations.get(resource) ?? 0) + 1;
    generations.set(resource, generation);
    const isCurrent = () =>
      current() && request.current() && generations.get(resource) === generation && extraCurrent();
    try {
      const value = await read(isCurrent, request, run);
      if (!isCurrent()) return Object.freeze({ status: "stale" });
      if (!valid(value)) invalidResponse();
      return freeze({ status: "ready", value: structuredClone(value), isCurrent });
    } catch (error) {
      if (error instanceof Error && authorityDenials.has(error)) throw error;
      if (!isCurrent()) return Object.freeze({ status: "stale" });
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError(READ, 503);
    }
  };
  const graphKey = (graph: WorkflowGraph) =>
    JSON.stringify(canonicalWorkflowDraft({ graph, layout: { positions: {} } }).graph);
  const observeEditor = () => {
    const editor = parent.editor();
    const next = JSON.stringify([editor.workflowId, editor.graph ? graphKey(editor.graph) : null]);
    if (next !== editorIdentity) {
      editorIdentity = next;
      simulationGeneration++;
    }
  };
  const editorGraph = (workflowId: string, graph: WorkflowGraph) => {
    live();
    const workflow = uuid(workflowId),
      editor = parent.editor();
    if (
      !editor.workflowId ||
      uuid(editor.workflowId) !== workflow ||
      !editor.graph ||
      graphKey(editor.graph) !== graphKey(graph)
    )
      throw new ApiError("Open the saved workflow's current graph before using this action.", 422);
    return workflow;
  };
  const targetEntry = (target: WorkflowActivityTarget) => {
    live();
    const entry = entries.get(workflowActivityTargetKey(target));
    return entry?.reserved ? entry : undefined;
  };
  const finishCleanup = (entry: Entry, proof: Extract<StorageTransition, { kind: "cleanup" }>) => {
    if (!owned(entry) || entry.transition !== proof) return;
    delete entry.transition;
    if (proof.status === "dismissed") {
      entries.delete(workflowActivityTargetKey(entry.marker.target));
      publish();
    } else {
      entry.reserved = false;
      patch(entry, proof.status, proof.status === "rejected" ? REJECTED : null);
    }
  };
  const cleanup = (
    entry: Entry,
    status: Extract<StorageTransition, { kind: "cleanup" }>["status"],
  ) => {
    if (!owned(entry) || entry.transition) return false;
    const proof = Object.freeze({
      kind: "cleanup" as const,
      before: freeze(structuredClone(entry.marker)),
      status,
      attempt: { started: false },
    });
    entry.transition = proof;
    try {
      persist(
        proof.before,
        null,
        () => owned(entry) && entry.transition === proof,
        undefined,
        proof.attempt,
      );
      finishCleanup(entry, proof);
      return true;
    } catch {
      patch(entry, entry.rejected ? "storage_blocked" : "confirmed_needs_refresh", STORAGE);
      return false;
    }
  };
  // Only explicit recovery consumes this private proof; reload has no such proof.
  const reconcileTransition = (entry: Entry) => {
    const proof = entry.transition;
    if (!proof || !owned(entry)) return false;
    storageStatus = "blocked";
    const valid = () =>
      owned(entry) &&
      entry.transition === proof &&
      (proof.kind === "cleanup" || !proof.candidate.invoked);
    try {
      const { storage, journal } = readJournal();
      if (!valid()) throw new Error(STORAGE);
      const before = proof.before;
      const targetKey = workflowActivityTargetKey(before.target);
      const row = journal.find(
        (item) =>
          item.owner_user_id === before.owner_user_id &&
          item.owner_studio_id === before.owner_studio_id &&
          workflowActivityTargetKey(item.target) === targetKey,
      );
      const operation = journal.find((item) => item.operation_id === before.operation_id);
      if (operation && !same(operation, before)) throw new Error(STORAGE);
      if (proof.kind === "cleanup") {
        if (row && !same(row, before)) throw new Error(STORAGE);
        if (!row && !proof.attempt.started) throw new Error(STORAGE);
        if (row)
          writeJournal(
            storage,
            journal.filter((item) => item !== row),
            valid,
            proof.attempt,
          );
        if (!valid()) throw new Error(STORAGE);
        finishCleanup(entry, proof);
      } else {
        if (!row || (!same(row, before) && !same(row, proof.after))) throw new Error(STORAGE);
        const candidate = journal.find((item) => item.operation_id === proof.after.operation_id);
        if (candidate && !same(candidate, proof.after)) throw new Error(STORAGE);
        if (same(row, proof.after)) {
          if (!proof.attempt.started) throw new Error(STORAGE);
          writeJournal(
            storage,
            journal.map((item) => (item === row ? before : item)),
            valid,
          );
        }
        if (!valid()) throw new Error(STORAGE);
        delete entry.transition;
        patch(
          entry,
          "confirmed",
          entry.current && "state" in entry.current && entry.current.state === "unknown"
            ? UNKNOWN_SAMPLE
            : null,
        );
      }
      inspectStorage();
      return true;
    } catch {
      if (current()) block();
      return true;
    }
  };
  const alias = (entry: Entry, deliveryId: string) => {
    if (!owned(entry) || entry.marker.command !== "test_email.create") throw new Error(ACCESS);
    const id = uuid(deliveryId);
    if (entry.marker.test_delivery_id === id) return;
    if (entry.marker.test_delivery_id) invalidResponse();
    const next = { ...entry.marker, test_delivery_id: id };
    if (entry.aliasCandidate && !same(entry.aliasCandidate, next)) invalidResponse();
    entry.aliasCandidate = next;
    persist(entry.marker, next, () => owned(entry), entry.aliasCandidate);
    if (!owned(entry)) throw new Error(ACCESS);
    entry.marker = next;
    delete entry.aliasCandidate;
  };
  const testCurrent = (entry: Entry, value: ApiWorkflowTestEmailResponse) => {
    if (!owned(entry)) return;
    entry.current = structuredClone(value);
    entry.acknowledged = true;
    patch(entry, "confirmed", value.state === "unknown" ? UNKNOWN_SAMPLE : null);
  };
  const refreshMessage = (entry: Entry) =>
    terminal(entry) &&
    entry.current &&
    "state" in entry.current &&
    entry.current.state === "unknown"
      ? `${UNKNOWN_SAMPLE} ${REFRESH}`
      : REFRESH;
  const currentEntity = async (entry: Entry) => {
    const request = live(),
      isCurrent = () => owned(entry) && request.current();
    try {
      const item = entry.marker;
      if (item.command === "run.cancel") {
        const identity = {
          studioId: item.owner_studio_id,
          workflowId: item.target.workflowId,
          runId: item.target.runId,
        };
        const value = await read(isCurrent, request, (token, signal) =>
          dependencies.api.getRun(identity, token, signal),
        );
        if (!isCurrent()) return;
        if (!isWorkflowRunDetail(value, identity)) invalidResponse();
        entry.current = structuredClone(value);
        cleanup(entry, "confirmed");
      } else {
        if (!item.test_delivery_id) invalidResponse();
        const identity = { operationId: item.operation_id, testDeliveryId: item.test_delivery_id };
        const value = await read(isCurrent, request, (token, signal) =>
          dependencies.api.getTestDelivery(identity, token, signal),
        );
        if (!isCurrent()) return;
        if (!isWorkflowTestDelivery(value, identity)) invalidResponse();
        testCurrent(entry, value);
      }
    } catch (error) {
      if (error instanceof Error && authorityDenials.has(error)) throw error;
      if (!isCurrent()) return;
      if (
        error instanceof ApiError &&
        error.status === 404 &&
        entry.marker.command === "run.cancel"
      ) {
        entry.current = null;
        cleanup(entry, "unavailable");
      } else {
        patch(
          entry,
          terminal(entry) ? "confirmed" : "confirmed_needs_refresh",
          refreshMessage(entry),
        );
      }
    }
  };
  const recover = async (entry: Entry) => {
    if (!owned(entry)) return;
    if (reconcileTransition(entry)) return;
    if (entry.rejected) {
      cleanup(entry, "rejected");
      return;
    }
    const request = live(),
      isCurrent = () => owned(entry) && request.current();
    patch(entry, "checking");
    try {
      const item = entry.marker;
      const identity =
        item.command === "run.cancel"
          ? {
              command: item.command,
              operationId: item.operation_id,
              studioId: item.owner_studio_id,
              workflowId: item.target.workflowId,
              runId: item.target.runId,
            }
          : {
              command: item.command,
              operationId: item.operation_id,
              ...(item.test_delivery_id ? { testDeliveryId: item.test_delivery_id } : {}),
            };
      const receipt = await read(isCurrent, request, (token, signal) =>
        dependencies.api.getOperation(identity, token, signal),
      );
      if (!isCurrent()) return;
      if (!isWorkflowActivityReceipt(receipt, identity)) invalidResponse();
      entry.acknowledged = true;
      if (receipt.command === "test_email.create") alias(entry, receipt.result.test_delivery_id);
      patch(entry, "confirmed_needs_refresh", REFRESH);
      await currentEntity(entry);
    } catch (error) {
      if (error instanceof Error && authorityDenials.has(error)) throw error;
      if (isCurrent())
        patch(
          entry,
          terminal(entry)
            ? "confirmed"
            : entry.acknowledged
              ? "confirmed_needs_refresh"
              : "unknown",
          storageStatus === "blocked"
            ? STORAGE
            : entry.acknowledged
              ? refreshMessage(entry)
              : UNKNOWN,
        );
    }
  };
  const join = (entry: Entry, work: () => Promise<void>) => {
    if (entry.work) return entry.work;
    entry.work = Promise.resolve()
      .then(work)
      .finally(() => {
        if (!owned(entry)) return;
        entry.work = null;
        if (entry.status === "checking")
          patch(
            entry,
            entry.acknowledged ? "confirmed_needs_refresh" : "unknown",
            entry.acknowledged ? REFRESH : UNKNOWN,
          );
      });
    return entry.work;
  };
  const submit = (
    item: WorkflowActivityMarker,
    dispatch: (token: string, signal: AbortSignal) => Promise<unknown>,
    accept: (entry: Entry, result: unknown) => Promise<void>,
    prior?: Entry,
  ) => {
    if (prior && (!owned(prior) || !terminal(prior) || !prior.reserved)) throw new Error(INTENT);
    if (prior?.transition) throw new Error(STORAGE);
    const entry: Entry = {
      ...restored(item),
      status: "submitting",
      message: null,
      invoked: false,
    };
    if (prior)
      prior.transition = Object.freeze({
        kind: "replacement",
        before: freeze(structuredClone(prior.marker)),
        after: item,
        candidate: entry,
        attempt: { started: false },
      });
    persist(
      prior?.marker ?? null,
      item,
      () => current() && (!prior || (owned(prior) && terminal(prior) && prior.reserved)),
      undefined,
      prior?.transition?.attempt,
    );
    if (prior) delete prior.transition;
    entries.set(workflowActivityTargetKey(item.target), entry);
    const settled = join(entry, async () => {
      if (!owned(entry)) return;
      const request = live();
      try {
        entry.invoked = true;
        const result = await dispatch(request.token, request.signal);
        if (!owned(entry) || !request.current()) return;
        await accept(entry, result);
      } catch (error) {
        if (error instanceof Error && authorityDenials.has(error)) throw error;
        if (!owned(entry) || !request.current()) return;
        if (denied(error)) {
          patch(entry, "unknown", UNKNOWN);
          if (
            error instanceof ApiError &&
            error.status === 401 &&
            parent.tokenChanged(request.token)
          )
            await recover(entry);
          else {
            const currentDenial = !parent.tokenChanged(request.token);
            parent.authFailure(error, request.token);
            if (currentDenial) throw error;
          }
        } else if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          entry.rejected = true;
          cleanup(entry, "rejected");
        } else {
          patch(
            entry,
            entry.acknowledged ? "confirmed_needs_refresh" : "unknown",
            storageStatus === "blocked" ? STORAGE : entry.acknowledged ? REFRESH : UNKNOWN,
          );
        }
      }
    });
    publish();
    return settled;
  };
  const requireStorage = () => {
    live();
    if (!inspectStorage()) throw new Error(STORAGE);
  };
  const priorTest = (workflowId: string, priorOperationId: string) => {
    const entry = targetEntry({ kind: "test", workflowId: uuid(workflowId) });
    if (!entry || entry.marker.operation_id !== uuid(priorOperationId) || !terminal(entry))
      throw new Error(INTENT);
    if (entry.transition) throw new Error(STORAGE);
    return entry;
  };
  const createTest = (
    workflowId: string,
    graph: WorkflowGraph,
    emailNodeId: string,
    priorOperationId?: string,
  ) => {
    live();
    const workflow = uuid(workflowId),
      target = { kind: "test" as const, workflowId: workflow };
    const existing = targetEntry(target);
    if (priorOperationId === undefined && existing) return existing.work ?? Promise.resolve();
    const prior =
      priorOperationId === undefined ? undefined : priorTest(workflow, priorOperationId);
    editorGraph(workflow, graph);
    if (!parent.canTestEmail()) throw new ApiError("Test email is currently unavailable.", 422);
    const captured = buildWorkflowTestEmail(PLACEHOLDER_ID, graph, emailNodeId);
    requireStorage();
    const adopted = targetEntry(target);
    if (!prior && adopted) return adopted.work ?? Promise.resolve();
    if (prior && priorTest(workflow, priorOperationId!) !== prior) throw new Error(INTENT);
    const item = marker(target, dependencies.uuid(), emailNodeId);
    const body = { ...captured, operation_id: item.operation_id };
    return submit(
      item,
      (token, signal) => dependencies.api.sendTestEmail(workflow, body, token, signal),
      async (entry, result) => {
        if (!isWorkflowTestDelivery(result, { operationId: item.operation_id })) invalidResponse();
        entry.acknowledged = true;
        alias(entry, result.test_delivery_id);
        testCurrent(entry, result);
      },
      prior,
    );
  };
  const activity: WorkflowActivity = {
    getSnapshot() {
      if (parent.mode === "live") current();
      return snapshot;
    },
    subscribe(listener) {
      if (parent.mode === "live") current();
      return parent.subscribe(listener);
    },
    pendingOperation(target) {
      if (!current()) return undefined;
      const entry = targetEntry(target);
      return entry ? operation(entry) : undefined;
    },
    async checkStorage() {
      live();
      for (const entry of [...entries.values()]) reconcileTransition(entry);
      inspectStorage();
    },
    invalidateSimulation() {
      live();
      simulationGeneration++;
    },
    simulate(workflowId, graph, context) {
      const workflow = editorGraph(workflowId, graph),
        body = buildWorkflowSimulationRequest(graph, context),
        generation = ++simulationGeneration;
      return publicRead(
        "simulation",
        (token, signal) => dependencies.api.simulate(workflow, body, token, signal),
        (value): value is Awaited<ReturnType<typeof dependencies.api.simulate>> =>
          isWorkflowSimulationResponse(value, body.graph),
        () => generation === simulationGeneration,
      );
    },
    listRuns(workflowId, options = {}) {
      const identity = { studioId: owner().studio, workflowId: uuid(workflowId) };
      const captured = { ...options };
      if (
        (captured.limit !== undefined &&
          (!Number.isSafeInteger(captured.limit) || captured.limit < 1 || captured.limit > 100)) ||
        (captured.cursor !== undefined &&
          (typeof captured.cursor !== "string" ||
            Array.from(captured.cursor).length < 1 ||
            Array.from(captured.cursor).length > 512))
      )
        throw new ApiError("Invalid workflow run page request.", 422);
      return publicRead(
        `list:${identity.workflowId}`,
        (token, signal) => dependencies.api.listRuns(identity, captured, token, signal),
        (value): value is Awaited<ReturnType<typeof dependencies.api.listRuns>> =>
          isWorkflowRunPage(value, identity, captured.limit ?? 50),
      );
    },
    getRun(workflowId, runId) {
      const identity = {
        studioId: owner().studio,
        workflowId: uuid(workflowId),
        runId: uuid(runId),
      };
      return publicRead(
        `run:${identity.workflowId}:${identity.runId}`,
        (token, signal) => dependencies.api.getRun(identity, token, signal),
        (value): value is ApiWorkflowRunDetail => isWorkflowRunDetail(value, identity),
      );
    },
    cancelRun(baseline) {
      const identity = owner();
      // Validate and capture all CAS fields before a caller can mutate its held DTO.
      if (
        !baseline ||
        !isWorkflowRunDetail(baseline, {
          studioId: identity.studio,
          workflowId: baseline.run?.workflow_id,
          runId: baseline.run?.id,
        })
      )
        throw new ApiError("Invalid current workflow run.", 422);
      const captured = structuredClone(baseline);
      if (uuid(captured.run.studio_id) !== identity.studio) throw new ApiError(ACCESS, 403);
      const target = {
        kind: "run" as const,
        workflowId: uuid(captured.run.workflow_id),
        runId: uuid(captured.run.id),
      };
      const existing = targetEntry(target);
      if (existing) return existing.work ?? Promise.resolve();
      buildWorkflowRunCancel(PLACEHOLDER_ID, captured);
      requireStorage();
      const adopted = targetEntry(target);
      if (adopted) return adopted.work ?? Promise.resolve();
      const item = marker(target, dependencies.uuid());
      return submit(
        item,
        (token, signal) => dependencies.api.cancelRun(captured, item.operation_id, token, signal),
        async (entry, result) => {
          if (!isWorkflowRunCancelResult(result, captured)) invalidResponse();
          entry.acknowledged = true;
          patch(entry, "confirmed_needs_refresh", REFRESH);
          await currentEntity(entry);
        },
      );
    },
    createTest,
    checkResult(target) {
      const entry = targetEntry(target);
      return entry ? join(entry, () => recover(entry)) : Promise.resolve();
    },
    createAnotherTest: (workflowId, graph, emailNodeId, priorOperationId) =>
      createTest(workflowId, graph, emailNodeId, priorOperationId),
    async dismissTestResult(workflowId, priorOperationId) {
      const entry = priorTest(workflowId, priorOperationId);
      if (!cleanup(entry, "dismissed")) throw new Error(STORAGE);
    },
  };
  const fence = () => {
    if (!active) return;
    active = false;
    for (const entry of entries.values()) delete entry.transition;
    entries.clear();
    generations.clear();
    simulationGeneration++;
    storageStatus = "inactive";
    publish(false);
  };
  observeEditor();
  publish(false);
  if (parent.mode === "live") inspectStorage(false);
  return { activity, observeEditor, fence };
}

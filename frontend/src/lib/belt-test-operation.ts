import { ApiError } from "@/lib/api";
import { captureAccessIdentity, invalidateAccessIdentity } from "@/lib/access-identity";
import { getActiveStudioIdCookie } from "@/lib/studio-state-cookie";
import { withCurrentLiveAuthRead, type BeginLiveAuthRequest } from "./store-action-types";
import type {
  ApiBeltTestEventCreate,
  ApiBeltTestEventUpdate,
  ApiBeltTestEventResponse,
  ApiBeltTestEventListResponse,
  ApiBeltTestRecipientApprove,
  ApiBeltTestRecipientRevoke,
  ApiBeltTestRecipientResponse,
  ApiBeltTestRecipientListResponse,
} from "../types/generated/api-contracts";
import {
  type BeltTestCommand,
  type BeltTestTarget,
  type BeltTestPair,
  type BeltTestCandidate,
  type BeltTestCreateFields,
  type BeltTestEdit,
  type BeltTestReceiptIdentity,
  beltTestTargetKey,
  isBeltTestTarget,
  isBeltTestEvent,
  isBeltTestEventPage,
  isBeltTestRecipient,
  isBeltTestRecipientPage,
  isBeltTestCandidates,
  isBeltTestReceipt,
  buildBeltTestCreate,
  buildBeltTestUpdate,
  buildBeltTestApprove,
  buildBeltTestRevoke,
  isBeltTestCreateResult,
  isBeltTestUpdateResult,
  isBeltTestApproveResult,
  isBeltTestRevokeResult,
} from "./belt-test-contract";

export type BeltTestEventPage = Readonly<Omit<ApiBeltTestEventListResponse, "items">> &
  Readonly<{ items: readonly Readonly<ApiBeltTestEventResponse>[] }>;
export type BeltTestRecipientPage = Readonly<Omit<ApiBeltTestRecipientListResponse, "items">> &
  Readonly<{ items: readonly Readonly<ApiBeltTestRecipientResponse>[] }>;
export type BeltTestPageOptions = Readonly<{ cursor?: string; limit?: number }>;
export type BeltTestRead<T> =
  Readonly<{ status: "ready"; value: T; isCurrent(): boolean }> | Readonly<{ status: "stale" }>;
export type BeltTestOperationStatus =
  | "idle"
  | "submitting"
  | "unknown"
  | "checking"
  | "confirmed_needs_refresh"
  | "confirmed"
  | "unavailable"
  | "rejected"
  | "storage_blocked";
export type BeltTestView = Readonly<{
  command: BeltTestCommand | null;
  target: BeltTestTarget;
  eventId: string | null;
  recipientId: string | null;
  status: BeltTestOperationStatus;
  locked: boolean;
  message: string | null;
  currentEvent: Readonly<ApiBeltTestEventResponse> | null;
  currentRecipient: Readonly<ApiBeltTestRecipientResponse> | null;
  isCurrent(): boolean;
}>;
export type BeltTestStorageView = Readonly<{
  status: "inactive" | "ready" | "blocked";
  message: string | null;
  isCurrent(): boolean;
}>;
export interface BeltTestFacade {
  readonly operations: ReadonlyMap<string, BeltTestView>;
  readonly storage: BeltTestStorageView;
  pendingOperation(target: BeltTestTarget): BeltTestView | undefined;
  checkStorage(): Promise<void>;
  listEvents(options?: BeltTestPageOptions): Promise<BeltTestRead<BeltTestEventPage>>;
  getEvent(eventId: string): Promise<BeltTestRead<Readonly<ApiBeltTestEventResponse>>>;
  listRecipients(
    eventId: string,
    options?: BeltTestPageOptions,
  ): Promise<BeltTestRead<BeltTestRecipientPage>>;
  getRecipient(
    eventId: string,
    recipientId: string,
  ): Promise<BeltTestRead<Readonly<ApiBeltTestRecipientResponse>>>;
  getCandidates(eventId: string): Promise<BeltTestRead<readonly BeltTestCandidate[]>>;
  createEvent(draftId: string, fields: BeltTestCreateFields): Promise<void>;
  updateEvent(baseline: Readonly<ApiBeltTestEventResponse>, edit: BeltTestEdit): Promise<void>;
  approveRecipients(
    event: Readonly<ApiBeltTestEventResponse>,
    pairs: readonly BeltTestPair[],
  ): Promise<void>;
  revokeRecipient(
    event: Readonly<ApiBeltTestEventResponse>,
    recipient: Readonly<ApiBeltTestRecipientResponse>,
  ): Promise<void>;
  checkResult(target: BeltTestTarget): Promise<void>;
}
export type BeltTestScope = Readonly<{ userId: string; studioId: string; role: "admin" }>;
export type BeltTestBinding = {
  isCurrent(): boolean;
  beginRequest: BeginLiveAuthRequest;
  beginMutation(): () => void;
  listEvents(query: string, token: string): Promise<unknown>;
  event(eventId: string, token: string): Promise<unknown>;
  listRecipients(eventId: string, query: string, token: string): Promise<unknown>;
  recipient(eventId: string, recipientId: string, token: string): Promise<unknown>;
  candidates(eventId: string, token: string): Promise<unknown>;
  create(body: ApiBeltTestEventCreate, token: string): Promise<unknown>;
  update(eventId: string, body: ApiBeltTestEventUpdate, token: string): Promise<unknown>;
  approve(eventId: string, body: ApiBeltTestRecipientApprove, token: string): Promise<unknown>;
  revoke(
    eventId: string,
    recipientId: string,
    body: ApiBeltTestRecipientRevoke,
    token: string,
  ): Promise<unknown>;
  receipt(operationId: string, token: string): Promise<unknown>;
};
export type BeltTestDependencies = {
  capture: typeof captureAccessIdentity;
  invalidate: typeof invalidateAccessIdentity;
  activeStudio: typeof getActiveStudioIdCookie;
  storage(): Pick<Storage, "getItem" | "setItem">;
  uuid(): string;
};
export type BeltTestOwner = {
  readonly scope: BeltTestScope;
  isCurrent(): boolean;
  getSnapshot(): BeltTestFacade;
  subscribe(listener: () => void): () => void;
  bind(binding: BeltTestBinding): () => void;
};
export const BELT_TEST_JOURNAL_KEY = "koaryu-belt-test-operations-v1";
const ACCESS = "Belt tests require current administrator access.";
const STORAGE = "Belt-test recovery storage is unavailable. Check storage before continuing.";
const PENDING = "Check the pending belt-test action before saving another change.";
const UNKNOWN = "The result is not confirmed. Check the saved result before trying again.";
const REFRESH = "The change was recorded. Check the result to load the current record.";
const REJECTED = "The change was not saved. Refresh the record and review your changes.";
const BAD = "Belt-test data is unavailable. Try loading it again.";
const denied = async (): Promise<never> => {
  throw new Error(ACCESS);
};
const stale = Object.freeze({ status: "stale" as const });
export const INACTIVE_BELT_TEST_FACADE: BeltTestFacade = Object.freeze({
  operations: new Map(),
  storage: Object.freeze({ status: "inactive", message: null, isCurrent: () => false }),
  pendingOperation: () => undefined,
  checkStorage: denied,
  listEvents: denied,
  getEvent: denied,
  listRecipients: denied,
  getRecipient: denied,
  getCandidates: denied,
  createEvent: denied,
  updateEvent: denied,
  approveRecipients: denied,
  revokeRecipient: denied,
  checkResult: denied,
});
const dependencies: BeltTestDependencies = {
  capture: captureAccessIdentity,
  invalidate: invalidateAccessIdentity,
  activeStudio: getActiveStudioIdCookie,
  storage: () => window.sessionStorage,
  uuid: () => crypto.randomUUID(),
};
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const canonical = (value: string) => {
  if (!uuid(value)) throw new Error("Use valid belt-test fields.");
  return value.toLowerCase();
};
const freezeRow = <T extends object>(value: T): Readonly<T> => Object.freeze({ ...value });
const freezeRows = <T extends object>(rows: readonly T[]) => Object.freeze(rows.map(freezeRow));
const freezePage = <T extends object>(page: {
  items: T[];
  has_more: boolean;
  next_cursor: string | null;
}) => Object.freeze({ ...page, items: freezeRows(page.items) });
function pageQuery(options?: BeltTestPageOptions) {
  const limit = options?.limit ?? 50,
    cursor = options?.cursor;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor !== undefined && (typeof cursor !== "string" || !cursor || [...cursor].length > 512))
  )
    throw new Error("Use valid belt-test page options.");
  return {
    limit,
    query: `?limit=${limit}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
  };
}
type Marker = {
  command: BeltTestCommand;
  operation_id: string;
  owner_user_id: string;
  owner_studio_id: string;
  target: BeltTestTarget;
  event_id?: string;
  recipient_id?: string;
};
const targetOf = (marker: Marker) => beltTestTargetKey(marker.target);
const eventOf = (marker: Marker) =>
  marker.target.kind === "event" ? marker.target.id : marker.event_id;
const sameMarker = (a: Marker | undefined, b: Marker | undefined) =>
  a === b ||
  Boolean(
    a &&
    b &&
    a.command === b.command &&
    a.operation_id === b.operation_id &&
    a.owner_user_id === b.owner_user_id &&
    a.owner_studio_id === b.owner_studio_id &&
    targetOf(a) === targetOf(b) &&
    a.event_id === b.event_id &&
    a.recipient_id === b.recipient_id,
  );
function closed(value: unknown, required: string, optional = ""): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  const keys = required.split(" ").filter(Boolean),
    allowed = [...keys, ...optional.split(" ").filter(Boolean)];
  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key))
  );
}
function parseJournal(raw: string | null): Marker[] {
  if (raw === null) return [];
  const data: unknown = JSON.parse(raw);
  if (
    !closed(data, "version entries") ||
    data.version !== 1 ||
    !Array.isArray(data.entries) ||
    data.entries.length > 100
  )
    throw new Error(STORAGE);
  const entries: Marker[] = [],
    operations = new Set<string>(),
    targets = new Set<string>();
  for (const entry of data.entries) {
    if (
      !closed(
        entry,
        "command operation_id owner_user_id owner_studio_id target",
        "event_id recipient_id",
      ) ||
      !uuid(entry.operation_id) ||
      !uuid(entry.owner_user_id) ||
      !uuid(entry.owner_studio_id) ||
      !isBeltTestTarget(entry.target)
    )
      throw new Error(STORAGE);
    const command = entry.command;
    if (
      command !== "belt_test.create" &&
      command !== "belt_test.update" &&
      command !== "belt_test.approve" &&
      command !== "belt_test.revoke"
    )
      throw new Error(STORAGE);
    if (
      (command === "belt_test.create") !== (entry.target.kind === "draft") ||
      (Object.hasOwn(entry, "event_id") &&
        (command !== "belt_test.create" || !uuid(entry.event_id))) ||
      (command === "belt_test.revoke"
        ? !Object.hasOwn(entry, "recipient_id") || !uuid(entry.recipient_id)
        : Object.hasOwn(entry, "recipient_id"))
    )
      throw new Error(STORAGE);
    const marker: Marker = {
      command,
      operation_id: canonical(entry.operation_id),
      owner_user_id: canonical(entry.owner_user_id),
      owner_studio_id: canonical(entry.owner_studio_id),
      target: Object.freeze({ kind: entry.target.kind, id: canonical(entry.target.id) }),
      ...(uuid(entry.event_id) ? { event_id: canonical(entry.event_id) } : {}),
      ...(uuid(entry.recipient_id) ? { recipient_id: canonical(entry.recipient_id) } : {}),
    };
    const prefix = `${marker.owner_user_id}:${marker.owner_studio_id}:`;
    const keys = [targetOf(marker), ...(marker.event_id ? [`event:${marker.event_id}`] : [])];
    if (operations.has(marker.operation_id) || keys.some((key) => targets.has(prefix + key)))
      throw new Error(STORAGE);
    operations.add(marker.operation_id);
    keys.forEach((key) => targets.add(prefix + key));
    entries.push(marker);
  }
  return entries;
}
class CurrentDenial extends ApiError {}
type Expectation = (value: unknown) => boolean;
type Pending = {
  marker: Marker;
  acknowledged: boolean;
  rejected: boolean;
  knownEvent?: string;
  expect?: Expectation;
};
type Attachment = BeltTestBinding & { finishes: Set<() => void> };
type Task = { io: Attachment; promise: Promise<void> };

export function createBeltTestOwner(scope: BeltTestScope, deps = dependencies): BeltTestOwner {
  const user = canonical(scope.userId),
    studio = canonical(scope.studioId);
  if (scope.role !== "admin") throw new Error(ACCESS);
  scope = Object.freeze({ ...scope }); // Authority capture requires the raw published IDs.
  let authority: ReturnType<typeof captureAccessIdentity> | null = null;
  let attachment: Attachment | null = null,
    fenced = false,
    listGeneration = 0;
  let storageStatus: BeltTestStorageView["status"] = "inactive";
  let snapshot = INACTIVE_BELT_TEST_FACADE;
  const pending = new Map<string, Pending>(),
    views = new Map<string, BeltTestView>();
  const generations = new Map<string, number>(),
    tasks = new Map<string, Task>();
  const listeners = new Set<() => void>();
  const methods = new WeakMap<Attachment, Omit<BeltTestFacade, "operations" | "storage">>();
  const isCurrent = () => {
    const active = deps.activeStudio();
    if (fenced) return false;
    if (!authority?.isCurrent() || !uuid(active) || canonical(active) !== studio) fenced = true;
    return !fenced;
  };
  const attached = (io: Attachment | null): io is Attachment =>
    Boolean(io && attachment === io && io.isCurrent() && isCurrent());
  function guard(io: Attachment | null): asserts io is Attachment {
    if (!attached(io)) throw new Error(ACCESS);
  }
  const sameOwner = (marker: Marker) =>
    marker.owner_user_id === user && marker.owner_studio_id === studio;
  const exact = (target: BeltTestTarget) => {
    const key = beltTestTargetKey(target);
    if (pending.has(key)) return key;
    return [...pending].find(
      ([, value]) => target.kind === "event" && value.marker.event_id === canonical(target.id),
    )?.[0];
  };
  const blocker = (target: BeltTestTarget) =>
    exact(target) ??
    [...pending]
      .filter(([, value]) => value.marker.command === "belt_test.create" && !value.marker.event_id)
      .map(([key]) => key)
      .sort()[0];
  const invalidateReads = (marker: Marker) => {
    listGeneration++;
    const id = eventOf(marker);
    if (id) generations.set(id, (generations.get(id) ?? 0) + 1);
  };
  const publish = () => {
    const io = attachment;
    if (io && !methods.has(io)) methods.set(io, facade(io));
    snapshot = io
      ? Object.freeze({
          ...methods.get(io)!,
          operations: Object.freeze(new Map(views)),
          storage: Object.freeze({
            status: storageStatus,
            message: storageStatus === "blocked" ? STORAGE : null,
            isCurrent: () => attached(io),
          }),
        })
      : INACTIVE_BELT_TEST_FACADE;
    for (const listener of [...listeners]) listener();
  };
  const view = (
    key: string,
    marker: Marker,
    status: BeltTestOperationStatus,
    message: string | null,
    event: ApiBeltTestEventResponse | null = null,
    recipient: ApiBeltTestRecipientResponse | null = null,
  ) => {
    const io = attachment,
      eventId = eventOf(marker),
      generation = eventId && generations.get(eventId);
    const result: BeltTestView = Object.freeze({
      command: marker.command,
      target: freezeRow(marker.target),
      eventId: eventOf(marker) ?? null,
      recipientId: marker.recipient_id ?? null,
      status,
      locked: pending.has(key),
      message,
      currentEvent: event && freezeRow(event),
      currentRecipient: recipient && freezeRow(recipient),
      isCurrent: () =>
        attached(io) &&
        views.get(key) === result &&
        (!eventId || generations.get(eventId) === generation),
    });
    views.set(key, result);
    publish();
  };
  const fail = (io: Attachment, key: string, blocked = false) => {
    if (!attached(io)) return;
    const value = pending.get(key);
    if (!value) return;
    if (blocked) storageStatus = "blocked";
    view(
      key,
      value.marker,
      blocked ? "storage_blocked" : value.acknowledged ? "confirmed_needs_refresh" : "unknown",
      blocked ? STORAGE : value.acknowledged ? REFRESH : UNKNOWN,
    );
  };
  const detach = (io: Attachment) => {
    for (const finish of io.finishes) finish();
    io.finishes.clear();
    if (attachment === io) {
      attachment = null;
      views.clear();
      storageStatus = "inactive";
      publish();
    }
  };
  const fence = () => {
    fenced = true;
    authority?.dispose();
    if (attachment) detach(attachment);
  };
  const adopt = (io: Attachment, entries: Marker[]) => {
    guard(io);
    const own = entries.filter(sameOwner);
    for (const value of pending.values())
      if (!own.some((marker) => sameMarker(marker, value.marker))) throw new Error(STORAGE);
    for (const marker of own) {
      const key = targetOf(marker),
        previous = pending.get(key);
      if (previous && !sameMarker(previous.marker, marker)) throw new Error(STORAGE);
    }
    for (const marker of own.sort((a, b) => targetOf(a).localeCompare(targetOf(b)))) {
      const key = targetOf(marker);
      if (!pending.has(key))
        pending.set(key, { marker, acknowledged: Boolean(marker.event_id), rejected: false });
      fail(io, key);
    }
  };
  const persist = (io: Attachment, key: string, next: Marker | null) => {
    guard(io);
    const storage = deps.storage(),
      entries = parseJournal(storage.getItem(BELT_TEST_JOURNAL_KEY));
    const previous = pending.get(key)?.marker;
    if (
      !sameMarker(
        entries.find((marker) => sameOwner(marker) && targetOf(marker) === key),
        previous,
      )
    )
      throw new Error(STORAGE);
    const nextEntries = entries.filter(
      (marker) => !(sameOwner(marker) && targetOf(marker) === key),
    );
    if (next) nextEntries.push(next);
    const before = JSON.stringify({ version: 1, entries }),
      after = JSON.stringify({ version: 1, entries: nextEntries });
    parseJournal(after); // Also validates new aliases against every retained reservation.
    guard(io);
    try {
      storage.setItem(BELT_TEST_JOURNAL_KEY, after);
      guard(io);
      if (storage.getItem(BELT_TEST_JOURNAL_KEY) !== after) throw new Error(STORAGE);
      guard(io);
    } catch (error) {
      try {
        // Roll back only our exact write, never a concurrent owner's new metadata.
        if (attached(io) && storage.getItem(BELT_TEST_JOURNAL_KEY) === after)
          storage.setItem(BELT_TEST_JOURNAL_KEY, before);
      } catch {
        /* The trusted in-memory reservation remains held. */
      }
      throw error;
    }
    if (next) {
      const value = pending.get(key);
      if (value) value.marker = next;
      else pending.set(key, { marker: next, acknowledged: false, rejected: false });
    } else pending.delete(key);
  };
  const persistChecked = (io: Attachment, key: string, next: Marker | null) => {
    try {
      persist(io, key, next);
    } catch (error) {
      fail(io, key, true);
      throw error;
    }
  };
  const authFailure = (
    io: Attachment,
    error: unknown,
    request: ReturnType<BeginLiveAuthRequest>,
  ) => {
    if (
      error instanceof ApiError &&
      [401, 402, 403].includes(error.status) &&
      attached(io) &&
      request.isCurrent()
    ) {
      deps.invalidate();
      fence();
      throw new CurrentDenial(ACCESS, error.status);
    }
  };
  const safeError = (error: unknown) =>
    error instanceof CurrentDenial
      ? error
      : new ApiError(
          error instanceof ApiError && [401, 402, 403].includes(error.status) ? ACCESS : BAD,
          error instanceof ApiError ? error.status : 503,
        );
  const read = <T>(io: Attachment, fetch: (token: string) => Promise<T>) =>
    withCurrentLiveAuthRead(
      () => {
        guard(io);
        return io.beginRequest();
      },
      async (request) => {
        try {
          const result = await fetch(request.token);
          guard(io);
          if (!request.isCurrent() && !request.canRetryAfterTokenChange?.()) throw new Error(BAD);
          return result;
        } catch (error) {
          authFailure(io, error, request);
          throw error;
        }
      },
      () => undefined,
    );
  const standalone = async <T>(
    io: Attachment,
    event: string | null,
    fetch: () => Promise<T>,
  ): Promise<BeltTestRead<T>> => {
    guard(io);
    const generation = event === null ? listGeneration : generations.get(event);
    const current = () =>
      attached(io) && generation === (event === null ? listGeneration : generations.get(event));
    try {
      const value = await fetch();
      return current() ? Object.freeze({ status: "ready", value, isCurrent: current }) : stale;
    } catch (error) {
      if (error instanceof CurrentDenial) throw error;
      if (!current()) return stale;
      throw safeError(error);
    }
  };
  const acknowledge = (io: Attachment, key: string, eventId: string) => {
    guard(io);
    const value = pending.get(key)!;
    const id = canonical(eventId);
    if (
      (value.knownEvent && value.knownEvent !== id) ||
      (eventOf(value.marker) && eventOf(value.marker) !== id)
    )
      throw new Error(BAD);
    value.knownEvent = id;
    value.acknowledged = true;
    if (value.marker.command === "belt_test.create" && !value.marker.event_id)
      persistChecked(io, key, { ...value.marker, event_id: id });
  };
  const observe = async (io: Attachment, key: string) => {
    guard(io);
    const marker = pending.get(key)!.marker,
      id = eventOf(marker);
    if (!id) throw new Error(BAD);
    const missing = Symbol("verified current entity missing");
    const current = (fetch: (token: string) => Promise<unknown>) =>
      read(io, async (token) => {
        try {
          return await fetch(token);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return missing;
          throw error;
        }
      });
    const event = await current((token) => io.event(id, token));
    guard(io);
    if (event !== missing && !isBeltTestEvent(event, studio, id)) throw new Error(BAD);
    let recipient: ApiBeltTestRecipientResponse | null = null,
      childMissing = false;
    if (event !== missing && marker.command === "belt_test.revoke") {
      const result = await current((token) => io.recipient(id, marker.recipient_id!, token));
      guard(io);
      if (result === missing) childMissing = true;
      else if (isBeltTestRecipient(result, studio, id, marker.recipient_id)) recipient = result;
      else throw new Error(BAD);
    }
    persistChecked(io, key, null);
    guard(io);
    invalidateReads(marker);
    const unavailable = event === missing || childMissing;
    view(
      key,
      marker,
      unavailable ? "unavailable" : "confirmed",
      event === missing
        ? "The belt-test change was saved, but the event is no longer available."
        : childMissing
          ? "The approval change was saved, but the recipient is no longer available."
          : marker.command === "belt_test.approve" || marker.command === "belt_test.revoke"
            ? "Approval change recorded."
            : "Belt-test change saved.",
      event === missing ? null : event,
      recipient,
    );
  };
  const run = (
    io: Attachment,
    key: string,
    status: "submitting" | "checking",
    action: () => Promise<void>,
  ) => {
    const task = tasks.get(key);
    if (task?.io === io && attached(io)) return task.promise;
    const marker = pending.get(key)!.marker;
    invalidateReads(marker);
    const promise = Promise.resolve()
      .then(async () => {
        guard(io);
        const settle = io.beginMutation();
        let finished = false;
        const finish = () => {
          if (!finished) {
            finished = true;
            settle();
            io.finishes.delete(finish);
          }
        };
        io.finishes.add(finish);
        try {
          await action();
        } catch (error) {
          if (attached(io) && tasks.get(key)?.promise === promise && pending.has(key)) {
            invalidateReads(pending.get(key)!.marker);
            fail(io, key, views.get(key)?.status === "storage_blocked");
          }
          throw safeError(error);
        } finally {
          finish();
        }
      })
      .finally(() => {
        if (tasks.get(key)?.promise === promise) tasks.delete(key);
      });
    tasks.set(key, { io, promise });
    view(
      key,
      marker,
      status,
      status === "submitting"
        ? "Saving belt-test change..."
        : "Checking the saved belt-test result...",
    );
    return promise;
  };
  const submit = (
    io: Attachment,
    marker: Marker,
    expect: Expectation,
    dispatch: (token: string) => Promise<unknown>,
  ) => {
    guard(io);
    const key = targetOf(marker);
    if (blocker(marker.target)) throw new Error(PENDING);
    if (storageStatus !== "ready") throw new Error(STORAGE);
    try {
      persist(io, key, marker);
    } catch {
      storageStatus = "blocked";
      publish();
      throw new Error(STORAGE);
    }
    pending.get(key)!.expect = expect;
    return run(io, key, "submitting", async () => {
      const request = io.beginRequest();
      let result: unknown;
      try {
        result = await dispatch(request.token);
      } catch (error) {
        authFailure(io, error, request);
        if (
          attached(io) &&
          request.isCurrent() &&
          error instanceof ApiError &&
          [400, 404, 409, 413, 422].includes(error.status)
        ) {
          pending.get(key)!.rejected = true;
          persistChecked(io, key, null);
          invalidateReads(marker);
          view(key, marker, "rejected", REJECTED);
        }
        throw error;
      }
      guard(io);
      if (!(request.isSameIdentity?.() ?? request.isCurrent()) || !expect(result))
        throw new Error(BAD);
      if (marker.command === "belt_test.create") {
        if (!isBeltTestEvent(result, studio)) throw new Error(BAD);
        acknowledge(io, key, result.id);
      } else acknowledge(io, key, marker.target.id);
      await observe(io, key);
    });
  };
  const makeMarker = (
    command: BeltTestCommand,
    target: BeltTestTarget,
    operation: string,
    recipient?: string,
  ): Marker => ({
    command,
    target: Object.freeze({ kind: target.kind, id: canonical(target.id) }),
    operation_id: canonical(operation),
    owner_user_id: user,
    owner_studio_id: studio,
    ...(recipient ? { recipient_id: canonical(recipient) } : {}),
  });
  const baseline = (event: Readonly<ApiBeltTestEventResponse>) => {
    if (!isBeltTestEvent(event, studio)) throw new Error("Use a current belt-test event.");
    return freezeRow(event);
  };
  function facade(io: Attachment): Omit<BeltTestFacade, "operations" | "storage"> {
    return {
      pendingOperation(target) {
        if (!attached(io)) return undefined;
        const key = blocker(target);
        return key ? views.get(key) : undefined;
      },
      async checkStorage() {
        guard(io);
        try {
          const storage = deps.storage(),
            entries = parseJournal(storage.getItem(BELT_TEST_JOURNAL_KEY));
          // Validate trusted memory before rewriting even a syntactically valid journal.
          for (const value of pending.values())
            if (!entries.some((marker) => sameMarker(marker, value.marker)))
              throw new Error(STORAGE);
          const serialized = JSON.stringify({ version: 1, entries });
          guard(io);
          storage.setItem(BELT_TEST_JOURNAL_KEY, serialized);
          guard(io);
          if (storage.getItem(BELT_TEST_JOURNAL_KEY) !== serialized) throw new Error(STORAGE);
          adopt(io, entries);
          storageStatus = "ready";
          publish();
        } catch {
          if (attached(io)) {
            storageStatus = "blocked";
            publish();
          }
          throw new Error(STORAGE);
        }
      },
      async listEvents(options) {
        const { limit, query } = pageQuery(options);
        return standalone(io, null, async () => {
          const result = await read(io, (token) => io.listEvents(query, token));
          if (!isBeltTestEventPage(result, studio, limit)) throw new Error(BAD);
          return freezePage(result);
        });
      },
      async getEvent(eventId) {
        const id = canonical(eventId);
        return standalone(io, id, async () => {
          const result = await read(io, (token) => io.event(id, token));
          if (!isBeltTestEvent(result, studio, id)) throw new Error(BAD);
          return freezeRow(result);
        });
      },
      async listRecipients(eventId, options) {
        const id = canonical(eventId),
          { limit, query } = pageQuery(options);
        return standalone(io, id, async () => {
          const result = await read(io, (token) => io.listRecipients(id, query, token));
          if (!isBeltTestRecipientPage(result, studio, id, limit)) throw new Error(BAD);
          return freezePage(result);
        });
      },
      async getRecipient(eventId, recipientId) {
        const id = canonical(eventId),
          child = canonical(recipientId);
        return standalone(io, id, async () => {
          const result = await read(io, (token) => io.recipient(id, child, token));
          if (!isBeltTestRecipient(result, studio, id, child)) throw new Error(BAD);
          return freezeRow(result);
        });
      },
      async getCandidates(eventId) {
        const id = canonical(eventId);
        return standalone(io, id, async () => {
          const result = await read(io, (token) => io.candidates(id, token));
          if (!isBeltTestCandidates(result)) throw new Error(BAD);
          return freezeRows(result);
        });
      },
      async createEvent(draftId, fields) {
        guard(io);
        const body = Object.freeze(buildBeltTestCreate(deps.uuid(), fields));
        return submit(
          io,
          makeMarker("belt_test.create", { kind: "draft", id: draftId }, body.operation_id),
          (value) => isBeltTestCreateResult(value, studio, body),
          (token) => io.create(body, token),
        );
      },
      async updateEvent(event, edit) {
        guard(io);
        const row = baseline(event),
          body = Object.freeze(buildBeltTestUpdate(deps.uuid(), row, edit));
        return submit(
          io,
          makeMarker("belt_test.update", { kind: "event", id: row.id }, body.operation_id),
          (value) => isBeltTestUpdateResult(value, row, body),
          (token) => io.update(canonical(row.id), body, token),
        );
      },
      async approveRecipients(event, pairs) {
        guard(io);
        const row = baseline(event),
          body = buildBeltTestApprove(deps.uuid(), row, pairs);
        body.recipients.forEach(Object.freeze);
        Object.freeze(body.recipients);
        Object.freeze(body);
        return submit(
          io,
          makeMarker("belt_test.approve", { kind: "event", id: row.id }, body.operation_id),
          (value) => isBeltTestApproveResult(value, row, body),
          (token) => io.approve(canonical(row.id), body, token),
        );
      },
      async revokeRecipient(event, recipient) {
        guard(io);
        const row = baseline(event),
          child = freezeRow(recipient);
        const body = Object.freeze(buildBeltTestRevoke(deps.uuid(), row, child));
        return submit(
          io,
          makeMarker(
            "belt_test.revoke",
            { kind: "event", id: row.id },
            body.operation_id,
            child.id,
          ),
          (value) => isBeltTestRevokeResult(value, row, child, body),
          (token) => io.revoke(canonical(row.id), canonical(child.id), body, token),
        );
      },
      checkResult(target) {
        guard(io);
        const key = exact(target);
        if (!key) return Promise.resolve();
        const task = tasks.get(key);
        if (task?.io === io && attached(io)) return task.promise;
        const value = pending.get(key)!,
          marker = value.marker;
        return run(io, key, "checking", async () => {
          if (value.rejected) {
            persistChecked(io, key, null);
            view(key, marker, "rejected", REJECTED);
            return;
          }
          const identity: BeltTestReceiptIdentity =
            marker.command === "belt_test.create"
              ? {
                  command: marker.command,
                  operationId: marker.operation_id,
                  studioId: studio,
                  ...(value.knownEvent || marker.event_id
                    ? { eventId: value.knownEvent ?? marker.event_id }
                    : {}),
                }
              : marker.command === "belt_test.revoke"
                ? {
                    command: marker.command,
                    operationId: marker.operation_id,
                    studioId: studio,
                    eventId: marker.target.id,
                    recipientId: marker.recipient_id!,
                  }
                : {
                    command: marker.command,
                    operationId: marker.operation_id,
                    studioId: studio,
                    eventId: marker.target.id,
                  };
          const receipt = await read(io, (token) => io.receipt(marker.operation_id, token));
          guard(io);
          if (
            !isBeltTestReceipt(receipt, identity) ||
            (value.expect && !value.expect(receipt.result))
          )
            throw new Error(BAD);
          acknowledge(
            io,
            key,
            marker.command === "belt_test.create" ? receipt.entity_id : marker.target.id,
          );
          await observe(io, key);
        });
      },
    };
  }
  authority = deps.capture(scope, fence);
  if (!isCurrent()) {
    fence();
    throw new Error(ACCESS);
  }
  return {
    scope,
    isCurrent,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bind(binding) {
      if (!isCurrent()) throw new Error(ACCESS);
      if (attachment) detach(attachment);
      const io: Attachment = { ...binding, finishes: new Set() };
      attachment = io;
      try {
        adopt(io, parseJournal(deps.storage().getItem(BELT_TEST_JOURNAL_KEY)));
        storageStatus = "ready";
      } catch {
        storageStatus = "blocked";
        // A malformed replacement journal cannot erase previously trusted reservations.
        adopt(
          io,
          [...pending.values()].map((value) => value.marker),
        );
      }
      publish();
      return () => detach(io);
    },
  };
}
const owners = new WeakMap<Window, BeltTestOwner>();
export function getBrowserBeltTestOwner(scope: BeltTestScope): BeltTestOwner {
  const existing = owners.get(window);
  if (
    existing?.isCurrent() &&
    canonical(existing.scope.userId) === canonical(scope.userId) &&
    canonical(existing.scope.studioId) === canonical(scope.studioId) &&
    existing.scope.role === scope.role
  )
    return existing;
  const owner = createBeltTestOwner(scope);
  owners.set(window, owner);
  return owner;
}

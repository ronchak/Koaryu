import { ApiError } from "@/lib/api";
import { captureAccessIdentity, invalidateAccessIdentity } from "@/lib/access-identity";
import { getActiveStudioIdCookie } from "@/lib/studio-state-cookie";
import { withCurrentLiveAuthRead, type BeginLiveAuthRequest } from "@/lib/store-action-types";
import type {
  ApiLeadCreate,
  ApiLeadCreateOperationResponse,
  ApiLeadResponse,
} from "@/types/generated/api-contracts";

export type LeadCreateView = Readonly<{
  status:
    | "idle"
    | "submitting"
    | "unknown"
    | "checking"
    | "confirmed_needs_refresh"
    | "confirmed"
    | "unavailable"
    | "rejected"
    | "storage_blocked";
  locked: boolean;
  message: string | null;
  isCurrent(): boolean;
}>;
export type LeadCreateScope = { userId: string; studioId: string; role: string };
type Marker = {
  command: "lead.create";
  operation_id: string;
  owner_user_id: string;
  owner_studio_id: string;
  lead_id?: string;
};
export const LEAD_CREATE_JOURNAL_KEY = "koaryu-lead-create-operations-v1";
export const LEAD_CREATE_JOURNAL_LIMIT = 100;
export const LEAD_CREATE_UNAVAILABLE = "The lead was created but is no longer available.";
const UNKNOWN = "The lead may have been saved. Check the result before adding another lead.";
const REFRESH = "The lead was created. Check the result to load its current details.";
const STORAGE =
  "This browser could not save the recovery record. Allow browser storage, then check the result before adding another lead.";
const REJECTED = "The lead was not saved. Review the fields and submit again.";
export const INACTIVE_LEAD_CREATE_VIEW: LeadCreateView = Object.freeze({
  status: "idle",
  locked: true,
  message: null,
  isCurrent: () => false,
});
export const PREVIEW_LEAD_CREATE_VIEW: LeadCreateView = Object.freeze({
  status: "idle",
  locked: false,
  message: null,
  isCurrent: () => true,
});

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const sources = ["walk_in", "referral", "social", "search", "website", "other"];
const stages = [
  "inquiry",
  "trial_scheduled",
  "trial_completed",
  "offer_sent",
  "enrolled",
  "closed_lost",
];
export function isLeadCreateResult(
  value: unknown,
  studioId: string,
  leadId?: string,
): value is ApiLeadResponse {
  if (
    !record(value) ||
    !uuid(value.id) ||
    value.studio_id !== studioId ||
    (leadId !== undefined && value.id !== leadId) ||
    typeof value.first_name !== "string" ||
    typeof value.last_name !== "string" ||
    !sources.includes(value.source as string) ||
    !stages.includes(value.stage as string) ||
    typeof value.is_minor !== "boolean" ||
    !date(value.created_at) ||
    !date(value.updated_at)
  )
    return false;
  for (const key of [
    "email",
    "phone",
    "program_interest",
    "guardian_name",
    "guardian_email",
    "guardian_phone",
    "follow_up_date",
    "notes",
  ]) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string")
      return false;
  }
  for (const key of ["program_id", "assigned_staff_id", "converted_student_id"]) {
    if (value[key] !== undefined && value[key] !== null && !uuid(value[key])) return false;
  }
  return (
    value.lost_reason === undefined ||
    value.lost_reason === null ||
    ["no_show", "price_objection", "timing", "no_response", "other"].includes(
      value.lost_reason as string,
    )
  );
}
export function isLeadCreateReceipt(
  value: unknown,
  operationId: string,
  studioId: string,
  leadId?: string,
): value is ApiLeadCreateOperationResponse {
  return (
    record(value) &&
    value.command === "lead.create" &&
    value.state === "committed" &&
    value.entity_type === "lead" &&
    value.operation_id === operationId &&
    uuid(value.entity_id) &&
    date(value.committed_at) &&
    isLeadCreateResult(value.result, studioId, leadId) &&
    value.entity_id === value.result.id
  );
}
function validMarker(value: unknown): value is Marker {
  return (
    record(value) &&
    [
      "command,operation_id,owner_studio_id,owner_user_id",
      "command,lead_id,operation_id,owner_studio_id,owner_user_id",
    ].includes(Object.keys(value).sort().join()) &&
    value.command === "lead.create" &&
    uuid(value.operation_id) &&
    uuid(value.owner_user_id) &&
    uuid(value.owner_studio_id) &&
    (value.lead_id === undefined || uuid(value.lead_id))
  );
}
type StorageLike = Pick<Storage, "getItem" | "setItem">;
function readJournal(storage: StorageLike): Marker[] {
  const raw = storage.getItem(LEAD_CREATE_JOURNAL_KEY);
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (
    !record(value) ||
    Object.keys(value).sort().join() !== "entries,version" ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > LEAD_CREATE_JOURNAL_LIMIT ||
    !value.entries.every(validMarker) ||
    new Set(value.entries.map((entry) => entry.operation_id)).size !== value.entries.length ||
    new Set(value.entries.map((entry) => `${entry.owner_user_id}:${entry.owner_studio_id}`))
      .size !== value.entries.length
  )
    throw new Error(STORAGE);
  return value.entries;
}
export type LeadCreateBinding = {
  isCurrent(): boolean;
  beginRequest: BeginLiveAuthRequest;
  beginMutation(): () => void;
  post(body: ApiLeadCreate, token: string): Promise<unknown>;
  receipt(operationId: string, token: string): Promise<unknown>;
  currentLead(id: string, token: string): Promise<unknown>;
  capturePublication(id: string): () => boolean;
  publish(id: string, lead: ApiLeadResponse | null, isCurrent: () => boolean): void;
};
export type LeadCreateDependencies = {
  capture: typeof captureAccessIdentity;
  invalidate: typeof invalidateAccessIdentity;
  activeStudio: typeof getActiveStudioIdCookie;
  storage(): StorageLike;
  uuid(): string;
};
const dependencies: LeadCreateDependencies = {
  capture: captureAccessIdentity,
  invalidate: invalidateAccessIdentity,
  activeStudio: getActiveStudioIdCookie,
  storage: () => window.sessionStorage,
  uuid: () => crypto.randomUUID(),
};

// The browser owns this command; providers attach only current observation sinks.
export function createLeadCreateOwner(scope: LeadCreateScope, deps = dependencies) {
  if (!uuid(scope.userId) || !uuid(scope.studioId) || !["admin", "front_desk"].includes(scope.role))
    throw new Error("Current lead access is required.");
  scope = { ...scope };
  let authority: ReturnType<typeof captureAccessIdentity> | null = null;
  let binding: LeadCreateBinding | null = null;
  let pending: Marker | null = null;
  let busy: Promise<void> | null = null;
  let fenced = false;
  let rejected = false;
  let knownLeadId: string | undefined;
  const listeners = new Set<() => void>();
  const isCurrent = () =>
    !fenced && Boolean(authority?.isCurrent()) && deps.activeStudio() === scope.studioId;
  let view: LeadCreateView = Object.freeze({
    status: "idle",
    locked: false,
    message: null,
    isCurrent,
  });
  const update = (status: LeadCreateView["status"], locked: boolean, message: string | null) => {
    view = Object.freeze({ status, locked, message, isCurrent });
    for (const listener of [...listeners]) listener();
  };
  const fence = () => {
    fenced = true;
    authority?.dispose();
    binding = null;
    update("idle", true, null);
  };
  authority = deps.capture(scope, fence);
  const requireCurrent = () => {
    if (isCurrent()) return;
    fence();
    throw new Error("Verify current studio access before continuing.");
  };
  const sameOwner = (entry: Marker) =>
    entry.owner_user_id === scope.userId && entry.owner_studio_id === scope.studioId;
  try {
    pending = readJournal(deps.storage()).find(sameOwner) ?? null;
    knownLeadId = pending?.lead_id;
    if (pending)
      update(
        pending.lead_id ? "confirmed_needs_refresh" : "unknown",
        true,
        pending.lead_id ? REFRESH : UNKNOWN,
      );
  } catch {
    update("storage_blocked", true, STORAGE);
  }
  // Every write rereads all scopes and verifies persistence. No expiry or eviction.
  const writeMarker = (next: Marker | null, attachmentCurrent = () => true) => {
    requireCurrent();
    const storage = deps.storage();
    const entries = readJournal(storage);
    const existing = entries.find(sameOwner);
    if (
      (pending &&
        (!existing ||
          existing.operation_id !== pending.operation_id ||
          existing.lead_id !== pending.lead_id)) ||
      (!pending && existing)
    )
      throw new Error(STORAGE);
    if (
      next &&
      entries.some((entry) => entry.operation_id === next.operation_id && !sameOwner(entry))
    )
      throw new Error(STORAGE);
    const nextEntries = entries.filter((entry) => !sameOwner(entry));
    if (next) nextEntries.push(next);
    if (nextEntries.length > LEAD_CREATE_JOURNAL_LIMIT) throw new Error(STORAGE);
    const previous = JSON.stringify({ version: 1, entries });
    const serialized = JSON.stringify({ version: 1, entries: nextEntries });
    requireCurrent();
    if (!attachmentCurrent()) throw new Error(REFRESH);
    try {
      storage.setItem(LEAD_CREATE_JOURNAL_KEY, serialized);
      requireCurrent();
      if (!attachmentCurrent()) throw new Error(STORAGE);
      const persisted = storage.getItem(LEAD_CREATE_JOURNAL_KEY);
      requireCurrent();
      if (!attachmentCurrent() || persisted !== serialized) throw new Error(STORAGE);
    } catch (error) {
      // Restore the earlier metadata if the write or verification failed. The
      // reservation remains locked even if storage also refuses this repair.
      try {
        storage.setItem(LEAD_CREATE_JOURNAL_KEY, previous);
      } catch {
        /* Keep the in-memory reservation. */
      }
      throw error;
    }
    pending = next;
  };
  const authFailure = (
    io: LeadCreateBinding,
    error: unknown,
    request: ReturnType<BeginLiveAuthRequest>,
  ) => {
    if (
      error instanceof ApiError &&
      [401, 402, 403].includes(error.status) &&
      binding === io &&
      io.isCurrent() &&
      request.isCurrent() &&
      isCurrent()
    ) {
      deps.invalidate();
      fence();
    }
  };
  const getBinding = () => {
    requireCurrent();
    if (!binding?.isCurrent()) throw new Error("Return to Leads to check the result.");
    return binding;
  };
  const beginRequest = (io: LeadCreateBinding) => {
    requireCurrent();
    if (binding !== io || !io.isCurrent())
      throw new Error("Current lead details need to be refreshed.");
    return io.beginRequest();
  };
  const read = async <T>(io: LeadCreateBinding, fetch: (token: string) => Promise<T>) =>
    withCurrentLiveAuthRead(
      () => beginRequest(io),
      async (request) => {
        try {
          const result = await fetch(request.token);
          if (!request.isCurrent() && !request.canRetryAfterTokenChange?.())
            throw new Error(REFRESH);
          requireCurrent();
          return result;
        } catch (error) {
          authFailure(io, error, request);
          throw error;
        }
      },
      () => undefined,
    );
  const confirmId = (id: string) => {
    if (
      !pending ||
      (pending.lead_id && pending.lead_id !== id) ||
      (knownLeadId && knownLeadId !== id)
    )
      throw new Error(UNKNOWN);
    knownLeadId = id;
    try {
      writeMarker({ ...pending, lead_id: id });
    } catch (error) {
      if (isCurrent()) update("storage_blocked", true, STORAGE);
      throw error;
    }
  };
  const observe = async (io: LeadCreateBinding) => {
    const id = pending?.lead_id;
    if (!id) throw new Error(UNKNOWN);
    const unchanged = io.capturePublication(id);
    const value = await read(io, async (token) => {
      try {
        return { value: await io.currentLead(id, token), missing: false as const };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return { missing: true as const };
        throw error;
      }
    });
    beginRequest(io);
    if (!unchanged()) throw new Error(REFRESH);
    if (!value.missing && !isLeadCreateResult(value.value, scope.studioId, id))
      throw new Error(REFRESH);
    try {
      writeMarker(null, () => binding === io && io.isCurrent() && unchanged());
    } catch (error) {
      if (isCurrent()) update("storage_blocked", true, STORAGE);
      throw error;
    }
    // All checks and cleanup are synchronous with publication, so no newer row
    // write or owner can interleave between the observation and its store update.
    beginRequest(io);
    io.publish(
      id,
      value.missing ? null : (value.value as ApiLeadResponse),
      () => isCurrent() && binding === io && io.isCurrent(),
    );
    update(
      value.missing ? "unavailable" : "confirmed",
      false,
      value.missing ? LEAD_CREATE_UNAVAILABLE : "Lead added to the pipeline.",
    );
  };
  const failedRead = () => {
    if (isCurrent() && view.status !== "storage_blocked")
      update(
        pending?.lead_id ? "confirmed_needs_refresh" : "unknown",
        true,
        pending?.lead_id ? REFRESH : UNKNOWN,
      );
  };
  return {
    scope,
    isCurrent,
    getSnapshot: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bind(next: LeadCreateBinding) {
      requireCurrent();
      const attachment = { ...next };
      binding = attachment;
      return () => {
        if (binding === attachment) binding = null;
      };
    },
    async submit(data: Partial<ApiLeadResponse>) {
      const io = getBinding();
      if (busy || pending || view.locked) throw new Error(view.message ?? UNKNOWN);
      let body: ApiLeadCreate;
      try {
        const operationId = deps.uuid();
        if (
          !uuid(operationId) ||
          typeof data.first_name !== "string" ||
          typeof data.last_name !== "string" ||
          data.stage === "enrolled"
        )
          throw new Error(REJECTED);
        // Serialize before reserving or dispatching. This also detaches the form.
        body = JSON.parse(JSON.stringify({ ...data, operation_id: operationId }));
        if (
          body.operation_id !== operationId ||
          typeof body.first_name !== "string" ||
          typeof body.last_name !== "string"
        )
          throw new Error(REJECTED);
      } catch {
        update("rejected", false, REJECTED);
        throw new Error(REJECTED);
      }
      try {
        writeMarker({
          command: "lead.create",
          operation_id: body.operation_id!,
          owner_user_id: scope.userId,
          owner_studio_id: scope.studioId,
        });
      } catch {
        if (isCurrent()) update("storage_blocked", true, STORAGE);
        throw new Error(STORAGE);
      }
      rejected = false;
      knownLeadId = undefined;
      update("submitting", true, "Saving lead...");
      const run = async () => {
        const finish = io.beginMutation();
        try {
          const request = beginRequest(io);
          let result: unknown;
          try {
            result = await io.post(body, request.token);
          } catch (error) {
            authFailure(io, error, request);
            if (
              isCurrent() &&
              error instanceof ApiError &&
              [400, 404, 409, 413, 422].includes(error.status)
            ) {
              rejected = true;
              try {
                writeMarker(null, () => binding === io && io.isCurrent());
                update("rejected", false, REJECTED);
              } catch {
                if (isCurrent()) update("rejected", true, STORAGE);
              }
            } else failedRead();
            throw new Error(view.message ?? UNKNOWN);
          }
          requireCurrent();
          if (!isLeadCreateResult(result, scope.studioId, pending?.lead_id))
            throw new Error(UNKNOWN);
          confirmId(result.id);
          await observe(io);
        } catch (error) {
          if (pending && !rejected) failedRead();
          throw error;
        } finally {
          finish();
        }
      };
      busy = run();
      try {
        await busy;
      } finally {
        busy = null;
      }
    },
    check(): Promise<void> {
      if (busy) return busy;
      const io = getBinding();
      if (view.status === "storage_blocked" || rejected) {
        try {
          const saved = readJournal(deps.storage()).find(sameOwner) ?? null;
          if (
            pending &&
            (!saved ||
              saved.operation_id !== pending.operation_id ||
              (saved.lead_id !== undefined && saved.lead_id !== knownLeadId))
          )
            throw new Error(STORAGE);
          pending = saved;
          knownLeadId ??= saved?.lead_id;
          if (!pending || rejected) {
            writeMarker(null, () => binding === io && io.isCurrent());
            update(rejected ? "rejected" : "idle", false, rejected ? REJECTED : null);
            return Promise.resolve();
          }
        } catch {
          update(rejected ? "rejected" : "storage_blocked", true, STORAGE);
          return Promise.reject(new Error(STORAGE));
        }
      }
      if (!pending) return Promise.resolve();
      update("checking", true, "Checking the saved result...");
      const run = async () => {
        const finish = io.beginMutation();
        try {
          const receipt = await read(io, (token) => io.receipt(pending!.operation_id, token));
          requireCurrent();
          if (
            !pending ||
            !isLeadCreateReceipt(receipt, pending.operation_id, scope.studioId, knownLeadId)
          )
            throw new Error(UNKNOWN);
          confirmId(receipt.entity_id);
          await observe(io);
        } catch (error) {
          failedRead();
          throw error;
        } finally {
          finish();
        }
      };
      busy = run().finally(() => {
        busy = null;
      });
      return busy;
    },
  };
}
export type LeadCreateOwner = ReturnType<typeof createLeadCreateOwner>;
const owners = new WeakMap<Window, LeadCreateOwner>();
export function getBrowserLeadCreateOwner(scope: LeadCreateScope): LeadCreateOwner {
  const retained = owners.get(window);
  if (
    retained?.isCurrent() &&
    retained.scope.userId === scope.userId &&
    retained.scope.studioId === scope.studioId &&
    retained.scope.role === scope.role
  )
    return retained;
  const owner = createLeadCreateOwner(scope);
  owners.set(window, owner);
  return owner;
}

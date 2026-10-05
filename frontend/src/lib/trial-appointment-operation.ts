import { ApiError } from "@/lib/api";
import { captureAccessIdentity, invalidateAccessIdentity } from "@/lib/access-identity";
import { getActiveStudioIdCookie } from "@/lib/studio-state-cookie";
import { withCurrentLiveAuthRead, type BeginLiveAuthRequest } from "@/lib/store-action-types";
import { isLeadCreateResult } from "@/lib/lead-create-operation";
import {
  isAppointmentInstant,
  isAppointmentSchedule,
  normalizeAppointmentSchedule,
  type AppointmentSchedule,
} from "@/lib/appointment-time";
import type { LeadOperation } from "@/lib/lead-operation-reservations";
import type {
  ApiTrialAppointmentCreate,
  ApiTrialAppointmentUpdate,
  ApiTrialAppointmentResponse,
  ApiTrialAppointmentListResponse,
  ApiTrialOperationResponse,
  ApiLeadResponse,
} from "@/types/generated/api-contracts";

export type TrialCommand = "trial.create" | "trial.update";
export type TrialOperationStatus =
  | "idle"
  | "submitting"
  | "unknown"
  | "checking"
  | "confirmed_needs_refresh"
  | "confirmed"
  | "unavailable"
  | "rejected"
  | "storage_blocked";
export type TrialOperationView = Readonly<{
  command: TrialCommand | null;
  leadId: string;
  appointmentId: string | null;
  status: TrialOperationStatus;
  locked: boolean;
  ownsLeadReservation: boolean;
  message: string | null;
  currentAppointment: Readonly<ApiTrialAppointmentResponse> | null;
  isCurrent(): boolean;
}>;
export type TrialStorageView = Readonly<{
  status: "inactive" | "ready" | "blocked";
  message: string | null;
  isCurrent(): boolean;
}>;
export type TrialReadResult<T> =
  Readonly<{ status: "ready"; value: T; isCurrent(): boolean }> | Readonly<{ status: "stale" }>;
export type TrialProgramSelection =
  Readonly<{ mode: "none" }> | Readonly<{ mode: "program"; id: string }>;
export type TrialCreateFields = Readonly<{
  schedule: AppointmentSchedule;
  location: string;
  program: TrialProgramSelection | Readonly<{ mode: "inherit" }>;
}>;
export type TrialEdit =
  | Readonly<{
      kind: "schedule";
      schedule?: AppointmentSchedule;
      location?: string;
      program?: TrialProgramSelection;
    }>
  | Readonly<{ kind: "outcome"; status: "completed" | "no_show" | "canceled" }>;
export interface TrialAppointmentFacade {
  readonly trialOperations: ReadonlyMap<string, TrialOperationView>;
  readonly trialStorage: TrialStorageView;
  checkTrialAppointmentStorage(): Promise<void>;
  listTrialAppointments(
    leadId: string,
    options?: Readonly<{ cursor?: string; limit?: number }>,
  ): Promise<TrialReadResult<Readonly<ApiTrialAppointmentListResponse>>>;
  getTrialAppointment(
    leadId: string,
    appointmentId: string,
  ): Promise<TrialReadResult<Readonly<ApiTrialAppointmentResponse>>>;
  createTrialAppointment(leadId: string, fields: TrialCreateFields): Promise<void>;
  updateTrialAppointment(
    baseline: Readonly<ApiTrialAppointmentResponse>,
    edit: TrialEdit,
  ): Promise<void>;
  checkTrialAppointmentResult(leadId: string): Promise<void>;
}
export const TRIAL_JOURNAL_KEY = "koaryu-trial-appointment-operations-v1";
export const TRIAL_UNAVAILABLE =
  "The trial change was saved, but the appointment is no longer available.";
const UNKNOWN =
  "The trial change may have been saved. Check the result before making another change.";
const REFRESH = "The trial change was saved. Check the result to load its current details.";
const STORAGE =
  "This browser could not verify the trial recovery record. Allow browser storage, then check storage before making another change.";
const ACCESS = "Verify current admin access before managing trial appointments.";
const REJECTED =
  "The trial change was not saved. Review the current appointment before trying again.";
const CONFLICT =
  "Another change is pending for this lead. Check the result when that change finishes.";
const UNAVAILABLE = "Trial appointments are temporarily unavailable. Try again shortly.";
const stale = Object.freeze({ status: "stale" as const });
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const location = (value: unknown): value is string =>
  typeof value === "string" && [...value].length <= 240;
const revision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
class CurrentTrialDenial extends ApiError {}
const bad = () => new ApiError(UNAVAILABLE, 503);
const invalid = () => new Error("Use valid trial appointment fields.");
export function isTrialAppointment(
  value: unknown,
  studio: string,
  lead: string,
  id?: string,
  validProgram: (value: unknown) => boolean = uuid,
): value is ApiTrialAppointmentResponse {
  return (
    record(value) &&
    uuid(value.id) &&
    value.studio_id === studio &&
    value.lead_id === lead &&
    (id === undefined || value.id === id) &&
    (value.program_id === null || validProgram(value.program_id)) &&
    (value.created_by === null || uuid(value.created_by)) &&
    typeof value.status === "string" &&
    ["scheduled", "completed", "no_show", "canceled"].includes(value.status) &&
    revision(value.revision) &&
    location(value.location) &&
    isAppointmentInstant(value.created_at) &&
    isAppointmentInstant(value.updated_at) &&
    typeof value.starts_at === "string" &&
    typeof value.ends_at === "string" &&
    typeof value.timezone === "string" &&
    isAppointmentSchedule({
      starts_at: value.starts_at,
      ends_at: value.ends_at,
      timezone: value.timezone,
    })
  );
}
export function isTrialAppointmentList(
  value: unknown,
  studio: string,
  lead: string,
  limit = 100,
): value is ApiTrialAppointmentListResponse {
  return (
    record(value) &&
    Array.isArray(value.items) &&
    value.items.length <= limit &&
    value.items.every((item) => isTrialAppointment(item, studio, lead)) &&
    new Set(value.items.map((item) => item.id)).size === value.items.length &&
    (value.next_cursor === null ||
      (typeof value.next_cursor === "string" &&
        value.next_cursor.length > 0 &&
        value.next_cursor.length <= 512)) &&
    typeof value.has_more === "boolean" &&
    value.has_more === (value.next_cursor !== null)
  );
}
export function isTrialReceipt(
  value: unknown,
  marker: TrialMarker,
): value is ApiTrialOperationResponse {
  return (
    record(value) &&
    value.operation_id === marker.operation_id &&
    value.command === marker.command &&
    value.state === "committed" &&
    value.entity_type === "trial_appointment" &&
    uuid(value.entity_id) &&
    isAppointmentInstant(value.committed_at) &&
    isTrialAppointment(
      value.result,
      marker.owner_studio_id,
      marker.lead_id,
      marker.appointment_id,
    ) &&
    value.entity_id === value.result.id
  );
}
function programFields(
  program: TrialCreateFields["program"],
  validProgram: (value: unknown) => boolean = uuid,
): { program_id?: string | null } {
  if (program.mode === "inherit") return {};
  if (program.mode === "none") return { program_id: null };
  if (program.mode === "program" && validProgram(program.id)) return { program_id: program.id };
  throw invalid();
}
export function buildTrialCreate(
  operationId: string,
  fields: TrialCreateFields,
  validProgram: (value: unknown) => boolean = uuid,
): ApiTrialAppointmentCreate {
  if (!uuid(operationId) || !location(fields.location)) throw invalid();
  return {
    operation_id: operationId,
    ...normalizeAppointmentSchedule(fields.schedule),
    location: fields.location,
    ...programFields(fields.program, validProgram),
  };
}
export function buildTrialUpdate(
  operationId: string,
  baseline: Readonly<ApiTrialAppointmentResponse>,
  edit: TrialEdit,
  previewProgram?: (value: unknown) => boolean,
): ApiTrialAppointmentUpdate {
  if (
    !uuid(operationId) ||
    !isTrialAppointment(
      baseline,
      baseline.studio_id,
      baseline.lead_id,
      undefined,
      previewProgram ? (value) => typeof value === "string" : uuid,
    ) ||
    baseline.status !== "scheduled" ||
    baseline.revision === Number.MAX_SAFE_INTEGER
  )
    throw invalid();
  const body: ApiTrialAppointmentUpdate = {
    operation_id: operationId,
    expected_revision: baseline.revision,
  };
  if (edit.kind === "outcome") {
    if (!["completed", "no_show", "canceled"].includes(edit.status)) throw invalid();
    body.status = edit.status;
  } else if (edit.kind === "schedule") {
    if (edit.schedule) {
      const next = normalizeAppointmentSchedule(edit.schedule),
        previous = normalizeAppointmentSchedule(baseline);
      if (
        next.starts_at !== previous.starts_at ||
        next.ends_at !== previous.ends_at ||
        next.timezone !== previous.timezone
      )
        Object.assign(body, next);
    }
    if (edit.location !== undefined) {
      if (!location(edit.location)) throw invalid();
      if (edit.location !== baseline.location) body.location = edit.location;
    }
    if (edit.program !== undefined) {
      const next = programFields(edit.program, previewProgram);
      if (!("program_id" in next)) throw invalid();
      if (next.program_id !== baseline.program_id) body.program_id = next.program_id;
    }
  } else throw invalid();
  if (Object.keys(body).length === 2)
    throw new Error("Choose an appointment change before saving.");
  return body;
}
export type TrialMarker = {
  command: TrialCommand;
  operation_id: string;
  owner_user_id: string;
  owner_studio_id: string;
  lead_id: string;
  appointment_id?: string;
};
type StorageLike = Pick<Storage, "getItem" | "setItem">;
function readJournal(storage: StorageLike): TrialMarker[] {
  const raw = storage.getItem(TRIAL_JOURNAL_KEY);
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (
    !record(value) ||
    Object.keys(value).sort().join() !== "entries,version" ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > 100
  )
    throw new Error(STORAGE);
  const entries: TrialMarker[] = [];
  for (const entry of value.entries) {
    if (
      !record(entry) ||
      ![
        "command,lead_id,operation_id,owner_studio_id,owner_user_id",
        "appointment_id,command,lead_id,operation_id,owner_studio_id,owner_user_id",
      ].includes(Object.keys(entry).sort().join()) ||
      typeof entry.command !== "string" ||
      !["trial.create", "trial.update"].includes(entry.command) ||
      !uuid(entry.operation_id) ||
      !uuid(entry.owner_user_id) ||
      !uuid(entry.owner_studio_id) ||
      !uuid(entry.lead_id) ||
      (entry.appointment_id !== undefined && !uuid(entry.appointment_id)) ||
      (entry.command === "trial.update" && !uuid(entry.appointment_id))
    )
      throw new Error(STORAGE);
    entries.push({
      command: entry.command === "trial.create" ? "trial.create" : "trial.update",
      operation_id: entry.operation_id,
      owner_user_id: entry.owner_user_id,
      owner_studio_id: entry.owner_studio_id,
      lead_id: entry.lead_id,
      ...(entry.appointment_id === undefined ? {} : { appointment_id: entry.appointment_id }),
    });
  }
  if (
    new Set(entries.map((entry) => entry.operation_id)).size !== entries.length ||
    new Set(
      entries.map((entry) => `${entry.owner_user_id}:${entry.owner_studio_id}:${entry.lead_id}`),
    ).size !== entries.length
  )
    throw new Error(STORAGE);
  return entries;
}
export type TrialScope = { userId: string; studioId: string; role: string };
export type TrialBinding = {
  isCurrent(): boolean;
  beginRequest: BeginLiveAuthRequest;
  beginMutation(): () => void;
  reserve(lead: string): LeadOperation | null;
  current(lead: string): LeadOperation | null;
  release(handle: LeadOperation): boolean;
  list(lead: string, query: string, token: string): Promise<unknown>;
  detail(lead: string, id: string, token: string): Promise<unknown>;
  create(lead: string, body: ApiTrialAppointmentCreate, token: string): Promise<unknown>;
  update(
    lead: string,
    id: string,
    body: ApiTrialAppointmentUpdate,
    token: string,
  ): Promise<unknown>;
  receipt(id: string, token: string): Promise<unknown>;
  currentLead(id: string, token: string): Promise<unknown>;
  capturePublication(id: string): () => boolean;
  publish(id: string, lead: ApiLeadResponse | null, isCurrent: () => boolean): void;
};
export type TrialDependencies = {
  capture: typeof captureAccessIdentity;
  invalidate: typeof invalidateAccessIdentity;
  activeStudio: typeof getActiveStudioIdCookie;
  storage(): StorageLike;
  uuid(): string;
};
const dependencies: TrialDependencies = {
  capture: captureAccessIdentity,
  invalidate: invalidateAccessIdentity,
  activeStudio: getActiveStudioIdCookie,
  storage: () => window.sessionStorage,
  uuid: () => crypto.randomUUID(),
};
type Attachment = TrialBinding & { handles: Map<string, LeadOperation> };
const frozenRow = (row: ApiTrialAppointmentResponse) => Object.freeze({ ...row });
function frozenList(value: ApiTrialAppointmentListResponse) {
  const items = value.items.map(frozenRow);
  Object.freeze(items);
  return Object.freeze({ ...value, items });
}
function pageQuery(options?: Readonly<{ cursor?: string; limit?: number }>) {
  const limit = options?.limit ?? 50,
    cursor = options?.cursor;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor !== undefined &&
      (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 512))
  )
    throw invalid();
  return {
    limit,
    query: `?limit=${limit}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
  };
}
const inactive = async (): Promise<never> => {
  throw new Error(ACCESS);
};
export const INACTIVE_TRIAL_FACADE: TrialAppointmentFacade = Object.freeze({
  trialOperations: new Map(),
  trialStorage: Object.freeze({ status: "inactive", message: null, isCurrent: () => false }),
  checkTrialAppointmentStorage: inactive,
  listTrialAppointments: inactive,
  getTrialAppointment: inactive,
  createTrialAppointment: inactive,
  updateTrialAppointment: inactive,
  checkTrialAppointmentResult: inactive,
});

export function createTrialAppointmentOwner(scope: TrialScope, deps = dependencies) {
  if (!uuid(scope.userId) || !uuid(scope.studioId) || scope.role !== "admin")
    throw new Error(ACCESS);
  scope = { ...scope };
  let authority: ReturnType<typeof captureAccessIdentity> | null = null,
    attachment: Attachment | null = null;
  let fenced = false,
    storageStatus: TrialStorageView["status"] = "inactive";
  const pending = new Map<string, TrialMarker>(),
    views = new Map<string, TrialOperationView>();
  const knownIds = new Map<string, string>();
  const confirmed = new Set<string>(),
    rejected = new Set<string>();
  const busy = new Map<string, { io: Attachment; promise: Promise<void> }>(),
    listeners = new Set<() => void>();
  const isCurrent = () =>
    !fenced && Boolean(authority?.isCurrent()) && deps.activeStudio() === scope.studioId;
  const attached = (io: Attachment | null): io is Attachment =>
    Boolean(io && attachment === io && io.isCurrent() && isCurrent());
  const owns = (io: Attachment, lead: string) =>
    attached(io) && io.handles.has(lead) && io.current(lead) === io.handles.get(lead);
  let snapshot: TrialAppointmentFacade = INACTIVE_TRIAL_FACADE;
  const publish = () => {
    const io = attachment;
    snapshot = Object.freeze({
      ...methods,
      trialOperations: Object.freeze(new Map(views)),
      trialStorage: Object.freeze({
        status: storageStatus,
        message: storageStatus === "blocked" ? STORAGE : null,
        isCurrent: () => attached(io),
      }),
    });
    for (const listener of [...listeners]) listener();
  };
  const view = (
    lead: string,
    status: TrialOperationStatus,
    message: string | null,
    row: ApiTrialAppointmentResponse | null = null,
    command?: TrialCommand,
  ) => {
    const io = attachment,
      marker = pending.get(lead),
      owned = io ? owns(io, lead) : false;
    const currentView: TrialOperationView = Object.freeze({
      leadId: lead,
      command: marker?.command ?? command ?? null,
      appointmentId:
        marker?.appointment_id ??
        row?.id ??
        (command ? (knownIds.get(lead) ?? views.get(lead)?.appointmentId) : null) ??
        null,
      status,
      locked: Boolean(marker),
      ownsLeadReservation: owned,
      message,
      currentAppointment: row && frozenRow(row),
      isCurrent: () => attached(io) && views.get(lead) === currentView,
    });
    views.set(lead, currentView);
    publish();
  };
  const release = (io: Attachment, lead: string) => {
    const handle = io.handles.get(lead);
    if (handle) io.release(handle);
    io.handles.delete(lead);
  };
  const detach = (io: Attachment) => {
    for (const lead of io.handles.keys()) release(io, lead);
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
  const requireAttachment = () => {
    if (!isCurrent()) {
      fence();
      throw new Error(ACCESS);
    }
    if (!attached(attachment)) throw new Error(ACCESS);
    return attachment;
  };
  const sameOwner = (entry: TrialMarker) =>
    entry.owner_user_id === scope.userId && entry.owner_studio_id === scope.studioId;
  const guard = (io: Attachment, lead?: string) => {
    if (!attached(io) || (lead !== undefined && !owns(io, lead))) throw new Error(REFRESH);
  };
  const reserve = (io: Attachment, lead: string) => {
    if (owns(io, lead)) return true;
    const handle = io.reserve(lead);
    if (handle) io.handles.set(lead, handle);
    return owns(io, lead);
  };
  const adopt = (io: Attachment, entries: TrialMarker[]) => {
    guard(io);
    for (const entry of entries.filter(sameOwner)) {
      const existing = pending.get(entry.lead_id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error(STORAGE);
    }
    for (const entry of pending.values()) {
      if (
        !entries.some(
          (saved) => sameOwner(saved) && JSON.stringify(saved) === JSON.stringify(entry),
        )
      )
        throw new Error(STORAGE);
    }
    for (const marker of entries
      .filter(sameOwner)
      .sort((a, b) => a.lead_id.localeCompare(b.lead_id))) {
      pending.set(marker.lead_id, marker);
      if (marker.command === "trial.create" && marker.appointment_id) confirmed.add(marker.lead_id);
      const owned = reserve(io, marker.lead_id);
      view(
        marker.lead_id,
        confirmed.has(marker.lead_id) ? "confirmed_needs_refresh" : "unknown",
        owned ? (confirmed.has(marker.lead_id) ? REFRESH : UNKNOWN) : CONFLICT,
      );
    }
  };
  const persist = (io: Attachment, lead: string, next: TrialMarker | null, extra = () => true) => {
    guard(io, lead);
    const storage = deps.storage(),
      entries = readJournal(storage),
      previous = pending.get(lead);
    const saved = entries.find((entry) => sameOwner(entry) && entry.lead_id === lead);
    if (JSON.stringify(saved) !== JSON.stringify(previous)) throw new Error(STORAGE);
    const nextEntries = entries.filter((entry) => !(sameOwner(entry) && entry.lead_id === lead));
    if (next) nextEntries.push(next);
    if (
      nextEntries.length > 100 ||
      new Set(nextEntries.map((entry) => entry.operation_id)).size !== nextEntries.length
    )
      throw new Error(STORAGE);
    const before = JSON.stringify({ version: 1, entries }),
      after = JSON.stringify({ version: 1, entries: nextEntries });
    guard(io, lead);
    if (!extra()) throw new Error(REFRESH);
    try {
      storage.setItem(TRIAL_JOURNAL_KEY, after);
      guard(io, lead);
      if (!extra() || storage.getItem(TRIAL_JOURNAL_KEY) !== after) throw new Error(STORAGE);
      guard(io, lead);
      if (!extra()) throw new Error(REFRESH);
    } catch (error) {
      try {
        storage.setItem(TRIAL_JOURNAL_KEY, before);
      } catch {
        /* Retain the in-memory lock. */
      }
      throw error;
    }
    if (next) pending.set(lead, next);
    else pending.delete(lead);
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
      return true;
    }
    return false;
  };
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
          if (!request.isCurrent() && !request.canRetryAfterTokenChange?.()) throw bad();
          return result;
        } catch (error) {
          if (error instanceof ApiError && authFailure(io, error, request))
            throw new CurrentTrialDenial(ACCESS, error.status);
          throw error;
        }
      },
      () => undefined,
    );
  const safeError = (error: unknown) =>
    new ApiError(
      error instanceof ApiError && error.status === 404
        ? "Trial appointment or lead not found."
        : UNAVAILABLE,
      error instanceof ApiError ? error.status : 503,
    );
  const standalone = async <T>(
    fetch: (io: Attachment) => Promise<T>,
  ): Promise<TrialReadResult<T>> => {
    const io = requireAttachment();
    try {
      const value = await fetch(io);
      return attached(io)
        ? Object.freeze({ status: "ready", value, isCurrent: () => attached(io) })
        : stale;
    } catch (error) {
      if (error instanceof CurrentTrialDenial) throw error;
      if (!attached(io)) return stale;
      throw safeError(error);
    }
  };
  const fail = (io: Attachment, lead: string, storage = false) => {
    if (!attached(io)) return;
    if (storage) storageStatus = "blocked";
    view(
      lead,
      storage ? "storage_blocked" : confirmed.has(lead) ? "confirmed_needs_refresh" : "unknown",
      storage ? STORAGE : confirmed.has(lead) ? REFRESH : UNKNOWN,
    );
  };
  const observe = async (io: Attachment, lead: string) => {
    guard(io, lead);
    const marker = pending.get(lead);
    if (!marker?.appointment_id) throw bad();
    const unchanged = io.capturePublication(lead);
    const currentOrMissing = (fetch: (token: string) => Promise<unknown>) =>
      read(io, async (token) => {
        try {
          return await fetch(token);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      });
    const appointment = await currentOrMissing((token) =>
      io.detail(lead, marker.appointment_id!, token),
    );
    guard(io, lead);
    if (
      appointment !== null &&
      !isTrialAppointment(appointment, scope.studioId, lead, marker.appointment_id)
    )
      throw bad();
    const currentLead = await currentOrMissing((token) => io.currentLead(lead, token));
    guard(io, lead);
    if (
      !unchanged() ||
      (currentLead !== null && !isLeadCreateResult(currentLead, scope.studioId, lead))
    )
      throw bad();
    try {
      persist(io, lead, null, unchanged);
    } catch (error) {
      fail(io, lead, true);
      throw error;
    }
    guard(io, lead);
    io.publish(lead, currentLead, () => attached(io) && !pending.has(lead));
    release(io, lead);
    confirmed.delete(lead);
    rejected.delete(lead);
    view(
      lead,
      appointment === null || currentLead === null ? "unavailable" : "confirmed",
      appointment === null || currentLead === null ? TRIAL_UNAVAILABLE : "Trial change saved.",
      currentLead === null ? null : appointment,
      marker.command,
    );
    knownIds.delete(lead);
  };
  const confirm = (io: Attachment, lead: string, id: string) => {
    guard(io, lead);
    const marker = pending.get(lead);
    if (
      !marker ||
      (marker.appointment_id !== undefined && marker.appointment_id !== id) ||
      (knownIds.has(lead) && knownIds.get(lead) !== id)
    )
      throw bad();
    knownIds.set(lead, id);
    confirmed.add(lead);
    try {
      persist(io, lead, { ...marker, appointment_id: id });
    } catch (error) {
      fail(io, lead, true);
      throw error;
    }
  };
  const run = (io: Attachment, lead: string, action: () => Promise<void>): Promise<void> => {
    const task = busy.get(lead);
    if (task?.io === io) return task.promise;
    const promise = Promise.resolve()
      .then(async () => {
        guard(io, lead);
        const finish = io.beginMutation();
        try {
          await action();
        } catch (error) {
          if (
            attached(io) &&
            pending.has(lead) &&
            !rejected.has(lead) &&
            views.get(lead)?.status !== "storage_blocked"
          )
            fail(io, lead);
          throw safeError(error);
        } finally {
          finish();
        }
      })
      .finally(() => {
        if (busy.get(lead)?.promise === promise) busy.delete(lead);
      });
    busy.set(lead, { io, promise });
    return promise;
  };
  const submit = (
    lead: string,
    command: TrialCommand,
    body: ApiTrialAppointmentCreate | ApiTrialAppointmentUpdate,
    appointmentId?: string,
  ) => {
    const io = requireAttachment();
    if (!uuid(lead)) throw invalid();
    if (storageStatus !== "ready") throw new Error(STORAGE);
    if (pending.has(lead) || !reserve(io, lead)) throw new Error(CONFLICT);
    confirmed.delete(lead);
    knownIds.delete(lead);
    rejected.delete(lead);
    try {
      persist(io, lead, {
        command,
        operation_id: body.operation_id,
        owner_user_id: scope.userId,
        owner_studio_id: scope.studioId,
        lead_id: lead,
        ...(appointmentId === undefined ? {} : { appointment_id: appointmentId }),
      });
    } catch {
      release(io, lead);
      storageStatus = "blocked";
      view(lead, "storage_blocked", STORAGE);
      throw new Error(STORAGE);
    }
    view(lead, "submitting", "Saving trial change...");
    return run(io, lead, async () => {
      const request = io.beginRequest();
      let result: unknown;
      try {
        result =
          "expected_revision" in body
            ? await io.update(lead, appointmentId!, body, request.token)
            : await io.create(lead, body, request.token);
      } catch (error) {
        authFailure(io, error, request);
        if (
          attached(io) &&
          error instanceof ApiError &&
          [400, 404, 409, 413, 422].includes(error.status)
        ) {
          rejected.add(lead);
          try {
            persist(io, lead, null);
            release(io, lead);
            view(lead, "rejected", REJECTED, null, command);
          } catch {
            fail(io, lead, true);
          }
        }
        throw error;
      }
      guard(io, lead);
      if (
        !(request.isSameIdentity?.() ?? request.isCurrent()) ||
        !isTrialAppointment(result, scope.studioId, lead, appointmentId) ||
        ("expected_revision" in body
          ? result.revision !== body.expected_revision + 1
          : result.revision !== 1 || result.status !== "scheduled")
      )
        throw bad();
      confirm(io, lead, result.id);
      await observe(io, lead);
    });
  };
  const methods = {
    async checkTrialAppointmentStorage() {
      const io = requireAttachment();
      try {
        const storage = deps.storage(),
          entries = readJournal(storage),
          serialized = JSON.stringify({ version: 1, entries });
        guard(io);
        storage.setItem(TRIAL_JOURNAL_KEY, serialized);
        guard(io);
        if (storage.getItem(TRIAL_JOURNAL_KEY) !== serialized) throw new Error(STORAGE);
        guard(io);
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
    async listTrialAppointments(
      lead: string,
      options?: Readonly<{ cursor?: string; limit?: number }>,
    ) {
      if (!uuid(lead)) throw invalid();
      const { limit, query } = pageQuery(options);
      return standalone(async (io) => {
        const value = await read(io, (token) => io.list(lead, query, token));
        if (!isTrialAppointmentList(value, scope.studioId, lead, limit)) throw bad();
        return frozenList(value);
      });
    },
    async getTrialAppointment(lead: string, id: string) {
      if (!uuid(lead) || !uuid(id)) throw invalid();
      return standalone(async (io) => {
        const value = await read(io, (token) => io.detail(lead, id, token));
        if (!isTrialAppointment(value, scope.studioId, lead, id)) throw bad();
        return frozenRow(value);
      });
    },
    async createTrialAppointment(lead: string, fields: TrialCreateFields) {
      requireAttachment();
      let body: ApiTrialAppointmentCreate;
      try {
        body = buildTrialCreate(deps.uuid(), fields);
      } catch (error) {
        if (!pending.has(lead))
          view(lead, "rejected", "Review the appointment fields before saving.");
        throw error;
      }
      return submit(lead, "trial.create", body);
    },
    async updateTrialAppointment(baseline: Readonly<ApiTrialAppointmentResponse>, edit: TrialEdit) {
      requireAttachment();
      if (baseline.studio_id !== scope.studioId) throw invalid();
      let body: ApiTrialAppointmentUpdate;
      try {
        body = buildTrialUpdate(deps.uuid(), baseline, edit);
      } catch (error) {
        if (!pending.has(baseline.lead_id))
          view(baseline.lead_id, "rejected", "Review the appointment fields before saving.");
        throw error;
      }
      return submit(baseline.lead_id, "trial.update", body, baseline.id);
    },
    checkTrialAppointmentResult(lead: string): Promise<void> {
      const io = requireAttachment(),
        task = busy.get(lead);
      if (task?.io === io) return task.promise;
      const marker = pending.get(lead);
      if (!marker) return Promise.resolve();
      if (!reserve(io, lead)) {
        view(lead, "unknown", CONFLICT);
        return Promise.reject(new Error(CONFLICT));
      }
      view(lead, "checking", "Checking the saved trial result...");
      return run(io, lead, async () => {
        if (rejected.has(lead)) {
          try {
            persist(io, lead, null);
            release(io, lead);
            view(lead, "rejected", REJECTED, null, marker.command);
          } catch (error) {
            fail(io, lead, true);
            throw error;
          }
          return;
        }
        const receipt = await read(io, (token) => io.receipt(marker.operation_id, token));
        guard(io, lead);
        if (
          !isTrialReceipt(receipt, {
            ...marker,
            ...(knownIds.has(lead) ? { appointment_id: knownIds.get(lead) } : {}),
          })
        )
          throw bad();
        confirm(io, lead, receipt.entity_id);
        await observe(io, lead);
      });
    },
  };
  authority = deps.capture(scope, fence);
  if (!isCurrent()) {
    fence();
    throw new Error(ACCESS);
  }
  return {
    scope,
    isCurrent,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bind(binding: TrialBinding) {
      if (!isCurrent()) throw new Error(ACCESS);
      if (attachment) detach(attachment);
      const io: Attachment = { ...binding, handles: new Map() };
      attachment = io;
      try {
        adopt(io, readJournal(deps.storage()));
        storageStatus = "ready";
      } catch {
        storageStatus = "blocked";
        // Previously verified in-memory commands retain their locks even when
        // the current journal cannot be trusted. Never adopt its malformed rows.
        adopt(io, [...pending.values()]);
      }
      publish();
      return () => detach(io);
    },
  };
}
export type TrialAppointmentOwner = ReturnType<typeof createTrialAppointmentOwner>;
const owners = new WeakMap<Window, TrialAppointmentOwner>();
export function getBrowserTrialAppointmentOwner(scope: TrialScope): TrialAppointmentOwner {
  const existing = owners.get(window);
  if (
    existing?.isCurrent() &&
    existing.scope.userId === scope.userId &&
    existing.scope.studioId === scope.studioId &&
    existing.scope.role === scope.role
  )
    return existing;
  const owner = createTrialAppointmentOwner(scope);
  owners.set(window, owner);
  return owner;
}

// Explicit sample owner. It never touches live authority, transport or storage.
export function createPreviewTrialOwner(
  getLeads: () => readonly { id: string; program_id?: string | null }[],
  isCurrent: () => boolean,
  getPrograms: () => readonly { id: string; archived_at?: string | null }[] = () => [],
) {
  const validProgram = (id: unknown) =>
    getPrograms().some((program) => program.id === id && !program.archived_at);
  const rows = new Map<string, ApiTrialAppointmentResponse[]>(),
    views = new Map<string, TrialOperationView>(),
    listeners = new Set<() => void>();
  const sample = "00000000-0000-4000-8000-000000000001";
  const ensure = (lead: string) => {
    if (!isCurrent()) throw new Error("This preview is no longer current.");
    if (!rows.has(lead))
      rows.set(
        lead,
        getLeads().some((item) => item.id === lead)
          ? [
              {
                id: crypto.randomUUID(),
                studio_id: sample,
                lead_id: lead,
                program_id: getLeads().find((item) => item.id === lead)?.program_id ?? null,
                starts_at: "2030-01-15T17:00:00Z",
                ends_at: "2030-01-15T18:00:00Z",
                timezone: "UTC",
                location: "Sample training room",
                status: "scheduled",
                revision: 1,
                created_by: null,
                created_at: "2030-01-01T00:00:00Z",
                updated_at: "2030-01-01T00:00:00Z",
              },
            ]
          : [],
      );
    return rows.get(lead)!;
  };
  const ready = <T>(value: T): TrialReadResult<T> =>
    Object.freeze({ status: "ready", value, isCurrent });
  const complete = (row: ApiTrialAppointmentResponse, command: TrialCommand) => {
    views.set(
      row.lead_id,
      Object.freeze({
        command,
        leadId: row.lead_id,
        appointmentId: row.id,
        status: "confirmed",
        locked: false,
        ownsLeadReservation: false,
        message: "Sample trial change saved.",
        currentAppointment: frozenRow(row),
        isCurrent,
      }),
    );
    publish();
  };
  const methods = {
    async checkTrialAppointmentStorage() {
      if (!isCurrent()) throw new Error(ACCESS);
    },
    async checkTrialAppointmentResult() {
      if (!isCurrent()) throw new Error(ACCESS);
    },
    async listTrialAppointments(
      lead: string,
      options?: Readonly<{ cursor?: string; limit?: number }>,
    ) {
      const { limit } = pageQuery(options),
        all = ensure(lead);
      const offset = options?.cursor === undefined ? 0 : Number(options.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) throw invalid();
      const items = all.slice(offset, offset + limit),
        more = offset + limit < all.length;
      return ready(
        frozenList({ items, next_cursor: more ? String(offset + limit) : null, has_more: more }),
      );
    },
    async getTrialAppointment(lead: string, id: string) {
      const row = ensure(lead).find((item) => item.id === id);
      if (!row) throw new ApiError("Sample appointment not found.", 404);
      return ready(frozenRow(row));
    },
    async createTrialAppointment(lead: string, fields: TrialCreateFields) {
      const all = ensure(lead),
        body = buildTrialCreate(crypto.randomUUID(), fields, validProgram);
      if (all.some((item) => item.status === "scheduled"))
        throw new ApiError("A sample trial is already scheduled.", 409);
      const now = new Date().toISOString();
      const row: ApiTrialAppointmentResponse = {
        id: crypto.randomUUID(),
        lead_id: lead,
        studio_id: sample,
        program_id:
          body.program_id === undefined
            ? (getLeads().find((item) => item.id === lead)?.program_id ?? null)
            : body.program_id,
        starts_at: body.starts_at,
        ends_at: body.ends_at,
        timezone: body.timezone,
        location: body.location ?? "",
        status: "scheduled",
        revision: 1,
        created_by: null,
        created_at: now,
        updated_at: now,
      };
      rows.set(lead, [row, ...all]);
      complete(row, "trial.create");
    },
    async updateTrialAppointment(baseline: Readonly<ApiTrialAppointmentResponse>, edit: TrialEdit) {
      const all = ensure(baseline.lead_id),
        current = all.find((item) => item.id === baseline.id);
      if (!current || current.revision !== baseline.revision)
        throw new ApiError("Reload the sample appointment before saving.", 409);
      const body = buildTrialUpdate(crypto.randomUUID(), current, edit, validProgram);
      const changes: Partial<ApiTrialAppointmentUpdate> = { ...body };
      delete changes.operation_id;
      delete changes.expected_revision;
      const row = {
        ...current,
        ...changes,
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
      };
      rows.set(
        row.lead_id,
        all.map((item) => (item.id === row.id ? row : item)),
      );
      complete(row, "trial.update");
    },
  };
  let snapshot: TrialAppointmentFacade;
  const publish = () => {
    snapshot = Object.freeze({
      ...methods,
      trialOperations: Object.freeze(new Map(views)),
      trialStorage: Object.freeze({ status: "inactive", message: null, isCurrent }),
    });
    for (const listener of listeners) listener();
  };
  publish();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

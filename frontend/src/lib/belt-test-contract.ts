import type {
  ApiBeltTestEventCreate,
  ApiBeltTestEventUpdate,
  ApiBeltTestEventResponse,
  ApiBeltTestEventListResponse,
  ApiBeltTestRecipientApprove,
  ApiBeltTestRecipientRevoke,
  ApiBeltTestRecipientSelection,
  ApiBeltTestRecipientResponse,
  ApiBeltTestRecipientApprovalResponse,
  ApiBeltTestRecipientListResponse,
  ApiBeltTestOperationResponse,
  ApiBeltTestApprovalOperationResponse,
  ApiBeltTestRevokeOperationResponse,
  ApiEligibilityEntry,
} from "../types/generated/api-contracts";
import {
  type AppointmentSchedule,
  isAppointmentInstant,
  isAppointmentSchedule,
  normalizeAppointmentSchedule,
} from "./appointment-time.ts";

export type BeltTestCommand =
  "belt_test.create" | "belt_test.update" | "belt_test.approve" | "belt_test.revoke";
export type BeltTestTarget =
  Readonly<{ kind: "draft"; id: string }> | Readonly<{ kind: "event"; id: string }>;
export type BeltTestPair = Readonly<{
  student_id: string;
  student_program_membership_id: string | null;
}>;
export type BeltTestCandidate = Readonly<Required<ApiEligibilityEntry>>;
export type BeltTestCreateFields = Readonly<{
  name: string;
  ladderId: string;
  schedule: AppointmentSchedule;
  location: string;
  status: "draft" | "scheduled";
}>;
export type BeltTestEdit =
  | Readonly<{
      kind: "details";
      name?: string;
      ladderId?: string;
      schedule?: AppointmentSchedule;
      location?: string;
    }>
  | Readonly<{ kind: "status"; status: "scheduled" | "completed" | "canceled" }>;
export type BeltTestReceipt =
  | ApiBeltTestOperationResponse
  | ApiBeltTestApprovalOperationResponse
  | ApiBeltTestRevokeOperationResponse;
export type BeltTestReceiptIdentity = Readonly<{ operationId: string; studioId: string }> &
  (
    | Readonly<{ command: "belt_test.create"; eventId?: string }>
    | Readonly<{ command: "belt_test.update" | "belt_test.approve"; eventId: string }>
    | Readonly<{ command: "belt_test.revoke"; eventId: string; recipientId: string }>
  );

const eventKeys =
  "id studio_id name ladder_id program_id starts_at ends_at timezone location status revision schedule_revision created_by created_at updated_at";
const recipientKeys =
  "id studio_id event_id student_id student_program_membership_id approved_schedule_revision approved_current_rank_id approved_target_rank_id state revision approved_by approved_at revoked_at created_at updated_at";
const candidateKeys =
  "student_id student_program_membership_id program_id student_name current_rank_id current_rank_name current_rank_color next_rank_id next_rank_name next_rank_color classes_since_promo classes_required days_at_rank days_required classes_met time_met needs_approval is_eligible";
const requestDetails = "name ladder_id starts_at ends_at timezone location";
const invalid = () => new Error("Use valid belt-test fields.");
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const nullableUuid = (value: unknown): value is string | null => value === null || uuid(value);
const sameId = (a: unknown, b: unknown): boolean =>
  (a === null && b === null) || (uuid(a) && uuid(b) && a.toLowerCase() === b.toLowerCase());
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const incrementable = (value: number) => value < Number.MAX_SAFE_INTEGER;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const has = (value: object, key: string) => Object.hasOwn(value, key);
function keys(value: unknown, required: string, optional = ""): value is Record<string, unknown> {
  const requiredKeys = required.split(" ").filter(Boolean),
    allowed = [...requiredKeys, ...optional.split(" ").filter(Boolean)];
  return (
    record(value) &&
    requiredKeys.every((key) => has(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key))
  );
}
const trimName = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
const name = (value: unknown): value is string =>
  typeof value === "string" &&
  [...value].length > 0 &&
  [...value].length <= 140 &&
  trimName(value) === value;
const location = (value: unknown): value is string =>
  typeof value === "string" && [...value].length <= 240;
const schedule = (value: unknown): value is AppointmentSchedule & Record<string, unknown> =>
  record(value) &&
  typeof value.starts_at === "string" &&
  typeof value.ends_at === "string" &&
  typeof value.timezone === "string" &&
  isAppointmentSchedule({
    starts_at: value.starts_at,
    ends_at: value.ends_at,
    timezone: value.timezone,
  });
function sameSchedule(a: AppointmentSchedule, b: AppointmentSchedule): boolean {
  const left = normalizeAppointmentSchedule(a),
    right = normalizeAppointmentSchedule(b);
  return (
    left.starts_at === right.starts_at &&
    left.ends_at === right.ends_at &&
    left.timezone === right.timezone
  );
}
const pairKey = (pair: BeltTestPair) =>
  `${pair.student_id.toLowerCase()}:${pair.student_program_membership_id?.toLowerCase() ?? "null"}`;
function dense(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index++) if (!has(value, String(index))) return false;
  return true;
}
const unique = <T>(rows: readonly T[], key: (row: T) => string) =>
  new Set(rows.map(key)).size === rows.length;
const uniqueIds = (rows: readonly { id: string }[]) => unique(rows, (row) => row.id.toLowerCase());
const isPair = (value: unknown): value is BeltTestPair =>
  keys(value, "student_id student_program_membership_id") &&
  uuid(value.student_id) &&
  nullableUuid(value.student_program_membership_id);
const ownEvent = (value: unknown): value is ApiBeltTestEventResponse =>
  record(value) && uuid(value.studio_id) && isBeltTestEvent(value, value.studio_id);
const editable = (value: unknown): value is ApiBeltTestEventResponse =>
  ownEvent(value) &&
  (value.status === "draft" || value.status === "scheduled") &&
  incrementable(value.revision);
const transition = (from: string, to: unknown) =>
  to === "canceled" ||
  (from === "draft" && to === "scheduled") ||
  (from === "scheduled" && to === "completed");

export function isBeltTestTarget(value: unknown): value is BeltTestTarget {
  return (
    keys(value, "kind id") && (value.kind === "draft" || value.kind === "event") && uuid(value.id)
  );
}
export function beltTestTargetKey(target: BeltTestTarget): string {
  if (!isBeltTestTarget(target)) throw invalid();
  return `${target.kind}:${target.id.toLowerCase()}`;
}
export function normalizeBeltTestName(value: string): string {
  if (typeof value !== "string") throw invalid();
  const result = trimName(value);
  if (!name(result)) throw invalid();
  return result;
}
export function normalizeBeltTestLocation(value: string): string {
  if (!location(value)) throw invalid();
  return value;
}
export function isBeltTestEvent(
  value: unknown,
  studioId: string,
  eventId?: string,
): value is ApiBeltTestEventResponse {
  return (
    uuid(studioId) &&
    (eventId === undefined || uuid(eventId)) &&
    keys(value, eventKeys) &&
    uuid(value.id) &&
    sameId(value.studio_id, studioId) &&
    (eventId === undefined || sameId(value.id, eventId)) &&
    name(value.name) &&
    uuid(value.ladder_id) &&
    nullableUuid(value.program_id) &&
    schedule(value) &&
    location(value.location) &&
    ["draft", "scheduled", "completed", "canceled"].some((status) => status === value.status) &&
    positive(value.revision) &&
    positive(value.schedule_revision) &&
    value.schedule_revision <= value.revision &&
    nullableUuid(value.created_by) &&
    isAppointmentInstant(value.created_at) &&
    isAppointmentInstant(value.updated_at)
  );
}
function page(
  value: unknown,
  limit: number,
): value is { items: unknown[]; next_cursor: string | null; has_more: boolean } {
  return (
    positive(limit) &&
    limit <= 100 &&
    keys(value, "items next_cursor has_more") &&
    Array.isArray(value.items) &&
    value.items.length <= limit &&
    dense(value.items) &&
    (value.next_cursor === null ||
      (typeof value.next_cursor === "string" &&
        value.next_cursor.length > 0 &&
        [...value.next_cursor].length <= 512)) &&
    typeof value.has_more === "boolean" &&
    value.has_more === (value.next_cursor !== null)
  );
}
export function isBeltTestEventPage(
  value: unknown,
  studioId: string,
  limit = 100,
): value is ApiBeltTestEventListResponse {
  return (
    uuid(studioId) &&
    page(value, limit) &&
    value.items.every((row) => isBeltTestEvent(row, studioId)) &&
    uniqueIds(value.items)
  );
}
export function isBeltTestRecipient(
  value: unknown,
  studioId: string,
  eventId: string,
  recipientId?: string,
): value is ApiBeltTestRecipientResponse {
  return (
    uuid(studioId) &&
    uuid(eventId) &&
    (recipientId === undefined || uuid(recipientId)) &&
    keys(value, recipientKeys) &&
    uuid(value.id) &&
    sameId(value.studio_id, studioId) &&
    sameId(value.event_id, eventId) &&
    (recipientId === undefined || sameId(value.id, recipientId)) &&
    uuid(value.student_id) &&
    nullableUuid(value.student_program_membership_id) &&
    positive(value.revision) &&
    positive(value.approved_schedule_revision) &&
    nullableUuid(value.approved_current_rank_id) &&
    uuid(value.approved_target_rank_id) &&
    nullableUuid(value.approved_by) &&
    isAppointmentInstant(value.approved_at) &&
    isAppointmentInstant(value.created_at) &&
    isAppointmentInstant(value.updated_at) &&
    ((value.state === "approved" && value.revoked_at === null) ||
      (value.state === "revoked" && isAppointmentInstant(value.revoked_at)))
  );
}
export function isBeltTestRecipientPage(
  value: unknown,
  studioId: string,
  eventId: string,
  limit = 100,
): value is ApiBeltTestRecipientListResponse {
  return (
    uuid(studioId) &&
    uuid(eventId) &&
    page(value, limit) &&
    value.items.every((row) => isBeltTestRecipient(row, studioId, eventId)) &&
    uniqueIds(value.items) &&
    unique(value.items, pairKey)
  );
}
export function isBeltTestCandidates(value: unknown): value is BeltTestCandidate[] {
  if (!Array.isArray(value) || !dense(value)) return false;
  const valid = value.every(
    (row) =>
      keys(row, candidateKeys) &&
      uuid(row.student_id) &&
      ["student_program_membership_id", "program_id", "current_rank_id", "next_rank_id"].every(
        (key) => nullableUuid(row[key]),
      ) &&
      typeof row.student_name === "string" &&
      ["current_rank_name", "current_rank_color", "next_rank_name", "next_rank_color"].every(
        (key) => row[key] === null || typeof row[key] === "string",
      ) &&
      ["classes_since_promo", "classes_required", "days_at_rank", "days_required"].every(
        (key) => typeof row[key] === "number" && Number.isSafeInteger(row[key]) && row[key] >= 0,
      ) &&
      ["classes_met", "time_met", "needs_approval", "is_eligible"].every(
        (key) => typeof row[key] === "boolean",
      ),
  );
  return valid && unique(value, pairKey);
}
export function isBeltTestApproval(
  value: unknown,
  studioId: string,
  eventId: string,
): value is ApiBeltTestRecipientApprovalResponse {
  return (
    uuid(studioId) &&
    uuid(eventId) &&
    keys(value, "items event_revision schedule_revision") &&
    positive(value.event_revision) &&
    positive(value.schedule_revision) &&
    value.schedule_revision <= value.event_revision &&
    Array.isArray(value.items) &&
    value.items.length > 0 &&
    value.items.length <= 100 &&
    dense(value.items) &&
    value.items.every(
      (row) =>
        isBeltTestRecipient(row, studioId, eventId) &&
        row.state === "approved" &&
        row.approved_schedule_revision === value.schedule_revision,
    ) &&
    uniqueIds(value.items) &&
    unique(value.items, pairKey)
  );
}
export function isBeltTestReceipt(
  value: unknown,
  identity: BeltTestReceiptIdentity,
): value is BeltTestReceipt {
  if (
    !keys(identity, "operationId studioId command", "eventId recipientId") ||
    !uuid(identity.operationId) ||
    !uuid(identity.studioId) ||
    !keys(value, "operation_id state command entity_type entity_id result committed_at") ||
    !sameId(value.operation_id, identity.operationId) ||
    value.state !== "committed" ||
    value.command !== identity.command ||
    !uuid(value.entity_id) ||
    !isAppointmentInstant(value.committed_at)
  )
    return false;
  if (identity.command === "belt_test.revoke")
    return (
      keys(identity, "operationId studioId command eventId recipientId") &&
      value.entity_type === "belt_test_recipient" &&
      sameId(value.entity_id, identity.recipientId) &&
      isBeltTestRecipient(
        value.result,
        identity.studioId,
        identity.eventId,
        identity.recipientId,
      ) &&
      value.result.state === "revoked"
    );
  if (value.entity_type !== "belt_test") return false;
  if (identity.command === "belt_test.create")
    return (
      keys(identity, "operationId studioId command", "eventId") &&
      (identity.eventId === undefined || sameId(value.entity_id, identity.eventId)) &&
      isBeltTestEvent(value.result, identity.studioId, value.entity_id) &&
      value.result.revision === 1 &&
      value.result.schedule_revision === 1 &&
      (value.result.status === "draft" || value.result.status === "scheduled")
    );
  if (
    !keys(identity, "operationId studioId command eventId") ||
    !sameId(value.entity_id, identity.eventId)
  )
    return false;
  if (identity.command === "belt_test.update")
    return isBeltTestEvent(value.result, identity.studioId, identity.eventId);
  return (
    identity.command === "belt_test.approve" &&
    isBeltTestApproval(value.result, identity.studioId, identity.eventId)
  );
}

export function buildBeltTestCreate(
  operationId: string,
  fields: BeltTestCreateFields,
): ApiBeltTestEventCreate {
  if (
    !uuid(operationId) ||
    !keys(fields, "name ladderId schedule location status") ||
    !uuid(fields.ladderId) ||
    !keys(fields.schedule, "starts_at ends_at timezone") ||
    !schedule(fields.schedule) ||
    (fields.status !== "draft" && fields.status !== "scheduled")
  )
    throw invalid();
  return {
    operation_id: operationId.toLowerCase(),
    name: normalizeBeltTestName(fields.name),
    ladder_id: fields.ladderId.toLowerCase(),
    ...normalizeAppointmentSchedule(fields.schedule),
    location: normalizeBeltTestLocation(fields.location),
    status: fields.status,
  };
}
export function buildBeltTestUpdate(
  operationId: string,
  baseline: Readonly<ApiBeltTestEventResponse>,
  edit: BeltTestEdit,
): ApiBeltTestEventUpdate {
  if (!uuid(operationId) || !editable(baseline) || !record(edit)) throw invalid();
  const body: ApiBeltTestEventUpdate = {
    operation_id: operationId.toLowerCase(),
    expected_revision: baseline.revision,
  };
  if (edit.kind === "status") {
    if (!keys(edit, "kind status") || !transition(baseline.status, edit.status)) throw invalid();
    body.status = edit.status;
  } else if (edit.kind === "details") {
    if (!keys(edit, "kind", "name ladderId schedule location")) throw invalid();
    if (has(edit, "name")) {
      const next = normalizeBeltTestName(edit.name!);
      if (next !== baseline.name) body.name = next;
    }
    if (has(edit, "ladderId")) {
      if (!uuid(edit.ladderId)) throw invalid();
      if (!sameId(edit.ladderId, baseline.ladder_id)) body.ladder_id = edit.ladderId.toLowerCase();
    }
    if (has(edit, "location")) {
      const next = normalizeBeltTestLocation(edit.location!);
      if (next !== baseline.location) body.location = next;
    }
    if (has(edit, "schedule")) {
      if (!keys(edit.schedule, "starts_at ends_at timezone") || !schedule(edit.schedule))
        throw invalid();
      if (!sameSchedule(edit.schedule, baseline))
        Object.assign(body, normalizeAppointmentSchedule(edit.schedule));
    }
  } else throw invalid();
  if (Object.keys(body).length === 2) throw new Error("Make a belt-test change before saving.");
  if (
    (has(body, "starts_at") || has(body, "ladder_id") || has(body, "location")) &&
    !incrementable(baseline.schedule_revision)
  )
    throw invalid();
  return body;
}
export function buildBeltTestApprove(
  operationId: string,
  event: Readonly<ApiBeltTestEventResponse>,
  pairs: readonly BeltTestPair[],
): ApiBeltTestRecipientApprove {
  if (
    !uuid(operationId) ||
    !ownEvent(event) ||
    event.status !== "scheduled" ||
    !Array.isArray(pairs) ||
    pairs.length < 1 ||
    pairs.length > 100 ||
    !dense(pairs) ||
    !pairs.every(isPair) ||
    !unique(pairs, pairKey)
  )
    throw invalid();
  const recipients: ApiBeltTestRecipientSelection[] = pairs.map((pair) => ({
    student_id: pair.student_id.toLowerCase(),
    student_program_membership_id: pair.student_program_membership_id?.toLowerCase() ?? null,
  }));
  return {
    operation_id: operationId.toLowerCase(),
    expected_event_revision: event.revision,
    recipients,
  };
}
export function buildBeltTestRevoke(
  operationId: string,
  event: Readonly<ApiBeltTestEventResponse>,
  recipient: Readonly<ApiBeltTestRecipientResponse>,
): ApiBeltTestRecipientRevoke {
  if (
    !uuid(operationId) ||
    !ownEvent(event) ||
    !isBeltTestRecipient(recipient, event.studio_id, event.id) ||
    recipient.state !== "approved" ||
    !incrementable(recipient.revision)
  )
    throw invalid();
  return { operation_id: operationId.toLowerCase(), expected_revision: recipient.revision };
}

function createRequest(value: unknown): value is Required<ApiBeltTestEventCreate> {
  return (
    keys(value, `operation_id ${requestDetails} status`) &&
    uuid(value.operation_id) &&
    name(value.name) &&
    uuid(value.ladder_id) &&
    schedule(value) &&
    location(value.location) &&
    (value.status === "draft" || value.status === "scheduled")
  );
}
function updateRequest(
  value: unknown,
  baseline: ApiBeltTestEventResponse,
): value is ApiBeltTestEventUpdate {
  if (
    !keys(value, "operation_id expected_revision", `${requestDetails} status`) ||
    !uuid(value.operation_id) ||
    value.expected_revision !== baseline.revision ||
    !editable(baseline)
  )
    return false;
  if (has(value, "status"))
    return Object.keys(value).length === 3 && transition(baseline.status, value.status);
  const scheduleKeys = ["starts_at", "ends_at", "timezone"].filter((key) => has(value, key));
  if (
    scheduleKeys.length &&
    (scheduleKeys.length !== 3 || !schedule(value) || sameSchedule(value, baseline))
  )
    return false;
  return (
    Object.keys(value).length > 2 &&
    (!has(value, "name") || (name(value.name) && value.name !== baseline.name)) &&
    (!has(value, "ladder_id") ||
      (uuid(value.ladder_id) && !sameId(value.ladder_id, baseline.ladder_id))) &&
    (!has(value, "location") || (location(value.location) && value.location !== baseline.location))
  );
}
export function isBeltTestCreateResult(
  value: unknown,
  studioId: string,
  request: Readonly<ApiBeltTestEventCreate>,
): value is ApiBeltTestEventResponse {
  return (
    createRequest(request) &&
    isBeltTestEvent(value, studioId) &&
    value.revision === 1 &&
    value.schedule_revision === 1 &&
    value.name === request.name &&
    sameId(value.ladder_id, request.ladder_id) &&
    value.location === request.location &&
    value.status === request.status &&
    sameSchedule(value, request)
  );
}
export function isBeltTestUpdateResult(
  value: unknown,
  baseline: Readonly<ApiBeltTestEventResponse>,
  request: Readonly<ApiBeltTestEventUpdate>,
): value is ApiBeltTestEventResponse {
  if (
    !ownEvent(baseline) ||
    !updateRequest(request, baseline) ||
    !isBeltTestEvent(value, baseline.studio_id, baseline.id)
  )
    return false;
  const changedSchedule =
    has(request, "starts_at") || has(request, "location") || has(request, "ladder_id");
  const expected = { ...baseline, ...request };
  return (
    value.revision === baseline.revision + 1 &&
    value.schedule_revision === baseline.schedule_revision + Number(changedSchedule) &&
    value.name === expected.name &&
    sameId(value.ladder_id, expected.ladder_id) &&
    value.location === expected.location &&
    value.status === expected.status &&
    sameSchedule(value, expected) &&
    (has(request, "ladder_id") || sameId(value.program_id, baseline.program_id)) &&
    value.created_at === baseline.created_at &&
    sameId(value.created_by, baseline.created_by)
  );
}
export function isBeltTestApproveResult(
  value: unknown,
  event: Readonly<ApiBeltTestEventResponse>,
  request: Readonly<ApiBeltTestRecipientApprove>,
): value is ApiBeltTestRecipientApprovalResponse {
  if (
    !ownEvent(event) ||
    event.status !== "scheduled" ||
    !keys(request, "operation_id expected_event_revision recipients") ||
    !uuid(request.operation_id) ||
    request.expected_event_revision !== event.revision ||
    !Array.isArray(request.recipients) ||
    request.recipients.length < 1 ||
    request.recipients.length > 100 ||
    !dense(request.recipients) ||
    !request.recipients.every(isPair) ||
    !unique(request.recipients, pairKey) ||
    !isBeltTestApproval(value, event.studio_id, event.id)
  )
    return false;
  const pairs = new Set(request.recipients.map(pairKey));
  return (
    value.event_revision === event.revision &&
    value.schedule_revision === event.schedule_revision &&
    value.items.length === pairs.size &&
    value.items.every((row) => pairs.has(pairKey(row)))
  );
}
export function isBeltTestRevokeResult(
  value: unknown,
  event: Readonly<ApiBeltTestEventResponse>,
  recipient: Readonly<ApiBeltTestRecipientResponse>,
  request: Readonly<ApiBeltTestRecipientRevoke>,
): value is ApiBeltTestRecipientResponse {
  if (
    !ownEvent(event) ||
    !isBeltTestRecipient(recipient, event.studio_id, event.id) ||
    recipient.state !== "approved" ||
    !incrementable(recipient.revision) ||
    !keys(request, "operation_id expected_revision") ||
    !uuid(request.operation_id) ||
    request.expected_revision !== recipient.revision ||
    !isBeltTestRecipient(value, event.studio_id, event.id, recipient.id)
  )
    return false;
  return (
    value.state === "revoked" &&
    value.revision === recipient.revision + 1 &&
    sameId(value.student_id, recipient.student_id) &&
    sameId(value.student_program_membership_id, recipient.student_program_membership_id) &&
    sameId(value.approved_current_rank_id, recipient.approved_current_rank_id) &&
    sameId(value.approved_target_rank_id, recipient.approved_target_rank_id) &&
    sameId(value.approved_by, recipient.approved_by) &&
    value.approved_schedule_revision === recipient.approved_schedule_revision &&
    value.approved_at === recipient.approved_at &&
    value.created_at === recipient.created_at
  );
}

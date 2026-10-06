import type { BeltLadder, Program, Student, EligibilityEntry } from "@/types";
import type {
  ApiBeltTestEventResponse,
  ApiBeltTestRecipientResponse,
} from "../types/generated/api-contracts";
import { normalizeAppointmentSchedule } from "./appointment-time";
import {
  beltTestTargetKey,
  normalizeBeltTestName,
  normalizeBeltTestLocation,
  type BeltTestCandidate,
  type BeltTestPair,
  type BeltTestTarget,
  type BeltTestCommand,
} from "./belt-test-contract";
import {
  INACTIVE_BELT_TEST_FACADE,
  type BeltTestFacade,
  type BeltTestOwner,
  type BeltTestRead,
  type BeltTestPageOptions,
  type BeltTestView,
} from "./belt-test-operation";

export type BeltTestPreviewReferences = Readonly<{
  getLadders(): readonly BeltLadder[];
  getPrograms(): readonly Program[];
  getStudents(): readonly Student[];
  eligibilityForLadder(ladderId: string): readonly EligibilityEntry[];
}>;
const sampleStudio = "00000000-0000-4000-8000-000000000001";
const copy = <T extends object>(row: T): Readonly<T> => Object.freeze({ ...row });
const pairKey = (row: BeltTestPair) =>
  JSON.stringify([row.student_id, row.student_program_membership_id]);
const bad = () => new Error("Review the sample belt-test fields and current selection.");

export function createPreviewBeltTestOwner(
  references: BeltTestPreviewReferences,
  isCurrent: () => boolean,
): Pick<BeltTestOwner, "getSnapshot" | "subscribe"> {
  const events = new Map<string, ApiBeltTestEventResponse>();
  const recipients = new Map<string, ApiBeltTestRecipientResponse>();
  const views = new Map<string, BeltTestView>(),
    listeners = new Set<() => void>();
  const generations = new Map<string, number>();
  let seeded = false,
    sequence = 0,
    snapshot = INACTIVE_BELT_TEST_FACADE;
  const guard = () => {
    if (!isCurrent()) throw new Error("This sample belt-test session has ended.");
  };
  const programExists = (id: string | null | undefined) =>
    !id || references.getPrograms().some((program) => program.id === id && !program.archived_at);
  const ladderFor = (id: string) =>
    references.getLadders().find((ladder) => ladder.id === id && programExists(ladder.program_id));
  const eventFor = (id: string) => {
    guard();
    const event = events.get(id);
    if (!event) throw bad();
    return event;
  };
  const baseline = (row: Readonly<ApiBeltTestEventResponse>) => {
    const current = eventFor(row.id);
    if (current.revision !== row.revision) throw bad();
    return current;
  };
  const newEvent = (
    name: string,
    ladder: BeltLadder,
    schedule: ReturnType<typeof normalizeAppointmentSchedule>,
    location: string,
    status: "draft" | "scheduled",
  ): ApiBeltTestEventResponse => {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      studio_id: sampleStudio,
      name,
      ladder_id: ladder.id,
      program_id: ladder.program_id ?? null,
      ...schedule,
      location,
      status,
      revision: 1,
      schedule_revision: 1,
      created_by: null,
      created_at: now,
      updated_at: now,
    };
  };
  const ensureSeed = () => {
    guard();
    if (seeded) return;
    const ladder = references.getLadders().find((row) => programExists(row.program_id));
    if (!ladder) return;
    const start = Date.now() + 86400000;
    const event = newEvent(
      "Sample belt test",
      ladder,
      normalizeAppointmentSchedule({
        starts_at: new Date(start).toISOString(),
        ends_at: new Date(start + 3600000).toISOString(),
        timezone: "UTC",
      }),
      "Sample training room",
      "scheduled",
    );
    events.set(event.id, event);
    seeded = true;
  };
  const ready = <T>(value: T, id: string | null): BeltTestRead<T> => {
    const version = id === null ? sequence : generations.get(id);
    return Object.freeze({
      status: "ready",
      value,
      isCurrent: () => isCurrent() && version === (id === null ? sequence : generations.get(id)),
    });
  };
  const page = <T extends { id: string }>(rows: T[], options?: BeltTestPageOptions) => {
    const limit = options?.limit ?? 50,
      cursor = options?.cursor;
    const index =
      cursor === undefined ? 0 : rows.findIndex((row) => `sample:${row.id}` === cursor) + 1;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (cursor !== undefined && index === 0)
    )
      throw bad();
    const items = rows.slice(index, index + limit),
      more = index + limit < rows.length;
    return Object.freeze({
      items: Object.freeze(items.map(copy)),
      has_more: more,
      next_cursor: more ? `sample:${items.at(-1)!.id}` : null,
    });
  };
  const liveMembership = (row: Student["program_memberships"][number]) =>
    (row.status === "active" || row.status === "paused") && !row.ended_at;
  const candidates = (event: ApiBeltTestEventResponse): readonly BeltTestCandidate[] => {
    const ladder = ladderFor(event.ladder_id);
    if (event.status !== "scheduled" || !ladder || (ladder.program_id ?? null) !== event.program_id)
      return Object.freeze([]);
    const rows = references.eligibilityForLadder(ladder.id).filter((row) => {
      const student = references.getStudents().find((value) => value.id === row.student_id);
      const memberships = student?.program_memberships ?? [];
      const membership =
        row.student_program_membership_id == null
          ? null
          : memberships.find((value) => value.id === row.student_program_membership_id);
      const program = membership?.program_id ?? student?.program_id ?? null;
      return (
        student?.status === "active" &&
        programExists(program) &&
        (row.program_id ?? null) === program &&
        (!event.program_id || event.program_id === program) &&
        (row.student_program_membership_id == null
          ? !memberships.some(liveMembership)
          : Boolean(membership && liveMembership(membership)))
      );
    });
    return Object.freeze(
      rows.map((row) =>
        copy({
          ...row,
          student_program_membership_id: row.student_program_membership_id ?? null,
          program_id: row.program_id ?? null,
          current_rank_id: row.current_rank_id ?? null,
          current_rank_name: row.current_rank_name ?? null,
          current_rank_color: row.current_rank_color ?? null,
          next_rank_id: row.next_rank_id ?? null,
          next_rank_name: row.next_rank_name ?? null,
          next_rank_color: row.next_rank_color ?? null,
        }),
      ),
    );
  };
  const complete = (
    target: BeltTestTarget,
    command: BeltTestCommand,
    event: ApiBeltTestEventResponse,
    recipient: ApiBeltTestRecipientResponse | null = null,
  ) => {
    sequence++;
    generations.set(event.id, (generations.get(event.id) ?? 0) + 1);
    const key = beltTestTargetKey(target);
    const view: BeltTestView = Object.freeze({
      command,
      target: copy(target),
      eventId: event.id,
      recipientId: recipient?.id ?? null,
      status: "confirmed",
      locked: false,
      message: "Sample change recorded locally.",
      currentEvent: copy(event),
      currentRecipient: recipient && copy(recipient),
      isCurrent: () =>
        isCurrent() && views.get(key) === view && generations.get(event.id) === generation,
    });
    const generation = generations.get(event.id);
    views.set(key, view);
    snapshot = Object.freeze({
      ...methods,
      operations: Object.freeze(new Map(views)),
      storage: Object.freeze({ status: "inactive", message: null, isCurrent }),
    });
    for (const listener of listeners) listener();
  };
  const methods: Omit<BeltTestFacade, "operations" | "storage"> = {
    pendingOperation: () => undefined,
    async checkStorage() {
      guard();
    },
    async checkResult() {
      guard();
    },
    async listEvents(options) {
      ensureSeed();
      return ready(page([...events.values()], options), null);
    },
    async getEvent(id) {
      ensureSeed();
      return ready(copy(eventFor(id)), id);
    },
    async listRecipients(id, options) {
      eventFor(id);
      return ready(
        page(
          [...recipients.values()].filter((row) => row.event_id === id),
          options,
        ),
        id,
      );
    },
    async getRecipient(id, child) {
      eventFor(id);
      const row = recipients.get(child);
      if (!row || row.event_id !== id) throw bad();
      return ready(copy(row), id);
    },
    async getCandidates(id) {
      return ready(candidates(eventFor(id)), id);
    },
    async createEvent(draft, fields) {
      guard();
      const target: BeltTestTarget = { kind: "draft", id: draft };
      beltTestTargetKey(target);
      const ladder = ladderFor(fields.ladderId);
      if (!ladder || (fields.status !== "draft" && fields.status !== "scheduled")) throw bad();
      const row = newEvent(
        normalizeBeltTestName(fields.name),
        ladder,
        normalizeAppointmentSchedule(fields.schedule),
        normalizeBeltTestLocation(fields.location),
        fields.status,
      );
      seeded = true;
      events.set(row.id, row);
      complete(target, "belt_test.create", row);
    },
    async updateEvent(previous, edit) {
      const row = baseline(previous);
      if (row.status !== "draft" && row.status !== "scheduled") throw bad();
      let next = { ...row },
        scheduleChanged = false;
      if (edit.kind === "status") {
        if (!(
          edit.status === "canceled" ||
          (row.status === "draft" && edit.status === "scheduled") ||
          (row.status === "scheduled" && edit.status === "completed")
        ))
          throw bad();
        next.status = edit.status;
      } else if (edit.kind === "details") {
        if (edit.name !== undefined) next.name = normalizeBeltTestName(edit.name);
        if (edit.location !== undefined) next.location = normalizeBeltTestLocation(edit.location);
        if (edit.ladderId !== undefined && edit.ladderId !== row.ladder_id) {
          const ladder = ladderFor(edit.ladderId);
          if (!ladder) throw bad();
          next.ladder_id = ladder.id;
          next.program_id = ladder.program_id ?? null;
        }
        if (edit.schedule !== undefined)
          next = { ...next, ...normalizeAppointmentSchedule(edit.schedule) };
        const oldSchedule = normalizeAppointmentSchedule(row),
          nextSchedule = normalizeAppointmentSchedule(next);
        scheduleChanged =
          next.ladder_id !== row.ladder_id ||
          next.program_id !== row.program_id ||
          next.location !== row.location ||
          JSON.stringify(oldSchedule) !== JSON.stringify(nextSchedule);
        if (!scheduleChanged && next.name === row.name)
          throw new Error("Make a sample change before saving.");
      } else throw bad();
      const context = ladderFor(next.ladder_id);
      if (
        next.status !== "canceled" &&
        (!context || (context.program_id ?? null) !== next.program_id)
      )
        throw bad();
      next.revision++;
      next.schedule_revision += Number(scheduleChanged);
      next.updated_at = new Date().toISOString();
      if (scheduleChanged || next.status === "canceled" || next.status === "completed")
        for (const [id, child] of recipients) {
          if (child.event_id === row.id && child.state === "approved")
            recipients.set(id, {
              ...child,
              state: "revoked",
              revision: child.revision + 1,
              revoked_at: next.updated_at,
              updated_at: next.updated_at,
            });
        }
      events.set(row.id, next);
      complete({ kind: "event", id: row.id }, "belt_test.update", next);
    },
    async approveRecipients(previous, pairs) {
      const event = baseline(previous),
        available = candidates(event);
      if (
        event.status !== "scheduled" ||
        pairs.length < 1 ||
        pairs.length > 100 ||
        new Set(pairs.map(pairKey)).size !== pairs.length
      )
        throw bad();
      const selected = pairs.map((pair) => {
        const row = available.find((row) => pairKey(row) === pairKey(pair));
        if (!row || !row.classes_met || !row.time_met || !row.next_rank_id) throw bad();
        return row;
      });
      const now = new Date().toISOString();
      for (const candidate of selected) {
        const prior = [...recipients.values()].find(
          (row) => row.event_id === event.id && pairKey(row) === pairKey(candidate),
        );
        if (
          prior?.state === "approved" &&
          prior.approved_schedule_revision === event.schedule_revision &&
          prior.approved_current_rank_id === candidate.current_rank_id &&
          prior.approved_target_rank_id === candidate.next_rank_id
        )
          continue;
        const row: ApiBeltTestRecipientResponse = {
          id: prior?.id ?? crypto.randomUUID(),
          studio_id: sampleStudio,
          event_id: event.id,
          student_id: candidate.student_id,
          student_program_membership_id: candidate.student_program_membership_id,
          approved_schedule_revision: event.schedule_revision,
          approved_current_rank_id: candidate.current_rank_id,
          approved_target_rank_id: candidate.next_rank_id!,
          state: "approved",
          revision: (prior?.revision ?? 0) + 1,
          approved_by: null,
          approved_at: now,
          revoked_at: null,
          created_at: prior?.created_at ?? now,
          updated_at: now,
        };
        recipients.set(row.id, row);
      }
      complete({ kind: "event", id: event.id }, "belt_test.approve", event);
    },
    async revokeRecipient(previous, recipient) {
      const event = baseline(previous),
        current = recipients.get(recipient.id);
      if (
        !current ||
        current.event_id !== event.id ||
        current.revision !== recipient.revision ||
        current.state !== "approved"
      )
        throw bad();
      const now = new Date().toISOString();
      const next: ApiBeltTestRecipientResponse = {
        ...current,
        state: "revoked",
        revision: current.revision + 1,
        revoked_at: now,
        updated_at: now,
      };
      recipients.set(next.id, next);
      complete({ kind: "event", id: event.id }, "belt_test.revoke", event, next);
    },
  };
  snapshot = Object.freeze({
    ...methods,
    operations: Object.freeze(new Map(views)),
    storage: Object.freeze({ status: "inactive", message: null, isCurrent }),
  });
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppointmentTimeFields,
  appointmentSummary,
} from "@/components/appointments/appointment-time-fields";
import { ModalFrame } from "@/components/ui/modal-frame";
import {
  createAppointmentTimeDraft,
  normalizeAppointmentSchedule,
  type AppointmentTimeDraft,
  type AppointmentTimeResolution,
} from "@/lib/appointment-time";
import {
  beltTestTargetKey,
  normalizeBeltTestName,
  normalizeBeltTestLocation,
  type BeltTestTarget,
  type BeltTestEdit,
} from "@/lib/belt-test-contract";
import type { BeltTestFacade } from "@/lib/belt-test-operation";
import type { ApiBeltTestEventResponse as Event } from "@/types/generated/api-contracts";
import type { BeltTestReferences } from "./belt-test-workspace";
import styles from "./belt-tests.module.css";

export const referenceId = (id: string | null | undefined) =>
  id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id.toLowerCase()
    : (id ?? null);
export function supportedBeltPlan(
  references: BeltTestReferences,
  id: string,
  event?: Readonly<Event> | null,
) {
  const ladder = references.ladders.find((row) => referenceId(row.id) === referenceId(id));
  const program = ladder?.program_id ?? null;
  return references.status === "ready" &&
    ladder &&
    (!program ||
      references.programs.some(
        (row) => referenceId(row.id) === referenceId(program) && !row.archived_at,
      )) &&
    (!event ||
      referenceId(id) !== referenceId(event.ladder_id) ||
      referenceId(program) === referenceId(event.program_id))
    ? ladder
    : null;
}
type Form = {
  baseline: Readonly<Event> | null;
  name: string;
  ladder: string;
  location: string;
  time: AppointmentTimeDraft;
};
type Intent = "draft" | "create_scheduled" | "details" | "scheduled" | "completed" | "canceled";
const dirtyForm = (form: Form) =>
  form.name !== (form.baseline?.name ?? "") ||
  form.ladder !== (form.baseline?.ladder_id ?? "") ||
  form.location !== (form.baseline?.location ?? "") ||
  form.time.scheduleEdited;
const formFor = (event: Readonly<Event> | null, timezone: string): Form => ({
  baseline: event,
  name: event?.name ?? "",
  ladder: event?.ladder_id ?? "",
  location: event?.location ?? "",
  time: createAppointmentTimeDraft(timezone, event),
});
type Props = {
  target: BeltTestTarget;
  event: Readonly<Event> | null;
  facade: BeltTestFacade;
  references: BeltTestReferences;
  timezone: string;
  preview: boolean;
  selectionDirty: boolean;
  isCurrent(): boolean;
  onDirtyChange(dirty: boolean): void;
  onCreated(event: Readonly<Event>, editedAfterSubmit: boolean): void;
  reload(): Promise<void>;
};

export function BeltTestEventEditor({
  target,
  event,
  facade,
  references,
  timezone,
  preview,
  selectionDirty,
  isCurrent,
  onDirtyChange,
  onCreated,
  reload,
}: Props) {
  const [form, setForm] = useState(() => formFor(event, timezone));
  const [message, setMessage] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [resolution, setResolution] = useState<{
    draft: AppointmentTimeDraft;
    result: AppointmentTimeResolution | null;
  } | null>(null);
  const formRef = useRef(form),
    alive = useRef(true),
    submitted = useRef<{ form: Form; target: BeltTestTarget } | null>(null);
  const [created, setCreated] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const change = (next: Form) => {
    onDirtyChange(dirtyForm(next) || review);
    formRef.current = next;
    setForm(next);
    setMessage(null);
    setIntent(null);
  };
  const dirty = dirtyForm(form) || review;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  const view = facade.operations.get(beltTestTargetKey(target));
  const operation = view?.isCurrent() ? view : undefined;
  const draftCompleted =
    created ||
    (target.kind === "draft" &&
      operation?.command === "belt_test.create" &&
      ["confirmed", "unavailable"].includes(operation.status));
  useEffect(() => {
    const sent = submitted.current;
    if (
      !sent ||
      !operation?.isCurrent() ||
      !isCurrent() ||
      !alive.current ||
      !["confirmed", "unavailable"].includes(operation.status)
    )
      return;
    submitted.current = null;
    const current = operation.currentEvent;
    if (!current) return;
    const edited = formRef.current !== sent.form;
    if (sent.target.kind === "draft") {
      setCreated(true);
      onCreated(current, edited);
    }
    if (edited) {
      setReview(true);
      setMessage("The change was recorded. Review or reload current details before saving again.");
    } else {
      const next = formFor(current, timezone);
      formRef.current = next;
      setForm(next);
      setReview(false);
    }
  }, [operation, isCurrent, onCreated, timezone]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (
        !active ||
        !event ||
        event === formRef.current.baseline ||
        submitted.current ||
        !isCurrent()
      )
        return;
      if (dirty) {
        setReview(true);
        return;
      }
      const next = formFor(event, timezone);
      formRef.current = next;
      setForm(next);
    });
    return () => {
      active = false;
    };
  }, [event, dirty, isCurrent, timezone]);
  const acceptResolution = useCallback(
    (draft: AppointmentTimeDraft, result: AppointmentTimeResolution | null) => {
      if (formRef.current.time === draft) setResolution({ draft, result });
    },
    [],
  );
  const schedule =
    resolution?.draft === form.time && resolution.result?.status === "resolved"
      ? resolution.result.schedule
      : null;
  const pending = facade.pendingOperation(target);
  const locked =
    Boolean(pending?.isCurrent() && pending.locked) || facade.storage.status === "blocked";
  const plan = supportedBeltPlan(references, form.ladder, form.baseline);
  const savedContext = event && supportedBeltPlan(references, event.ladder_id, event);
  const missing = target.kind === "event" && !event;
  const eventEditable =
    !missing && (!event || event.status === "draft" || event.status === "scheduled");
  const editable = eventEditable || dirty;
  const program = plan ? (plan.program_id ?? null) : (form.baseline?.program_id ?? null);
  const programName =
    program === null
      ? "All programs"
      : (references.programs.find((row) => referenceId(row.id) === referenceId(program))?.name ??
        "Unavailable saved program");
  const details = (): Extract<BeltTestEdit, { kind: "details" }> => {
    const name = normalizeBeltTestName(form.name),
      location = normalizeBeltTestLocation(form.location);
    if (!schedule || !plan)
      throw Error("Choose a current belt plan and resolve the event schedule.");
    const baseline = form.baseline;
    const sameSchedule =
      baseline &&
      JSON.stringify(normalizeAppointmentSchedule(baseline)) ===
        JSON.stringify(normalizeAppointmentSchedule(schedule));
    return {
      kind: "details",
      ...(name === baseline?.name ? {} : { name }),
      ...(referenceId(form.ladder) === referenceId(baseline?.ladder_id)
        ? {}
        : { ladderId: form.ladder }),
      ...(location === baseline?.location ? {} : { location }),
      ...(sameSchedule ? {} : { schedule }),
    };
  };
  function request(next: Intent) {
    if (!isCurrent() || locked || review) return;
    try {
      if (["draft", "create_scheduled", "details"].includes(next)) {
        const change = details();
        if (next === "details" && Object.keys(change).length === 1) {
          setMessage("No details changed.");
          return;
        }
      }
      setIntent(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Review the event fields.");
    }
  }
  async function save() {
    if (!intent || !isCurrent() || !alive.current || locked || review) return;
    const action = intent,
      snapshot = formRef.current;
    setIntent(null);
    try {
      if (action === "draft" || action === "create_scheduled") {
        if (target.kind !== "draft" || draftCompleted || !plan || !schedule) return;
        submitted.current = { form: snapshot, target };
        await facade.createEvent(target.id, {
          name: normalizeBeltTestName(snapshot.name),
          ladderId: snapshot.ladder,
          location: normalizeBeltTestLocation(snapshot.location),
          schedule,
          status: action === "draft" ? "draft" : "scheduled",
        });
      } else {
        const baseline = action === "details" ? snapshot.baseline : event;
        if (
          !baseline ||
          (action !== "details" && (dirty || selectionDirty)) ||
          (action !== "details" && action !== "canceled" && !savedContext)
        )
          return;
        const edit = action === "details" ? details() : { kind: "status" as const, status: action };
        submitted.current = { form: snapshot, target: { kind: "event", id: baseline.id } };
        await facade.updateEvent(baseline, edit);
      }
    } catch {
      if (alive.current && isCurrent())
        setMessage(
          "The change could not be confirmed. Review the result above before saving again.",
        );
    }
  }
  const changeImpactsApproval =
    form.time.scheduleEdited ||
    form.ladder !== form.baseline?.ladder_id ||
    form.location !== form.baseline?.location;
  return (
    <section className={styles.panel} aria-label="Belt-test details">
      <h2>{event?.name ?? form.baseline?.name ?? "New belt test"}</h2>
      {missing && <p>These unsaved fields remain local because the event is unavailable.</p>}
      {preview && <p>Sample only. Changes stay in this preview session.</p>}
      {event && (
        <p>
          {event.status} · {appointmentSummary(event)} · {event.location || "No location"}
        </p>
      )}
      {references.status !== "ready" && (
        <p role="status">
          {references.status === "loading"
            ? "Loading belt plans and programs."
            : "Belt plans or programs are unavailable."}
        </p>
      )}
      {references.status === "unavailable" && (
        <button type="button" onClick={references.retry}>
          Retry reference choices
        </button>
      )}
      {event && !savedContext && references.status === "ready" && (
        <p>
          Unavailable saved context. Choose a different current plan to repair it, or cancel this
          event.
        </p>
      )}
      {editable ? (
        <>
          <label>
            Name
            <input value={form.name} onChange={(e) => change({ ...form, name: e.target.value })} />
          </label>
          <label>
            Belt plan
            <select
              aria-label="Belt plan"
              value={form.ladder}
              onChange={(e) => change({ ...form, ladder: e.target.value })}
            >
              <option value="">Choose a belt plan</option>
              {form.ladder && !plan && (
                <option value={form.ladder}>Unavailable saved belt plan</option>
              )}
              {references.ladders
                .filter((row) => supportedBeltPlan(references, row.id, form.baseline))
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
            </select>
          </label>
          {references.status === "ready" && !references.ladders.length && (
            <p>No belt plans are available.</p>
          )}
          <p>Program: {programName}</p>
          <div className={styles.timeFields}>
            <AppointmentTimeFields
              draft={form.time}
              onChange={(time) => change({ ...form, time })}
              onResolution={acceptResolution}
            />
          </div>
          <label>
            Location
            <input
              value={form.location}
              onChange={(e) => change({ ...form, location: e.target.value })}
            />
          </label>
          <p>Scheduling requires a future start. Completion is available after the start.</p>
          {dirty && <p>Leaving this page or reloading discards unsaved changes.</p>}
          {review && (
            <p role="alert">
              Current details need review. Reload and discard local changes before saving again.
            </p>
          )}
          <div className={styles.actions}>
            {target.kind === "draft" ? (
              <>
                <button
                  type="button"
                  disabled={locked || review || !plan || !schedule || draftCompleted}
                  onClick={() => request("draft")}
                >
                  Save draft
                </button>
                <button
                  type="button"
                  disabled={locked || review || !plan || !schedule || draftCompleted}
                  onClick={() => request("create_scheduled")}
                >
                  Schedule event
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={locked || review || !plan || !schedule || !eventEditable}
                  onClick={() => request("details")}
                >
                  Save details
                </button>
                {event?.status === "draft" && (
                  <button
                    type="button"
                    disabled={locked || dirty || selectionDirty || !savedContext}
                    onClick={() => request("scheduled")}
                  >
                    Schedule event
                  </button>
                )}
                {event?.status === "scheduled" && (
                  <button
                    type="button"
                    disabled={locked || dirty || selectionDirty || !savedContext}
                    onClick={() => request("completed")}
                  >
                    Complete event
                  </button>
                )}
                <button
                  type="button"
                  disabled={locked || dirty || selectionDirty}
                  onClick={() => request("canceled")}
                >
                  Cancel event
                </button>
                <button type="button" onClick={() => void reload()}>
                  Reload current event
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <p>This event is history. Its details cannot be changed.</p>
      )}
      {message && <p role="status">{message}</p>}
      {intent && (
        <ModalFrame
          ariaLabel="Confirm belt-test change"
          panelClassName={styles.confirmation}
          onBackdropClick={() => setIntent(null)}
        >
          <h2>
            Confirm{" "}
            {intent === "details"
              ? "detail changes"
              : intent === "canceled"
                ? "cancellation"
                : intent === "completed"
                  ? "completion"
                  : intent === "draft"
                    ? "draft"
                    : "schedule"}
          </h2>
          <p>{event?.name ?? form.name}</p>
          <p>
            {appointmentSummary(
              event && !["details", "draft", "create_scheduled"].includes(intent)
                ? event
                : schedule!,
            )}
          </p>
          <p>{event && intent !== "details" ? event.location : form.location || "No location"}</p>
          {intent === "details" && (
            <p>
              {changeImpactsApproval
                ? "Previous approvals must be reviewed again when the schedule, timezone, location or plan changes."
                : "Name-only changes preserve recorded approvals."}
            </p>
          )}
          <button type="button" onClick={() => setIntent(null)}>
            Keep editing
          </button>
          <button type="button" disabled={locked} onClick={() => void save()}>
            Confirm change
          </button>
        </ModalFrame>
      )}
    </section>
  );
}

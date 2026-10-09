"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AppointmentTimeFields,
  appointmentSummary,
} from "@/components/appointments/appointment-time-fields";
import {
  createAppointmentTimeDraft,
  type AppointmentTimeDraft,
  type AppointmentTimeResolution,
} from "@/lib/appointment-time";
import type {
  TrialAppointmentFacade,
  TrialEdit,
  TrialOperationView,
} from "@/lib/trial-appointment-operation";
import type {
  ApiTrialAppointmentResponse as Appointment,
  ApiTrialAppointmentListResponse as AppointmentPage,
} from "@/types/generated/api-contracts";
import type { Lead, Program } from "@/types";
import styles from "./leads-ledger.module.css";

const active = (view?: TrialOperationView) =>
  view?.status === "submitting" || view?.status === "checking";
const statusLabel = {
  scheduled: "Scheduled",
  completed: "Completed",
  no_show: "Missed",
  canceled: "Canceled",
};
type Form = {
  baseline: Readonly<Appointment> | null;
  outcome?: "completed" | "no_show" | "canceled";
  time: AppointmentTimeDraft;
  location: string;
  program: string;
};
type References = {
  programs: Program[];
  status: "loading" | "ready" | "unavailable";
  retry: () => void;
};

export function TrialAppointmentRecovery({
  facade,
  leads,
  pendingLeadIds,
}: {
  facade: TrialAppointmentFacade;
  leads: Lead[];
  pendingLeadIds: ReadonlySet<string>;
}) {
  const storage = facade.trialStorage;
  const views = [...facade.trialOperations.values()].filter(
    (view) => view.isCurrent() && view.message,
  );
  if (!storage.isCurrent() || (!views.length && storage.status !== "blocked")) return null;
  return (
    <section className={styles.trialRecovery} aria-label="Trial change results">
      {storage.status === "blocked" && (
        <div role="alert">
          <p>{storage.message}</p>
          <button
            type="button"
            onClick={() => void facade.checkTrialAppointmentStorage().catch(() => undefined)}
          >
            Check browser recovery record
          </button>
        </div>
      )}
      {views.map((view) => {
        const lead = leads.find((item) => item.id === view.leadId);
        const canCheck =
          view.locked &&
          !active(view) &&
          (view.ownsLeadReservation || !pendingLeadIds.has(view.leadId));
        return (
          <div key={view.leadId} role="status">
            <p>
              {lead
                ? `${lead.first_name} ${lead.last_name}`
                : view.locked
                  ? "Trial change awaiting confirmation"
                  : "Trial change"}
            </p>
            <p>{view.message}</p>
            {canCheck && (
              <button
                type="button"
                onClick={() => {
                  if (view.isCurrent())
                    void facade.checkTrialAppointmentResult(view.leadId).catch(() => undefined);
                }}
              >
                Check result
              </button>
            )}
            {view.locked && !active(view) && !canCheck && (
              <p>Finish the other lead change before checking this result.</p>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function LeadTrialAppointments({
  lead,
  facade,
  timezone,
  preview,
  references,
  reserved,
  isCurrent,
}: {
  lead: Lead;
  facade: TrialAppointmentFacade;
  timezone: string;
  preview: boolean;
  references: References;
  reserved: boolean;
  isCurrent: () => boolean;
}) {
  const [page, setPage] = useState<Readonly<AppointmentPage> | null>(null);
  const [observed, setObserved] = useState<TrialOperationView | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [resolution, setResolution] = useState<{
    draft: AppointmentTimeDraft;
    result: AppointmentTimeResolution | null;
  } | null>(null);
  const mounted = useRef(false),
    readGeneration = useRef(0),
    formGeneration = useRef(0);
  const formRef = useRef<Form | null>(null),
    submitted = useRef<Form | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = useCallback(() => mounted.current && isCurrent(), [isCurrent]);
  const { listTrialAppointments, getTrialAppointment } = facade;
  const load = useCallback(
    async (next?: string) => {
      if (!current()) return;
      const request = ++readGeneration.current;
      setCursor(next);
      setLoading(true);
      setReadError(null);
      try {
        const result = await listTrialAppointments(lead.id, {
          limit: 50,
          ...(next === undefined ? {} : { cursor: next }),
        });
        if (
          !current() ||
          request !== readGeneration.current ||
          result.status !== "ready" ||
          !result.isCurrent()
        )
          return;
        setPage(result.value);
        setObserved(null);
      } catch {
        if (current() && request === readGeneration.current)
          setReadError(
            "Trial history could not be refreshed. Previously loaded appointments remain below.",
          );
      } finally {
        if (current() && request === readGeneration.current) setLoading(false);
      }
    },
    [current, lead.id, listTrialAppointments],
  );
  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);
  const view = facade.trialOperations.get(lead.id);
  const operation = view?.isCurrent() ? view : undefined;
  useEffect(() => {
    if (
      !operation ||
      !["confirmed", "unavailable"].includes(operation.status) ||
      !operation.isCurrent() ||
      !current()
    )
      return;
    queueMicrotask(() => {
      if (!current() || !operation.isCurrent()) return;
      setObserved(operation);
      void load();
      if (submitted.current && submitted.current === formRef.current) {
        formRef.current = null;
        setForm(null);
        formGeneration.current++;
      }
      submitted.current = null;
    });
  }, [operation, current, load]);
  const changeForm = (next: Form | null) => {
    formGeneration.current++;
    formRef.current = next;
    setForm(next);
    setFormError(null);
    setDetailLoading(false);
  };
  const open = (baseline: Readonly<Appointment> | null = null, outcome?: Form["outcome"]) =>
    changeForm({
      baseline,
      outcome,
      time: createAppointmentTimeDraft(timezone, baseline),
      location: baseline?.location ?? "",
      program: baseline ? (baseline.program_id ?? "none") : "inherit",
    });
  async function edit(row: Readonly<Appointment>, outcome?: Form["outcome"]) {
    const request = ++formGeneration.current;
    setDetailLoading(true);
    setFormError(null);
    try {
      const result = await getTrialAppointment(lead.id, row.id);
      if (
        !current() ||
        request !== formGeneration.current ||
        result.status !== "ready" ||
        !result.isCurrent()
      )
        return;
      open(result.value, outcome);
    } catch {
      if (current() && request === formGeneration.current)
        setFormError("The current appointment could not be loaded. Your draft has been kept.");
    } finally {
      if (current() && request === formGeneration.current) setDetailLoading(false);
    }
  }
  const acceptResolution = useCallback(
    (draft: AppointmentTimeDraft, result: AppointmentTimeResolution | null) => {
      if (formRef.current?.time === draft) setResolution({ draft, result });
    },
    [],
  );
  const resolved =
    resolution?.draft === form?.time && resolution?.result?.status === "resolved"
      ? resolution.result.schedule
      : null;
  const choices = references.programs.filter((program) => !program.archived_at);
  const eligible = !lead.converted_student_id && !["closed_lost", "enrolled"].includes(lead.stage);
  const availableProgram = (id: string | null) =>
    references.status === "ready" && (id === null || choices.some((program) => program.id === id));
  const programLabel = (id: string | null) =>
    id === null
      ? "No program"
      : references.status !== "ready"
        ? "Program details unavailable"
        : (choices.find((program) => program.id === id)?.name ?? "Unavailable saved program");
  const supportedProgram =
    form &&
    (form.program === "none" ||
      (form.program === "inherit"
        ? !lead.program_id || availableProgram(lead.program_id)
        : choices.some((program) => program.id === form.program)));
  const locked =
    reserved || Boolean(operation?.locked) || (!preview && facade.trialStorage.status !== "ready");
  const canSave =
    !locked &&
    !detailLoading &&
    (form?.outcome === "canceled" || eligible) &&
    Boolean(
      (form?.outcome &&
        (form.outcome === "canceled" || availableProgram(form.baseline!.program_id))) ||
      (resolved &&
        references.status === "ready" &&
        supportedProgram &&
        [...(form?.location ?? "")].length <= 240),
    );
  async function save() {
    const draft = formRef.current;
    if (!draft || !canSave || !current()) return;
    submitted.current = draft;
    setFormError(null);
    const program =
      draft.program === "none"
        ? { mode: "none" as const }
        : { mode: "program" as const, id: draft.program };
    try {
      if (!draft.baseline) {
        if (!resolved) return;
        await facade.createTrialAppointment(lead.id, {
          schedule: resolved,
          location: draft.location,
          program: draft.program === "inherit" ? { mode: "inherit" } : program,
        });
      } else {
        const update: TrialEdit = draft.outcome
          ? { kind: "outcome", status: draft.outcome }
          : {
              kind: "schedule",
              ...(draft.time.scheduleEdited && resolved ? { schedule: resolved } : {}),
              ...(draft.location !== draft.baseline.location ? { location: draft.location } : {}),
              ...(draft.program !== (draft.baseline.program_id ?? "none") ? { program } : {}),
            };
        await facade.updateTrialAppointment(draft.baseline, update);
      }
    } catch {
      if (current() && formRef.current === draft)
        setFormError(
          "The trial change could not be confirmed. Review the result message before trying again.",
        );
    }
  }
  const title = form?.outcome
    ? `Confirm ${statusLabel[form.outcome].toLowerCase()} trial`
    : form?.baseline
      ? "Edit trial"
      : "Schedule trial";
  const observation = observed?.isCurrent() ? observed : null;
  const rows = observation
    ? [
        ...(observation.currentAppointment ? [observation.currentAppointment] : []),
        ...(page?.items ?? []).filter((row) => row.id !== observation.appointmentId),
      ]
    : (page?.items ?? []);
  return (
    <section className={styles.trialPanel} aria-label="Trial appointments">
      <h3>Trials</h3>
      {preview && <p>Sample trial appointments. Changes stay in this preview.</p>}
      <p>
        Scheduling requires a future start. Complete a trial after it starts, or mark it missed
        after it ends.
      </p>
      <button type="button" disabled={locked || !eligible} onClick={() => open()}>
        Schedule trial
      </button>
      {detailLoading && <p role="status">Loading current appointment...</p>}
      {formError && (
        <div role="alert">
          <p>{formError}</p>
          {form?.baseline && (
            <button
              type="button"
              disabled={active(operation)}
              onClick={() => void edit(form.baseline!, form.outcome)}
            >
              Discard edits and reload current appointment
            </button>
          )}
        </div>
      )}
      {form && (
        <form
          className={styles.trialForm}
          aria-label={title}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h4>{title}</h4>
          {form.outcome ? (
            <p>
              {statusLabel[form.outcome]}: {appointmentSummary(form.baseline!)} ·{" "}
              {form.baseline!.location || "No location"} · {programLabel(form.baseline!.program_id)}
            </p>
          ) : (
            <>
              <AppointmentTimeFields
                draft={form.time}
                onResolution={acceptResolution}
                onChange={(time) => changeForm({ ...form, time })}
              />
              <label>
                Location
                <input
                  value={form.location}
                  onChange={(event) => changeForm({ ...form, location: event.target.value })}
                />
              </label>
              {[...form.location].length > 240 && (
                <p role="alert">Use at most 240 characters for the location.</p>
              )}
              <label>
                Trial program
                <select
                  value={form.program}
                  onChange={(event) => changeForm({ ...form, program: event.target.value })}
                >
                  {!form.baseline && (
                    <option value="inherit">Use lead&apos;s current program</option>
                  )}
                  <option value="none">No program</option>
                  {form.baseline && !supportedProgram && (
                    <option value={form.program}>Unavailable saved program</option>
                  )}
                  {choices.map((program) => (
                    <option key={program.id} value={program.id}>
                      {program.name}
                    </option>
                  ))}
                </select>
              </label>
              {form.program === "inherit" && (
                <p>
                  {lead.program_id
                    ? `Current lead context: ${programLabel(lead.program_id)}.`
                    : "The loaded lead does not establish a program context."}
                </p>
              )}
              {references.status !== "ready" && (
                <div role="status">
                  <p>
                    {references.status === "loading"
                      ? "Loading program choices..."
                      : "Program choices are unavailable. Saved selections are kept."}
                  </p>
                  <button type="button" onClick={references.retry}>
                    Retry program choices
                  </button>
                </div>
              )}
              {!supportedProgram && (
                <p>
                  Select a current program or No program to edit this appointment. Cancellation
                  remains available.
                </p>
              )}
            </>
          )}
          <div className={styles.trialActions}>
            <button type="submit" disabled={!canSave}>
              {form.outcome ? "Confirm trial outcome" : "Save trial"}
            </button>
            <button type="button" onClick={() => changeForm(null)}>
              Cancel form
            </button>
          </div>
        </form>
      )}
      {loading && <p role="status">Loading trial history...</p>}
      {readError && <p role="alert">{readError}</p>}
      <div className={styles.trialActions}>
        <button type="button" disabled={loading} onClick={() => void load(cursor)}>
          {readError ? "Retry page" : "Refresh trials"}
        </button>
        {cursor !== undefined && (
          <button type="button" disabled={loading} onClick={() => void load()}>
            Back to first page
          </button>
        )}
        {page?.next_cursor && (
          <button type="button" disabled={loading} onClick={() => void load(page.next_cursor!)}>
            Next trials
          </button>
        )}
      </div>
      {page && rows.length === 0 && !loading && <p>No trial appointments on this page.</p>}
      {rows.map((row) => (
        <article key={row.id} className={styles.trialHistory}>
          <h4>{statusLabel[row.status]}</h4>
          <p>{appointmentSummary(row)}</p>
          <p>
            {row.location || "No location"} · {programLabel(row.program_id)}
          </p>
          {row.status === "scheduled" && (
            <div className={styles.trialActions}>
              <button type="button" disabled={locked || !eligible} onClick={() => void edit(row)}>
                {references.status !== "ready"
                  ? "Edit trial"
                  : availableProgram(row.program_id)
                    ? "Reschedule trial"
                    : "Change trial program"}
              </button>
              {(["completed", "no_show", "canceled"] as const).map((outcome) => (
                <button
                  type="button"
                  disabled={
                    locked ||
                    (outcome !== "canceled" && (!eligible || !availableProgram(row.program_id)))
                  }
                  key={outcome}
                  onClick={() => void edit(row, outcome)}
                >
                  {outcome === "completed"
                    ? "Complete trial"
                    : outcome === "no_show"
                      ? "Mark trial missed"
                      : "Cancel trial"}
                </button>
              ))}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}

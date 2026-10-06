"use client";

import { useEffect, useId, useState } from "react";
import {
  editAppointmentTimeField,
  resolveAppointmentTime,
  selectAppointmentOccurrence,
  type AppointmentSchedule,
  type AppointmentTimeDraft,
  type AppointmentTimeFields as Fields,
  type AppointmentTimeResolution,
} from "@/lib/appointment-time";
import styles from "@/components/leads/leads-ledger.module.css";

export function appointmentSummary(schedule: AppointmentSchedule) {
  try {
    const format = new Intl.DateTimeFormat("en", {
      timeZone: schedule.timezone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "longOffset",
      hourCycle: "h23",
    });
    const local = (instant: string) =>
      format
        .formatToParts(new Date(instant))
        .map((part) =>
          part.type === "second"
            ? part.value + (instant.match(/\.\d+(?=Z|[+-])/)?.[0] ?? "")
            : part.value,
        )
        .join("");
    return `${local(schedule.starts_at)} to ${local(schedule.ends_at)} · ${schedule.timezone}`;
  } catch {
    return `${schedule.starts_at} to ${schedule.ends_at} · ${schedule.timezone}. Local conversion is unavailable.`;
  }
}

export function AppointmentTimeFields({
  draft,
  onChange,
  onResolution,
}: {
  draft: AppointmentTimeDraft;
  onChange: (draft: AppointmentTimeDraft) => void;
  onResolution: (draft: AppointmentTimeDraft, result: AppointmentTimeResolution | null) => void;
}) {
  const id = useId();
  const [attempt, setAttempt] = useState(0);
  const [zones] = useState(() => ["UTC", ...Intl.supportedValuesOf("timeZone")]);
  const occurrenceKey = JSON.stringify([
    draft.fields,
    draft.original?.starts_at ?? null,
    draft.original?.ends_at ?? null,
    draft.original?.timezone ?? null,
    draft.scheduleEdited,
  ]);
  const [occurrences, setOccurrences] = useState<{
    key: string;
    result: Extract<AppointmentTimeResolution, { status: "needs_choice" }>;
  } | null>(null);
  const [conversion, setConversion] = useState<{
    draft: AppointmentTimeDraft;
    result?: AppointmentTimeResolution;
    failed?: boolean;
  } | null>(null);
  useEffect(() => {
    let current = true;
    onResolution(draft, null);
    void resolveAppointmentTime(draft)
      .then((result) => {
        if (!current) return;
        setConversion({ draft, result });
        if (result.status === "needs_choice") setOccurrences({ key: occurrenceKey, result });
        onResolution(draft, result);
      })
      .catch(() => {
        if (current) setConversion({ draft, failed: true });
      });
    return () => {
      current = false;
    };
  }, [draft, attempt, onResolution, occurrenceKey]);
  const resolved = conversion?.draft === draft ? conversion : null;
  const result = resolved?.result;
  const choices = occurrences?.key === occurrenceKey ? occurrences.result : null;
  const fields: [keyof Fields, string, string][] = [
    ["startDate", "Start date", "date"],
    ["startTime", "Start time", "time"],
    ["endDate", "End date", "date"],
    ["endTime", "End time", "time"],
    ["timezone", "Timezone", "text"],
  ];
  return (
    <fieldset className={styles.trialFields}>
      <legend>Appointment time</legend>
      {draft.original && !draft.scheduleEdited && draft.localSupport === "unavailable" && (
        <p className={styles.trialWide}>
          Saved time: {draft.original.starts_at} to {draft.original.ends_at} ·{" "}
          {draft.original.timezone}.
          {draft.localSupport === "unavailable" &&
            " Local conversion is unavailable. Keep this schedule for location or program edits, or enter a supported timezone and dates to change it."}
        </p>
      )}
      {fields.map(([field, label, type]) => (
        <label key={field} htmlFor={`${id}-${field}`}>
          {label}
          <input
            id={`${id}-${field}`}
            type={type}
            list={field === "timezone" ? `${id}-zones` : undefined}
            value={draft.fields[field]}
            min={type === "date" ? "0001-01-01" : undefined}
            max={type === "date" ? "9999-12-31" : undefined}
            placeholder={field === "timezone" ? "America/Los_Angeles" : undefined}
            aria-describedby={`${id}-feedback`}
            onChange={(event) =>
              onChange(editAppointmentTimeField(draft, field, event.target.value))
            }
          />
        </label>
      ))}
      <datalist id={`${id}-zones`}>
        {zones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
        {!zones.includes(draft.fields.timezone) && <option value={draft.fields.timezone} />}
      </datalist>
      <div id={`${id}-feedback`} className={styles.trialWide} aria-live="polite">
        {!resolved && <p>Converting appointment time...</p>}
        {resolved?.failed && (
          <>
            <p role="alert">Appointment time conversion could not load.</p>
            <button
              type="button"
              onClick={() => {
                setConversion(null);
                setAttempt((value) => value + 1);
              }}
            >
              Retry time conversion
            </button>
          </>
        )}
        {result?.status === "invalid" &&
          result.issues.map((issue, index) => (
            <p key={`${issue.field}-${index}`}>{issue.message}</p>
          ))}
        {choices &&
          (["start", "end"] as const).map(
            (endpoint) =>
              choices[endpoint].length > 1 && (
                <fieldset key={endpoint}>
                  <legend>
                    {endpoint === "start" ? "Start" : "End"} time occurs twice. Choose an
                    occurrence.
                  </legend>
                  {choices[endpoint].map((choice, index) => (
                    <label className={styles.trialOccurrence} key={choice.instant}>
                      <input
                        type="radio"
                        name={`${id}-${endpoint}-occurrence`}
                        value={choice.instant}
                        checked={
                          draft[endpoint === "start" ? "startChoice" : "endChoice"] ===
                          choice.instant
                        }
                        onChange={() =>
                          onChange(selectAppointmentOccurrence(draft, endpoint, choice.instant))
                        }
                      />
                      {index === 0 ? "Earlier occurrence" : "Later occurrence"} · UTC{choice.offset}
                      {" · "}
                      {choice.instant}
                    </label>
                  ))}
                </fieldset>
              ),
          )}
        {result?.status === "resolved" && (
          <p>Resolved time: {appointmentSummary(result.schedule)}</p>
        )}
      </div>
    </fieldset>
  );
}

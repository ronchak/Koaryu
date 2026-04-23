"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar, Clock, Repeat, Users, X } from "lucide-react";

const FULL_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type ClassFormMode = "single" | "weekly";

export type ClassFormField =
  | "name"
  | "date"
  | "startTime"
  | "endTime"
  | "capacity"
  | "dayOfWeek"
  | "startDate"
  | "endDate";

export interface SingleSessionFormSubmitPayload {
  kind: "single_session";
  name: string;
  sessionDate: string;
  startTime: string;
  endTime: string;
  capacity?: number;
}

export interface WeeklyClassTemplateSubmitPayload {
  kind: "weekly_template";
  name: string;
  startTime: string;
  endTime: string;
  capacity?: number;
  recurrence: {
    frequency: "weekly";
    dayOfWeek: number;
    startDate: string;
    endDate?: string;
  };
}

export type ClassFormSubmitPayload =
  | SingleSessionFormSubmitPayload
  | WeeklyClassTemplateSubmitPayload;

export interface ClassFormInitialValues {
  mode?: ClassFormMode;
  name?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  capacity?: number;
  dayOfWeek?: number;
  startDate?: string;
  endDate?: string;
}

type ClassFormFieldErrors = Partial<Record<ClassFormField, string>>;

interface SharedClassFormModalProps {
  open: boolean;
  onClose: () => void;
  isLoading?: boolean;
  error?: string | null;
  fieldErrors?: ClassFormFieldErrors;
  initialValues?: ClassFormInitialValues;
  title?: string;
  defaultMode?: ClassFormMode;
  submitLabel?: string;
}

interface UnifiedSubmitProps {
  onSubmit: (payload: ClassFormSubmitPayload) => Promise<void> | void;
  onSubmitSingle?: never;
  onSubmitRecurring?: never;
}

interface SplitSubmitProps {
  onSubmit?: never;
  onSubmitSingle: (payload: SingleSessionFormSubmitPayload) => Promise<void> | void;
  onSubmitRecurring: (payload: WeeklyClassTemplateSubmitPayload) => Promise<void> | void;
}

export type ClassFormModalProps = SharedClassFormModalProps & (UnifiedSubmitProps | SplitSubmitProps);

interface FormState {
  mode: ClassFormMode;
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  capacity: string;
  dayOfWeek: number;
  startDate: string;
  endDate: string;
}

function todayDateString() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseTimeToMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return Number.NaN;
  return hours * 60 + minutes;
}

function formatTimeLabel(value: string) {
  if (!value) return "time";

  const [hoursText, minutes] = value.split(":");
  const hours = Number(hoursText);
  if (Number.isNaN(hours)) return value;

  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${hour12}:${minutes} ${suffix}`;
}

function formatDateLabel(value: string) {
  if (!value) return "date";

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function getDayOfWeekFromDate(value: string) {
  if (!value) return new Date().getDay();

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return new Date().getDay();
  return date.getDay();
}

function buildInitialState(initialValues?: ClassFormInitialValues, defaultMode: ClassFormMode = "weekly"): FormState {
  const today = todayDateString();
  const date = initialValues?.date || initialValues?.startDate || today;

  return {
    mode: initialValues?.mode || defaultMode,
    name: initialValues?.name || "",
    date,
    startTime: initialValues?.startTime || "18:00",
    endTime: initialValues?.endTime || "19:30",
    capacity: initialValues?.capacity ? String(initialValues.capacity) : "",
    dayOfWeek: initialValues?.dayOfWeek ?? getDayOfWeekFromDate(date),
    startDate: initialValues?.startDate || date,
    endDate: initialValues?.endDate || "",
  };
}

function SelectField({
  label,
  value,
  error,
  hint,
  disabled,
  onChange,
  options,
}: {
  label: string;
  value: string;
  error?: string;
  hint?: string;
  disabled?: boolean;
  onChange: (nextValue: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm text-text-secondary font-medium">{label}</label>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={`w-full px-3 py-2 text-sm bg-surface-raised border rounded-[6px] text-text-primary focus:border-accent focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          error ? "border-danger" : "border-border"
        }`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-danger">{error}</p>}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function ClassFormModal(props: ClassFormModalProps) {
  const {
    open,
    initialValues,
    defaultMode = "weekly",
  } = props;

  if (!open) return null;

  const resetKey = JSON.stringify([
    defaultMode,
    initialValues?.mode || "",
    initialValues?.name || "",
    initialValues?.date || "",
    initialValues?.startTime || "",
    initialValues?.endTime || "",
    initialValues?.capacity ?? "",
    initialValues?.dayOfWeek ?? "",
    initialValues?.startDate || "",
    initialValues?.endDate || "",
  ]);

  return <ClassFormModalContent key={resetKey} {...props} defaultMode={defaultMode} />;
}

function ClassFormModalContent(props: ClassFormModalProps & { defaultMode: ClassFormMode }) {
  const {
    onClose,
    isLoading = false,
    error,
    fieldErrors,
    title = "Create class",
    initialValues,
    defaultMode,
    submitLabel,
  } = props;

  const [form, setForm] = useState<FormState>(() => buildInitialState(initialValues, defaultMode));
  const [validationErrors, setValidationErrors] = useState<ClassFormFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  function getFieldError(field: ClassFormField) {
    return fieldErrors?.[field] || validationErrors[field];
  }

  function patchForm(nextValues: Partial<FormState>, clearedFields?: ClassFormField[]) {
    setForm((current) => ({ ...current, ...nextValues }));
    setSubmitError(null);

    if (clearedFields?.length) {
      setValidationErrors((current) => {
        const next = { ...current };
        clearedFields.forEach((field) => {
          delete next[field];
        });
        return next;
      });
    }
  }

  function handleModeChange(nextMode: ClassFormMode) {
    if (nextMode === form.mode) return;

    if (nextMode === "weekly") {
      patchForm(
        {
          mode: "weekly",
          dayOfWeek: getDayOfWeekFromDate(form.date),
          startDate: form.startDate || form.date,
        },
        ["date", "dayOfWeek", "startDate", "endDate"]
      );
      return;
    }

    patchForm(
      {
        mode: "single",
        date: form.date || form.startDate || todayDateString(),
      },
      ["date", "dayOfWeek", "startDate", "endDate"]
    );
  }

  async function dispatchSubmit(payload: ClassFormSubmitPayload) {
    if (props.onSubmit) {
      await props.onSubmit(payload);
      return;
    }

    if (payload.kind === "single_session") {
      await props.onSubmitSingle(payload);
      return;
    }

    await props.onSubmitRecurring(payload);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextErrors: ClassFormFieldErrors = {};
    const trimmedName = form.name.trim();
    const capacityValue = form.capacity.trim();
    const startMinutes = parseTimeToMinutes(form.startTime);
    const endMinutes = parseTimeToMinutes(form.endTime);

    if (!trimmedName) nextErrors.name = "Class name is required.";
    if (!form.startTime) nextErrors.startTime = "Start time is required.";
    if (!form.endTime) nextErrors.endTime = "End time is required.";

    if (!Number.isNaN(startMinutes) && !Number.isNaN(endMinutes) && endMinutes <= startMinutes) {
      nextErrors.endTime = "End time must be after the start time.";
    }

    if (capacityValue) {
      const parsedCapacity = Number.parseInt(capacityValue, 10);
      if (!/^\d+$/.test(capacityValue) || parsedCapacity <= 0) {
        nextErrors.capacity = "Capacity must be a positive whole number.";
      }
    }

    if (form.mode === "single") {
      if (!form.date) nextErrors.date = "Choose the class date.";
    } else {
      if (!Number.isInteger(form.dayOfWeek) || form.dayOfWeek < 0 || form.dayOfWeek > 6) {
        nextErrors.dayOfWeek = "Choose the weekday for this series.";
      }
      if (!form.startDate) nextErrors.startDate = "Choose when the series can begin.";
      if (form.endDate && form.startDate && form.endDate < form.startDate) {
        nextErrors.endDate = "End date cannot be before the series start date.";
      }
    }

    setValidationErrors(nextErrors);
    setSubmitError(null);

    if (Object.keys(nextErrors).length > 0) return;

    const capacity = capacityValue ? Number.parseInt(capacityValue, 10) : undefined;
    const payload: ClassFormSubmitPayload =
      form.mode === "single"
        ? {
            kind: "single_session",
            name: trimmedName,
            sessionDate: form.date,
            startTime: form.startTime,
            endTime: form.endTime,
            capacity,
          }
        : {
            kind: "weekly_template",
            name: trimmedName,
            startTime: form.startTime,
            endTime: form.endTime,
            capacity,
            recurrence: {
              frequency: "weekly",
              dayOfWeek: form.dayOfWeek,
              startDate: form.startDate,
              endDate: form.endDate || undefined,
            },
          };

    try {
      await dispatchSubmit(payload);
    } catch (submitFailure) {
      setSubmitError(
        submitFailure instanceof Error ? submitFailure.message : "Could not save this class. Please try again."
      );
    }
  }

  const recurringSummary = `Creates a weekly ${FULL_DAY_NAMES[form.dayOfWeek]} timeslot at ${formatTimeLabel(
    form.startTime
  )}, active from ${formatDateLabel(form.startDate)}${form.endDate ? ` until ${formatDateLabel(form.endDate)}` : ""}.`;
  const singleSummary = `Creates one scheduled class on ${formatDateLabel(form.date)} at ${formatTimeLabel(
    form.startTime
  )}.`;
  const primaryLabel =
    submitLabel || (form.mode === "weekly" ? "Create weekly template" : "Create one-off session");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={() => {
          if (!isLoading) onClose();
        }}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-[560px] bg-surface border border-border rounded-[8px] shadow-2xl"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-text-primary">{title}</h2>
            <p className="text-xs text-muted mt-1">Create either a standing weekly class template or a one-off session.</p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!isLoading) onClose();
            }}
            disabled={isLoading}
            className="text-muted hover:text-text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="px-6 py-5 space-y-5 max-h-[80vh] overflow-y-auto">
            {(error || submitError) && (
              <div className="rounded-[6px] border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
                {error || submitError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleModeChange("weekly")}
                className={`text-left rounded-[8px] border px-4 py-3 transition-colors cursor-pointer ${
                  form.mode === "weekly"
                    ? "border-accent bg-accent/10"
                    : "border-border bg-surface-raised hover:border-accent/40"
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <Repeat className="w-4 h-4" />
                  Weekly template
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  Creates a standing weekly class slot staff can rely on.
                </p>
              </button>
              <button
                type="button"
                onClick={() => handleModeChange("single")}
                className={`text-left rounded-[8px] border px-4 py-3 transition-colors cursor-pointer ${
                  form.mode === "single"
                    ? "border-accent bg-accent/10"
                    : "border-border bg-surface-raised hover:border-accent/40"
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <Calendar className="w-4 h-4" />
                  One-off session
                </div>
                <p className="mt-1 text-xs text-text-secondary">Use this for a single date outside the weekly template.</p>
              </button>
            </div>

            <div className="rounded-[8px] border border-border bg-surface-raised/40 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                {form.mode === "weekly" ? "Weekly class template" : "One-off scheduled session"}
              </p>
              <p className="mt-1 text-sm text-text-primary">
                {form.mode === "weekly" ? recurringSummary : singleSummary}
              </p>
            </div>

            <Input
              label="Class name *"
              value={form.name}
              disabled={isLoading}
              onChange={(event) => patchForm({ name: event.target.value }, ["name"])}
              placeholder="Adult Gi Fundamentals"
              error={getFieldError("name")}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {form.mode === "single" ? (
                <Input
                  label="Class date *"
                  type="date"
                  value={form.date}
                  disabled={isLoading}
                  onChange={(event) => patchForm({ date: event.target.value }, ["date"])}
                  error={getFieldError("date")}
                />
              ) : (
                <SelectField
                  label="Weekday *"
                  value={String(form.dayOfWeek)}
                  disabled={isLoading}
                  onChange={(value) => patchForm({ dayOfWeek: Number(value) }, ["dayOfWeek"])}
                  options={FULL_DAY_NAMES.map((day, index) => ({ value: String(index), label: day }))}
                  error={getFieldError("dayOfWeek")}
                />
              )}

              <Input
                label="Capacity"
                type="number"
                min="1"
                inputMode="numeric"
                value={form.capacity}
                disabled={isLoading}
                onChange={(event) => patchForm({ capacity: event.target.value }, ["capacity"])}
                placeholder="30"
                error={getFieldError("capacity")}
                hint="Leave blank for no cap."
              />
            </div>

            {form.mode === "weekly" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input
                  label="Series start date *"
                  type="date"
                  value={form.startDate}
                  disabled={isLoading}
                  onChange={(event) => patchForm({ startDate: event.target.value }, ["startDate", "endDate"])}
                  error={getFieldError("startDate")}
                  hint="This is when the weekly timeslot becomes active."
                />
                <Input
                  label="Template end date"
                  type="date"
                  value={form.endDate}
                  disabled={isLoading}
                  onChange={(event) => patchForm({ endDate: event.target.value }, ["endDate"])}
                  error={getFieldError("endDate")}
                  hint="Optional. Leave blank to keep the weekly template open-ended."
                />
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="Start time *"
                type="time"
                value={form.startTime}
                disabled={isLoading}
                onChange={(event) => patchForm({ startTime: event.target.value }, ["startTime", "endTime"])}
                error={getFieldError("startTime")}
              />
              <Input
                label="End time *"
                type="time"
                value={form.endTime}
                disabled={isLoading}
                onChange={(event) => patchForm({ endTime: event.target.value }, ["endTime"])}
                error={getFieldError("endTime")}
              />
            </div>

            <div className="rounded-[8px] border border-border bg-bg px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <Clock className="w-4 h-4 text-text-secondary" />
                {formatTimeLabel(form.startTime)} to {formatTimeLabel(form.endTime)}
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-text-secondary">
                <span className="inline-flex items-center gap-1 rounded-full bg-surface-raised px-2.5 py-1">
                  <Users className="w-3 h-3" />
                  {form.capacity ? `${form.capacity} spots` : "No capacity limit"}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-surface-raised px-2.5 py-1">
                  <Calendar className="w-3 h-3" />
                  {form.mode === "weekly" ? FULL_DAY_NAMES[form.dayOfWeek] : formatDateLabel(form.date)}
                </span>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 px-6 py-4 border-t border-border">
            <Button type="button" variant="ghost" size="sm" disabled={isLoading} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" isLoading={isLoading}>
              {primaryLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

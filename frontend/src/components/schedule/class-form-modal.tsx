"use client";

import { useId, useState } from "react";
import { ProgramPicker } from "@/components/programs/program-picker";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { Input } from "@/components/ui/input";
import { ModalFrame } from "@/components/ui/modal-frame";
import {
  FULL_DAY_NAMES,
  buildClassFormInitialState,
  buildClassFormModeState,
  buildClassFormResetKey,
  buildClassFormSubmitDecision,
  formatDateLabel,
  formatTimeLabel,
  type ClassFormField,
  type ClassFormFieldErrors,
  type ClassFormInitialValues,
  type ClassFormMode,
  type ClassFormState,
  type ClassFormSubmitPayload,
  type SingleSessionFormSubmitPayload,
  type WeeklyClassTemplateSubmitPayload,
} from "@/lib/class-form-model";
import type { Program } from "@/types";
import { Calendar, Clock, Repeat, Users, X } from "lucide-react";

export type {
  ClassFormInitialValues,
  ClassFormMode,
  ClassFormSubmitPayload,
  SingleSessionFormSubmitPayload,
  WeeklyClassTemplateSubmitPayload,
} from "@/lib/class-form-model";

interface SharedClassFormModalProps {
  open: boolean;
  onClose: () => void;
  isLoading?: boolean;
  error?: string | null;
  onDismissError?: () => void;
  fieldErrors?: ClassFormFieldErrors;
  initialValues?: ClassFormInitialValues;
  title?: string;
  defaultMode?: ClassFormMode;
  submitLabel?: string;
  programs?: Program[];
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
  const generatedId = useId();
  const selectId = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "select"}-${generatedId.replace(/:/g, "")}`;
  const errorId = error ? `${selectId}-error` : undefined;
  const hintId = hint && !error ? `${selectId}-hint` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={selectId} className="text-sm text-text-secondary font-medium">{label}</label>
      <select
        id={selectId}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
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
      {error && <p id={errorId} className="text-xs text-danger">{error}</p>}
      {hint && !error && <p id={hintId} className="text-xs text-muted">{hint}</p>}
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

  const resetKey = buildClassFormResetKey(initialValues, defaultMode);

  return <ClassFormModalContent key={resetKey} {...props} defaultMode={defaultMode} />;
}

function ClassFormModalContent(props: ClassFormModalProps & { defaultMode: ClassFormMode }) {
  const {
    onClose,
    isLoading = false,
    error,
    onDismissError,
    fieldErrors,
    title = "Create class",
    initialValues,
    defaultMode,
    submitLabel,
    programs = [],
  } = props;

  const [form, setForm] = useState<ClassFormState>(() => buildClassFormInitialState(initialValues, defaultMode));
  const [validationErrors, setValidationErrors] = useState<ClassFormFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  function getFieldError(field: ClassFormField) {
    return fieldErrors?.[field] || validationErrors[field];
  }

  function patchForm(nextValues: Partial<ClassFormState>, clearedFields?: ClassFormField[]) {
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

    patchForm(
      buildClassFormModeState(form, nextMode),
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

    const decision = buildClassFormSubmitDecision(form);

    setValidationErrors(decision.errors);
    setSubmitError(null);

    if (!decision.payload) return;

    try {
      await dispatchSubmit(decision.payload);
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
    <ModalFrame
      rootClassName="p-4"
      panelClassName="w-full max-w-[560px] bg-surface border border-border rounded-[8px] shadow-2xl"
      ariaLabel={title}
      onBackdropClick={() => {
        if (!isLoading) onClose();
      }}
    >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-text-primary">{title}</h2>
            <p className="text-xs text-muted mt-1">Create either a standing weekly class template or a one-off session.</p>
          </div>
          <button
            type="button"
            aria-label="Close class form dialog"
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
              <DismissibleNotice
                tone="danger"
                onDismiss={() => {
                  setSubmitError(null);
                  onDismissError?.();
                }}
              >
                {error || submitError}
              </DismissibleNotice>
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

            <ProgramPicker
              programs={programs}
              value={form.programId}
              onChange={(programId) => patchForm({ programId: programId || "" }, ["programId"])}
              label="Program"
              allowEmpty
              disabled={isLoading}
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
    </ModalFrame>
  );
}

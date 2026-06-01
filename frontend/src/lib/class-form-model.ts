export const FULL_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type ClassFormMode = "single" | "weekly";

export type ClassFormField =
  | "name"
  | "programId"
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
  program_id?: string;
  capacity?: number;
}

export interface WeeklyClassTemplateSubmitPayload {
  kind: "weekly_template";
  name: string;
  startTime: string;
  endTime: string;
  program_id?: string;
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
  programId?: string | null;
  program_id?: string | null;
  capacity?: number;
  dayOfWeek?: number;
  startDate?: string;
  endDate?: string;
}

export type ClassFormFieldErrors = Partial<Record<ClassFormField, string>>;

export interface ClassFormState {
  mode: ClassFormMode;
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  programId: string;
  capacity: string;
  dayOfWeek: number;
  startDate: string;
  endDate: string;
}

export interface ClassFormSubmitDecision {
  errors: ClassFormFieldErrors;
  payload?: ClassFormSubmitPayload;
}

export function todayDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseTimeToMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return Number.NaN;
  return hours * 60 + minutes;
}

export function formatTimeLabel(value: string) {
  if (!value) return "time";

  const [hoursText, minutes] = value.split(":");
  const hours = Number(hoursText);
  if (Number.isNaN(hours)) return value;

  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${hour12}:${minutes} ${suffix}`;
}

export function formatDateLabel(value: string) {
  if (!value) return "date";

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function getDayOfWeekFromDate(value: string) {
  if (!value) return new Date().getDay();

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return new Date().getDay();
  return date.getDay();
}

export function buildClassFormInitialState(
  initialValues?: ClassFormInitialValues,
  defaultMode: ClassFormMode = "weekly"
): ClassFormState {
  const today = todayDateString();
  const date = initialValues?.date || initialValues?.startDate || today;

  return {
    mode: initialValues?.mode || defaultMode,
    name: initialValues?.name || "",
    date,
    startTime: initialValues?.startTime || "18:00",
    endTime: initialValues?.endTime || "19:30",
    programId: initialValues?.programId || initialValues?.program_id || "",
    capacity: initialValues?.capacity ? String(initialValues.capacity) : "",
    dayOfWeek: initialValues?.dayOfWeek ?? getDayOfWeekFromDate(date),
    startDate: initialValues?.startDate || date,
    endDate: initialValues?.endDate || "",
  };
}

export function buildClassFormResetKey(
  initialValues: ClassFormInitialValues | undefined,
  defaultMode: ClassFormMode
) {
  return JSON.stringify([
    defaultMode,
    initialValues?.mode || "",
    initialValues?.name || "",
    initialValues?.date || "",
    initialValues?.startTime || "",
    initialValues?.endTime || "",
    initialValues?.programId || initialValues?.program_id || "",
    initialValues?.capacity ?? "",
    initialValues?.dayOfWeek ?? "",
    initialValues?.startDate || "",
    initialValues?.endDate || "",
  ]);
}

export function buildClassFormModeState(form: ClassFormState, nextMode: ClassFormMode): Partial<ClassFormState> {
  if (nextMode === form.mode) {
    return {};
  }

  if (nextMode === "weekly") {
    return {
      mode: "weekly",
      dayOfWeek: getDayOfWeekFromDate(form.date),
      startDate: form.startDate || form.date,
    };
  }

  return {
    mode: "single",
    date: form.date || form.startDate || todayDateString(),
  };
}

export function buildClassFormSubmitDecision(form: ClassFormState): ClassFormSubmitDecision {
  const errors: ClassFormFieldErrors = {};
  const trimmedName = form.name.trim();
  const capacityValue = form.capacity.trim();
  const startMinutes = parseTimeToMinutes(form.startTime);
  const endMinutes = parseTimeToMinutes(form.endTime);

  if (!trimmedName) errors.name = "Class name is required.";
  if (!form.startTime) errors.startTime = "Start time is required.";
  if (!form.endTime) errors.endTime = "End time is required.";

  if (!Number.isNaN(startMinutes) && !Number.isNaN(endMinutes) && endMinutes <= startMinutes) {
    errors.endTime = "End time must be after the start time.";
  }

  if (capacityValue) {
    const parsedCapacity = Number.parseInt(capacityValue, 10);
    if (!/^\d+$/.test(capacityValue) || parsedCapacity <= 0) {
      errors.capacity = "Capacity must be a positive whole number.";
    }
  }

  if (form.mode === "single") {
    if (!form.date) errors.date = "Choose the class date.";
  } else {
    if (!Number.isInteger(form.dayOfWeek) || form.dayOfWeek < 0 || form.dayOfWeek > 6) {
      errors.dayOfWeek = "Choose the weekday for this series.";
    }
    if (!form.startDate) errors.startDate = "Choose when the series can begin.";
    if (form.endDate && form.startDate && form.endDate < form.startDate) {
      errors.endDate = "End date cannot be before the series start date.";
    }
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  const capacity = capacityValue ? Number.parseInt(capacityValue, 10) : undefined;
  const programId = form.programId || undefined;

  if (form.mode === "single") {
    return {
      errors,
      payload: {
        kind: "single_session",
        name: trimmedName,
        sessionDate: form.date,
        startTime: form.startTime,
        endTime: form.endTime,
        program_id: programId,
        capacity,
      },
    };
  }

  return {
    errors,
    payload: {
      kind: "weekly_template",
      name: trimmedName,
      startTime: form.startTime,
      endTime: form.endTime,
      program_id: programId,
      capacity,
      recurrence: {
        frequency: "weekly",
        dayOfWeek: form.dayOfWeek,
        startDate: form.startDate,
        endDate: form.endDate || undefined,
      },
    },
  };
}

export type AppointmentSchedule = Readonly<{
  starts_at: string;
  ends_at: string;
  timezone: string;
}>;
export type AppointmentTimeFields = Readonly<{
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timezone: string;
}>;
export type AppointmentTimeDraft = Readonly<{
  fields: AppointmentTimeFields;
  original: AppointmentSchedule | null;
  scheduleEdited: boolean;
  localSupport: "supported" | "unavailable";
  startChoice: string | null;
  endChoice: string | null;
}>;
export type AppointmentOccurrence = Readonly<{ instant: string; offset: string; label: string }>;
export type AppointmentTimeIssue = Readonly<{
  field: keyof AppointmentTimeFields | "duration";
  message: string;
}>;
export type AppointmentTimeResolution =
  | Readonly<{ status: "invalid"; issues: readonly AppointmentTimeIssue[] }>
  | Readonly<{
      status: "needs_choice";
      start: readonly AppointmentOccurrence[];
      end: readonly AppointmentOccurrence[];
    }>
  | Readonly<{ status: "resolved"; schedule: AppointmentSchedule }>;

export function isAppointmentTimezone(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..") &&
    !["localtime", "posixrules", "posix", "right"].includes(value.split("/")[0])
  );
}
export function supportsAppointmentTimezone(value: string): boolean {
  if (!isAppointmentTimezone(value) || /^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
// Validate wire instants without loading a timezone converter. Fractions remain
// strings so submillisecond appointments and untouched schedules keep precision.
function instantParts(value: unknown): { seconds: bigint; fraction: string } | null {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!match || !validDate(match[1])) return null;
  const millis = Date.parse(value);
  const year = new Date(millis).getUTCFullYear();
  if (!Number.isFinite(millis) || year < 1 || year > 9999) return null;
  return { seconds: BigInt(Math.floor(millis / 1000)), fraction: match[5] ?? "" };
}
export function isAppointmentInstant(value: unknown): value is string {
  return instantParts(value) !== null;
}
export function isAppointmentSchedule(value: AppointmentSchedule): boolean {
  const start = instantParts(value.starts_at),
    end = instantParts(value.ends_at);
  if (!start || !end || !isAppointmentTimezone(value.timezone)) return false;
  const precision = Math.max(start.fraction.length, end.fraction.length);
  const scale = BigInt(10) ** BigInt(precision);
  const elapsed =
    (end.seconds - start.seconds) * scale +
    BigInt(end.fraction.padEnd(precision, "0") || "0") -
    BigInt(start.fraction.padEnd(precision, "0") || "0");
  return elapsed > BigInt(0) && elapsed <= BigInt(86400) * scale;
}
export function normalizeAppointmentSchedule(schedule: AppointmentSchedule): AppointmentSchedule {
  if (!isAppointmentSchedule(schedule)) throw new Error("Use a valid appointment schedule.");
  const utc = (value: string) => {
    const parts = instantParts(value)!;
    const fraction = parts.fraction.replace(/0+$/, "");
    return `${new Date(Number(parts.seconds) * 1000).toISOString().slice(0, 19)}${fraction ? `.${fraction}` : ""}Z`;
  };
  return Object.freeze({
    starts_at: utc(schedule.starts_at),
    ends_at: utc(schedule.ends_at),
    timezone: schedule.timezone,
  });
}
function freezeDraft(draft: AppointmentTimeDraft): AppointmentTimeDraft {
  return Object.freeze({
    ...draft,
    fields: Object.freeze({ ...draft.fields }),
    original: draft.original && Object.freeze({ ...draft.original }),
  });
}
export function createAppointmentTimeDraft(
  timezone: string,
  original: AppointmentSchedule | null = null,
): AppointmentTimeDraft {
  const zone = original?.timezone ?? timezone;
  let fields: AppointmentTimeFields = {
    startDate: "",
    startTime: "",
    endDate: "",
    endTime: "",
    timezone: zone,
  };
  let supported = supportsAppointmentTimezone(zone);
  if (original && supported) {
    try {
      const format = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        calendar: "gregory",
        numberingSystem: "latn",
        era: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      const local = (instant: string) => {
        if (!isAppointmentInstant(instant)) throw new Error();
        const parts = Object.fromEntries(
          format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
        );
        const date = `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
        if (parts.era !== "AD" || !validDate(date)) throw new Error();
        return [date, `${parts.hour}:${parts.minute}`];
      };
      const [startDate, startTime] = local(original.starts_at),
        [endDate, endTime] = local(original.ends_at);
      fields = { ...fields, startDate, startTime, endDate, endTime };
    } catch {
      supported = false;
    }
  }
  return freezeDraft({
    fields,
    original,
    scheduleEdited: false,
    localSupport: supported ? "supported" : "unavailable",
    startChoice: null,
    endChoice: null,
  });
}
export function editAppointmentTimeField(
  draft: AppointmentTimeDraft,
  field: keyof AppointmentTimeFields,
  value: string,
): AppointmentTimeDraft {
  if (draft.fields[field] === value) return draft;
  return freezeDraft({
    ...draft,
    fields: { ...draft.fields, [field]: value },
    scheduleEdited: true,
    localSupport: supportsAppointmentTimezone(field === "timezone" ? value : draft.fields.timezone)
      ? "supported"
      : "unavailable",
    startChoice: field === "timezone" || field.startsWith("start") ? null : draft.startChoice,
    endChoice: field === "timezone" || field.startsWith("end") ? null : draft.endChoice,
  });
}
export function selectAppointmentOccurrence(
  draft: AppointmentTimeDraft,
  endpoint: "start" | "end",
  instant: string,
): AppointmentTimeDraft {
  return freezeDraft({ ...draft, [endpoint === "start" ? "startChoice" : "endChoice"]: instant });
}
export async function resolveAppointmentTime(
  draft: AppointmentTimeDraft,
): Promise<AppointmentTimeResolution> {
  const invalid = (issues: AppointmentTimeIssue[]): AppointmentTimeResolution =>
    Object.freeze({
      status: "invalid",
      issues: Object.freeze(issues.map((issue) => Object.freeze(issue))),
    });
  if (draft.original && !draft.scheduleEdited) {
    return isAppointmentSchedule(draft.original)
      ? Object.freeze({ status: "resolved", schedule: Object.freeze({ ...draft.original }) })
      : invalid([
          {
            field: "duration",
            message: "Repair the saved appointment schedule before changing it.",
          },
        ]);
  }
  const { fields } = draft;
  const issues: AppointmentTimeIssue[] = [];
  for (const field of ["startDate", "endDate"] as const)
    if (!validDate(fields[field]))
      issues.push({ field, message: "Enter a valid date from 0001-01-01 through 9999-12-31." });
  for (const field of ["startTime", "endTime"] as const)
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(fields[field]))
      issues.push({ field, message: "Enter a time as HH:mm." });
  if (!supportsAppointmentTimezone(fields.timezone))
    issues.push({ field: "timezone", message: "Select a supported named timezone or UTC." });
  if (issues.length) return invalid(issues);
  const { Temporal } = await import("@js-temporal/polyfill").catch(() => {
    throw new Error("Appointment time conversion could not load. Try again.");
  });
  let resolvedTimezone: string | null = null;
  const occurrences = (endpoint: "start" | "end"): readonly AppointmentOccurrence[] => {
    const wall = Temporal.PlainDateTime.from(
      `${fields[`${endpoint}Date`]}T${fields[`${endpoint}Time`]}:00`,
    );
    const choices = new Map<string, AppointmentOccurrence>();
    for (const disambiguation of ["earlier", "later"] as const) {
      const candidate = wall.toZonedDateTime(fields.timezone, { disambiguation });
      if (!candidate.toPlainDateTime().equals(wall)) continue;
      if (resolvedTimezone !== null && resolvedTimezone !== candidate.timeZoneId)
        throw new Error("Appointment timezone identities do not match.");
      resolvedTimezone = candidate.timeZoneId;
      const instant = candidate.toInstant().toString({ smallestUnit: "second" });
      if (!isAppointmentInstant(instant)) {
        issues.push({
          field: `${endpoint}Date`,
          message: "The resolved UTC date must be within years 0001 through 9999.",
        });
        continue;
      }
      choices.set(
        instant,
        Object.freeze({
          instant,
          offset: candidate.offset,
          label: `${instant} (UTC${candidate.offset})`,
        }),
      );
    }
    if (!choices.size && !issues.some((issue) => issue.field === `${endpoint}Date`))
      issues.push({
        field: `${endpoint}Time`,
        message: "This local time does not exist in the selected timezone.",
      });
    return Object.freeze([...choices.values()]);
  };
  let start: readonly AppointmentOccurrence[], end: readonly AppointmentOccurrence[];
  try {
    start = occurrences("start");
    end = occurrences("end");
  } catch {
    return invalid([
      {
        field: "timezone",
        message:
          "This timezone is unavailable for time conversion. Select a supported named timezone.",
      },
    ]);
  }
  const chosen = (
    options: readonly AppointmentOccurrence[],
    choice: string | null,
    field: "startTime" | "endTime",
  ) => {
    if (choice !== null && !options.some((option) => option.instant === choice)) {
      issues.push({ field, message: "Choose an occurrence for the current date and time." });
      return null;
    }
    return choice ?? (options.length === 1 ? options[0].instant : null);
  };
  const starts_at = chosen(start, draft.startChoice, "startTime"),
    ends_at = chosen(end, draft.endChoice, "endTime");
  if (issues.length || resolvedTimezone === null) return invalid(issues);
  if (!starts_at || !ends_at) return Object.freeze({ status: "needs_choice", start, end });
  const schedule = Object.freeze({ starts_at, ends_at, timezone: resolvedTimezone });
  return isAppointmentSchedule(schedule)
    ? Object.freeze({ status: "resolved", schedule })
    : invalid([
        {
          field: "duration",
          message: "The appointment must last more than zero and at most 24 hours.",
        },
      ]);
}

// Deep links into a specific view: `/schedule?date=…&session=…` and `/leads?focus=…`
// or `/leads?lead=…`. Pure parsing only, so Node tests can import it; pages and
// controllers apply the targets and remove them from the address once used.

export type ScheduleRouteTarget = {
  /** Studio calendar date, `YYYY-MM-DD`. */
  date: string;
  /** A `class_sessions` id on that date whose attendance should open, if any. */
  sessionId: string | null;
};

export type LeadsRouteFocus = "overdue" | "today";

export type LeadsRouteTarget = {
  focus: LeadsRouteFocus | null;
  leadId: string | null;
};

export type RouteTargetOptions = {
  /**
   * Preview data uses readable ids such as `sess-1` and `lead-1`. Live records
   * are UUIDs, so anything else is ignored outside preview mode.
   */
  allowPreviewIds?: boolean;
};

export const SCHEDULE_TARGET_PARAMS = ["date", "session"] as const;
export const LEADS_TARGET_PARAMS = ["focus", "lead"] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LEADS_FOCUS_VALUES: readonly LeadsRouteFocus[] = ["overdue", "today"];

function toSearchParams(search: URLSearchParams | string) {
  return typeof search === "string" ? new URLSearchParams(search) : search;
}

/** The parameter's value when it appears exactly once; repeated or absent values are ignored. */
function singleParam(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

/** A real calendar date in `YYYY-MM-DD` form, such as `2026-10-10` (not `2026-02-30`). */
export function isRouteDateKey(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/** A record id from a link: a UUID, normalized to lower case, or a preview id when allowed. */
export function parseRouteRecordId(
  value: string | null | undefined,
  { allowPreviewIds = false }: RouteTargetOptions = {},
): string | null {
  if (typeof value !== "string") return null;
  if (UUID_PATTERN.test(value)) return value.toLowerCase();
  return allowPreviewIds && PREVIEW_ID_PATTERN.test(value) ? value : null;
}

/**
 * `/schedule?date=YYYY-MM-DD[&session=<id>]`. Without a valid date there is no
 * target; an invalid session id is dropped and the date still applies.
 */
export function parseScheduleTarget(
  search: URLSearchParams | string,
  options: RouteTargetOptions = {},
): ScheduleRouteTarget | null {
  const params = toSearchParams(search);
  const date = singleParam(params, "date");
  if (!isRouteDateKey(date)) return null;
  return { date, sessionId: parseRouteRecordId(singleParam(params, "session"), options) };
}

/** `/leads?focus=overdue|today` and/or `/leads?lead=<id>`; unknown values are ignored. */
export function parseLeadsTarget(
  search: URLSearchParams | string,
  options: RouteTargetOptions = {},
): LeadsRouteTarget | null {
  const params = toSearchParams(search);
  const focusValue = singleParam(params, "focus");
  const focus = LEADS_FOCUS_VALUES.find((value) => value === focusValue) ?? null;
  const leadId = parseRouteRecordId(singleParam(params, "lead"), options);
  return focus || leadId ? { focus, leadId } : null;
}

export function isSameScheduleTarget(
  a: ScheduleRouteTarget | null | undefined,
  b: ScheduleRouteTarget | null | undefined,
) {
  if (!a || !b) return !a && !b;
  return a.date === b.date && a.sessionId === b.sessionId;
}

export type ScheduleTargetSessionOutcome<T> =
  { kind: "open"; session: T } | { kind: "canceled"; session: T } | { kind: "missing" };

/**
 * Finds the linked session among a loaded schedule range. Only a session on the
 * linked date counts, and a canceled one never opens attendance.
 */
export function resolveScheduleTargetSession<
  T extends { id: string; date: string; status: string },
>(
  target: Pick<ScheduleRouteTarget, "date" | "sessionId">,
  sessions: readonly T[],
): ScheduleTargetSessionOutcome<T> {
  const session = target.sessionId
    ? sessions.find(
        (candidate) =>
          candidate.date === target.date &&
          (candidate.id === target.sessionId || candidate.id.toLowerCase() === target.sessionId),
      )
    : undefined;
  if (!session) return { kind: "missing" };
  return session.status === "canceled" ? { kind: "canceled", session } : { kind: "open", session };
}

/**
 * The same address without the given parameters, or null when none of them is
 * present (nothing to replace). Other parameters and the hash are kept.
 */
export function buildConsumedRouteHref(
  location: { pathname: string; search: string; hash?: string },
  names: readonly string[],
): string | null {
  const params = new URLSearchParams(location.search);
  if (!names.some((name) => params.has(name))) return null;
  for (const name of names) params.delete(name);
  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ""}${location.hash ?? ""}`;
}

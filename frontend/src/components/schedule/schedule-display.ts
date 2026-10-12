import type { ClassSession, Program } from "@/types";

/** Display helpers shared by the Schedule views, the Today panel and the attendance sheet. */

export const SCHEDULE_FALLBACK_COLOR = "var(--product-wood, var(--accent))";

export function getProgramColor(program: Program | null | undefined) {
  return program?.color_hex || SCHEDULE_FALLBACK_COLOR;
}

/** "3/20" when the class has a capacity, "3 in" without one; null when there is nothing to say. */
export function getSessionFill(session: ClassSession) {
  if (session.status === "canceled") return null;
  if (session.capacity) return `${session.attendance_count}/${session.capacity}`;
  if (session.attendance_count > 0) return `${session.attendance_count} in`;
  return null;
}

/** 0-1 share of seats taken, or null when the class has no capacity. */
export function getSessionFillRatio(session: ClassSession) {
  if (!session.capacity || session.status === "canceled") return null;
  return Math.max(0, Math.min(1, session.attendance_count / session.capacity));
}

export function formatClockTime(value: string) {
  const [hoursText = "0", minutes = "00"] = value.split(":");
  const hours = Number(hoursText);
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes.slice(0, 2)} ${suffix}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

import { toLocalDateKey } from "./date";

export function formatDate(value?: string | null) {
  if (!value) return "—";

  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function subtractDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() - days);
  return toLocalDateKey(date);
}

export function formatPercent(value?: number | null) {
  if (value == null || Number.isNaN(value)) {
    return "—";
  }

  return `${Math.round(value * 100)}%`;
}

export function formatCount(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function sampledDetailText(label: string, hasPartialStudentSample: boolean) {
  return hasPartialStudentSample ? `${label} from the first loaded roster page` : label;
}

export function studentStartDate(student: { membership_start_date?: string | null; created_at: string }) {
  return student.membership_start_date || student.created_at.slice(0, 10);
}

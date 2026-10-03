import { toLocalDateKey } from "./date";

export function subtractDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() - days);
  return toLocalDateKey(date);
}

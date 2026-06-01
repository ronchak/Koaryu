export function toLocalDateKey(date: Date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dateKeyToUtcMidnightMs(value: string) {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) {
    return Number.NaN;
  }

  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

export function differenceInLocalDateKeys(from: string, to: string) {
  const fromMs = dateKeyToUtcMidnightMs(from);
  const toMs = dateKeyToUtcMidnightMs(to);
  const days = Math.floor((toMs - fromMs) / MS_PER_DAY);

  return Number.isFinite(days) ? Math.max(0, days) : 0;
}

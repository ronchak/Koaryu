// Pure helpers for the Horizon dashboard: the landing page's ridge geometry
// re-sampled for a short header band, plus the greeting and the one-line brief.

export {
  HORIZON_BAND_RIDGE_PATHS,
  HORIZON_BAND_VIEWBOX,
  HORIZON_RIDGE_PATHS,
  HORIZON_VIEWBOX,
} from "../components/ui/horizon-ridges.ts";

export type DayPeriod = "morning" | "afternoon" | "evening";

export function dayPeriodForHour(hour: number): DayPeriod {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  return "evening";
}

/** First word of the display name, else the legal first name, else nothing. */
export function greetingName(
  userName: string | null | undefined,
  legalFirstName: string | null | undefined,
): string {
  const preferred = (userName ?? "").trim().split(/\s+/)[0] ?? "";
  if (preferred && !preferred.includes("@")) return preferred;
  return (legalFirstName ?? "").trim();
}

export function dashboardGreeting(period: DayPeriod | null, name: string): string {
  if (!period) return name ? `Welcome back, ${name}.` : "Welcome back.";
  return name ? `Good ${period}, ${name}.` : `Good ${period}.`;
}

/** "Saturday, October 10" for a studio business date (YYYY-MM-DD). */
export function formatDashboardDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export type HorizonWeekDay = { iso: string; weekday: string; day: number; isToday: boolean };

/** The Sunday-to-Saturday week containing a business date. */
export function horizonWeek(isoDate: string): HorizonWeekDay[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return [];
  const today = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const sunday = today - new Date(today).getUTCDay() * 86_400_000;
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(sunday + index * 86_400_000);
    return {
      iso: date.toISOString().slice(0, 10),
      weekday: weekday.format(date),
      day: date.getUTCDate(),
      isToday: date.getTime() === today,
    };
  });
}

const NUMBER_WORDS = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
];

export function countWord(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** How late a follow-up is, in the largest whole unit that reads naturally. */
export function describeFollowUpDue(followUpDate: string, today: string): string | null {
  const parse = (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  };
  const due = parse(followUpDate);
  const now = parse(today);
  if (due === null || now === null) return null;
  const days = Math.round((now - due) / 86_400_000);
  if (days < 0) return null;
  if (days === 0) return "Due today";
  if (days < 14) return `${days} ${plural(days, "day", "days")} overdue`;
  if (days < 60) {
    const weeks = Math.floor(days / 7);
    return `${weeks} weeks overdue`;
  }
  const months = Math.floor(days / 30);
  return `${months} months overdue`;
}

export type HorizonBriefInput = {
  attention: { state: string; count: number } | null;
  classes: { state: string; count: number } | null;
  promotions: { state: string; count: number } | null;
};

export type HorizonBrief = { lead: string | null; rest: string[] };

const SETTLED = new Set(["ready", "empty", "partial"]);

/** The bold first sentence and the supporting sentences under the greeting. */
export function buildHorizonBrief({
  attention,
  classes,
  promotions,
}: HorizonBriefInput): HorizonBrief {
  let lead: string | null = null;
  if (attention && SETTLED.has(attention.state)) {
    lead =
      attention.count === 0
        ? attention.state === "partial"
          ? null
          : "Nothing needs you right now."
        : `${countWord(attention.count)} ${plural(attention.count, "thing needs", "things need")} you today.`;
  }
  const rest: string[] = [];
  if (classes && (classes.state === "ready" || classes.state === "empty")) {
    rest.push(
      classes.count === 0
        ? "No classes on the schedule today."
        : `${countWord(classes.count)} ${plural(classes.count, "class", "classes")} on the schedule today.`,
    );
  }
  if (promotions && SETTLED.has(promotions.state) && promotions.count > 0) {
    rest.push(
      `${countWord(promotions.count)} ${plural(promotions.count, "student is", "students are")} ready for the next belt.`,
    );
  }
  return { lead, rest };
}

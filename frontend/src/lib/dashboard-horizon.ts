// Pure helpers for the Horizon dashboard: the landing page's ridge geometry
// re-sampled for a short header band, plus the greeting and the one-line brief.

export const HORIZON_VIEWBOX = { width: 1600, height: 300 } as const;
export const HORIZON_BAND_VIEWBOX = { width: 1600, height: 160 } as const;

type Ridge = {
  readonly baseY: number;
  readonly amplitude: number;
  readonly frequency: number;
  readonly phase: number;
};

// Same frequencies and phases as the landing's close hills (close-hills.ts),
// compressed into the bottom of a 300-unit band, far ridge first.
const HORIZON_RIDGES: readonly Ridge[] = [
  { baseY: 150, amplitude: 22, frequency: 0.9, phase: 0.4 },
  { baseY: 190, amplitude: 26, frequency: 1.2, phase: 2.1 },
  { baseY: 230, amplitude: 30, frequency: 0.8, phase: 4.3 },
  { baseY: 268, amplitude: 30, frequency: 1.1, phase: 1.2 },
  { baseY: 300, amplitude: 28, frequency: 0.7, phase: 5.6 },
];

// The page-header band: the same ridges, lower and flatter, under a short sky.
const HORIZON_BAND_RIDGES: readonly Ridge[] = [
  { baseY: 92, amplitude: 12, frequency: 0.9, phase: 0.4 },
  { baseY: 114, amplitude: 14, frequency: 1.2, phase: 2.1 },
  { baseY: 134, amplitude: 14, frequency: 0.8, phase: 4.3 },
  { baseY: 152, amplitude: 12, frequency: 1.1, phase: 1.2 },
  { baseY: 168, amplitude: 10, frequency: 0.7, phase: 5.6 },
];

type Point = readonly [number, number];

function ridgeLine(ridge: Ridge, width: number, resolution = 46): Point[] {
  const { baseY, amplitude, frequency, phase } = ridge;
  return Array.from({ length: resolution + 1 }, (_, index) => {
    const progress = index / resolution;
    return [
      -120 + progress * (width + 240),
      baseY +
        Math.sin(progress * Math.PI * 2 * frequency + phase) * amplitude +
        Math.sin(progress * Math.PI * 2 * frequency * 2.31 + phase * 1.7) * amplitude * 0.4 +
        Math.sin(progress * Math.PI * 2 * frequency * 0.57 + phase * 0.45) * amplitude * 0.72,
    ] as const;
  });
}

function smoothPath(points: readonly Point[]): string {
  const fixed = (value: number) => value.toFixed(1);
  let path = `M${fixed(points[0][0])} ${fixed(points[0][1])}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index - 1] ?? points[index];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[index + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    path += ` C${fixed(c1x)} ${fixed(c1y)} ${fixed(c2x)} ${fixed(c2y)} ${fixed(p2[0])} ${fixed(p2[1])}`;
  }
  return path;
}

function closedRidgePaths(
  ridges: readonly Ridge[],
  viewBox: { width: number; height: number },
): readonly string[] {
  return Object.freeze(
    ridges.map(
      (ridge) =>
        `${smoothPath(ridgeLine(ridge, viewBox.width))} L${viewBox.width + 120} ${viewBox.height + 40} L-120 ${viewBox.height + 40} Z`,
    ),
  );
}

/** Closed ridge outlines, far to near, filled down past the bottom edge. */
export const HORIZON_RIDGE_PATHS: readonly string[] = closedRidgePaths(
  HORIZON_RIDGES,
  HORIZON_VIEWBOX,
);

/** The compact page-header version of the same hills. */
export const HORIZON_BAND_RIDGE_PATHS: readonly string[] = closedRidgePaths(
  HORIZON_BAND_RIDGES,
  HORIZON_BAND_VIEWBOX,
);

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

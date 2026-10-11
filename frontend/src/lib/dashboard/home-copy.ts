import { getLeadNextAction } from "../../components/leads/lead-focus.ts";
import { formatClockTime } from "../../components/schedule/schedule-display.ts";
import { resolveDashboardOwnerFirstName } from "../dashboard-brief-greetings.ts";
import type { Lead } from "../../types";
import type { DashboardHomeLeadStage, DashboardHomeSetupStep } from "../../types/dashboard";
import type {
  HomeAgendaRow,
  HomeAttentionItem,
  HomeBelt,
  HomeFollowUpDue,
  HomeNewStudentRow,
  HomePromotionRow,
  HomeSentence,
  HomeSentenceClauseKind,
  HomeStudentStatus,
  HomeTone,
} from "./home-model.ts";
import { isHomeMissingStat, type HomeStatCell } from "./home-panels.ts";

/*
 * Every owner-facing string on Home, in one place so it can be read and
 * reviewed together. The wording is transcribed from D7 in
 * docs/home-rebuild-decisions.md; change it there first. The four lead
 * next-step strings are not here: they live in Leads
 * (components/leads/lead-focus.ts) and Home reuses them through
 * `getLeadNextAction`, so Home and Leads always say the same thing.
 *
 * No React, Next or store imports: Node tests import this file directly.
 * Numbers are words up to ten and digits after in sentences and row titles,
 * and digits in stat values, notes, tags and meta (D7, rule 3).
 */

const NUMBER_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
] as const;

/** Number words up to ten, digits after. "start" capitalises a word that opens a sentence. */
export function words(n: number, position: "start" | "inline" = "inline"): string {
  if (!Number.isInteger(n) || n < 0 || n >= NUMBER_WORDS.length) return digits(n);
  const word = NUMBER_WORDS[n];
  return position === "start" ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/** Digits for stat values, notes, tags and meta. */
export function digits(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : String(n);
}

/** A singular string and a plural builder, chosen by count. */
export type HomePlural = readonly [one: string, many: (n: number) => string];

export function plural(pair: HomePlural, n: number): string {
  return n === 1 ? pair[0] : pair[1](n);
}

/** `formatClockTime` on a studio-local wall-clock string: "16:00:00" reads "4:00 PM". */
export function clock(time: string): string {
  return formatClockTime(time);
}

export type HomeDayPeriod = "morning" | "afternoon" | "evening";

export const HOME_COPY = {
  header: {
    greeting: {
      named: (period: HomeDayPeriod, firstName: string) => `Good ${period}, ${firstName}.`,
      anonymous: (period: HomeDayPeriod) => `Good ${period}.`,
    },
    eyebrow: {
      date: (weekday: string, month: string, day: number) => `${weekday}, ${month} ${day}`,
      previewSuffix: " · Preview data",
    },
    actions: {
      addStudent: "Add student",
      takeAttendance: "Take attendance",
    },
  },

  // Sentence (D6 grammar)
  sentence: {
    anchor: {
      none: "No classes today",
      one: "One class today",
      many: (n: number) => `${words(n, "start")} classes today`,
    },
    quiet: {
      withClasses: (anchor: string) => `${anchor} and nothing else needs you.`,
      noClasses: "No classes today and nothing needs you.",
      // The class count is unknown and every needs input the role can see is zero.
      noAnchor: "Nothing needs you.",
    },
    join: {
      // A lone anchor, or a lone clause when the class count is unknown.
      one: (a: string) => `${a}.`,
      two: (a: string, b: string) => `${a} and ${b}.`,
      three: (a: string, b: string, c: string) => `${a}, ${b}, and ${c}.`,
    },
    clauses: {
      payments: ["one payment to chase", (n) => `${words(n)} payments to chase`],
      followUpsOverdue: ["one follow-up overdue", (n) => `${words(n)} follow-ups overdue`],
      setup: ["one setup step left", (n) => `${words(n)} setup steps left`],
      approvals: ["one promotion to approve", (n) => `${words(n)} promotions to approve`],
      followUpsToday: ["one follow-up due today", (n) => `${words(n)} follow-ups due today`],
      ready: [
        "one student ready for the next belt",
        (n) => `${words(n)} students ready for the next belt`,
      ],
      away: [
        "one student hasn't been in for two weeks",
        (n) => `${words(n)} students haven't been in for two weeks`,
      ],
      contacts: [
        "one student has no emergency contact on file",
        (n) => `${words(n)} students have no emergency contact on file`,
      ],
    } satisfies Record<HomeSentenceClauseKind, HomePlural>,
  },

  // At a glance (stats)
  stats: {
    label: "At a glance",
    // A stat the role has but the server couldn't compute (tone neutral).
    missing: { value: "—", note: "Couldn't check" },
    followUps: {
      label: "Follow-ups due",
      note: {
        overdue: [
          "Oldest 1 day overdue",
          (n) => `Oldest ${digits(n)} days overdue`,
        ] satisfies HomePlural,
        // Orchestrator ruling: overdue with no readable oldest date.
        overdueUnknown: "Overdue",
        today: "All due today",
        none: "Nothing due",
      },
    },
    promotions: {
      label: "Ready to promote",
      note: {
        approval: ["1 needs approval", (n) => `${digits(n)} need approval`] satisfies HomePlural,
        ready: "Ready when you are",
        none: "Nobody waiting",
      },
    },
    activeStudents: {
      label: "Active students",
      note: {
        trialing: ["1 trialing", (n) => `${digits(n)} trialing`] satisfies HomePlural,
        onHold: ["1 on hold", (n) => `${digits(n)} on hold`] satisfies HomePlural,
        separator: " · ",
        none: "Nobody trialing or on hold",
      },
    },
    attendance: {
      label: "Attendance",
      unit: "%",
      note: {
        filled: (filled: number, capacity: number, windowDays: number) =>
          `${digits(filled)} of ${digits(capacity)} spots · ${digits(windowDays)} days`,
        none: "No classes tracked yet",
      },
    },
  },

  // Needs attention
  attention: {
    title: "Needs attention",
    empty: { title: "All clear", detail: "Nothing needs you right now." },
    missing: { title: "Couldn't check what needs you" },
    payments: {
      title: [
        "One payment needs a look",
        (n) => `${words(n, "start")} payments need a look`,
      ] satisfies HomePlural,
      meta: "Failed, unpaid or past due",
      action: "Review",
    },
    setup: {
      title: [
        "One setup step left",
        (n) => `${words(n, "start")} setup steps left`,
      ] satisfies HomePlural,
      meta: (stepTitle: string) => `Next: ${stepTitle}`,
      action: "Continue",
      steps: {
        programs: "Name your programs",
        students: "Add your students",
        belts: "Set your belt system",
        classes: "Add your weekly classes",
        billing: "Add tuition plans",
      } satisfies Record<DashboardHomeSetupStep, string>,
    },
    away: {
      title: ["One student away", (n) => `${words(n, "start")} students away`] satisfies HomePlural,
      meta: "No check-in for two weeks or more",
      action: "See who",
    },
    contact: {
      title: [
        "No emergency contact for one student",
        (n) => `No emergency contact for ${words(n)} students`,
      ] satisfies HomePlural,
      meta: { one: "Add one on their profile", many: "Add one on each student's profile" },
      action: { profile: "Open profile", students: "Open students" },
    },
  },

  // Today's classes
  agenda: {
    title: "Today's classes",
    link: "Open schedule",
    checkedIn: ["1 checked in", (n) => `${digits(n)} checked in`] satisfies HomePlural,
    spots: ["1 spot", (n) => `${digits(n)} spots`] satisfies HomePlural,
    noCheckIns: "No check-ins",
    action: { started: "Take attendance", upcoming: "Open" },
    more: ["One more class", (n) => `${words(n, "start")} more classes`] satisfies HomePlural,
    empty: { title: "No classes today", detail: "The mat is quiet. Nothing to check in." },
    missing: { title: "Couldn't check today's classes" },
  },

  // Follow-ups panel
  followUps: {
    title: "Follow-ups",
    link: "All leads",
    tag: {
      overdue: ["1 day overdue", (n) => `${digits(n)} days overdue`] satisfies HomePlural,
      today: "Due today",
    },
    empty: { title: "No follow-ups due", detail: "Nobody to call today." },
    missing: { title: "Couldn't check follow-ups" },
  },

  // Ready to promote panel
  promotions: {
    title: "Ready to promote",
    link: "Open belt tracker",
    // Accessible text; the visible arrow is a lucide ArrowRight icon.
    belts: (from: string, to: string) => `${from} to ${to}`,
    noBelt: "No belt yet",
    classes: {
      ranked: [
        "1 class since last belt",
        (n) => `${digits(n)} classes since last belt`,
      ] satisfies HomePlural,
      unranked: ["1 class so far", (n) => `${digits(n)} classes so far`] satisfies HomePlural,
    },
    tag: { approval: "Needs approval" },
    empty: {
      title: "Nobody ready yet",
      detail: "Students show up here when they qualify for the next belt.",
    },
    missing: { title: "Couldn't check who's ready" },
  },

  // New students panel
  newStudents: {
    title: "New students",
    link: "All students",
    meta: {
      withDate: (month: string, day: number, status: string) =>
        `Started ${month} ${day} · ${status}`,
      noDate: (status: string) => status,
      // Orchestrator ruling: a start date with no status word to follow it.
      dateOnly: (month: string, day: number) => `Started ${month} ${day}`,
    },
    // Orchestrator ruling: `unknown` has no status word.
    status: {
      active: "Active",
      trialing: "Trialing",
      paused: "On hold",
      inactive: "Inactive",
      canceled: "Canceled",
      unknown: null,
    } satisfies Record<HomeStudentStatus, string | null>,
    empty: { title: "No new students yet", detail: "Students you add show up here." },
    missing: { title: "Couldn't check new students" },
  },

  // Loading (one page-level state; placeholder bands carry their real titles, no body text)
  loading: { status: "Loading Home" },

  // Error (one page-level state)
  error: {
    refresh: {
      title: "Couldn't refresh",
      detail: (time: string) => `Showing what we had as of ${time}.`,
    },
    load: { title: "Couldn't load Home", detail: "Check your connection and try again." },
    retry: "Try again",
  },

  // Edit Home (Phase 4)
  edit: {
    trigger: "Edit Home",
    title: "Edit Home",
    alwaysShown: "Always shown",
    panels: "Panels",
    band: { glance: "At a glance", attention: "Needs attention", classes: "Today's classes" },
    panel: { followUps: "Follow-ups", promotions: "Ready to promote", newStudents: "New students" },
    move: (panel: string) => `Move ${panel}`,
    show: (panel: string) => `Show ${panel}`,
    reset: "Reset to defaults",
    done: "Done",
    announce: {
      shown: (panel: string) => `${panel} shown`,
      hidden: (panel: string) => `${panel} hidden`,
      movedUp: (panel: string) => `${panel} moved up`,
      movedDown: (panel: string) => `${panel} moved down`,
      reset: "Reset to defaults",
    },
  },
} as const;

// ── Header ──────────────────────────────────────────────────────────────────

/** The greeting's part of the day: 5:00 to 11:59 morning, 12:00 to 16:59 afternoon, else evening. */
export function homeDayPeriod(hour: number): HomeDayPeriod {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  return "evening";
}

/** The studio-local hour for `now`, or null for an unusable time zone. */
export function studioHour(timezone: string, now: Date): number | null {
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" })
        .formatToParts(now)
        .find((part) => part.type === "hour")?.value,
    );
    return Number.isInteger(hour) ? hour % 24 : null;
  } catch {
    return null;
  }
}

/** First word of the display name, else the legal first name; never an email. */
export function homeFirstName(
  displayName: string | null | undefined,
  legalFirstName: string | null | undefined,
): string | null {
  return (
    resolveDashboardOwnerFirstName(displayName) ?? resolveDashboardOwnerFirstName(legalFirstName)
  );
}

/**
 * "Good morning, Ronak." on the studio clock. Call once, at the first client
 * render: the greeting never changes after it appears. An unusable time zone
 * falls back to the viewer's own clock.
 */
export function homeGreeting(input: {
  timezone: string;
  now: Date;
  displayName: string | null | undefined;
  legalFirstName: string | null | undefined;
}): string {
  const period = homeDayPeriod(studioHour(input.timezone, input.now) ?? input.now.getHours());
  const firstName = homeFirstName(input.displayName, input.legalFirstName);
  return firstName
    ? HOME_COPY.header.greeting.named(period, firstName)
    : HOME_COPY.header.greeting.anonymous(period);
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function dateKeyParts(
  dateKey: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormatPart[] | null {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).formatToParts(date);
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((entry) => entry.type === type)?.value ?? "";
}

/** "Saturday, October 10" for a studio business date (YYYY-MM-DD); "" when unreadable. */
export function homeDateLabel(dateKey: string): string {
  const parts = dateKeyParts(dateKey, { weekday: "long", month: "long", day: "numeric" });
  if (!parts) return "";
  return HOME_COPY.header.eyebrow.date(
    part(parts, "weekday"),
    part(parts, "month"),
    Number(part(parts, "day")),
  );
}

/** The eyebrow: the studio date, plus " · Preview data" in preview mode. */
export function homeEyebrow(dateKey: string, isPreview: boolean): string {
  const label = homeDateLabel(dateKey);
  if (!label) return "";
  return isPreview ? `${label}${HOME_COPY.header.eyebrow.previewSuffix}` : label;
}

/**
 * D6: the anchor plus up to two needs clauses, as one sentence. With the class
 * count unknown the first clause opens the sentence, or "Nothing needs you."
 * when every visible input is zero; with any visible input unknown it never
 * says that nothing needs you. "" when there is nothing to say.
 */
export function homeSentenceText(sentence: HomeSentence): string {
  const copy = HOME_COPY.sentence;
  const { classes } = sentence;
  const clauses = sentence.clauses.map(({ kind, count }) => plural(copy.clauses[kind], count));
  if (classes === null) {
    if (clauses.length === 0) return sentence.incomplete ? "" : copy.quiet.noAnchor;
    const first = clauses[0].charAt(0).toUpperCase() + clauses[0].slice(1);
    return clauses.length === 1 ? copy.join.one(first) : copy.join.two(first, clauses[1]);
  }
  const anchor =
    classes <= 0 ? copy.anchor.none : classes === 1 ? copy.anchor.one : copy.anchor.many(classes);
  if (clauses.length === 0) {
    if (sentence.incomplete) return copy.join.one(anchor);
    return classes <= 0 ? copy.quiet.noClasses : copy.quiet.withClasses(anchor);
  }
  if (clauses.length === 1) return copy.join.two(anchor, clauses[0]);
  return copy.join.three(anchor, clauses[0], clauses[1]);
}

// ── At a glance ─────────────────────────────────────────────────────────────

export type HomeStatCopy = {
  label: string;
  /** Undefined shows the kit's dash. */
  value?: number | string;
  unit?: string;
  note: string;
};

export function homeStatCopy(stat: HomeStatCell): HomeStatCopy {
  const copy = HOME_COPY.stats;
  if (isHomeMissingStat(stat)) {
    return { label: copy[stat.id].label, value: copy.missing.value, note: copy.missing.note };
  }
  switch (stat.id) {
    case "followUps": {
      const note = stat.note;
      return {
        label: copy.followUps.label,
        value: stat.value,
        note:
          note.kind === "overdue"
            ? note.oldestDays === null
              ? copy.followUps.note.overdueUnknown
              : plural(copy.followUps.note.overdue, note.oldestDays)
            : note.kind === "today"
              ? copy.followUps.note.today
              : copy.followUps.note.none,
      };
    }
    case "promotions": {
      const note = stat.note;
      return {
        label: copy.promotions.label,
        value: stat.value,
        note:
          note.kind === "approval"
            ? plural(copy.promotions.note.approval, note.count)
            : note.kind === "ready"
              ? copy.promotions.note.ready
              : copy.promotions.note.none,
      };
    }
    case "activeStudents": {
      const notes = copy.activeStudents.note;
      const parts = [
        stat.note.trialing > 0 ? plural(notes.trialing, stat.note.trialing) : null,
        stat.note.onHold > 0 ? plural(notes.onHold, stat.note.onHold) : null,
      ].filter((entry): entry is string => entry !== null);
      return {
        label: copy.activeStudents.label,
        value: stat.value,
        note: parts.length > 0 ? parts.join(notes.separator) : notes.none,
      };
    }
    case "attendance": {
      const note = stat.note;
      return {
        label: copy.attendance.label,
        value: stat.value ?? undefined,
        // The model's unit token "percent" renders as the kit's "%".
        unit: stat.value !== null && stat.unit === "percent" ? copy.attendance.unit : undefined,
        note:
          note.kind === "filled"
            ? copy.attendance.note.filled(note.filled, note.capacity, note.windowDays)
            : copy.attendance.note.none,
      };
    }
  }
}

// ── Needs attention ─────────────────────────────────────────────────────────

export type HomeRowCopy = { title: string; meta: string; action: string };

export function homeAttentionCopy(item: HomeAttentionItem): HomeRowCopy {
  const copy = HOME_COPY.attention;
  switch (item.kind) {
    case "payments":
      return {
        title: plural(copy.payments.title, item.count),
        meta: copy.payments.meta,
        action: copy.payments.action,
      };
    case "setup":
      return {
        title: plural(copy.setup.title, item.count),
        meta: copy.setup.meta(copy.setup.steps[item.nextStep]),
        action: copy.setup.action,
      };
    case "away":
      return {
        title: plural(copy.away.title, item.count),
        meta: copy.away.meta,
        action: copy.away.action,
      };
    case "contact":
      return {
        title: plural(copy.contact.title, item.count),
        meta: item.count === 1 ? copy.contact.meta.one : copy.contact.meta.many,
        // The action follows the link: one named student opens their profile.
        action:
          item.studentId !== null ? copy.contact.action.profile : copy.contact.action.students,
      };
  }
}

// ── Today's classes ─────────────────────────────────────────────────────────

/** D3's one count phrase for a class: meta text, a warn tag, or nothing. */
export type HomeClassCount =
  { kind: "meta"; text: string } | { kind: "tag"; text: string; tone: HomeTone } | null;

export function homeClassCount(row: HomeAgendaRow): HomeClassCount {
  const copy = HOME_COPY.agenda;
  switch (row.countKind) {
    case "checkedIn":
      return { kind: "meta", text: plural(copy.checkedIn, row.checkedIn) };
    case "spots":
      return row.capacity !== null
        ? { kind: "meta", text: plural(copy.spots, row.capacity) }
        : null;
    case "noCheckIns":
      return { kind: "tag", text: copy.noCheckIns, tone: "warn" };
    case "none":
      return null;
  }
}

export function homeClassAction(row: HomeAgendaRow): string {
  return row.action === "takeAttendance"
    ? HOME_COPY.agenda.action.started
    : HOME_COPY.agenda.action.upcoming;
}

export function homeAgendaMore(count: number): string {
  return plural(HOME_COPY.agenda.more, count);
}

// ── Error ───────────────────────────────────────────────────────────────────

/** "9:41 AM": an ISO instant on the studio clock, or null when either is unreadable. */
export function homeAsOfClock(iso: string, timezone: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const hour = part(parts, "hour");
    const minute = part(parts, "minute");
    return hour && minute ? clock(`${hour}:${minute}`) : null;
  } catch {
    return null;
  }
}

/** The refresh failure's detail; null when the time of the shown data is unreadable. */
export function homeRefreshErrorDetail(asOf: string | null, timezone: string): string | null {
  const time = asOf ? homeAsOfClock(asOf, timezone) : null;
  return time ? HOME_COPY.error.refresh.detail(time) : null;
}

// ── Follow-ups ──────────────────────────────────────────────────────────────

export function homeFollowUpTag(due: HomeFollowUpDue): { label: string; tone: HomeTone } {
  return due.kind === "overdue"
    ? { label: plural(HOME_COPY.followUps.tag.overdue, due.days), tone: "alert" }
    : { label: HOME_COPY.followUps.tag.today, tone: "warn" };
}

/** The lead's next step, in Leads' own words. A due follow-up always has a date. */
export function homeFollowUpNextStep(stage: DashboardHomeLeadStage): string {
  const lead: Pick<Lead, "stage" | "follow_up_date"> = { stage, follow_up_date: "due" };
  return getLeadNextAction(lead as Lead);
}

// ── Ready to promote ────────────────────────────────────────────────────────

export function homeBeltName(belt: HomeBelt | null): string {
  return belt ? belt.name : HOME_COPY.promotions.noBelt;
}

/** "White to Yellow": the accessible text for a belt pair. */
export function homeBeltPairLabel(row: Pick<HomePromotionRow, "from" | "to">): string {
  return HOME_COPY.promotions.belts(homeBeltName(row.from), homeBeltName(row.to));
}

export function homePromotionMeta(row: Pick<HomePromotionRow, "from" | "classesAtRank">): string {
  const classes = HOME_COPY.promotions.classes;
  return plural(row.from ? classes.ranked : classes.unranked, row.classesAtRank);
}

// ── New students ────────────────────────────────────────────────────────────

/** "Oct 3" for a YYYY-MM-DD date; null when unreadable. */
function homeShortDate(dateKey: string): { month: string; day: number } | null {
  const parts = dateKeyParts(dateKey, { month: "short", day: "numeric" });
  if (!parts) return null;
  return { month: part(parts, "month"), day: Number(part(parts, "day")) };
}

/** "Started Oct 3 · Trialing"; the date drops when unknown, the status word when unknown. */
export function homeNewStudentMeta(
  row: Pick<HomeNewStudentRow, "status" | "startedOn">,
): string | null {
  const copy = HOME_COPY.newStudents;
  const status = copy.status[row.status];
  const started = row.startedOn ? homeShortDate(row.startedOn) : null;
  if (started && status) return copy.meta.withDate(started.month, started.day, status);
  if (started) return copy.meta.dateOnly(started.month, started.day);
  return status ? copy.meta.noDate(status) : null;
}

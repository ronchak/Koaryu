import type {
  DashboardHome,
  DashboardHomeAttentionItem,
  DashboardHomeLeadStage,
  DashboardHomeSetupStep,
} from "../../types/dashboard";

/*
 * Pure mapper from the one Home payload (or its absence) to typed sections.
 * No React, Next or store imports, so Node tests import it directly. Numbers
 * stay numbers and nothing here is owner-facing copy: `home-copy.ts` turns
 * these facts into words. Every rule follows docs/home-rebuild-decisions.md.
 * A section the payload omits maps to null or is left out; only the sentence
 * reads the role, for its approval/ready choice (D6) and to tell a missing
 * section the role could see (unknown) from one it may not (absent).
 */

export type HomeStatus = "loading" | "error" | "ready";
export type HomeRole = "admin" | "front_desk" | "instructor";
export type HomeTone = "alert" | "warn" | "calm" | "neutral";

export const HOME_ROLES = [
  "admin",
  "front_desk",
  "instructor",
] as const satisfies readonly HomeRole[];

export function homeRoleClass(role: unknown): HomeRole | null {
  return (HOME_ROLES as readonly unknown[]).includes(role) ? (role as HomeRole) : null;
}

export const HOME_LINKS = {
  leads: "/leads",
  leadsOverdue: "/leads?focus=overdue",
  leadsToday: "/leads?focus=today",
  beltTrackerReady: "/belt-tracker#belt-ready-title",
  students: "/students",
  studentsActive: "/students?status=active",
  studentsAway: "/students?inactiveDays=14",
  billingInvoices: "/billing?tab=invoices",
  reports: "/reports",
  schedule: "/schedule",
} as const;

export function homeLeadHref(leadId: string): string {
  return `/leads?lead=${encodeURIComponent(leadId)}`;
}

export function homeStudentHref(studentId: string): string {
  return `/students/${encodeURIComponent(studentId)}`;
}

export function homeScheduleHref(date: string, sessionId?: string): string {
  const query = `date=${encodeURIComponent(date)}`;
  return sessionId === undefined
    ? `/schedule?${query}`
    : `/schedule?${query}&session=${encodeURIComponent(sessionId)}`;
}

// D2: setup steps in order, each with the page that completes it.
export const HOME_SETUP_STEPS = [
  { id: "programs", href: "/settings" },
  { id: "students", href: "/students/import" },
  { id: "belts", href: "/belt-tracker" },
  { id: "classes", href: "/schedule" },
  { id: "billing", href: "/billing" },
] as const satisfies readonly { id: DashboardHomeSetupStep; href: string }[];

// D1: left to right. Which of these appear is decided by the payload.
export const HOME_STAT_ORDER = ["followUps", "promotions", "activeStudents", "attendance"] as const;
export type HomeStatId = (typeof HOME_STAT_ORDER)[number];

// D2: fixed severity order; the first row is emphasised; at most six rows.
export const HOME_ATTENTION_ORDER = ["payments", "setup", "away", "contact"] as const;
export type HomeAttentionKind = (typeof HOME_ATTENTION_ORDER)[number];
export const HOME_ATTENTION_LIMIT = 6;

// D6: needs clauses in priority order; the sentence carries at most two.
export const HOME_SENTENCE_CLAUSE_ORDER = [
  "payments",
  "followUpsOverdue",
  "setup",
  "approvals",
  "followUpsToday",
  "ready",
  "away",
  "contacts",
] as const;
export type HomeSentenceClauseKind = (typeof HOME_SENTENCE_CLAUSE_ORDER)[number];
export const HOME_SENTENCE_CLAUSE_LIMIT = 2;

// D6 "Roles" column: who can see each needs clause. A clause the role can see
// whose section the payload lacks is unknown, not zero.
export const HOME_SENTENCE_CLAUSE_ROLES = {
  payments: ["admin", "front_desk"],
  followUpsOverdue: ["admin", "front_desk"],
  setup: ["admin"],
  approvals: ["admin"],
  followUpsToday: ["admin", "front_desk"],
  ready: ["admin", "instructor"],
  away: ["admin", "front_desk", "instructor"],
  contacts: ["admin", "front_desk"],
} as const satisfies Record<HomeSentenceClauseKind, readonly HomeRole[]>;

// D4 row budgets.
export const HOME_FOLLOW_UP_LIMIT = 6;
export const HOME_PROMOTION_LIMIT = 6;
export const HOME_NEW_STUDENT_LIMIT = 5;

export type HomeFollowUpsNote =
  { kind: "overdue"; oldestDays: number | null } | { kind: "today" } | { kind: "none" };
export type HomePromotionsNote =
  { kind: "approval"; count: number } | { kind: "ready" } | { kind: "none" };
export type HomeActiveStudentsNote = { trialing: number; onHold: number };
export type HomeAttendanceNote =
  { kind: "filled"; filled: number; capacity: number; windowDays: number } | { kind: "none" };

export type HomeStat =
  | { id: "followUps"; value: number; tone: HomeTone; href: string; note: HomeFollowUpsNote }
  | { id: "promotions"; value: number; tone: HomeTone; href: string; note: HomePromotionsNote }
  | {
      id: "activeStudents";
      value: number;
      tone: "neutral";
      href: string;
      note: HomeActiveStudentsNote;
    }
  | {
      id: "attendance";
      /** Rounded percent; null when no sessions or no capacity were tracked. */
      value: number | null;
      /** Present only with a value. */
      unit?: "percent";
      tone: "neutral";
      href: string;
      note: HomeAttendanceNote;
    };

type HomeAttentionBase = { count: number; tone: HomeTone; href: string; emphasized: boolean };
export type HomeAttentionItem =
  | (HomeAttentionBase & { kind: "payments" })
  | (HomeAttentionBase & { kind: "setup"; nextStep: DashboardHomeSetupStep })
  | (HomeAttentionBase & { kind: "away" })
  /** `studentId` only when exactly one student is missing a contact and the server named them. */
  | (HomeAttentionBase & { kind: "contact"; studentId: string | null });

export type HomeClassPhase = "upcoming" | "started" | "ended" | "unknown";
export type HomeClassCountKind = "checkedIn" | "spots" | "noCheckIns" | "none";
export type HomeClassAction = "takeAttendance" | "open";

export type HomeAgendaRow = {
  id: string;
  name: string;
  /** Studio-local wall-clock strings as the server sent them, for `formatClockTime`. */
  startTime: string;
  endTime: string;
  checkedIn: number;
  capacity: number | null;
  phase: HomeClassPhase;
  countKind: HomeClassCountKind;
  action: HomeClassAction;
  emphasized: boolean;
  href: string;
};

export type HomeAgenda = {
  rows: HomeAgendaRow[];
  overflow: { count: number; href: string } | null;
  total: number;
};

export type HomeFollowUpDue = { kind: "overdue"; days: number } | { kind: "today" };
export type HomeFollowUpRow = {
  id: string;
  name: string;
  due: HomeFollowUpDue;
  stage: DashboardHomeLeadStage;
  href: string;
};

export type HomeBelt = { name: string; color: string | null };
export type HomePromotionRow = {
  studentId: string;
  name: string;
  /** Null for a student with no belt yet. */
  from: HomeBelt | null;
  to: HomeBelt;
  classesAtRank: number;
  needsApproval: boolean;
  href: string;
};

export type HomeStudentStatus =
  "active" | "trialing" | "paused" | "inactive" | "canceled" | "unknown";
export type HomeNewStudentRow = {
  id: string;
  name: string;
  status: HomeStudentStatus;
  startedOn: string | null;
  href: string;
};

export type HomePanels = {
  followUps: { rows: HomeFollowUpRow[] } | null;
  promotions: { rows: HomePromotionRow[] } | null;
  newStudents: { rows: HomeNewStudentRow[] } | null;
};

export type HomeSentence = {
  /** Today's class count; null when the agenda is unknown (the sentence has no anchor). */
  classes: number | null;
  /** Known non-zero needs, highest priority first, at most two. */
  clauses: { kind: HomeSentenceClauseKind; count: number }[];
  /**
   * Present when a needs input the role can see is unknown (its section is
   * missing), so the sentence may never claim that nothing needs you.
   */
  incomplete?: true;
};

export type HomeModel = {
  status: HomeStatus;
  asOf: string | null;
  error: string | null;
  /** The server's studio business date; null without a payload. */
  today: string | null;
  /** D1 order; null without a payload. */
  stats: HomeStat[] | null;
  attention: { items: HomeAttentionItem[] } | null;
  agenda: HomeAgenda | null;
  panels: HomePanels;
  sentence: HomeSentence | null;
};

export type HomeModelState = {
  status: HomeStatus;
  payload: DashboardHome | null;
  error: string | null;
  asOf: string | null;
};

export type HomeModelInput = {
  state: HomeModelState;
  role: HomeRole | null;
  /** Studio-local minutes since midnight, or null while unknown. */
  nowMinutes: number | null;
};

const NO_PANELS: HomePanels = { followUps: null, promotions: null, newStudents: null };

export function buildHomeModel({ state, role, nowMinutes }: HomeModelInput): HomeModel {
  const base = { status: state.status, asOf: state.asOf, error: state.error };
  const payload = state.payload;
  const today = payload?.studio?.today ?? null;
  if (!payload || today === null) {
    return {
      ...base,
      today,
      stats: payload ? [] : null,
      attention: null,
      agenda: null,
      panels: NO_PANELS,
      sentence: null,
    };
  }
  const now = typeof nowMinutes === "number" && Number.isFinite(nowMinutes) ? nowMinutes : null;
  const agenda = buildAgenda(payload, today, now);
  const attention = payload.needs_attention
    ? { items: buildAttention(payload.needs_attention.items) }
    : null;
  const viewerRole = role ?? homeRoleClass(payload.viewer?.role);
  return {
    ...base,
    today,
    stats: buildStats(payload, today),
    attention,
    agenda,
    panels: {
      followUps: payload.follow_ups
        ? {
            rows: payload.follow_ups.rows.slice(0, HOME_FOLLOW_UP_LIMIT).map((row) => {
              const days = dateKeyDays(row.follow_up_date, today);
              return {
                id: row.id,
                name: joinName(row.first_name, row.last_name),
                due: days !== null && days > 0 ? { kind: "overdue", days } : { kind: "today" },
                stage: row.stage,
                href: homeLeadHref(row.id),
              };
            }),
          }
        : null,
      promotions: payload.ready_to_promote
        ? {
            rows: payload.ready_to_promote.rows.slice(0, HOME_PROMOTION_LIMIT).map((row) => ({
              studentId: row.student_id,
              name: row.name,
              from: row.from ? { name: row.from.name, color: row.from.color ?? null } : null,
              to: { name: row.to.name, color: row.to.color ?? null },
              classesAtRank: row.classes_at_rank,
              needsApproval: row.needs_approval,
              href: homeStudentHref(row.student_id),
            })),
          }
        : null,
      newStudents: payload.recent_students
        ? {
            rows: payload.recent_students.slice(0, HOME_NEW_STUDENT_LIMIT).map((row) => ({
              id: row.id,
              name: row.name,
              status: studentStatus(row.status),
              startedOn: row.started_on ?? null,
              href: homeStudentHref(row.id),
            })),
          }
        : null,
    },
    sentence: buildSentence(payload, agenda?.total ?? null, attention?.items ?? null, viewerRole),
  };
}

function buildStats(payload: DashboardHome, today: string): HomeStat[] {
  const stats = payload.stats;
  if (!stats) return [];
  const items: HomeStat[] = [];
  const followUps = stats.follow_ups;
  if (followUps) {
    const overdue = followUps.overdue_count > 0;
    const dueToday = !overdue && followUps.due_today_count > 0;
    const oldest = followUps.oldest_due_date ?? payload.follow_ups?.rows[0]?.follow_up_date;
    const oldestDays = oldest ? dateKeyDays(oldest, today) : null;
    items.push({
      id: "followUps",
      value: followUps.due_count,
      tone: overdue ? "alert" : dueToday ? "warn" : "calm",
      href: overdue ? HOME_LINKS.leadsOverdue : dueToday ? HOME_LINKS.leadsToday : HOME_LINKS.leads,
      note: overdue
        ? { kind: "overdue", oldestDays: oldestDays === null ? null : Math.max(1, oldestDays) }
        : dueToday
          ? { kind: "today" }
          : { kind: "none" },
    });
  }
  const promotions = stats.promotions;
  if (promotions) {
    const approval = promotions.needs_approval > 0;
    const ready = !approval && promotions.ready_count > 0;
    items.push({
      id: "promotions",
      value: promotions.ready_count,
      tone: approval ? "warn" : ready ? "calm" : "neutral",
      href: HOME_LINKS.beltTrackerReady,
      note: approval
        ? { kind: "approval", count: promotions.needs_approval }
        : ready
          ? { kind: "ready" }
          : { kind: "none" },
    });
  }
  const active = stats.active_students;
  if (active) {
    items.push({
      id: "activeStudents",
      value: active.active,
      tone: "neutral",
      href: HOME_LINKS.students,
      note: { trialing: active.trialing, onHold: active.on_hold },
    });
  }
  const attendance = stats.attendance;
  if (attendance) {
    const tracked = attendance.sessions > 0 && attendance.capacity > 0;
    items.push(
      tracked
        ? {
            id: "attendance",
            value: Math.round((attendance.seats_filled / attendance.capacity) * 100),
            unit: "percent",
            tone: "neutral",
            href: HOME_LINKS.reports,
            note: {
              kind: "filled",
              filled: attendance.seats_filled,
              capacity: attendance.capacity,
              windowDays: attendance.window_days,
            },
          }
        : {
            id: "attendance",
            value: null,
            tone: "neutral",
            href: HOME_LINKS.reports,
            note: { kind: "none" },
          },
    );
  }
  return items;
}

function buildAttention(source: readonly DashboardHomeAttentionItem[]): HomeAttentionItem[] {
  const byKind = new Map<HomeAttentionKind, DashboardHomeAttentionItem>();
  for (const item of source) {
    const kind = item.kind as HomeAttentionKind;
    if (HOME_ATTENTION_ORDER.includes(kind) && item.count > 0 && !byKind.has(kind)) {
      byKind.set(kind, item);
    }
  }
  const items: HomeAttentionItem[] = [];
  for (const kind of HOME_ATTENTION_ORDER) {
    const item = byKind.get(kind);
    if (!item || items.length >= HOME_ATTENTION_LIMIT) continue;
    const emphasized = items.length === 0;
    if (item.kind === "payments") {
      items.push({
        kind: "payments",
        count: item.count,
        tone: "alert",
        href: HOME_LINKS.billingInvoices,
        emphasized,
      });
    } else if (item.kind === "setup") {
      const step = HOME_SETUP_STEPS.find((candidate) => candidate.id === item.next_step);
      // A step this client has no page or words for cannot be offered.
      if (!step) continue;
      items.push({
        kind: "setup",
        count: item.count,
        tone: "warn",
        href: step.href,
        emphasized,
        nextStep: step.id,
      });
    } else if (item.kind === "away") {
      items.push({
        kind: "away",
        count: item.count,
        tone: "warn",
        href: HOME_LINKS.studentsAway,
        emphasized,
      });
    } else if (item.kind === "contact") {
      const studentId = item.count === 1 && item.student_id ? item.student_id : null;
      items.push({
        kind: "contact",
        count: item.count,
        tone: "warn",
        href: studentId ? homeStudentHref(studentId) : HOME_LINKS.studentsActive,
        emphasized,
        studentId,
      });
    }
  }
  return items;
}

function buildAgenda(
  payload: DashboardHome,
  today: string,
  nowMinutes: number | null,
): HomeAgenda | null {
  const classes = payload.classes_today;
  if (!classes) return null;
  const phases = classes.rows.map((row) =>
    classPhase(parseClockMinutes(row.start_time), parseClockMinutes(row.end_time), nowMinutes),
  );
  const emphasizedIndex = phases.findIndex((phase) => phase !== "ended");
  return {
    rows: classes.rows.map((row, index) => {
      const phase = phases[index];
      const started = phase === "started" || phase === "ended";
      const capacity = row.capacity ?? null;
      return {
        id: row.id,
        name: row.name,
        startTime: row.start_time,
        endTime: row.end_time,
        checkedIn: row.checked_in,
        capacity,
        phase,
        countKind:
          row.checked_in > 0
            ? "checkedIn"
            : started
              ? "noCheckIns"
              : capacity !== null && capacity > 0
                ? "spots"
                : "none",
        action: started ? "takeAttendance" : "open",
        emphasized: index === emphasizedIndex,
        href: homeScheduleHref(today, row.id),
      };
    }),
    overflow:
      classes.overflow > 0 ? { count: classes.overflow, href: homeScheduleHref(today) } : null,
    total: classes.total,
  };
}

/**
 * D6 with unknowns: a clause whose section is missing is dropped, and the
 * sentence is marked incomplete if the role could have seen it. With no class
 * count and no clause left, it says "Nothing needs you." only when every needs
 * input the role can see is known and zero; otherwise it is null.
 */
function buildSentence(
  payload: DashboardHome,
  classes: number | null,
  attentionItems: readonly HomeAttentionItem[] | null,
  role: HomeRole | null,
): HomeSentence | null {
  const attention = new Map((attentionItems ?? []).map((item) => [item.kind, item.count]));
  const followUps = payload.stats?.follow_ups;
  const promotions = payload.stats?.promotions;
  const overdue = followUps?.overdue_count ?? 0;
  const needsApproval = promotions?.needs_approval ?? 0;
  const attentionKnown = attentionItems !== null;
  const known: Record<HomeSentenceClauseKind, boolean> = {
    payments: attentionKnown,
    followUpsOverdue: Boolean(followUps),
    setup: attentionKnown,
    approvals: Boolean(promotions),
    followUpsToday: Boolean(followUps),
    ready: Boolean(promotions),
    away: attentionKnown,
    contacts: attentionKnown,
  };
  const counts: Record<HomeSentenceClauseKind, number> = {
    payments: attention.get("payments") ?? 0,
    followUpsOverdue: overdue,
    setup: attention.get("setup") ?? 0,
    approvals: role === "admin" ? needsApproval : 0,
    followUpsToday: overdue === 0 ? (followUps?.due_today_count ?? 0) : 0,
    ready:
      role === "instructor" || (role === "admin" && needsApproval === 0)
        ? (promotions?.ready_count ?? 0)
        : 0,
    away: attention.get("away") ?? 0,
    contacts: attention.get("contact") ?? 0,
  };
  const clauses = HOME_SENTENCE_CLAUSE_ORDER.filter((kind) => known[kind] && counts[kind] > 0)
    .slice(0, HOME_SENTENCE_CLAUSE_LIMIT)
    .map((kind) => ({ kind, count: counts[kind] }));
  // Without a role there is no telling a missing section from one the role may not see.
  const incomplete =
    role !== null &&
    HOME_SENTENCE_CLAUSE_ORDER.some(
      (kind) =>
        !known[kind] && (HOME_SENTENCE_CLAUSE_ROLES[kind] as readonly HomeRole[]).includes(role),
    );
  // No anchor and no clause: only a role whose every needs input is known may hear it is quiet.
  if (classes === null && clauses.length === 0 && (incomplete || role === null)) return null;
  return incomplete ? { classes, clauses, incomplete: true } : { classes, clauses };
}

function classPhase(start: number | null, end: number | null, now: number | null): HomeClassPhase {
  if (now === null || start === null) return "unknown";
  if (now < start) return "upcoming";
  if (end === null) return "started";
  // A class that runs past midnight ends on the next day's clock.
  return now < (end <= start ? end + 24 * 60 : end) ? "started" : "ended";
}

const CLOCK_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

function parseClockMinutes(value: string): number | null {
  const match = CLOCK_PATTERN.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) return null;
  return hours * 60 + minutes;
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole studio days from `from` to `to`, or null when either is not a YYYY-MM-DD date. */
function dateKeyDays(from: string, to: string): number | null {
  const start = dateKeyMs(from);
  const end = dateKeyMs(to);
  return start === null || end === null ? null : Math.round((end - start) / MS_PER_DAY);
}

function dateKeyMs(value: string): number | null {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? ms : null;
}

function joinName(first: string, last: string): string {
  return [first, last]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}

const STUDENT_STATUSES = ["active", "trialing", "paused", "inactive", "canceled"] as const;

function studentStatus(value: string): HomeStudentStatus {
  return (STUDENT_STATUSES as readonly string[]).includes(value)
    ? (value as HomeStudentStatus)
    : "unknown";
}

/** Studio-local minutes since midnight for `now`, or null for an unusable time zone. */
export function studioMinutesSinceMidnight(timezone: string, now: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    return (hour % 24) * 60 + minute;
  } catch {
    return null;
  }
}

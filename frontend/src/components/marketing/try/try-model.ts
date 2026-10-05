/**
 * The hands-on Koaryu miniature on /try: pure state and the rules
 * the real app uses (attendance cycles Unmarked, Present, Late, Absent; Present and
 * Late count toward the next rank; leads queue by how overdue their follow-up is).
 * No network, no storage: everything resets with the page.
 */
import type {
  BeltRank,
  DemoLead,
  DemoLeadSource,
  DemoLeadStage,
  DemoStudent,
} from "./try-content.ts";

export type Mark = "unmarked" | "present" | "late" | "absent";

export const MARK_CYCLE: readonly Mark[] = ["unmarked", "present", "late", "absent"];

export const MARK_LABELS: Readonly<Record<Mark, string>> = {
  unmarked: "Check in",
  present: "Present",
  late: "Late",
  absent: "Absent",
};

export const BELT_LABELS: Readonly<Record<BeltRank, string>> = {
  white: "White Belt",
  yellow: "Yellow Belt",
  orange: "Orange Belt",
  green: "Green Belt",
};

export const STAGES: readonly { id: DemoLeadStage; label: string }[] = [
  { id: "inquiry", label: "Inquiry" },
  { id: "trial_scheduled", label: "Trial Scheduled" },
  { id: "trial_completed", label: "Trial Completed" },
  { id: "offer_sent", label: "Offer Sent" },
  { id: "enrolled", label: "Enrolled" },
];

export const SOURCE_LABELS: Readonly<Record<DemoLeadSource, string>> = {
  walk_in: "Walk-in",
  referral: "Referral",
  social: "Social",
  search: "Search",
  website: "Website",
  other: "Other",
};

export type LeadBand = "overdue-3" | "overdue-1" | "today" | "upcoming" | "done";

export const LEAD_BANDS: readonly { id: LeadBand; label: string }[] = [
  { id: "overdue-3", label: "3–7 days overdue" },
  { id: "overdue-1", label: "1–2 days overdue" },
  { id: "today", label: "Due today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "done", label: "Unscheduled / completed" },
];

/** The demo's "today" is the class night: a Tuesday. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const TODAY = 2;

export function nextMark(mark: Mark): Mark {
  return MARK_CYCLE[(MARK_CYCLE.indexOf(mark) + 1) % MARK_CYCLE.length];
}

/** Present and Late count as attended, as in Koaryu; Absent and unmarked do not. */
export function countsTowardRank(mark: Mark): boolean {
  return mark === "present" || mark === "late";
}

export type Standing = "progress" | "approval" | "ready";

export interface StudentProgress {
  classes: number;
  required: number;
  classesMet: boolean;
  timeMet: boolean;
  standing: Standing;
}

export function studentProgress(student: DemoStudent, mark: Mark): StudentProgress {
  const classes = student.attended + (countsTowardRank(mark) ? 1 : 0);
  const classesMet = classes >= student.required;
  const timeMet = student.daysAtRank >= student.daysRequired;
  const standing: Standing =
    classesMet && timeMet ? (student.needsApproval ? "approval" : "ready") : "progress";
  return { classes, required: student.required, classesMet, timeMet, standing };
}

export interface TryState {
  marks: Readonly<Record<string, Mark>>;
  leads: readonly DemoLead[];
  /** How many leads the visitor has added; also numbers their ids. */
  added: number;
  /** The lead most recently added or moved, for a brief highlight. */
  touchedLead: string | null;
}

export type TryAction =
  | { type: "cycle"; id: string }
  | { type: "reset" }
  | { type: "addLead"; lead: NewLead }
  | { type: "moveLead"; id: string; direction: -1 | 1 };

export interface NewLead {
  name: string;
  program: string;
  source: DemoLeadSource;
  dueIn: number;
}

export function initialTryState(
  students: readonly DemoStudent[],
  leads: readonly DemoLead[],
): TryState {
  return {
    marks: Object.fromEntries(students.map((student) => [student.id, "unmarked" as Mark])),
    leads,
    added: 0,
    touchedLead: null,
  };
}

/** Builds the reducer for one roster, so Reset can return to the page's sample data. */
export function createTryReducer(students: readonly DemoStudent[], leads: readonly DemoLead[]) {
  return function tryReducer(state: TryState, action: TryAction): TryState {
    switch (action.type) {
      case "cycle": {
        if (!(action.id in state.marks)) return state;
        return {
          ...state,
          marks: { ...state.marks, [action.id]: nextMark(state.marks[action.id]) },
        };
      }
      case "reset":
        return initialTryState(students, leads);
      case "addLead": {
        const name = action.lead.name.trim().replace(/\s+/g, " ").slice(0, 40);
        if (!name) return state;
        const id = `added-${state.added + 1}`;
        const lead: DemoLead = {
          id,
          name,
          stage: "inquiry",
          program: action.lead.program,
          source: action.lead.source,
          dueIn: Math.max(0, Math.round(action.lead.dueIn)),
          owner: null,
          minor: false,
        };
        return { ...state, leads: [...state.leads, lead], added: state.added + 1, touchedLead: id };
      }
      case "moveLead": {
        const lead = state.leads.find((candidate) => candidate.id === action.id);
        if (!lead) return state;
        const index = STAGES.findIndex((stage) => stage.id === lead.stage) + action.direction;
        if (index < 0 || index >= STAGES.length) return state;
        return {
          ...state,
          leads: state.leads.map((candidate) =>
            candidate.id === action.id ? { ...candidate, stage: STAGES[index].id } : candidate,
          ),
          touchedLead: action.id,
        };
      }
    }
  };
}

export interface SessionSummary {
  present: number;
  absent: number;
  unmarked: number;
}

/** Late counts with Present, as on Koaryu's session sheet. */
export function sessionSummary(marks: Readonly<Record<string, Mark>>): SessionSummary {
  const values = Object.values(marks);
  return {
    present: values.filter(countsTowardRank).length,
    absent: values.filter((mark) => mark === "absent").length,
    unmarked: values.filter((mark) => mark === "unmarked").length,
  };
}

export function beltRegister(
  students: readonly DemoStudent[],
  marks: Readonly<Record<string, Mark>>,
): Record<Standing, number> {
  const register: Record<Standing, number> = { ready: 0, approval: 0, progress: 0 };
  for (const student of students) {
    register[studentProgress(student, marks[student.id] ?? "unmarked").standing] += 1;
  }
  return register;
}

export function leadBand(lead: DemoLead): LeadBand {
  if (lead.stage === "enrolled") return "done";
  if (lead.dueIn <= -3) return "overdue-3";
  if (lead.dueIn < 0) return "overdue-1";
  if (lead.dueIn === 0) return "today";
  return "upcoming";
}

export function leadTotals(leads: readonly DemoLead[]) {
  const open = leads.filter((lead) => lead.stage !== "enrolled");
  return {
    overdue: open.filter((lead) => lead.dueIn < 0).length,
    dueToday: open.filter((lead) => lead.dueIn === 0).length,
    unassigned: open.filter((lead) => !lead.owner).length,
    active: open.length,
    enrolled: leads.length - open.length,
  };
}

export function stageCounts(leads: readonly DemoLead[]): Record<DemoLeadStage, number> {
  const counts = Object.fromEntries(STAGES.map((stage) => [stage.id, 0])) as Record<
    DemoLeadStage,
    number
  >;
  for (const lead of leads) counts[lead.stage] += 1;
  return counts;
}

/** The same next actions Koaryu's follow-up queue shows for each stage. */
export function nextAction(stage: DemoLeadStage): string {
  switch (stage) {
    case "inquiry":
      return "Make first contact";
    case "trial_scheduled":
      return "Confirm trial attendance";
    case "trial_completed":
      return "Review trial and next step";
    case "offer_sent":
      return "Follow up on the offer";
    case "enrolled":
      return "Enrollment complete";
  }
}

export function weekday(offset: number): string {
  return WEEKDAYS[(((TODAY + offset) % 7) + 7) % 7];
}

export function followUpLabel(lead: DemoLead): string {
  if (lead.stage === "enrolled") return "No follow-up due";
  if (lead.dueIn === 0) return "Due today";
  if (lead.dueIn < 0) return `${-lead.dueIn}d overdue · ${weekday(lead.dueIn)}`;
  return `Due ${weekday(lead.dueIn)}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return `${parts[0]?.[0] ?? ""}${parts.length > 1 ? parts.at(-1)![0] : ""}`.toUpperCase();
}

export type TaskId = "mark" | "ready" | "lead";

export function tasksDone(
  state: TryState,
  students: readonly DemoStudent[],
): Record<TaskId, boolean> {
  return {
    mark: Object.values(state.marks).some((mark) => mark !== "unmarked"),
    ready: beltRegister(students, state.marks).ready > 0,
    lead: state.added > 0,
  };
}

/** What a screen reader hears after each change. */
export function describeChange(
  before: TryState,
  after: TryState,
  action: TryAction,
  students: readonly DemoStudent[],
): string {
  switch (action.type) {
    case "cycle": {
      const student = students.find((candidate) => candidate.id === action.id);
      if (!student) return "";
      const mark = after.marks[action.id];
      const was = studentProgress(student, before.marks[action.id]);
      const now = studentProgress(student, mark);
      const tally = `${now.classes} of ${now.required} classes toward ${BELT_LABELS[student.nextBelt]}.`;
      const label = mark === "unmarked" ? "unmarked" : MARK_LABELS[mark];
      const readyNote =
        now.standing === "ready" && was.standing !== "ready"
          ? ` Ready to test for ${BELT_LABELS[student.nextBelt]}.`
          : "";
      return `${student.name} ${label}. ${tally}${readyNote}`;
    }
    case "reset":
      return "Demo reset to the sample class.";
    case "addLead": {
      const lead = after.leads.at(-1);
      if (!lead || after.added === before.added) return "";
      return `Added ${lead.name} as an inquiry. ${followUpLabel(lead)}.`;
    }
    case "moveLead": {
      const lead = after.leads.find((candidate) => candidate.id === action.id);
      if (!lead) return "";
      const stage = STAGES.find((candidate) => candidate.id === lead.stage)?.label ?? "";
      return `${lead.name} moved to ${stage}. Next: ${nextAction(lead.stage)}.`;
    }
  }
}

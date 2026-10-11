import type * as ApiContracts from "../../types/generated/api-contracts";
import {
  MOCK_ATTENDANCE,
  MOCK_BELT_LADDER,
  MOCK_CLASS_TEMPLATES,
  MOCK_ELIGIBILITY,
  MOCK_LEADS,
  MOCK_SESSIONS,
  MOCK_STUDENTS,
} from "../mock-data.ts";
import { DEMO_STUDIO_NAME, MOCK_BELT_LADDERS, MOCK_PROGRAMS } from "../preview-studio-data.ts";
import { buildPreviewEligibilityForLadder } from "../preview-belt-eligibility.ts";
import { buildEligibilityGroups, isEligibilityEntryReady } from "../belt-tracker-page-model.ts";
import { buildStudentInactivityRows, isStudentOnHoldNow } from "../student-insights.ts";
import { shiftDateKey } from "../date.ts";

type DashboardHome = ApiContracts.ApiDashboardHomeResponse;

export function buildPreviewHomePayload(input: {
  today: string;
  role: "admin" | "front_desk" | "instructor";
  now?: Date;
}): DashboardHome {
  const { today, role } = input;
  const now = input.now ?? new Date();
  const checkedInBySession = new Map<string, number>();
  for (const record of MOCK_ATTENDANCE) {
    if (record.status !== "absent") {
      checkedInBySession.set(
        record.session_id,
        (checkedInBySession.get(record.session_id) ?? 0) + 1,
      );
    }
  }

  const todaySessions = MOCK_SESSIONS.filter(
    (session) => session.date === today && session.status !== "canceled",
  ).sort(
    (left, right) =>
      left.start_time.localeCompare(right.start_time) || left.id.localeCompare(right.id),
  );
  const windowStart = shiftDateKey(today, -30);
  const windowSessions = MOCK_SESSIONS.filter(
    (session) =>
      session.status !== "canceled" && session.date >= windowStart && session.date <= today,
  );
  const capacitySessions = windowSessions.filter((session) => (session.capacity ?? 0) > 0);
  // The demo studio has plans and one payment that needs attention.
  const paymentAttentionCount = 1;
  const hasPlans = true;
  const items: ApiContracts.ApiDashboardHomeNeedsAttention["items"] = [];
  if (role !== "instructor") {
    items.push({ kind: "payments", count: paymentAttentionCount });
  }

  const setupSteps: [ApiContracts.ApiDashboardHomeSetupItem["next_step"], boolean][] = [
    ["programs", MOCK_PROGRAMS.some((program) => !program.is_system && !program.archived_at)],
    ["students", MOCK_STUDENTS.length > 0],
    ["belts", MOCK_BELT_LADDERS.some((ladder) => ladder.ranks.some((rank) => !rank.is_tip))],
    [
      "classes",
      MOCK_CLASS_TEMPLATES.some((template) => template.is_active) || MOCK_SESSIONS.length > 0,
    ],
    ["billing", hasPlans],
  ];
  const incompleteSteps = setupSteps.filter(([, complete]) => !complete);
  if (role === "admin" && incompleteSteps.length > 0) {
    items.push({ kind: "setup", count: incompleteSteps.length, next_step: incompleteSteps[0][0] });
  }

  const awayCount = buildStudentInactivityRows(
    MOCK_STUDENTS,
    MOCK_SESSIONS,
    MOCK_ATTENDANCE,
    today,
  ).filter((row) => row.daysInactive >= 14).length;
  if (awayCount > 0) items.push({ kind: "away", count: awayCount });
  const missingContacts = MOCK_STUDENTS.filter(
    (student) =>
      (student.status === "active" || student.status === "trialing") &&
      (student.emergency_contact_name == null || student.emergency_contact_name === ""),
  );
  if (role !== "instructor" && missingContacts.length > 0) {
    items.push({
      kind: "contact",
      count: missingContacts.length,
      ...(missingContacts.length === 1 ? { student_id: missingContacts[0].id } : {}),
    });
  }

  const payload: DashboardHome = {
    generated_at: now.toISOString(),
    viewer: { role },
    // Preview identity and business timezone match StoreProvider; records retain
    // their local dates from mock-data so links open the same demo sessions.
    studio: { id: "preview-studio", name: DEMO_STUDIO_NAME, timezone: "UTC", today },
    needs_attention: { items: items.slice(0, 6) },
    classes_today: {
      total: todaySessions.length,
      overflow: Math.max(todaySessions.length - 5, 0),
      rows: todaySessions.slice(0, 5).map((session) => ({
        id: session.id,
        name: session.name,
        start_time: session.start_time,
        end_time: session.end_time,
        checked_in: checkedInBySession.get(session.id) ?? 0,
        capacity: session.capacity ?? null,
      })),
    },
    stats: {
      active_students: {
        total: MOCK_STUDENTS.length,
        active: MOCK_STUDENTS.filter(
          (student) => student.status === "active" || student.status === "trialing",
        ).length,
        trialing: MOCK_STUDENTS.filter((student) => student.status === "trialing").length,
        on_hold: MOCK_STUDENTS.filter((student) => isStudentOnHoldNow(student, today)).length,
      },
      attendance: {
        window_days: 30,
        sessions: windowSessions.length,
        seats_filled: capacitySessions.reduce(
          (sum, session) => sum + (checkedInBySession.get(session.id) ?? 0),
          0,
        ),
        capacity: capacitySessions.reduce((sum, session) => sum + session.capacity!, 0),
      },
    },
    recent_students: [...MOCK_STUDENTS]
      .sort(
        (left, right) =>
          right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
      )
      .slice(0, 5)
      .map((student) => ({
        id: student.id,
        name: `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`.trim(),
        status: student.status,
        started_on: student.membership_start_date || student.created_at.slice(0, 10),
      })),
  };
  const stats = payload.stats!;

  if (role !== "instructor") {
    const dueLeads = MOCK_LEADS.filter(
      (
        lead,
      ): lead is typeof lead & {
        stage: ApiContracts.ApiDashboardHomeFollowUpRow["stage"];
        follow_up_date: string;
      } =>
        lead.stage !== "enrolled" &&
        lead.stage !== "closed_lost" &&
        Boolean(lead.follow_up_date && lead.follow_up_date <= today),
    ).sort(
      (left, right) =>
        left.follow_up_date.localeCompare(right.follow_up_date) || left.id.localeCompare(right.id),
    );
    const overdueCount = dueLeads.filter((lead) => lead.follow_up_date < today).length;
    stats.follow_ups = {
      due_count: dueLeads.length,
      overdue_count: overdueCount,
      due_today_count: dueLeads.length - overdueCount,
      oldest_due_date: dueLeads[0]?.follow_up_date ?? null,
    };
    payload.follow_ups = {
      rows: dueLeads.slice(0, 6).map((lead) => ({
        id: lead.id,
        first_name: lead.first_name,
        last_name: lead.last_name,
        stage: lead.stage,
        follow_up_date: lead.follow_up_date,
      })),
    };
  }

  if (role !== "front_desk") {
    const ladder = MOCK_BELT_LADDERS[0];
    const ranks = [...(ladder?.ranks ?? [])].sort(
      (left, right) => left.display_order - right.display_order || left.id.localeCompare(right.id),
    );
    const ready = buildPreviewEligibilityForLadder({
      ladderId: ladder?.id,
      beltLadders: MOCK_BELT_LADDERS,
      beltRanks: ranks,
      students: MOCK_STUDENTS,
      seedRows: ladder?.id === MOCK_BELT_LADDER.id ? MOCK_ELIGIBILITY : [],
      nowMs: now.getTime(),
    }).filter(isEligibilityEntryReady);
    stats.promotions = {
      ready_count: ready.length,
      needs_approval: ready.filter((entry) => entry.needs_approval).length,
    };
    payload.ready_to_promote = {
      rows: buildEligibilityGroups(ready, ranks)
        .flatMap((group) => group.entries)
        .slice(0, 6)
        .map((entry) => ({
          student_id: entry.student_id,
          name: entry.student_name,
          from:
            entry.current_rank_id == null
              ? null
              : { name: entry.current_rank_name!, color: entry.current_rank_color ?? null },
          to: { name: entry.next_rank_name!, color: entry.next_rank_color ?? null },
          classes_at_rank: entry.classes_since_promo,
          needs_approval: entry.needs_approval,
        })),
    };
  }

  return payload;
}

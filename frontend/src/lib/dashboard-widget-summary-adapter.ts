export type DashboardTodayScheduleRow = {
  id: string;
  startTime: string;
  endTime: string;
  name: string;
  capacity: number | null;
  attendanceCount: number;
  expectedCount: number | null;
};

export type DashboardTodayScheduleEnrichment = {
  available: boolean;
  expectedCountsAvailable: boolean;
  rows: DashboardTodayScheduleRow[];
  overflowCount: number;
};

export type DashboardEmergencyContactsEnrichment = {
  available: boolean;
  activeStudents: number;
  completeStudents: number;
  missingStudents: number;
};

export type DashboardWidgetSummaryEnrichments = {
  todaySchedule: DashboardTodayScheduleEnrichment;
  emergencyContacts: DashboardEmergencyContactsEnrichment;
};

const unavailableTodaySchedule = (): DashboardTodayScheduleEnrichment => ({
  available: false,
  expectedCountsAvailable: false,
  rows: [],
  overflowCount: 0,
});

const unavailableEmergencyContacts = (): DashboardEmergencyContactsEnrichment => ({
  available: false,
  activeStudents: 0,
  completeStudents: 0,
  missingStudents: 0,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : nonNegativeInteger(value);
}

function parseTodaySchedule(value: unknown): DashboardTodayScheduleEnrichment {
  if (
    !isRecord(value)
    || value.available !== true
    || typeof value.expected_counts_available !== "boolean"
    || !Array.isArray(value.rows)
  ) {
    return unavailableTodaySchedule();
  }
  const expectedCountsAvailable = value.expected_counts_available === true;
  const rows: DashboardTodayScheduleRow[] = [];
  for (const candidate of value.rows.slice(0, 5)) {
    if (!isRecord(candidate)) continue;
    const attendanceCount = nonNegativeInteger(candidate.attendance_count);
    const capacity = optionalNonNegativeInteger(candidate.capacity);
    const expectedCount = optionalNonNegativeInteger(candidate.expected_count);
    if (
      typeof candidate.id !== "string"
      || typeof candidate.start_time !== "string"
      || typeof candidate.end_time !== "string"
      || typeof candidate.name !== "string"
      || attendanceCount === null
      || (candidate.capacity !== null && candidate.capacity !== undefined && capacity === null)
      || (candidate.expected_count !== null && candidate.expected_count !== undefined && expectedCount === null)
    ) {
      return unavailableTodaySchedule();
    }
    rows.push({
      id: candidate.id,
      startTime: candidate.start_time,
      endTime: candidate.end_time,
      name: candidate.name,
      capacity,
      attendanceCount,
      expectedCount: expectedCountsAvailable ? expectedCount : null,
    });
  }
  const parsedOverflowCount = optionalNonNegativeInteger(value.overflow_count);
  if (value.overflow_count !== null && value.overflow_count !== undefined && parsedOverflowCount === null) {
    return unavailableTodaySchedule();
  }
  const overflowCount = parsedOverflowCount ?? 0;
  return { available: true, expectedCountsAvailable, rows, overflowCount };
}

function parseEmergencyContacts(value: unknown): DashboardEmergencyContactsEnrichment {
  if (!isRecord(value) || value.available !== true) {
    return unavailableEmergencyContacts();
  }
  const activeStudents = nonNegativeInteger(value.active_students);
  const completeStudents = nonNegativeInteger(value.complete_students);
  const missingStudents = nonNegativeInteger(value.missing_students);
  if (
    activeStudents === null
    || completeStudents === null
    || missingStudents === null
    || completeStudents + missingStudents !== activeStudents
  ) {
    return unavailableEmergencyContacts();
  }
  return { available: true, activeStudents, completeStudents, missingStudents };
}

export function readDashboardWidgetSummaryEnrichments(
  summary: unknown
): DashboardWidgetSummaryEnrichments {
  if (!isRecord(summary)) {
    return {
      todaySchedule: unavailableTodaySchedule(),
      emergencyContacts: unavailableEmergencyContacts(),
    };
  }
  return {
    todaySchedule: parseTodaySchedule(summary.today_schedule),
    emergencyContacts: parseEmergencyContacts(summary.emergency_contacts),
  };
}

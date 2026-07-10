import type { AttendanceRecord } from "@/types";

function compareAttendanceRecency(left: AttendanceRecord, right: AttendanceRecord) {
  const leftTime = Date.parse(left.checked_in_at);
  const rightTime = Date.parse(right.checked_in_at);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const checkedInAtCompare = left.checked_in_at.localeCompare(right.checked_in_at);
  return checkedInAtCompare !== 0 ? checkedInAtCompare : left.id.localeCompare(right.id);
}

export function getLatestAttendanceRecord(records: AttendanceRecord[]) {
  let latest: AttendanceRecord | undefined;
  for (const record of records) {
    if (!latest || compareAttendanceRecency(record, latest) > 0) {
      latest = record;
    }
  }
  return latest;
}

export function buildLatestAttendanceByStudentId(records: AttendanceRecord[]) {
  const latestByStudentId = new Map<string, AttendanceRecord>();
  for (const record of records) {
    const current = latestByStudentId.get(record.student_id);
    if (!current || compareAttendanceRecency(record, current) > 0) {
      latestByStudentId.set(record.student_id, record);
    }
  }
  return latestByStudentId;
}

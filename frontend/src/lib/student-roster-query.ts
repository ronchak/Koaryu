import {
  normalizeStudentListSearch,
  type StudentListQuery,
} from "./student-list-page.ts";

export function buildStudentPagePath(query: StudentListQuery = {}): string {
  const params = new URLSearchParams();
  params.set("page_size", String(Math.min(200, Math.max(1, query.pageSize || 50))));
  params.set("sort_by", query.sortKey || "name");
  params.set("sort_dir", query.sortDir || "asc");

  const search = normalizeStudentListSearch(query.search);
  if (search) {
    params.set("search", search);
  }
  if (query.status) {
    params.set("status", query.status);
  }
  if (query.programId) {
    params.set("program_id", query.programId);
  }
  if (query.cursor) {
    params.set("cursor", query.cursor);
  } else {
    params.set("page", String(Math.max(1, query.page || 1)));
  }
  if (query.fullRoster) {
    params.set("full_roster", "1");
  }
  if (query.inactivityDays) {
    params.set("inactivity_days", String(query.inactivityDays));
  }
  if (query.newStudents) {
    params.set("new_students", query.newStudents);
  }
  if (query.today) {
    params.set("today", query.today);
  }

  return `/students?${params.toString()}`;
}

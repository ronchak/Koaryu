import type { RetainedStore } from "@/lib/retained-state";
import type { StudentRosterCursorChainEntry } from "@/lib/student-roster-pagination";
import type { Student } from "@/types";

// What the roster and student record keep between visits for one identity.
// The roster's last page lets "Back to students" show the rows it left, and the
// rows it has loaded let a student record draw its layout before its own read.

const ROSTER_SNAPSHOT_KEY = "students:roster-page";
const SUMMARIES_KEY = "students:summaries";
const MAX_SUMMARIES = 500;

export type StudentRosterSnapshot = {
  queryKey: string;
  page: number;
  cursor: string | null;
  history: Array<[number, StudentRosterCursorChainEntry]>;
  students: Student[];
  total: number;
  hasNext: boolean;
  hasPrevious: boolean;
  nextCursor: string | null;
  previousCursor: string | null;
};

export function readStudentRosterSnapshot(
  store: RetainedStore | null,
): StudentRosterSnapshot | null {
  return store?.get<StudentRosterSnapshot>(ROSTER_SNAPSHOT_KEY) ?? null;
}

export function rememberStudentRosterSnapshot(
  store: RetainedStore | null,
  snapshot: StudentRosterSnapshot,
) {
  if (!store) return;
  store.set(ROSTER_SNAPSHOT_KEY, snapshot);
  rememberStudentSummaries(store, snapshot.students);
}

export function forgetStudentRosterSnapshot(store: RetainedStore | null) {
  store?.delete(ROSTER_SNAPSHOT_KEY);
}

export function rememberStudentSummaries(store: RetainedStore | null, students: Student[]) {
  if (!store || students.length === 0) return;
  const next = new Map(store.get<Map<string, Student>>(SUMMARIES_KEY) ?? []);
  for (const student of students) {
    next.delete(student.id);
    next.set(student.id, student);
  }
  while (next.size > MAX_SUMMARIES) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  store.set(SUMMARIES_KEY, next);
}

export function readStudentSummary(store: RetainedStore | null, id: string): Student | undefined {
  return store?.get<Map<string, Student>>(SUMMARIES_KEY)?.get(id);
}

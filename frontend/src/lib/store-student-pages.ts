import { api, ApiError } from "@/lib/api";
import type { StudentListQuery } from "@/lib/student-list-page";
import { buildStudentPagePath } from "@/lib/student-roster-query";
import type {
  Student,
  StudentRosterPageResponse,
} from "@/types";

export { buildStudentPagePath } from "@/lib/student-roster-query";

export interface StudentPageRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number | null;
}

export type StudentRosterCursorRecovery = "first" | "nearest_prior";

export class StudentRosterCursorError extends Error {
  readonly code: string;
  readonly recoverTo: StudentRosterCursorRecovery;

  constructor(code: string, message: string, recoverTo: StudentRosterCursorRecovery) {
    super(message);
    this.name = "StudentRosterCursorError";
    this.code = code;
    this.recoverTo = recoverTo;
  }
}

export function decodeStudentRosterCursorError(error: unknown): StudentRosterCursorError | null {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return null;
  }

  try {
    const detail = error.detail ?? JSON.parse(error.message) as unknown;
    if (!detail || typeof detail !== "object") {
      return null;
    }

    const record = detail as Record<string, unknown>;
    if (
      typeof record.code !== "string" ||
      typeof record.message !== "string" ||
      !record.code.trim() ||
      !record.message.trim() ||
      (record.recover_to !== "first" && record.recover_to !== "nearest_prior")
    ) {
      return null;
    }

    return new StudentRosterCursorError(
      record.code,
      record.message,
      record.recover_to,
    );
  } catch {
    return null;
  }
}

export async function fetchStudentPage(
  authToken: string,
  query: StudentListQuery = {},
  options?: StudentPageRequestOptions
): Promise<StudentRosterPageResponse> {
  try {
    return await api.get<StudentRosterPageResponse>(
      buildStudentPagePath(query),
      authToken,
      options
    );
  } catch (error) {
    throw decodeStudentRosterCursorError(error) || error;
  }
}

export async function fetchAllStudents(
  authToken: string,
  options?: { timeoutMs?: number | null }
): Promise<Student[]> {
  const pageSize = 200;
  let cursor: string | null = null;
  const collected: Student[] = [];
  const seenCursors = new Set<string>();

  while (true) {
    const result = await fetchStudentPage(authToken, {
      page: 1,
      pageSize,
      fullRoster: true,
      ...(cursor ? { cursor } : {}),
    }, options);

    collected.push(...result.items);

    if (!result.has_next) {
      break;
    }

    if (!result.next_cursor || seenCursors.has(result.next_cursor)) {
      throw new Error("Student roster cursor did not make progress.");
    }
    seenCursors.add(result.next_cursor);
    cursor = result.next_cursor;
  }

  return collected;
}

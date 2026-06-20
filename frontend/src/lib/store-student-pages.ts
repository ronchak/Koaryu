import { api } from "@/lib/api";
import type { StudentListQuery } from "@/lib/student-list-page";
import type {
  Student,
  StudentListResponse,
} from "@/types";

export interface StudentPageRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number | null;
}

export function buildStudentPagePath(query: StudentListQuery = {}): string {
  const params = new URLSearchParams();
  params.set("page", String(Math.max(1, query.page || 1)));
  params.set("page_size", String(Math.min(200, Math.max(1, query.pageSize || 50))));
  params.set("sort_by", query.sortKey || "name");
  params.set("sort_dir", query.sortDir || "asc");

  const search = query.search?.trim();
  if (search) {
    params.set("search", search);
  }
  if (query.status) {
    params.set("status", query.status);
  }
  if (query.programId) {
    params.set("program_id", query.programId);
  }

  return `/students?${params.toString()}`;
}

export async function fetchStudentPage(
  authToken: string,
  query: StudentListQuery = {},
  options?: StudentPageRequestOptions
): Promise<StudentListResponse> {
  return api.get<StudentListResponse>(
    buildStudentPagePath(query),
    authToken,
    options
  );
}

export async function fetchAllStudents(
  authToken: string,
  options?: { timeoutMs?: number | null }
): Promise<Student[]> {
  const pageSize = 200;
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  const collected: Student[] = [];

  while (collected.length < total) {
    const result = await fetchStudentPage(authToken, { page, pageSize }, options);

    collected.push(...result.items);
    total = result.total;

    if (result.items.length < pageSize) {
      break;
    }

    page += 1;
  }

  return collected;
}

import type { Student, StudentListQueryContract, StudentListResponse } from "@/types";

export type StudentListSortKey = NonNullable<StudentListQueryContract["sort_by"]>;
export type StudentListSortDir = NonNullable<StudentListQueryContract["sort_dir"]>;
export type StudentRosterStatusFilter = NonNullable<StudentListQueryContract["status"]>;

export interface StudentListQuery {
  search?: string;
  status?: StudentRosterStatusFilter;
  programId?: string;
  page?: number;
  pageSize?: number;
  sortKey?: StudentListSortKey;
  sortDir?: StudentListSortDir;
}

function previewStudentListName(student: Student) {
  return `${student.legal_last_name}, ${student.preferred_name || student.legal_first_name}`.toLowerCase();
}

export function buildPreviewStudentListPage(
  students: Student[],
  query: StudentListQuery = {}
): StudentListResponse {
  const page = Math.max(1, query.page || 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize || 50));
  const search = query.search?.trim().toLowerCase() || "";
  const sortKey = query.sortKey || "name";
  const sortDir = query.sortDir || "asc";

  let list = [...students];

  if (search) {
    list = list.filter((student) => {
      const membershipNames = (student.program_memberships || [])
        .map((membership) => membership.program_name || "")
        .join(" ")
        .toLowerCase();
      return (
        student.legal_first_name.toLowerCase().includes(search) ||
        student.legal_last_name.toLowerCase().includes(search) ||
        (student.preferred_name || "").toLowerCase().includes(search) ||
        (student.email || "").toLowerCase().includes(search) ||
        (student.phone || "").toLowerCase().includes(search) ||
        membershipNames.includes(search)
      );
    });
  }

  if (query.status) {
    list = list.filter((student) => student.status === query.status);
  }

  if (query.programId) {
    list = list.filter((student) =>
      (student.program_memberships || []).some((membership) =>
        membership.program_id === query.programId &&
        membership.status !== "ended" &&
        !membership.ended_at
      ) || student.program_id === query.programId
    );
  }

  list.sort((a, b) => {
    let cmp = 0;
    if (sortKey === "name") {
      cmp = previewStudentListName(a).localeCompare(previewStudentListName(b));
    } else if (sortKey === "status") {
      cmp = a.status.localeCompare(b.status) || previewStudentListName(a).localeCompare(previewStudentListName(b));
    } else if (sortKey === "membership_start_date") {
      cmp =
        (a.membership_start_date || "").localeCompare(b.membership_start_date || "") ||
        previewStudentListName(a).localeCompare(previewStudentListName(b));
    } else {
      cmp =
        a.created_at.localeCompare(b.created_at) ||
        previewStudentListName(a).localeCompare(previewStudentListName(b));
    }

    return sortDir === "asc" ? cmp : -cmp;
  });

  const offset = (page - 1) * pageSize;
  return {
    items: list.slice(offset, offset + pageSize),
    total: list.length,
    page,
    page_size: pageSize,
  };
}

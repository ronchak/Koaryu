import type { StudentRosterStatusFilter } from "@/lib/student-list-page";
import type { Program, Student, StudentListQueryContract } from "@/types";

export type SortKey = NonNullable<StudentListQueryContract["sort_by"]>;
export type SortDir = NonNullable<StudentListQueryContract["sort_dir"]>;

export interface StudentRosterRow {
  student: Student;
  displayName: string;
  programs: Program[];
  searchFields: {
    legalFirstName: string;
    legalLastName: string;
    preferredName: string;
    email: string;
    programs: string;
  };
  contact: string;
  visibleTags: string[];
  hiddenTagCount: number;
}

interface StudentRosterFilterOptions {
  search: string;
  statusFilter: StudentRosterStatusFilter | "";
  programFilter: string;
  inactivityThreshold: number | null;
  inactivityByStudentId: ReadonlyMap<string, number>;
  newStudentStartDate: string | null;
  today: string;
  sortKey: SortKey;
  sortDir: SortDir;
  usesDerivedRosterFilters: boolean;
}

interface StudentQueryFilterInput {
  fullRosterParam: string | null;
  inactiveDaysParam: string | null;
  newStudentsParam: string | null;
  today: string;
}

interface StudentRosterModeInput {
  fullRosterRequested: boolean;
  hasNewStudentFilter: boolean;
  inactivityThreshold: number | null;
  pagedRosterEnabled: boolean;
}

interface StudentRosterLoadStateInput {
  isProgramDataLoaded: boolean;
  isStudioBootstrapSettled: boolean;
  isDerivedRosterRefreshing: boolean;
  isPagedLoading: boolean;
  page: number;
  pageSize: number;
  pagedLoadError: string | null;
  pagedLoaded: boolean;
  pagedTotal: number;
  studentsCount: number;
  studentsLoadError: string | null;
  studentsLoaded: boolean;
  studentsMayBePartial: boolean;
  usesDerivedRosterFilters: boolean;
}

export function formatDate(d?: string | null) {
  if (!d) return "\u2014";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function displayName(student: Student) {
  return `${student.legal_last_name}, ${student.preferred_name || student.legal_first_name}`;
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function subtractDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() - days);
  return toDateKey(date);
}

export function getNewStudentStartDate({
  today,
  isNewStudentYtd,
  newStudentDays,
}: {
  today: string;
  isNewStudentYtd: boolean;
  newStudentDays: number | null;
}) {
  if (isNewStudentYtd) {
    return `${today.slice(0, 4)}-01-01`;
  }

  if (newStudentDays) {
    return subtractDays(today, newStudentDays);
  }

  return null;
}

export function buildStudentQueryFilterState({
  fullRosterParam,
  inactiveDaysParam,
  newStudentsParam,
  today,
}: StudentQueryFilterInput) {
  const inactivityThreshold = Number(inactiveDaysParam || "") || null;
  const newStudentDays = Number(newStudentsParam || "") || null;
  const isNewStudentYtd = newStudentsParam === "ytd";
  const hasNewStudentFilter = Boolean(newStudentDays || isNewStudentYtd);

  return {
    fullRosterRequested: fullRosterParam === "1",
    hasNewStudentFilter,
    inactivityThreshold,
    isNewStudentYtd,
    newStudentDays,
    newStudentStartDate: getNewStudentStartDate({
      today,
      isNewStudentYtd,
      newStudentDays,
    }),
  };
}

export function shouldUseDerivedRosterFilters({
  fullRosterRequested,
  hasNewStudentFilter,
  inactivityThreshold,
  pagedRosterEnabled,
}: StudentRosterModeInput) {
  return !pagedRosterEnabled || Boolean(inactivityThreshold || hasNewStudentFilter || fullRosterRequested);
}

export function buildStudentRosterLoadState({
  isProgramDataLoaded,
  isStudioBootstrapSettled,
  isDerivedRosterRefreshing,
  isPagedLoading,
  page,
  pageSize,
  pagedLoadError,
  pagedLoaded,
  pagedTotal,
  studentsCount,
  studentsLoadError,
  studentsLoaded,
  studentsMayBePartial,
  usesDerivedRosterFilters,
}: StudentRosterLoadStateInput) {
  const isInitialRosterLoading = usesDerivedRosterFilters
    ? !studentsLoadError && (
      !isStudioBootstrapSettled ||
      !isProgramDataLoaded ||
      !studentsLoaded ||
      studentsMayBePartial ||
      isDerivedRosterRefreshing
    )
    : !isStudioBootstrapSettled || !isProgramDataLoaded || !pagedLoaded;
  const activeLoadError = usesDerivedRosterFilters ? studentsLoadError : pagedLoadError;
  const isRosterRefreshing = !usesDerivedRosterFilters && isPagedLoading && pagedLoaded;
  const visibleTotal = usesDerivedRosterFilters ? studentsCount : pagedTotal;
  const totalPages = Math.max(1, Math.ceil(pagedTotal / pageSize));
  const pageStart = pagedTotal === 0 ? 0 : (page - 1) * pageSize + 1;
  const pageEnd = Math.min(page * pageSize, pagedTotal);

  return {
    activeLoadError,
    isInitialRosterLoading,
    isRosterRefreshing,
    pageEnd,
    pageStart,
    totalPages,
    visibleTotal,
  };
}

export function parseBulkTagsInput(value: string) {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

export function withStudentRosterRefreshWarning(currentMessage: string | null) {
  const warning = "Koaryu could not refresh the visible roster automatically; refresh the page if the list looks stale.";
  return currentMessage ? `${currentMessage} ${warning}` : warning;
}

export function studentStartDate(student: Student) {
  return student.membership_start_date || student.created_at.slice(0, 10);
}

export function isCurrentStudent(student: Student) {
  return student.status === "active" || student.status === "trialing" || student.status === "paused";
}

export function buildStudentRows(students: Student[], programs: Program[]): StudentRosterRow[] {
  return students.map((student) => {
    const activeMemberships = student.program_memberships || [];
    return {
      student,
      displayName: displayName(student),
      programs: activeMemberships
        .filter((membership) => membership.status !== "ended" && !membership.ended_at)
        .map((membership) => programs.find((program) => program.id === membership.program_id))
        .filter((program): program is Program => Boolean(program)),
      searchFields: {
        legalFirstName: student.legal_first_name.toLowerCase(),
        legalLastName: student.legal_last_name.toLowerCase(),
        preferredName: student.preferred_name?.toLowerCase() || "",
        email: student.email?.toLowerCase() || "",
        programs: activeMemberships
          .map((membership) => membership.program_name || "")
          .join(" ")
          .toLowerCase(),
      },
      contact:
        student.email ||
        student.phone ||
        (student.is_minor && student.guardians[0]?.email) ||
        "\u2014",
      visibleTags: student.tags.slice(0, 2),
      hiddenTagCount: Math.max(0, student.tags.length - 2),
    };
  });
}

export function filterStudentRows(
  studentRows: StudentRosterRow[],
  {
    search,
    statusFilter,
    programFilter,
    inactivityThreshold,
    inactivityByStudentId,
    newStudentStartDate,
    today,
    sortKey,
    sortDir,
    usesDerivedRosterFilters,
  }: StudentRosterFilterOptions
) {
  let list = [...studentRows];

  if (!usesDerivedRosterFilters) {
    return list;
  }

  if (search.trim()) {
    const q = search.toLowerCase();
    list = list.filter(
      (row) =>
        row.searchFields.legalFirstName.includes(q) ||
        row.searchFields.legalLastName.includes(q) ||
        row.searchFields.preferredName.includes(q) ||
        row.searchFields.email.includes(q) ||
        row.searchFields.programs.includes(q)
    );
  }

  if (statusFilter) {
    list = list.filter((row) => row.student.status === statusFilter);
  }

  if (programFilter) {
    list = list.filter((row) =>
      (row.student.program_memberships || []).some((membership) =>
        membership.program_id === programFilter &&
        membership.status !== "ended" &&
        !membership.ended_at
      ) || row.student.program_id === programFilter
    );
  }

  if (inactivityThreshold) {
    list = list.filter(
      (row) => (inactivityByStudentId.get(row.student.id) || 0) >= inactivityThreshold
    );
  }

  if (newStudentStartDate) {
    list = list.filter((row) => {
      if (!isCurrentStudent(row.student)) {
        return false;
      }

      const startDate = studentStartDate(row.student);
      return startDate >= newStudentStartDate && startDate <= today;
    });
  }

  list.sort((a, b) => {
    let cmp = 0;
    if (sortKey === "name") {
      cmp = a.displayName.localeCompare(b.displayName);
    } else if (sortKey === "status") {
      cmp = a.student.status.localeCompare(b.student.status);
    } else if (sortKey === "membership_start_date") {
      cmp =
        (a.student.membership_start_date || "").localeCompare(
          b.student.membership_start_date || ""
        );
    } else if (sortKey === "created_at") {
      cmp = a.student.created_at.localeCompare(b.student.created_at);
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  return list;
}

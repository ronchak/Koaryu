"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { StudentRosterBulkPanel } from "@/components/students/student-roster-controls";
import { toLocalDateKey } from "@/lib/date";
import {
  buildStudentInactivityRows,
  formatInactivityDaysForRange,
} from "@/lib/student-insights";
import type { StudentRosterStatusFilter } from "@/lib/student-list-page";
import {
  buildStudentQueryFilterState,
  buildInactivityScheduleDateRange,
  buildStudentRosterLoadState,
  buildStudentRows,
  filterStudentRows,
  parseBulkTagsInput,
  shouldUseDerivedRosterFilters,
  withStudentRosterRefreshWarning,
  type SortDir,
  type SortKey,
} from "@/lib/students-page-model";
import type {
  ConfigStoreContextValue,
  ProgramsStoreContextValue,
  ScheduleStoreContextValue,
  StudentsStoreContextValue,
} from "@/lib/store-contexts";
import { hasStaffPermission } from "@/lib/staff-permissions";
import type { Student, StudentCreate, StudentStatus } from "@/types";

const STUDENTS_BOOTSTRAP_FRESH_MS = 30_000;
const STUDENTS_PAGE_SIZE = 50;
const STUDENTS_SEARCH_DEBOUNCE_MS = 250;
const PAGED_STUDENTS_ROSTER_ENABLED = process.env.NEXT_PUBLIC_STUDENTS_PAGED_ROSTER !== "false";

type StudentsPageControllerOptions = {
  config: Pick<ConfigStoreContextValue, "currentRole">;
  programsStore: Pick<
    ProgramsStoreContextValue,
    "programs" | "programsLoadError" | "programsLoaded" | "refreshPrograms"
  >;
  scheduleStore: Pick<
    ScheduleStoreContextValue,
    "attendance" | "refreshScheduleRange" | "sessions"
  >;
  studentsStore: Pick<
    StudentsStoreContextValue,
    | "addStudent"
    | "bulkAddTagsToStudents"
    | "bulkUpdateStudentStatus"
    | "deleteStudents"
    | "listStudentsPage"
    | "refreshStudents"
    | "students"
    | "studentsLastLoadedAt"
    | "studentsLoadError"
    | "studentsLoaded"
    | "studentsMayBePartial"
  >;
};

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return debounced;
}

export function useStudentsPageController({
  config,
  programsStore,
  scheduleStore,
  studentsStore,
}: StudentsPageControllerOptions) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const canManageRoster = hasStaffPermission(config.currentRole, "manage_roster_bulk");
  const { programs, programsLoadError, programsLoaded, refreshPrograms } = programsStore;
  const {
    attendance,
    refreshScheduleRange,
    sessions,
  } = scheduleStore;
  const {
    addStudent,
    bulkAddTagsToStudents,
    bulkUpdateStudentStatus,
    deleteStudents,
    listStudentsPage,
    refreshStudents,
    students,
    studentsLastLoadedAt,
    studentsLoadError,
    studentsLoaded,
    studentsMayBePartial,
  } = studentsStore;

  const today = toLocalDateKey();
  const inactiveDaysParam = searchParams.get("inactiveDays");
  const newStudentsParam = searchParams.get("newStudents");
  const fullRosterParam = searchParams.get("fullRoster");
  const {
    fullRosterRequested,
    hasNewStudentFilter,
    inactivityThreshold,
    isNewStudentYtd,
    newStudentDays,
    newStudentStartDate,
  } = useMemo(
    () =>
      buildStudentQueryFilterState({
        fullRosterParam,
        inactiveDaysParam,
        newStudentsParam,
        today,
      }),
    [fullRosterParam, inactiveDaysParam, newStudentsParam, today]
  );

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StudentRosterStatusFilter | "">("");
  const [programFilter, setProgramFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [activeBulkPanel, setActiveBulkPanel] = useState<StudentRosterBulkPanel | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isAddingTags, setIsAddingTags] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [bulkActionError, setBulkActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [bulkStatus, setBulkStatus] = useState<StudentStatus>("active");
  const [pagedStudents, setPagedStudents] = useState<Student[]>([]);
  const [pagedTotal, setPagedTotal] = useState(0);
  const [pagedLoaded, setPagedLoaded] = useState(false);
  const [pagedLoadError, setPagedLoadError] = useState<string | null>(null);
  const [isPagedLoading, setIsPagedLoading] = useState(false);
  const [isDerivedRosterRefreshing, setIsDerivedRosterRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [inactivityScheduleStatus, setInactivityScheduleStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [inactivityScheduleError, setInactivityScheduleError] = useState<string | null>(null);
  const pagedRequestSeqRef = useRef(0);
  const inactivityScheduleRequestSeqRef = useRef(0);
  const debouncedSearch = useDebouncedValue(search, STUDENTS_SEARCH_DEBOUNCE_MS);

  const usesDerivedRosterFilters = shouldUseDerivedRosterFilters({
    fullRosterRequested,
    hasNewStudentFilter,
    inactivityThreshold,
    pagedRosterEnabled: PAGED_STUDENTS_ROSTER_ENABLED,
  });
  const inactivityScheduleRange = useMemo(
    () => inactivityThreshold
      ? buildInactivityScheduleDateRange(today, inactivityThreshold)
      : null,
    [inactivityThreshold, today]
  );
  const refreshInactivitySchedule = useCallback(async () => {
    const range = inactivityScheduleRange;
    if (!range) {
      return;
    }
    const requestSequence = inactivityScheduleRequestSeqRef.current + 1;
    inactivityScheduleRequestSeqRef.current = requestSequence;
    setInactivityScheduleError(null);
    setInactivityScheduleStatus("loading");
    try {
      await refreshScheduleRange(range.startDate, range.endDate);
      if (inactivityScheduleRequestSeqRef.current === requestSequence) {
        setInactivityScheduleStatus("ready");
      }
    } catch (error) {
      if (inactivityScheduleRequestSeqRef.current === requestSequence) {
        setInactivityScheduleError(
          error instanceof Error ? error.message : "Schedule could not be loaded."
        );
        setInactivityScheduleStatus("error");
      }
      throw error;
    }
  }, [inactivityScheduleRange, refreshScheduleRange]);

  useEffect(() => {
    inactivityScheduleRequestSeqRef.current += 1;
    const timer = window.setTimeout(() => {
      if (!inactivityScheduleRange) {
        setInactivityScheduleError(null);
        setInactivityScheduleStatus("idle");
        return;
      }
      void refreshInactivitySchedule().catch((error) => {
        console.error("Failed to load inactivity schedule range", error);
      });
    }, 0);
    return () => {
      inactivityScheduleRequestSeqRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [inactivityScheduleRange, refreshInactivitySchedule]);
  const visibleStudents = usesDerivedRosterFilters ? students : pagedStudents;
  const studentRows = useMemo(
    () => buildStudentRows(visibleStudents, programs),
    [programs, visibleStudents]
  );
  const inactivityRows = useMemo(
    () =>
      inactivityThreshold
        ? buildStudentInactivityRows(students, sessions, attendance)
        : [],
    [attendance, inactivityThreshold, sessions, students]
  );
  const inactivityDaysByStudentId = useMemo(
    () => new Map(inactivityRows.map((row) => [row.student.id, row.daysInactive])),
    [inactivityRows]
  );
  const inactivityByStudentId = useMemo(
    () => new Map(inactivityRows.map((row) => [
      row.student.id,
      inactivityThreshold
        ? formatInactivityDaysForRange(row, inactivityThreshold)
        : String(row.daysInactive),
    ])),
    [inactivityRows, inactivityThreshold]
  );
  const hasActiveFilters = Boolean(search || statusFilter || programFilter || inactivityThreshold || hasNewStudentFilter);

  const loadPagedStudents = useCallback(async (options?: { signal?: AbortSignal }) => {
    const requestSeq = pagedRequestSeqRef.current + 1;
    pagedRequestSeqRef.current = requestSeq;
    setIsPagedLoading(true);
    setPagedLoadError(null);

    try {
      const result = await listStudentsPage(
        {
          search: debouncedSearch,
          ...(statusFilter ? { status: statusFilter } : {}),
          programId: programFilter,
          page,
          pageSize: STUDENTS_PAGE_SIZE,
          sortKey,
          sortDir,
        },
        { signal: options?.signal }
      );
      if (requestSeq !== pagedRequestSeqRef.current) {
        return;
      }
      const resultTotalPages = Math.max(1, Math.ceil(result.total / STUDENTS_PAGE_SIZE));
      if (result.total > 0 && page > resultTotalPages) {
        setPage(resultTotalPages);
        return;
      }
      setPagedStudents(result.items);
      setPagedTotal(result.total);
      setPagedLoaded(true);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      if (requestSeq !== pagedRequestSeqRef.current) {
        return;
      }
      setPagedLoadError(error instanceof Error ? error.message : "Failed to load students.");
      setPagedLoaded(true);
    } finally {
      if (requestSeq === pagedRequestSeqRef.current) {
        setIsPagedLoading(false);
      }
    }
  }, [
    debouncedSearch,
    listStudentsPage,
    page,
    programFilter,
    sortDir,
    sortKey,
    statusFilter,
  ]);

  useEffect(() => {
    if (!usesDerivedRosterFilters) {
      return;
    }

    if (!studentsLoaded) {
      return;
    }

    if (
      !studentsLoadError &&
      !studentsMayBePartial &&
      studentsLastLoadedAt &&
      Date.now() - studentsLastLoadedAt < STUDENTS_BOOTSTRAP_FRESH_MS
    ) {
      return;
    }

    let isActive = true;
    const timer = window.setTimeout(() => {
      setIsDerivedRosterRefreshing(true);
      void refreshStudents()
        .catch((error) => {
          console.error("Failed to refresh students page data", error);
        })
        .finally(() => {
          if (isActive) {
            setIsDerivedRosterRefreshing(false);
          }
        });
    }, 0);

    return () => {
      isActive = false;
      window.clearTimeout(timer);
    };
  }, [
    refreshStudents,
    studentsLastLoadedAt,
    studentsLoadError,
    studentsLoaded,
    studentsMayBePartial,
    usesDerivedRosterFilters,
  ]);

  useEffect(() => {
    if (usesDerivedRosterFilters) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void loadPagedStudents({ signal: controller.signal });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      pagedRequestSeqRef.current += 1;
      controller.abort();
    };
  }, [loadPagedStudents, usesDerivedRosterFilters]);

  const filtered = useMemo(() => {
    return filterStudentRows(studentRows, {
      search,
      statusFilter,
      programFilter,
      inactivityThreshold,
      inactivityByStudentId: inactivityDaysByStudentId,
      newStudentStartDate,
      today,
      sortKey,
      sortDir,
      usesDerivedRosterFilters,
    });
  }, [
    studentRows,
    search,
    statusFilter,
    programFilter,
    inactivityThreshold,
    inactivityDaysByStudentId,
    newStudentStartDate,
    today,
    sortKey,
    sortDir,
    usesDerivedRosterFilters,
  ]);

  const {
    activeLoadError,
    isInitialRosterLoading,
    isRosterRefreshing,
    pageEnd,
    pageStart,
    totalPages,
    visibleTotal,
  } = buildStudentRosterLoadState({
    programsLoadError,
    programsLoaded,
    scheduleLoadError: inactivityScheduleError,
    scheduleRequired: Boolean(inactivityThreshold),
    scheduleStatus: inactivityScheduleStatus,
    isDerivedRosterRefreshing,
    isPagedLoading,
    page,
    pageSize: STUDENTS_PAGE_SIZE,
    pagedLoadError,
    pagedLoaded,
    pagedTotal,
    studentsCount: students.length,
    studentsLoadError,
    studentsLoaded,
    studentsMayBePartial,
    usesDerivedRosterFilters,
  });

  function resetRosterPaging() {
    setPage(1);
    setSelectedIds(new Set());
    setActiveBulkPanel(null);
    setDeleteError(null);
    setBulkActionError(null);
  }

  function handleSort(key: SortKey) {
    resetRosterPaging();
    if (sortKey === key) {
      setSortDir((direction) => (direction === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const reloadVisibleRoster = useCallback(async () => {
    if (usesDerivedRosterFilters) {
      await refreshStudents();
      return;
    }

    await loadPagedStudents();
  }, [loadPagedStudents, refreshStudents, usesDerivedRosterFilters]);

  const retryRequiredStudentDatasets = useCallback(async () => {
    const requests: Promise<unknown>[] = [reloadVisibleRoster()];
    if (!programsLoaded || programsLoadError) {
      requests.push(refreshPrograms({ includeArchived: false }));
    }
    if (inactivityThreshold && inactivityScheduleStatus !== "ready") {
      requests.push(refreshInactivitySchedule());
    }
    await Promise.all(requests);
  }, [
    inactivityThreshold,
    programsLoadError,
    programsLoaded,
    refreshPrograms,
    refreshInactivitySchedule,
    reloadVisibleRoster,
    inactivityScheduleStatus,
  ]);

  async function reloadVisibleRosterAfterMutation(context: string) {
    try {
      await reloadVisibleRoster();
    } catch (error) {
      console.error(`Failed to refresh students after ${context}`, error);
      setActionMessage((current) => withStudentRosterRefreshWarning(current));
    }
  }

  function toggleSelect(id: string) {
    setDeleteError(null);
    setBulkActionError(null);
    setActionMessage(null);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      if (next.size === 0) {
        setActiveBulkPanel(null);
      }
      return next;
    });
  }

  function toggleSelectAll() {
    setDeleteError(null);
    setBulkActionError(null);
    setActionMessage(null);
    if (selectedIds.size === filtered.length) {
      setActiveBulkPanel(null);
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((row) => row.student.id)));
    }
  }

  function toggleBulkPanel(panel: StudentRosterBulkPanel) {
    setDeleteError(null);
    setBulkActionError(null);
    setActionMessage(null);
    setActiveBulkPanel((current) => (current === panel ? null : panel));
  }

  async function handleDeleteSelected() {
    if (!canManageRoster || selectedIds.size === 0) return;

    setIsDeleting(true);
    setDeleteError(null);

    try {
      const deleteCount = selectedIds.size;
      await deleteStudents(Array.from(selectedIds));
      setSelectedIds(new Set());
      setActiveBulkPanel(null);
      setActionMessage(`${deleteCount} ${deleteCount === 1 ? "student was" : "students were"} removed from the active roster.`);
      if (!usesDerivedRosterFilters && filtered.length <= deleteCount && page > 1) {
        setPage((current) => Math.max(1, current - 1));
      } else {
        await reloadVisibleRosterAfterMutation("delete");
      }
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Failed to delete selected students.");
      if (!usesDerivedRosterFilters) {
        void reloadVisibleRoster().catch((refreshError) => {
          console.error("Failed to refresh students after delete error", refreshError);
        });
      }
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleAddTags() {
    if (!canManageRoster || selectedIds.size === 0) return;

    const tags = parseBulkTagsInput(tagInput);

    if (tags.length === 0) {
      setBulkActionError("Enter at least one tag to add.");
      return;
    }

    setIsAddingTags(true);
    setBulkActionError(null);

    try {
      const result = await bulkAddTagsToStudents(Array.from(selectedIds), tags, {
        refreshMode: usesDerivedRosterFilters ? "full" : "local",
      });
      if (result.updated !== selectedIds.size) {
        setBulkActionError(
          `Added tags to ${result.updated} of ${selectedIds.size} selected students. Some students may no longer be available.`
        );
        if (!usesDerivedRosterFilters) {
          await reloadVisibleRosterAfterMutation("partial bulk tag update");
        }
        return;
      }
      setTagInput("");
      setActiveBulkPanel(null);
      setActionMessage(`Tags added to ${result.updated} ${result.updated === 1 ? "student" : "students"}.`);
      if (!usesDerivedRosterFilters) {
        await reloadVisibleRosterAfterMutation("bulk tag update");
      }
    } catch (error) {
      setBulkActionError(error instanceof Error ? error.message : "Failed to add tags.");
      if (!usesDerivedRosterFilters) {
        void reloadVisibleRoster().catch((refreshError) => {
          console.error("Failed to refresh students after bulk tag error", refreshError);
        });
      }
    } finally {
      setIsAddingTags(false);
    }
  }

  async function handleBulkStatusUpdate() {
    if (!canManageRoster || selectedIds.size === 0) return;

    setIsUpdatingStatus(true);
    setBulkActionError(null);

    try {
      const result = await bulkUpdateStudentStatus(Array.from(selectedIds), bulkStatus, {
        refreshMode: usesDerivedRosterFilters ? "full" : "local",
      });
      if (result.updated !== selectedIds.size) {
        setBulkActionError(
          `Updated ${result.updated} of ${selectedIds.size} selected students. Some students may no longer be available.`
        );
        if (!usesDerivedRosterFilters) {
          await reloadVisibleRosterAfterMutation("partial bulk status update");
        }
        return;
      }
      setActiveBulkPanel(null);
      setActionMessage(`Status changed to ${bulkStatus} for ${result.updated} ${result.updated === 1 ? "student" : "students"}.`);
      if (!usesDerivedRosterFilters) {
        await reloadVisibleRosterAfterMutation("bulk status update");
      }
    } catch (error) {
      setBulkActionError(error instanceof Error ? error.message : "Failed to update status.");
      if (!usesDerivedRosterFilters) {
        void reloadVisibleRoster().catch((refreshError) => {
          console.error("Failed to refresh students after bulk status error", refreshError);
        });
      }
    } finally {
      setIsUpdatingStatus(false);
    }
  }

  async function handleAddStudent(data: StudentCreate) {
    setIsAdding(true);
    try {
      await addStudent(data);
      setShowForm(false);
      setActionMessage("Student added to the roster.");
      if (!usesDerivedRosterFilters && page !== 1) {
        setPage(1);
      } else {
        await reloadVisibleRosterAfterMutation("student create");
      }
    } finally {
      setIsAdding(false);
    }
  }

  const allSelected = filtered.length > 0 && selectedIds.size === filtered.length;
  const selectedCount = selectedIds.size;

  return {
    contentProps: {
      actionMessage,
      activeBulkPanel,
      activeLoadError,
      allSelected,
      bulkActionError,
      bulkStatus,
      canManageRoster,
      deleteError,
      filtered,
      fullRosterRequested,
      hasActiveFilters,
      hasNewStudentFilter,
      inactivityByStudentId,
      inactivityThreshold,
      isAdding,
      isAddingTags,
      isDeleting,
      isInitialRosterLoading,
      isNewStudentYtd,
      isPagedLoading,
      isRosterRefreshing,
      isUpdatingStatus,
      newStudentDays,
      newStudentStartDate,
      onAddStudent: () => setShowForm(true),
      onAddStudentSubmit: handleAddStudent,
      onAddTags: handleAddTags,
      onBulkStatusChange: setBulkStatus,
      onBulkStatusUpdate: handleBulkStatusUpdate,
      onCancelDelete: () => {
        setActiveBulkPanel(null);
        setDeleteError(null);
      },
      onCancelStatus: () => {
        setActiveBulkPanel(null);
        setBulkActionError(null);
      },
      onCancelTags: () => {
        setActiveBulkPanel(null);
        setBulkActionError(null);
        setTagInput("");
      },
      onClearFilters: () => {
        setSearch("");
        setStatusFilter("");
        setProgramFilter("");
        resetRosterPaging();
        router.replace("/students");
      },
      onCloseStudentForm: () => setShowForm(false),
      onDeleteSelected: handleDeleteSelected,
      onDismissActionMessage: () => setActionMessage(null),
      onDismissRosterQueryNotice: () => router.push("/students"),
      onImportCsv: () => {
        if (canManageRoster) router.push("/students/import");
      },
      onNextPage: () => {
        setSelectedIds(new Set());
        setActiveBulkPanel(null);
        setPage((current) => Math.min(totalPages, current + 1));
      },
      onOpenStudent: (studentId: string) => router.push(`/students/${studentId}`),
      onPreviousPage: () => {
        setSelectedIds(new Set());
        setActiveBulkPanel(null);
        setPage((current) => Math.max(1, current - 1));
      },
      onProgramFilterChange: (value: string) => {
        setProgramFilter(value);
        resetRosterPaging();
      },
      onRetryRosterLoad: () => {
        void retryRequiredStudentDatasets().catch((error) => {
          console.error("Failed to retry student roster load", error);
        });
      },
      onSearchChange: (value: string) => {
        setSearch(value);
        resetRosterPaging();
      },
      onSort: handleSort,
      onStatusFilterChange: (value: StudentRosterStatusFilter | "") => {
        setStatusFilter(value);
        resetRosterPaging();
      },
      onTagInputChange: setTagInput,
      onToggleBulkPanel: toggleBulkPanel,
      onToggleSelect: toggleSelect,
      onToggleSelectAll: toggleSelectAll,
      page,
      pageEnd,
      pageStart,
      pagedTotal,
      programFilter,
      programs,
      search,
      selectedCount,
      selectedIds,
      showForm,
      sortDir,
      sortKey,
      statusFilter,
      studentsCount: students.length,
      tagInput,
      totalPages,
      usesDerivedRosterFilters,
      visibleTotal,
    },
  };
}

export type StudentsPageController = ReturnType<typeof useStudentsPageController>;

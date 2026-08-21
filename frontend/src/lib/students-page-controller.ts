"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { StudentRosterBulkPanel } from "@/components/students/student-roster-controls";
import { toLocalDateKey } from "@/lib/date";
import {
  buildStudentInactivityRows,
  formatInactivityDaysForRange,
} from "@/lib/student-insights";
import {
  StudentRosterCursorError,
} from "@/lib/store-student-pages";
import { buildStudentPagePath } from "@/lib/student-roster-query";
import {
  hasStudentRosterSearchChanged,
  normalizeStudentListSearch,
  shouldScheduleStudentRosterSearch,
  type StudentListQuery,
  type StudentRosterNewStudentWindow,
  type StudentRosterStatusFilter,
} from "@/lib/student-list-page";
import {
  chooseStudentRosterRecoveryTarget,
  isStudentRosterRequestCurrent,
  MAX_STUDENT_ROSTER_CURSOR_RECOVERY_ATTEMPTS,
  type StudentRosterCursorChainEntry,
} from "@/lib/student-roster-pagination";
import {
  buildServerInactivityByStudentId,
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
  StudioStoreContextValue,
} from "@/lib/store-contexts";
import { hasStaffPermission } from "@/lib/staff-permissions";
import type {
  Student,
  StudentCreate,
  StudentRosterPageResponse,
  StudentStatus,
} from "@/types";

const STUDENTS_BOOTSTRAP_FRESH_MS = 30_000;
const STUDENTS_PAGE_SIZE = 50;
const STUDENTS_SEARCH_DEBOUNCE_MS = 250;
const PAGED_STUDENTS_ROSTER_ENABLED = process.env.NEXT_PUBLIC_STUDENTS_PAGED_ROSTER !== "false";

type StudentsPageControllerOptions = {
  config: Pick<ConfigStoreContextValue, "currentRole" | "isPreviewMode" | "token">;
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
  studioStore: Pick<StudioStoreContextValue, "currentStudioId">;
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
  studioStore,
}: StudentsPageControllerOptions) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const canManageRoster = hasStaffPermission(config.currentRole, "manage_roster_bulk");
  const canCreateStudents = hasStaffPermission(config.currentRole, "create_students");
  const { currentStudioId } = studioStore;
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
  const [pageRequestNonce, setPageRequestNonce] = useState(0);
  const [inactivityScheduleStatus, setInactivityScheduleStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [inactivityScheduleError, setInactivityScheduleError] = useState<string | null>(null);
  const pagedRequestSeqRef = useRef(0);
  const pagedAbortControllerRef = useRef<AbortController | null>(null);
  const pagedQueryKeyRef = useRef("");
  const cursorHistoryRef = useRef(new Map<number, StudentRosterCursorChainEntry>());
  const pageRef = useRef(1);
  const pagedCursorRef = useRef<string | null>(null);
  const [pagedHasNext, setPagedHasNext] = useState(false);
  const [pagedHasPrevious, setPagedHasPrevious] = useState(false);
  const [pagedNextCursor, setPagedNextCursor] = useState<string | null>(null);
  const [pagedPreviousCursor, setPagedPreviousCursor] = useState<string | null>(null);
  const inactivityScheduleRequestSeqRef = useRef(0);
  const normalizedSearch = normalizeStudentListSearch(search);
  const lastInputNormalizedSearchRef = useRef(normalizedSearch);
  const debouncedSearch = useDebouncedValue(
    normalizedSearch,
    STUDENTS_SEARCH_DEBOUNCE_MS,
  );

  const usesDerivedRosterFilters = shouldUseDerivedRosterFilters({
    fullRosterRequested,
    hasNewStudentFilter,
    inactivityThreshold,
    pagedRosterEnabled: PAGED_STUDENTS_ROSTER_ENABLED,
    isPreviewMode: config.isPreviewMode,
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
      await refreshScheduleRange(range.startDate, range.endDate, "read");
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
      if (!inactivityScheduleRange || !usesDerivedRosterFilters || config.isPreviewMode) {
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
  }, [config.isPreviewMode, inactivityScheduleRange, refreshInactivitySchedule, usesDerivedRosterFilters]);
  const visibleStudents = usesDerivedRosterFilters ? students : pagedStudents;
  const studentRows = useMemo(
    () => buildStudentRows(visibleStudents, programs),
    [programs, visibleStudents]
  );
  const inactivityRows = useMemo(
    () =>
      inactivityThreshold && usesDerivedRosterFilters
        ? buildStudentInactivityRows(students, sessions, attendance)
        : [],
    [attendance, inactivityThreshold, sessions, students, usesDerivedRosterFilters]
  );
  const localInactivityDaysByStudentId = useMemo(
    () => new Map(inactivityRows.map((row) => [row.student.id, row.daysInactive])),
    [inactivityRows]
  );
  const localInactivityByStudentId = useMemo(
    () => new Map(inactivityRows.map((row) => [
      row.student.id,
      inactivityThreshold
        ? formatInactivityDaysForRange(row, inactivityThreshold)
        : String(row.daysInactive),
    ])),
    [inactivityRows, inactivityThreshold]
  );
  const serverInactivityByStudentId = useMemo(
    () => buildServerInactivityByStudentId(visibleStudents, inactivityThreshold),
    [inactivityThreshold, visibleStudents]
  );
  const inactivityDaysByStudentId = useMemo(() => usesDerivedRosterFilters
    ? localInactivityDaysByStudentId
    : new Map(
      Array.from(serverInactivityByStudentId.entries()).map(([studentId, value]) => [
        studentId,
        Number.parseInt(value, 10) || 0,
      ])
    ), [localInactivityDaysByStudentId, serverInactivityByStudentId, usesDerivedRosterFilters]);
  const inactivityByStudentId = useMemo(() => usesDerivedRosterFilters
    ? localInactivityByStudentId
    : serverInactivityByStudentId, [localInactivityByStudentId, serverInactivityByStudentId, usesDerivedRosterFilters]);
  const hasActiveFilters = Boolean(search || statusFilter || programFilter || inactivityThreshold || hasNewStudentFilter);

  const newStudents = useMemo<StudentRosterNewStudentWindow | undefined>(() => {
    if (isNewStudentYtd) {
      return "ytd";
    }
    return newStudentDays ? String(newStudentDays) as StudentRosterNewStudentWindow : undefined;
  }, [isNewStudentYtd, newStudentDays]);
  const liveRosterQuery = useMemo<StudentListQuery>(() => ({
    search: debouncedSearch,
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(programFilter ? { programId: programFilter } : {}),
    page: 1,
    pageSize: STUDENTS_PAGE_SIZE,
    sortKey,
    sortDir,
    fullRoster: fullRosterRequested,
    ...(inactivityThreshold
      ? { inactivityDays: inactivityThreshold as 14 | 30 | 90 }
      : {}),
    ...(newStudents ? { newStudents } : {}),
    today,
  }), [
    debouncedSearch,
    fullRosterRequested,
    inactivityThreshold,
    newStudents,
    programFilter,
    sortDir,
    sortKey,
    statusFilter,
    today,
  ]);
  const liveRosterQueryKey = useMemo(
    () => JSON.stringify({
      auth: config.token ? "authenticated" : "signed-out",
      path: buildStudentPagePath(liveRosterQuery),
      studio: currentStudioId,
    }),
    [config.token, currentStudioId, liveRosterQuery]
  );
  const buildRosterPageQuery = useCallback(
    (requestedPage: number, requestedCursor: string | null): StudentListQuery => ({
      ...liveRosterQuery,
      page: requestedPage,
      ...(requestedCursor ? { cursor: requestedCursor } : { cursor: null }),
    }),
    [liveRosterQuery]
  );

  const resetRosterPaging = useCallback(() => {
    pagedAbortControllerRef.current?.abort();
    pagedAbortControllerRef.current = null;
    pagedRequestSeqRef.current += 1;
    pagedQueryKeyRef.current = "";
    cursorHistoryRef.current.clear();
    pageRef.current = 1;
    pagedCursorRef.current = null;
    setPage(1);
    setIsPagedLoading(false);
    setPagedLoadError(null);
    setPagedHasNext(false);
    setPagedHasPrevious(false);
    setPagedNextCursor(null);
    setPagedPreviousCursor(null);
    setSelectedIds(new Set());
    setActiveBulkPanel(null);
    setDeleteError(null);
    setBulkActionError(null);
  }, []);

  const requestRosterPage = useCallback((requestedPage: number, requestedCursor: string | null) => {
    pageRef.current = requestedPage;
    pagedCursorRef.current = requestedCursor;
    setPage(requestedPage);
    setIsPagedLoading(true);
    setPagedLoadError(null);
    setSelectedIds(new Set());
    setActiveBulkPanel(null);
    setDeleteError(null);
    setBulkActionError(null);
    setPageRequestNonce((current) => current + 1);
  }, []);

  const loadPagedStudents = useCallback(async (options?: {
    recoverEmpty?: boolean;
    signal?: AbortSignal;
  }) => {
    if (usesDerivedRosterFilters) {
      return;
    }

    const requestSeq = pagedRequestSeqRef.current + 1;
    pagedRequestSeqRef.current = requestSeq;
    const requestQueryKey = liveRosterQueryKey;
    pagedQueryKeyRef.current = requestQueryKey;
    const requestController = new AbortController();
    pagedAbortControllerRef.current = requestController;
    const abortFromCaller = () => requestController.abort();
    if (options?.signal?.aborted) {
      abortFromCaller();
    } else {
      options?.signal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    setIsPagedLoading(true);
    setPagedLoadError(null);

    let requestedPage = pageRef.current;
    let requestedCursor = pagedCursorRef.current;
    const attemptedPageOrdinals = new Set<number>();
    let recoveryAttempts = 0;
    const isCurrentRequest = () => isStudentRosterRequestCurrent({
      activeQueryKey: pagedQueryKeyRef.current,
      activeRequestSequence: pagedRequestSeqRef.current,
      authCurrent: !requestController.signal.aborted,
      requestQueryKey,
      requestSequence: requestSeq,
    });

    try {
      while (true) {
        attemptedPageOrdinals.add(requestedPage);

        let result: StudentRosterPageResponse;
        try {
          result = await listStudentsPage(
            buildRosterPageQuery(requestedPage, requestedCursor),
            { signal: requestController.signal }
          );
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            return;
          }
          if (!isCurrentRequest()) {
            return;
          }

          if (error instanceof StudentRosterCursorError) {
            const recoveryTarget = chooseStudentRosterRecoveryTarget({
              attemptedPageOrdinals,
              failedPageOrdinal: requestedPage,
              history: cursorHistoryRef.current,
              maxAttempts: MAX_STUDENT_ROSTER_CURSOR_RECOVERY_ATTEMPTS,
              recoverTo: error.recoverTo,
            });
            if (recoveryTarget) {
              recoveryAttempts += 1;
              requestedPage = recoveryTarget.pageOrdinal;
              requestedCursor = recoveryTarget.cursor;
              continue;
            }
          }

          throw error;
        }

        if (!isCurrentRequest()) {
          return;
        }

        if (options?.recoverEmpty && requestedPage > 1 && result.items.length === 0) {
          const recoveryTarget = chooseStudentRosterRecoveryTarget({
            attemptedPageOrdinals,
            failedPageOrdinal: requestedPage,
            history: cursorHistoryRef.current,
            maxAttempts: MAX_STUDENT_ROSTER_CURSOR_RECOVERY_ATTEMPTS,
            recoverTo: "nearest_prior",
          });
          if (recoveryTarget && recoveryAttempts < MAX_STUDENT_ROSTER_CURSOR_RECOVERY_ATTEMPTS) {
            recoveryAttempts += 1;
            requestedPage = recoveryTarget.pageOrdinal;
            requestedCursor = recoveryTarget.cursor;
            continue;
          }
        }

        const nextCursor = result.has_next ? result.next_cursor ?? null : null;
        const previousCursor = result.has_previous ? result.previous_cursor ?? null : null;
        cursorHistoryRef.current.set(result.page_ordinal, {
          nextCursor,
          pageOrdinal: result.page_ordinal,
          previousCursor,
          requestCursor: requestedCursor,
        });
        for (const knownPage of cursorHistoryRef.current.keys()) {
          if (knownPage > result.page_ordinal) {
            cursorHistoryRef.current.delete(knownPage);
          }
        }

        pageRef.current = result.page_ordinal;
        pagedCursorRef.current = requestedCursor;
        setPage(result.page_ordinal);
        setPagedNextCursor(nextCursor);
        setPagedPreviousCursor(previousCursor);
        setPagedHasNext(Boolean(nextCursor) && result.has_next);
        setPagedHasPrevious(Boolean(previousCursor) && result.has_previous);
        setPagedStudents(result.items);
        setPagedTotal(result.total);
        setPagedLoaded(true);
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      if (!isCurrentRequest()) {
        return;
      }
      setPagedLoadError(error instanceof Error ? error.message : "Failed to load students.");
      setPagedLoaded(true);
    } finally {
      options?.signal?.removeEventListener("abort", abortFromCaller);
      if (pagedAbortControllerRef.current === requestController) {
        pagedAbortControllerRef.current = null;
      }
      if (isCurrentRequest()) {
        setIsPagedLoading(false);
      }
    }
  }, [
    buildRosterPageQuery,
    listStudentsPage,
    liveRosterQueryKey,
    usesDerivedRosterFilters,
  ]);

  useEffect(() => {
    if (!usesDerivedRosterFilters || config.isPreviewMode) {
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
    config.isPreviewMode,
    refreshStudents,
    studentsLastLoadedAt,
    studentsLoadError,
    studentsLoaded,
    studentsMayBePartial,
    usesDerivedRosterFilters,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => resetRosterPaging(), 0);
    return () => window.clearTimeout(timer);
  }, [
    config.token,
    currentStudioId,
    fullRosterParam,
    inactiveDaysParam,
    newStudentsParam,
    resetRosterPaging,
    today,
    usesDerivedRosterFilters,
  ]);

  useEffect(() => {
    if (usesDerivedRosterFilters) {
      return;
    }
    if (!shouldScheduleStudentRosterSearch(normalizedSearch, debouncedSearch)) {
      return;
    }

    const timer = window.setTimeout(() => {
      void loadPagedStudents();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      pagedRequestSeqRef.current += 1;
      pagedAbortControllerRef.current?.abort();
    };
  }, [
    loadPagedStudents,
    liveRosterQueryKey,
    normalizedSearch,
    pageRequestNonce,
    debouncedSearch,
    usesDerivedRosterFilters,
  ]);

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
    scheduleRequired: Boolean(inactivityThreshold && usesDerivedRosterFilters),
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

  function handleSort(key: SortKey) {
    resetRosterPaging();
    if (sortKey === key) {
      setSortDir((direction) => (direction === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const reloadVisibleRoster = useCallback(async (options?: {
    recoverEmpty?: boolean;
  }) => {
    if (usesDerivedRosterFilters) {
      await refreshStudents();
      return;
    }

    await loadPagedStudents(options);
  }, [loadPagedStudents, refreshStudents, usesDerivedRosterFilters]);

  const retryRequiredStudentDatasets = useCallback(async () => {
    const requests: Promise<unknown>[] = [reloadVisibleRoster()];
    if (!programsLoaded || programsLoadError) {
      requests.push(refreshPrograms({ includeArchived: false }));
    }
    if (
      inactivityThreshold &&
      usesDerivedRosterFilters &&
      !config.isPreviewMode &&
      inactivityScheduleStatus !== "ready"
    ) {
      requests.push(refreshInactivitySchedule());
    }
    await Promise.all(requests);
  }, [
    config.isPreviewMode,
    inactivityThreshold,
    programsLoadError,
    programsLoaded,
    refreshPrograms,
    refreshInactivitySchedule,
    reloadVisibleRoster,
    inactivityScheduleStatus,
    usesDerivedRosterFilters,
  ]);

  async function reloadVisibleRosterAfterMutation(context: string) {
    try {
      await reloadVisibleRoster({ recoverEmpty: !usesDerivedRosterFilters });
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
      await reloadVisibleRosterAfterMutation("delete");
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Failed to archive selected students.");
      if (!usesDerivedRosterFilters) {
        void reloadVisibleRoster({ recoverEmpty: true }).catch((refreshError) => {
          console.error("Failed to refresh students after archive error", refreshError);
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
        void reloadVisibleRoster({ recoverEmpty: true }).catch((refreshError) => {
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
        void reloadVisibleRoster({ recoverEmpty: true }).catch((refreshError) => {
          console.error("Failed to refresh students after bulk status error", refreshError);
        });
      }
    } finally {
      setIsUpdatingStatus(false);
    }
  }

  async function handleAddStudent(data: StudentCreate) {
    if (!canCreateStudents) return;
    setIsAdding(true);
    try {
      await addStudent(data);
      setShowForm(false);
      setActionMessage("Student added to the roster.");
      await reloadVisibleRosterAfterMutation("student create");
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
      canCreateStudents,
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
      onAddStudent: () => {
        if (canCreateStudents) setShowForm(true);
      },
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
        lastInputNormalizedSearchRef.current = "";
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
        if (usesDerivedRosterFilters || isPagedLoading || !pagedHasNext || !pagedNextCursor) {
          return;
        }
        requestRosterPage(pageRef.current + 1, pagedNextCursor);
      },
      onOpenStudent: (studentId: string) => router.push(`/students/${studentId}`),
      onPreviousPage: () => {
        if (usesDerivedRosterFilters || isPagedLoading || !pagedHasPrevious || !pagedPreviousCursor) {
          return;
        }
        requestRosterPage(Math.max(1, pageRef.current - 1), pagedPreviousCursor);
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
        const previousNormalizedSearch = lastInputNormalizedSearchRef.current;
        const nextNormalizedSearch = normalizeStudentListSearch(value);
        lastInputNormalizedSearchRef.current = nextNormalizedSearch;
        setSearch(value);
        if (hasStudentRosterSearchChanged(previousNormalizedSearch, nextNormalizedSearch)) {
          resetRosterPaging();
        }
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
      hasNextPage: pagedHasNext,
      hasPreviousPage: pagedHasPrevious,
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

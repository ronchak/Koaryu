"use client";

import { useResumeRefresh } from "@/lib/use-resume-refresh";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  consumeRosterReturn,
  loadRosterReturn,
  saveRosterReturn,
  safeStudentsReturn,
} from "@/lib/student-roster-location";
import { useRouter, useSearchParams } from "next/navigation";
import type { StudentRosterBulkPanel } from "@/components/students/student-roster-controls";
import { buildStudentInactivityRows, formatInactivityDaysForRange } from "@/lib/student-insights";
import { StudentRosterCursorError } from "@/lib/store-student-pages";
import { buildStudentPagePath } from "@/lib/student-roster-query";
import { useRetainedStore } from "@/lib/retained-state";
import { prefetchRecordRoute } from "@/lib/route-prefetch";
import {
  readStudentRosterSnapshot,
  rememberStudentRosterSnapshot,
} from "@/lib/student-retained-data";
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
import type { Student, StudentCreate, StudentRosterPageResponse, StudentStatus } from "@/types";

const STUDENTS_BOOTSTRAP_FRESH_MS = 30_000;
const STUDENTS_PAGE_SIZE = 50;
const STUDENTS_SEARCH_DEBOUNCE_MS = 250;
const PAGED_STUDENTS_ROSTER_ENABLED = process.env.NEXT_PUBLIC_STUDENTS_PAGED_ROSTER !== "false";

type StudentsPageControllerOptions = {
  config: Pick<ConfigStoreContextValue, "businessDate" | "currentRole" | "isPreviewMode" | "token">;
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
  studioStore: Pick<
    StudioStoreContextValue,
    "currentStudioId" | "identityGeneration" | "currentUserId"
  >;
};

// One bulk roster write owns the selection, panel and payload until it settles.
type StudentRosterBulkCommand =
  | { kind: "delete"; ids: string[]; scope: string }
  | { kind: "tags"; ids: string[]; tags: string[]; scope: string }
  | { kind: "status"; ids: string[]; status: StudentStatus; scope: string };

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
  const { currentStudioId, identityGeneration } = studioStore;
  const { programs, programsLoadError, programsLoaded, refreshPrograms } = programsStore;
  const { attendance, refreshScheduleRange, sessions } = scheduleStore;
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

  const today = config.businessDate;
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
    [fullRosterParam, inactiveDaysParam, newStudentsParam, today],
  );

  const returnScope = `${studioStore.currentUserId}:${currentStudioId}:${config.currentRole}:${identityGeneration}`;
  const currentRosterScope = useRef<string | null>(returnScope);
  useEffect(() => {
    currentRosterScope.current = returnScope;
    return () => {
      if (currentRosterScope.current === returnScope) currentRosterScope.current = null;
    };
  }, [returnScope]);
  const retainedStore = useRetainedStore();
  const [initialReturn] = useState(() =>
    loadRosterReturn(returnScope, safeStudentsReturn(`/students?${searchParams}`)),
  );
  const initialReturnRef = useRef(initialReturn);
  const [search, setSearch] = useState(() => (searchParams.get("q") ?? "").slice(0, 200));
  const [statusFilter, setStatusFilter] = useState<StudentRosterStatusFilter | "">(() =>
    ["active", "trialing", "inactive", "paused", "canceled"].includes(
      searchParams.get("status") ?? "",
    )
      ? (searchParams.get("status") as StudentRosterStatusFilter)
      : "",
  );
  const [programFilter, setProgramFilter] = useState(() =>
    (searchParams.get("program") ?? "").slice(0, 100),
  );
  const [sortKey, setSortKey] = useState<SortKey>(() =>
    ["name", "status", "membership_start_date", "created_at"].includes(
      searchParams.get("sort") ?? "",
    )
      ? (searchParams.get("sort") as SortKey)
      : "name",
  );
  const [sortDir, setSortDir] = useState<SortDir>(() =>
    searchParams.get("dir") === "desc" ? "desc" : "asc",
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [activeBulkPanel, setActiveBulkPanel] = useState<StudentRosterBulkPanel | null>(null);
  const [pendingBulkCommand, setPendingBulkCommand] = useState<StudentRosterBulkCommand | null>(
    null,
  );
  const bulkCommandOwnerRef = useRef<StudentRosterBulkCommand | null>(null);
  const currentPendingBulkCommand =
    pendingBulkCommand?.scope === returnScope ? pendingBulkCommand : null;
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
  const [page, setPage] = useState(initialReturn?.page ?? 1);
  const [pageRequestNonce, setPageRequestNonce] = useState(0);
  const [inactivityScheduleStatus, setInactivityScheduleStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [inactivityScheduleError, setInactivityScheduleError] = useState<string | null>(null);
  const pagedRequestSeqRef = useRef(0);
  const pagedAbortControllerRef = useRef<AbortController | null>(null);
  const pagedQueryKeyRef = useRef("");
  const cursorHistoryRef = useRef(
    new Map<number, StudentRosterCursorChainEntry>(initialReturn?.history ?? []),
  );
  const pageRef = useRef(initialReturn?.page ?? 1);
  const pagedCursorRef = useRef<string | null>(initialReturn?.cursor ?? null);
  const [pagedHasNext, setPagedHasNext] = useState(false);
  const [pagedHasPrevious, setPagedHasPrevious] = useState(false);
  const [pagedNextCursor, setPagedNextCursor] = useState<string | null>(null);
  const [pagedPreviousCursor, setPagedPreviousCursor] = useState<string | null>(null);
  const inactivityScheduleRequestSeqRef = useRef(0);
  const normalizedSearch = normalizeStudentListSearch(search);
  const lastInputNormalizedSearchRef = useRef(normalizedSearch);
  const debouncedSearch = useDebouncedValue(normalizedSearch, STUDENTS_SEARCH_DEBOUNCE_MS);

  const usesDerivedRosterFilters = shouldUseDerivedRosterFilters({
    fullRosterRequested,
    hasNewStudentFilter,
    inactivityThreshold,
    pagedRosterEnabled: PAGED_STUDENTS_ROSTER_ENABLED,
    isPreviewMode: config.isPreviewMode,
  });
  const inactivityScheduleRange = useMemo(
    () =>
      inactivityThreshold ? buildInactivityScheduleDateRange(today, inactivityThreshold) : null,
    [inactivityThreshold, today],
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
          error instanceof Error ? error.message : "Schedule could not be loaded.",
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
  }, [
    config.isPreviewMode,
    inactivityScheduleRange,
    refreshInactivitySchedule,
    usesDerivedRosterFilters,
  ]);
  const visibleStudents = usesDerivedRosterFilters ? students : pagedStudents;
  const studentRows = useMemo(
    () => buildStudentRows(visibleStudents, programs, config.businessDate),
    [config.businessDate, programs, visibleStudents],
  );
  const inactivityRows = useMemo(
    () =>
      inactivityThreshold && usesDerivedRosterFilters
        ? buildStudentInactivityRows(students, sessions, attendance, today)
        : [],
    [attendance, inactivityThreshold, sessions, students, today, usesDerivedRosterFilters],
  );
  const localInactivityDaysByStudentId = useMemo(
    () => new Map(inactivityRows.map((row) => [row.student.id, row.daysInactive])),
    [inactivityRows],
  );
  const localInactivityByStudentId = useMemo(
    () =>
      new Map(
        inactivityRows.map((row) => [
          row.student.id,
          inactivityThreshold
            ? formatInactivityDaysForRange(row, inactivityThreshold)
            : String(row.daysInactive),
        ]),
      ),
    [inactivityRows, inactivityThreshold],
  );
  const serverInactivityByStudentId = useMemo(
    () => buildServerInactivityByStudentId(visibleStudents, inactivityThreshold),
    [inactivityThreshold, visibleStudents],
  );
  const inactivityDaysByStudentId = useMemo(
    () =>
      usesDerivedRosterFilters
        ? localInactivityDaysByStudentId
        : new Map(
            Array.from(serverInactivityByStudentId.entries()).map(([studentId, value]) => [
              studentId,
              Number.parseInt(value, 10) || 0,
            ]),
          ),
    [localInactivityDaysByStudentId, serverInactivityByStudentId, usesDerivedRosterFilters],
  );
  const inactivityByStudentId = useMemo(
    () => (usesDerivedRosterFilters ? localInactivityByStudentId : serverInactivityByStudentId),
    [localInactivityByStudentId, serverInactivityByStudentId, usesDerivedRosterFilters],
  );
  const hasActiveFilters = Boolean(
    search || statusFilter || programFilter || inactivityThreshold || hasNewStudentFilter,
  );

  const rosterHref = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("q", search.slice(0, 200));
    if (statusFilter) params.set("status", statusFilter);
    if (programFilter) params.set("program", programFilter);
    if (sortKey !== "name") params.set("sort", sortKey);
    if (sortDir !== "asc") params.set("dir", sortDir);
    if (inactiveDaysParam) params.set("inactiveDays", inactiveDaysParam);
    if (newStudentsParam) params.set("newStudents", newStudentsParam);
    if (fullRosterParam) params.set("fullRoster", fullRosterParam);
    return safeStudentsReturn(`/students?${params}`);
  }, [
    search,
    statusFilter,
    programFilter,
    sortKey,
    sortDir,
    inactiveDaysParam,
    newStudentsParam,
    fullRosterParam,
  ]);
  const incomingRosterHref = safeStudentsReturn(`/students?${searchParams}`);
  const lastRosterHrefRef = useRef(incomingRosterHref);

  useEffect(() => {
    const saved = initialReturnRef.current;
    if (!saved || (!pagedLoaded && !usesDerivedRosterFilters)) return;
    const frame = requestAnimationFrame(() => {
      const row = document.querySelector(`[data-student-id="${CSS.escape(saved.focusId)}"]`);
      row?.querySelector<HTMLElement>("button[data-open-student]")?.focus({ preventScroll: true });
      document.getElementById("main-content")?.scrollTo({ top: saved.scroll });
      consumeRosterReturn(saved);
      initialReturnRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [pagedLoaded, usesDerivedRosterFilters]);

  const newStudents = useMemo<StudentRosterNewStudentWindow | undefined>(() => {
    if (isNewStudentYtd) {
      return "ytd";
    }
    return newStudentDays ? (String(newStudentDays) as StudentRosterNewStudentWindow) : undefined;
  }, [isNewStudentYtd, newStudentDays]);
  const liveRosterQuery = useMemo<StudentListQuery>(
    () => ({
      search: debouncedSearch,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(programFilter ? { programId: programFilter } : {}),
      page: 1,
      pageSize: STUDENTS_PAGE_SIZE,
      sortKey,
      sortDir,
      fullRoster: fullRosterRequested,
      ...(inactivityThreshold ? { inactivityDays: inactivityThreshold as 14 | 30 | 90 } : {}),
      ...(newStudents ? { newStudents } : {}),
      today,
    }),
    [
      debouncedSearch,
      fullRosterRequested,
      inactivityThreshold,
      newStudents,
      programFilter,
      sortDir,
      sortKey,
      statusFilter,
      today,
    ],
  );
  const liveRosterQueryKey = useMemo(
    () =>
      JSON.stringify({
        auth: config.token ? "authenticated" : "signed-out",
        path: buildStudentPagePath(liveRosterQuery),
        studio: currentStudioId,
      }),
    [config.token, currentStudioId, liveRosterQuery],
  );

  // Returning to the roster redraws the page it left before the first paint; the
  // load below then revalidates it in place instead of behind a skeleton.
  const rosterRestoreAttemptedRef = useRef(false);
  useLayoutEffect(() => {
    if (rosterRestoreAttemptedRef.current) return;
    rosterRestoreAttemptedRef.current = true;
    if (usesDerivedRosterFilters) return;
    const snapshot = readStudentRosterSnapshot(retainedStore);
    if (
      !snapshot ||
      snapshot.queryKey !== liveRosterQueryKey ||
      snapshot.page !== pageRef.current ||
      snapshot.cursor !== pagedCursorRef.current
    ) {
      return;
    }
    cursorHistoryRef.current = new Map(snapshot.history);
    setPagedStudents(snapshot.students);
    setPagedTotal(snapshot.total);
    setPagedHasNext(snapshot.hasNext);
    setPagedHasPrevious(snapshot.hasPrevious);
    setPagedNextCursor(snapshot.nextCursor);
    setPagedPreviousCursor(snapshot.previousCursor);
    setPagedLoaded(true);
  }, [liveRosterQueryKey, retainedStore, usesDerivedRosterFilters]);
  const buildRosterPageQuery = useCallback(
    (requestedPage: number, requestedCursor: string | null): StudentListQuery => ({
      ...liveRosterQuery,
      page: requestedPage,
      ...(requestedCursor ? { cursor: requestedCursor } : { cursor: null }),
    }),
    [liveRosterQuery],
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

  useEffect(() => {
    // Native history changes the address synchronously; Next's searchParams
    // subscription can lag behind a second keystroke. Compare our write marker
    // with the actual address so that delayed notifications cannot erase input.
    if (window.location.pathname !== "/students") return;
    const browserHref = safeStudentsReturn(`/students${window.location.search}`);
    if (browserHref !== lastRosterHrefRef.current) {
      // Keep the selected command's retry context if browser history changes mid-write.
      if (currentPendingBulkCommand) {
        window.history.replaceState(window.history.state, "", rosterHref);
        return;
      }
      const timer = window.setTimeout(() => {
        if (bulkCommandOwnerRef.current?.scope === returnScope) {
          window.history.replaceState(window.history.state, "", rosterHref);
          return;
        }
        const params = new URLSearchParams(browserHref.split("?")[1]);
        lastRosterHrefRef.current = browserHref;
        setSearch((params.get("q") ?? "").slice(0, 200));
        setStatusFilter(
          ["active", "trialing", "inactive", "paused", "canceled"].includes(
            params.get("status") ?? "",
          )
            ? (params.get("status") as StudentRosterStatusFilter)
            : "",
        );
        setProgramFilter((params.get("program") ?? "").slice(0, 100));
        setSortKey(
          ["name", "status", "membership_start_date", "created_at"].includes(
            params.get("sort") ?? "",
          )
            ? (params.get("sort") as SortKey)
            : "name",
        );
        setSortDir(params.get("dir") === "desc" ? "desc" : "asc");
        resetRosterPaging();
      }, 0);
      return () => window.clearTimeout(timer);
    }
    if (browserHref !== rosterHref) {
      lastRosterHrefRef.current = rosterHref;
      window.history.replaceState(window.history.state, "", rosterHref);
    }
  }, [currentPendingBulkCommand, incomingRosterHref, resetRosterPaging, returnScope, rosterHref]);

  const requestRosterPage = useCallback(
    (requestedPage: number, requestedCursor: string | null) => {
      if (bulkCommandOwnerRef.current?.scope === returnScope) return;
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
    },
    [returnScope],
  );

  const loadPagedStudents = useCallback(
    async (options?: { recoverEmpty?: boolean; signal?: AbortSignal }) => {
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
      const isCurrentRequest = () =>
        isStudentRosterRequestCurrent({
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
            result = await listStudentsPage(buildRosterPageQuery(requestedPage, requestedCursor), {
              signal: requestController.signal,
            });
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

          const nextCursor = result.has_next ? (result.next_cursor ?? null) : null;
          const previousCursor = result.has_previous ? (result.previous_cursor ?? null) : null;
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
          rememberStudentRosterSnapshot(retainedStore, {
            queryKey: requestQueryKey,
            page: result.page_ordinal,
            cursor: requestedCursor,
            history: [...cursorHistoryRef.current],
            students: result.items,
            total: result.total,
            hasNext: Boolean(nextCursor) && result.has_next,
            hasPrevious: Boolean(previousCursor) && result.has_previous,
            nextCursor,
            previousCursor,
          });
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
    },
    [
      buildRosterPageQuery,
      listStudentsPage,
      liveRosterQueryKey,
      retainedStore,
      usesDerivedRosterFilters,
    ],
  );

  useEffect(() => {
    if (!usesDerivedRosterFilters || config.isPreviewMode || studentsLoadError) {
      return;
    }

    if (
      studentsLoaded &&
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

  const pagingResetKey = JSON.stringify([
    identityGeneration,
    currentStudioId,
    fullRosterParam,
    inactiveDaysParam,
    newStudentsParam,
    usesDerivedRosterFilters,
  ]);
  const rosterIdentityKey = JSON.stringify([identityGeneration, currentStudioId]);
  const previousPagingResetKeyRef = useRef(pagingResetKey);
  const previousRosterIdentityKeyRef = useRef(rosterIdentityKey);
  useEffect(() => {
    if (previousPagingResetKeyRef.current === pagingResetKey) return;
    // A replaced tenant or identity always drops the old selection. Same-identity
    // query changes wait for a pending bulk command; settlement reruns this effect.
    const identityChanged = previousRosterIdentityKeyRef.current !== rosterIdentityKey;
    if (!identityChanged && currentPendingBulkCommand) return;
    const timer = window.setTimeout(() => {
      if (!identityChanged && bulkCommandOwnerRef.current?.scope === returnScope) return;
      previousPagingResetKeyRef.current = pagingResetKey;
      previousRosterIdentityKeyRef.current = rosterIdentityKey;
      resetRosterPaging();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    currentPendingBulkCommand,
    pagingResetKey,
    resetRosterPaging,
    returnScope,
    rosterIdentityKey,
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
    scheduleRequired: Boolean(
      inactivityThreshold && usesDerivedRosterFilters && !config.isPreviewMode,
    ),
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

  function acquireBulkCommand(command: StudentRosterBulkCommand) {
    if (bulkCommandOwnerRef.current?.scope === command.scope) return false;
    bulkCommandOwnerRef.current = command;
    setPendingBulkCommand(command);
    return true;
  }

  function releaseBulkCommand(command: StudentRosterBulkCommand) {
    if (bulkCommandOwnerRef.current !== command) return;
    bulkCommandOwnerRef.current = null;
    setPendingBulkCommand(null);
  }

  const isBulkCommandOwned = () => bulkCommandOwnerRef.current?.scope === returnScope;
  const isCurrentBulkCommand = (command: StudentRosterBulkCommand) =>
    currentRosterScope.current === command.scope && bulkCommandOwnerRef.current === command;

  function handleSort(key: SortKey) {
    if (isBulkCommandOwned()) return;
    resetRosterPaging();
    if (sortKey === key) {
      setSortDir((direction) => (direction === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const reloadVisibleRoster = useCallback(
    async (options?: { recoverEmpty?: boolean }) => {
      if (usesDerivedRosterFilters) {
        await refreshStudents();
        return;
      }

      await loadPagedStudents(options);
    },
    [loadPagedStudents, refreshStudents, usesDerivedRosterFilters],
  );

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
  useResumeRefresh(() =>
    Promise.allSettled([
      reloadVisibleRoster({ recoverEmpty: true }),
      refreshPrograms({ includeArchived: false }),
      ...(inactivityThreshold && usesDerivedRosterFilters && !config.isPreviewMode
        ? [refreshInactivitySchedule()]
        : []),
    ]),
  );

  async function reloadVisibleRosterAfterMutation(context: string, isCurrent?: () => boolean) {
    try {
      await reloadVisibleRoster({ recoverEmpty: !usesDerivedRosterFilters });
    } catch (error) {
      console.error(`Failed to refresh students after ${context}`, error);
      if (!isCurrent || isCurrent()) {
        setActionMessage((current) => withStudentRosterRefreshWarning(current));
      }
    }
  }

  function toggleSelect(id: string) {
    if (isBulkCommandOwned()) return;
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
    if (isBulkCommandOwned()) return;
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
    if (isBulkCommandOwned()) return;
    setDeleteError(null);
    setBulkActionError(null);
    setActionMessage(null);
    setActiveBulkPanel((current) => (current === panel ? null : panel));
  }

  async function handleDeleteSelected() {
    if (!canManageRoster || isBulkCommandOwned() || selectedIds.size === 0) return;

    const command: StudentRosterBulkCommand = {
      kind: "delete",
      ids: Array.from(selectedIds),
      scope: returnScope,
    };
    if (!acquireBulkCommand(command)) return;
    setDeleteError(null);

    try {
      const deleteCount = command.ids.length;
      await deleteStudents(command.ids);
      if (!isCurrentBulkCommand(command)) return;
      setSelectedIds(new Set());
      setActiveBulkPanel(null);
      setActionMessage(
        `${deleteCount} ${deleteCount === 1 ? "student was" : "students were"} removed from the active roster.`,
      );
      await reloadVisibleRosterAfterMutation("delete", () => isCurrentBulkCommand(command));
    } catch (error) {
      if (!isCurrentBulkCommand(command)) return;
      setDeleteError(
        error instanceof Error ? error.message : "Failed to archive selected students.",
      );
      if (!usesDerivedRosterFilters) {
        void reloadVisibleRoster({ recoverEmpty: true }).catch((refreshError) => {
          console.error("Failed to refresh students after archive error", refreshError);
        });
      }
    } finally {
      releaseBulkCommand(command);
    }
  }

  async function handleAddTags() {
    if (!canManageRoster || isBulkCommandOwned() || selectedIds.size === 0) return;

    const tags = parseBulkTagsInput(tagInput);

    if (tags.length === 0) {
      setBulkActionError("Enter at least one tag to add.");
      return;
    }

    const command: StudentRosterBulkCommand = {
      kind: "tags",
      ids: Array.from(selectedIds),
      tags,
      scope: returnScope,
    };
    if (!acquireBulkCommand(command)) return;
    setBulkActionError(null);

    try {
      const result = await bulkAddTagsToStudents(command.ids, command.tags, {
        refreshMode: usesDerivedRosterFilters ? "full" : "local",
      });
      if (!isCurrentBulkCommand(command)) return;
      if (result.updated !== command.ids.length) {
        setBulkActionError(
          `Added tags to ${result.updated} of ${command.ids.length} selected students. Some students may no longer be available.`,
        );
        if (!usesDerivedRosterFilters) {
          await reloadVisibleRosterAfterMutation("partial bulk tag update", () =>
            isCurrentBulkCommand(command),
          );
        }
        return;
      }
      setTagInput("");
      setActiveBulkPanel(null);
      setActionMessage(
        `Tags added to ${result.updated} ${result.updated === 1 ? "student" : "students"}.`,
      );
      if (!usesDerivedRosterFilters) {
        await reloadVisibleRosterAfterMutation("bulk tag update", () =>
          isCurrentBulkCommand(command),
        );
      }
    } catch (error) {
      if (!isCurrentBulkCommand(command)) return;
      setBulkActionError(error instanceof Error ? error.message : "Failed to add tags.");
      if (!usesDerivedRosterFilters) {
        void reloadVisibleRoster({ recoverEmpty: true }).catch((refreshError) => {
          console.error("Failed to refresh students after bulk tag error", refreshError);
        });
      }
    } finally {
      releaseBulkCommand(command);
    }
  }

  async function handleBulkStatusUpdate() {
    if (!canManageRoster || isBulkCommandOwned() || selectedIds.size === 0) return;

    const command: StudentRosterBulkCommand = {
      kind: "status",
      ids: Array.from(selectedIds),
      status: bulkStatus,
      scope: returnScope,
    };
    if (!acquireBulkCommand(command)) return;
    setBulkActionError(null);

    try {
      const result = await bulkUpdateStudentStatus(command.ids, command.status, {
        refreshMode: usesDerivedRosterFilters ? "full" : "local",
      });
      if (!isCurrentBulkCommand(command)) return;
      if (result.updated !== command.ids.length) {
        setBulkActionError(
          `Updated ${result.updated} of ${command.ids.length} selected students. Some students may no longer be available.`,
        );
        if (!usesDerivedRosterFilters) {
          await reloadVisibleRosterAfterMutation("partial bulk status update", () =>
            isCurrentBulkCommand(command),
          );
        }
        return;
      }
      setActiveBulkPanel(null);
      setActionMessage(
        `Status changed to ${command.status} for ${result.updated} ${result.updated === 1 ? "student" : "students"}.`,
      );
      if (!usesDerivedRosterFilters) {
        await reloadVisibleRosterAfterMutation("bulk status update", () =>
          isCurrentBulkCommand(command),
        );
      }
    } catch (error) {
      if (!isCurrentBulkCommand(command)) return;
      setBulkActionError(error instanceof Error ? error.message : "Failed to update status.");
      if (!usesDerivedRosterFilters) {
        void reloadVisibleRoster({ recoverEmpty: true }).catch((refreshError) => {
          console.error("Failed to refresh students after bulk status error", refreshError);
        });
      }
    } finally {
      releaseBulkCommand(command);
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
      isAddingTags: currentPendingBulkCommand?.kind === "tags",
      isBulkCommandPending: currentPendingBulkCommand !== null,
      isDeleting: currentPendingBulkCommand?.kind === "delete",
      isInitialRosterLoading,
      isNewStudentYtd,
      isPagedLoading,
      isRosterRefreshing,
      isUpdatingStatus: currentPendingBulkCommand?.kind === "status",
      newStudentDays,
      newStudentStartDate,
      onAddStudent: () => {
        if (canCreateStudents) setShowForm(true);
      },
      onAddStudentSubmit: handleAddStudent,
      onAddTags: handleAddTags,
      onBulkStatusChange: (status: StudentStatus) => {
        if (!isBulkCommandOwned()) setBulkStatus(status);
      },
      onBulkStatusUpdate: handleBulkStatusUpdate,
      onCancelDelete: () => {
        if (isBulkCommandOwned()) return;
        setActiveBulkPanel(null);
        setDeleteError(null);
      },
      onCancelStatus: () => {
        if (isBulkCommandOwned()) return;
        setActiveBulkPanel(null);
        setBulkActionError(null);
      },
      onCancelTags: () => {
        if (isBulkCommandOwned()) return;
        setActiveBulkPanel(null);
        setBulkActionError(null);
        setTagInput("");
      },
      onClearFilters: () => {
        if (isBulkCommandOwned()) return;
        lastInputNormalizedSearchRef.current = "";
        setSearch("");
        setStatusFilter("");
        setProgramFilter("");
        resetRosterPaging();
        router.replace("/students");
      },
      onCloseStudentForm: () => {
        if (!isAdding) setShowForm(false);
      },
      onDeleteSelected: handleDeleteSelected,
      onDismissActionMessage: () => setActionMessage(null),
      onDismissRosterQueryNotice: () => router.push("/students"),
      onImportCsv: () => {
        if (canManageRoster) router.push("/students/import");
      },
      onNextPage: () => {
        if (
          isBulkCommandOwned() ||
          usesDerivedRosterFilters ||
          isPagedLoading ||
          !pagedHasNext ||
          !pagedNextCursor
        ) {
          return;
        }
        requestRosterPage(pageRef.current + 1, pagedNextCursor);
      },
      onPrefetchStudent: (studentId: string) => {
        prefetchRecordRoute(
          router,
          `/students/${studentId}?returnTo=${encodeURIComponent(rosterHref)}`,
        );
      },
      onOpenStudent: (studentId: string) => {
        saveRosterReturn({
          scope: returnScope,
          href: rosterHref,
          page: pageRef.current,
          cursor: pagedCursorRef.current,
          history: [...cursorHistoryRef.current],
          scroll: document.getElementById("main-content")?.scrollTop ?? 0,
          focusId: studentId,
          savedAt: Date.now(),
        });
        router.push(`/students/${studentId}?returnTo=${encodeURIComponent(rosterHref)}`);
      },
      onPreviousPage: () => {
        if (
          isBulkCommandOwned() ||
          usesDerivedRosterFilters ||
          isPagedLoading ||
          !pagedHasPrevious ||
          !pagedPreviousCursor
        ) {
          return;
        }
        requestRosterPage(Math.max(1, pageRef.current - 1), pagedPreviousCursor);
      },
      onProgramFilterChange: (value: string) => {
        if (isBulkCommandOwned()) return;
        setProgramFilter(value);
        resetRosterPaging();
      },
      onRetryRosterLoad: () => {
        void retryRequiredStudentDatasets().catch((error) => {
          console.error("Failed to retry student roster load", error);
        });
      },
      onSearchChange: (value: string) => {
        if (isBulkCommandOwned()) return;
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
        if (isBulkCommandOwned()) return;
        setStatusFilter(value);
        resetRosterPaging();
      },
      onTagInputChange: (value: string) => {
        if (!isBulkCommandOwned()) setTagInput(value);
      },
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

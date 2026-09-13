"use client";

import type { ApiDashboardWorkspaceResponse } from "@/types/generated/api-contracts";
import { useReconciledProjectionCommand } from "@/lib/store-projection-reconciliation";
import { useStudioDay } from "@/lib/use-studio-day";
import { initialBootstrapView, bootstrapDatasets } from "@/lib/bootstrap-route";
import { APP_RESUME_EVENT, APP_DATA_REFRESH_EVENT } from "@/lib/app-resume";
import { pendingCommands, subscribePendingCommands } from "@/lib/pending-commands";
import { markDashboardFactsChanged, needsFreshDashboardFacts } from "@/lib/dashboard-freshness";
import { beginResourceMutation, createResourceScope } from "@/lib/store-resource-scope";

import React, { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { api, isStaffArchivedError, isSubscriptionRequiredError } from "@/lib/api";
import { markPerformance, measurePerformance } from "@/lib/performance";
import {
  clearStoredStudioSessionCookies,
  syncStoredStudioSessionCookies,
} from "@/lib/store-session-cookies";
import {
  StoreContextProviders,
  useStoreContextValues,
} from "@/lib/store-provider-values";
import {
  KEYS,
  load,
  save,
} from "@/lib/store-storage";
import { useSyncedRefValue } from "@/lib/store-ref-sync";
import { invalidateEligibilityAfterStudentMutation } from "@/lib/store-eligibility-invalidation";
import { buildPreviewEligibilityForLadder } from "@/lib/preview-belt-eligibility";
import {
  applyLiveStudioDataResetRefs,
  buildSubscriptionAccessRestoreState,
  buildSignedOutStudioResetState,
  buildSubscriptionRequiredStudioResetState,
  nextLiveStudioDataResetGeneration,
  type LiveStudioDataResetState,
} from "@/lib/store-reset-model";
import {
  setPromotionHistoryCacheItems,
  toPromotionHistoryByStudent,
  type PromotionHistoryCache,
  type PromotionHistoryRequests,
} from "@/lib/store-promotion-history";
import type {
  Student,
  Lead,
  BeltRank, BeltLadder,
  ClassSession,
  ClassTemplate, AttendanceRecord,
  EligibilityEntry, Promotion,
  Program,
  StaffMember,
  StaffLegalNameResponse, StaffRoleName, DashboardSummary,
} from "@/types";
import {
  MOCK_STUDENTS,
  MOCK_SESSIONS,
  MOCK_CLASS_TEMPLATES,
  MOCK_ATTENDANCE,
  MOCK_BELT_LADDER,
  MOCK_ELIGIBILITY,
  MOCK_LEADS,
} from "@/lib/mock-data";
import {
  MOCK_BELT_LADDERS,
  MOCK_PROGRAMS,
  MOCK_STAFF_MEMBERS,
} from "@/lib/preview-studio-data";
import {
  createScheduleReconciliationQueue,
  createScheduleCoordinatorState,
  compareSessions,
  discardSupersededScheduleWindowFailure,
  fetchScheduleWindowRange,
  isAuthoritativeScheduleReady,
  isScheduleReadCurrent,
  mergeAttendanceForSessions,
  mergeSessionsForRange,
  markScheduleCoordinatorSnapshotState,
  normalizeAttendanceRecords,
  refreshScheduleCoordinatorAuthState,
  resolveScheduleReconciliationRange,
  resetScheduleCoordinatorState,
  shouldPreserveScheduleMutationsOnAuthChange,
  type ScheduleRangeRefreshIntent,
} from "@/lib/schedule-store-model";
import { useStoreBeltActions } from "@/lib/store-belt-actions";
import { useStoreLeadActions } from "@/lib/store-lead-actions";
import { useStoreProgramActions } from "@/lib/store-program-actions";
import { useStoreScheduleActions } from "@/lib/store-schedule-actions";
import { useStoreStaffActions } from "@/lib/store-staff-actions";
import { useStoreStudentBulkActions } from "@/lib/store-student-bulk-actions";
import { useStoreStudentImportActions } from "@/lib/store-student-import-actions";
import { useStoreStudentPhotoActions } from "@/lib/store-student-photo-actions";
import { useStoreStudentRosterActions } from "@/lib/store-student-roster-actions";
import { useStoreStudioActions } from "@/lib/store-studio-actions";
import { selectBeltLadder, sortBeltLadders } from "@/lib/belt-store-model";
import {
  buildAuthUserProfile,
  buildDeferredScheduleDateRange,
  buildSessionUserProfile,
  isStaffProfilesAvailable,
  isLiveAuthRequestCurrent,
  parseAuthProfileResponse,
  resolveBootstrapLadders,
  resolveBootstrapStudioName,
  type AuthUserProfile,
  type AuthProfileResponse,
  type BootstrapResponse,
} from "@/lib/store-bootstrap-model";
import { withCurrentLiveAuthRead } from "@/lib/store-action-types";
import { routeForMembershipStatus } from "@/lib/auth-route-model";
import {
  buildPreviewHydratedLadderState,
  resolvePreviewLadderHydrationDefaults,
  type DemoResetResponse,
} from "@/lib/studio-store-model";
import {
  sortPrograms,
} from "@/lib/program-store-model";
import { canMaterializeScheduleRange } from "@/lib/staff-permissions";

export {
  useBeltStore,
  useConfigStore,
  useDashboardStore,
  useLeadStore,
  useProgramStore,
  useScheduleStore,
  useStore,
  useStudentStore,
  useStudioStore,
} from "@/lib/store-contexts";

// ── Provider ─────────────────────────────────────────────────────────────────
export function StoreProvider({ children }: { children: ReactNode }) {
  const isPreviewMode = process.env.NEXT_PUBLIC_PREVIEW_MODE === "true";
  const [hydrated, setHydrated] = useState(false);
  const [subscriptionRequired, setSubscriptionRequired] = useState(false);
  const [initialFeaturePending, setInitialFeaturePending] = useState(true);
  const [studioTimezone, setStudioTimezone] = useState("UTC");
  const businessDate = useStudioDay(studioTimezone);
  const businessDateRef = useRef(businessDate);
  useEffect(() => { businessDateRef.current = businessDate; }, [businessDate]);
  const [identityReady, setIdentityReady] = useState(false);
  const [identityLoadError, setIdentityLoadError] = useState<string | null>(null);
  const [identityGeneration, setIdentityGeneration] = useState(0);
  const authoritativeIdentityRef = useRef<string | null>(null);
  const authoritativeStudioIdRef = useRef<string | null>(null);
  const identityEpochRef = useRef(0);
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const retryInitialization = useCallback(() => setInitializationAttempt((value) => value + 1), []);
  const [token, setToken] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const authGenerationRef = useRef(0);
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const bootstrapRequestRef = useRef<{ pathname: string; controller: AbortController } | null>(null);
  useEffect(() => {
    pathnameRef.current = pathname;
    if (bootstrapRequestRef.current?.pathname !== pathname) bootstrapRequestRef.current?.controller.abort();
  }, [pathname]);
  const [supabase] = useState(() => createClient());

  // ── State ──
  const [students, setStudents] = useState<Student[]>(() =>
    isPreviewMode ? MOCK_STUDENTS : []
  );
  const [studentsLoaded, setStudentsLoaded] = useState(isPreviewMode);
  const [studentsLoadError, setStudentsLoadError] = useState<string | null>(null);
  const [studentsLastLoadedAt, setStudentsLastLoadedAt] = useState<number | null>(() =>
    isPreviewMode ? Date.now() : null
  );
  const [studentsMayBePartial, setStudentsMayBePartial] = useState(false);
  const [dashboardSummary, setDashboardSummary] = useState<DashboardSummary | null>(null);
  const [dashboardSummaryLoadError, setDashboardSummaryLoadError] = useState<string | null>(null);
  const [dashboardSummaryLoaded, setDashboardSummaryLoaded] = useState(isPreviewMode);
  const dashboardSummaryRequestSeqRef = useRef(0);
  const dashboardSummaryFlightRef = useRef<{ sequence: number; fresh: boolean; promise: Promise<void> } | null>(null);
  const studentsRef = useRef<Student[]>(students);
  const studentsRevisionRef = useRef(0);
  const studentMutationEpochRef = useRef(0);
  const studentRosterRequestSequenceRef = useRef(0);
  const previewStudentPhotoUrlsRef = useRef<Record<string, string>>({});
  const [programs, setProgramRows] = useState<Program[]>(() =>
    isPreviewMode ? MOCK_PROGRAMS : []
  );
  const [programsLoaded, setProgramsLoadedState] = useState(isPreviewMode);
  const programsLoadedRef = useRef(isPreviewMode);
  const setProgramsLoaded = useCallback((loaded: boolean) => {
    programsLoadedRef.current = loaded;
    setProgramsLoadedState(loaded);
  }, []);
  const [programsLoadError, setProgramsLoadError] = useState<string | null>(null);
  const programsRef = useRef<Program[]>(programs);
  const programScopeRef = useRef(createResourceScope());
  const resetProgramScope = useCallback(() => {
    programScopeRef.current.settle();
    programScopeRef.current = createResourceScope();
  }, []);
  const setPrograms = useCallback((next: Program[]) => {
    programsRef.current = next;
    setProgramRows(next);
  }, []);
  const [programsUsageLoaded, setProgramsUsageLoaded] = useState(isPreviewMode);
  const [programsUsageLoadError, setProgramsUsageLoadError] = useState<string | null>(null);
  const [leads, setLeads] = useState<Lead[]>(() =>
    isPreviewMode ? MOCK_LEADS : []
  );
  const [leadsLoaded, setLeadsLoaded] = useState(isPreviewMode);
  const [leadsLoadError, setLeadsLoadError] = useState<string | null>(null);
  const leadsRef = useRef<Lead[]>(leads);
  const leadMutationScopeRef = useRef(createResourceScope());
  const beginLeadMutation = useCallback(() => beginResourceMutation(leadMutationScopeRef.current), []);
  const [beltLadders, setBeltLaddersState] = useState<BeltLadder[]>(() =>
    isPreviewMode ? MOCK_BELT_LADDERS : []
  );
  const beltsHydratedRef = useRef(false);
  const [beltLaddersLoadError, setBeltLaddersLoadError] = useState<string | null>(null);
  const [studioLoadError, setStudioLoadError] = useState<string | null>(null);
  const beltLaddersRef = useRef<BeltLadder[]>(beltLadders);
  const [beltRanks, setBeltRanksState] = useState<BeltRank[]>(() =>
    isPreviewMode ? MOCK_BELT_LADDER.ranks : []
  );
  const beltRanksRef = useRef<BeltRank[]>(beltRanks);
  const refreshBeltsRef = useRef<((preferredLadderId?: string | null) => Promise<void>) | null>(null);
  const [sessions, setSessionsState] = useState<ClassSession[]>(() =>
    isPreviewMode ? MOCK_SESSIONS : []
  );
  const sessionsRef = useRef<ClassSession[]>(sessions);
  const setSessions = useCallback((update: ClassSession[] | ((current: ClassSession[]) => ClassSession[])) => {
    const next = typeof update === "function" ? update(sessionsRef.current) : update;
    sessionsRef.current = next;
    setSessionsState(next);
  }, []);
  const [templates, setTemplates] = useState<ClassTemplate[]>(() =>
    isPreviewMode ? MOCK_CLASS_TEMPLATES : []
  );
  const templatesRef = useRef<ClassTemplate[]>(templates);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>(() =>
    isPreviewMode ? MOCK_ATTENDANCE : []
  );
  const attendanceRef = useRef<AttendanceRecord[]>(attendance);
  const scheduleCoordinatorRef = useRef(createScheduleCoordinatorState());
  const scheduleReconciliationQueueRef = useRef(createScheduleReconciliationQueue());
  const scheduleReconciliationScopeRef = useRef(0);
  const destructivelyResetScheduleCoordinator = useCallback((
    hasAuthoritativeSnapshot = false
  ) => {
    scheduleReconciliationScopeRef.current += 1;
    scheduleReconciliationQueueRef.current.invalidate(
      scheduleReconciliationScopeRef.current
    );
    scheduleCoordinatorRef.current = resetScheduleCoordinatorState(
      scheduleCoordinatorRef.current,
      hasAuthoritativeSnapshot
    );
  }, []);
  const [scheduleStatus, setScheduleStatus] = useState<"idle" | "loading" | "ready" | "error">(
    isPreviewMode ? "ready" : "idle"
  );
  const [scheduleLoadError, setScheduleLoadError] = useState<string | null>(null);
  const [studioName, setStudioNameState] = useState(() =>
    isPreviewMode ? "My Studio" : ""
  );
  const [currentUser, setCurrentUser] = useState<AuthUserProfile | null>(() =>
    isPreviewMode
      ? { id: "preview-user", email: "demo@koaryu.local", full_name: "Demo User" }
      : null
  );
  const authUserIdRef = useRef<string | null>(isPreviewMode ? "preview-user" : null);
  const activeUserId = currentUser?.id || null;
  const [currentStudioId, setCurrentStudioId] = useState<string | null>(() =>
    isPreviewMode ? "preview-studio" : null
  );
  const [currentRole, setCurrentRole] = useState<StaffRoleName | null>(() =>
    isPreviewMode ? "admin" : null
  );
  const currentRoleRef = useRef(currentRole);
  const [staffProfilesAvailable, setStaffProfilesAvailable] = useState(false);
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>(() =>
    isPreviewMode ? MOCK_STAFF_MEMBERS : []
  );
  const staffMembersRef = useRef<StaffMember[]>(staffMembers);
  const staffScopeRef = useRef(createResourceScope());
  const selfLegalNameRevisionRef = useRef(0);
  const resetStaffScope = useCallback(() => {
    staffScopeRef.current.settle();
    staffScopeRef.current = createResourceScope();
  }, []);
  const [staffLoaded, setStaffLoaded] = useState(isPreviewMode);
  const [staffLoadError, setStaffLoadError] = useState<string | null>(null);
  const [subRankTerm, setSubRankTermState] = useState(() =>
    isPreviewMode ? MOCK_BELT_LADDER.sub_rank_term || "Stripe" : "Stripe"
  );
  const [ladderName, setLadderNameState] = useState(() =>
    isPreviewMode ? MOCK_BELT_LADDER.name : ""
  );
  const [currentLadderId, setCurrentLadderIdState] = useState<string | null>(null);
  const currentLadderIdRef = useRef<string | null>(null);
  const [eligibility, setEligibility] = useState<EligibilityEntry[]>(() =>
    isPreviewMode ? MOCK_ELIGIBILITY : []
  );
  const eligibilityRef = useRef<EligibilityEntry[]>(eligibility);
  const [eligibilityLadderId, setEligibilityLadderId] = useState<string | null>(() =>
    isPreviewMode ? MOCK_BELT_LADDER.id : null
  );
  const [eligibilityPendingLadderId, setEligibilityPendingLadderId] = useState<string | null>(null);
  const [eligibilityLoadError, setEligibilityLoadError] = useState<string | null>(null);
  const eligibilityCacheRef = useRef<Record<string, EligibilityEntry[]>>(
    isPreviewMode ? { [MOCK_BELT_LADDER.id]: MOCK_ELIGIBILITY } : {}
  );
  const eligibilityRequestSeqRef = useRef(0);
  const [promotionHistoryCache, setPromotionHistoryCache] = useState<PromotionHistoryCache>(() =>
    isPreviewMode ? load(KEYS.promotionHistory, {}) : {}
  );
  const promotionHistoryCacheRef = useRef<PromotionHistoryCache>(promotionHistoryCache);
  const promotionHistoryRequestsRef = useRef<PromotionHistoryRequests>({});
  const promotionHistoryGenerationRef = useRef(0);

  const clearPromotionHistoryCache = useCallback(() => {
    promotionHistoryGenerationRef.current += 1;
    promotionHistoryRequestsRef.current = {};
    promotionHistoryCacheRef.current = {};
    setPromotionHistoryCache({});
    if (isPreviewMode) save(KEYS.promotionHistory, {});
  }, [isPreviewMode]);

  const beginLiveAuthRequest = useCallback(() => {
    const requestToken = tokenRef.current;
    if (!requestToken) {
      throw new Error("Not authenticated");
    }
    const requestGeneration = authGenerationRef.current;
    const identityEpoch = identityEpochRef.current;
    const identity = authoritativeIdentityRef.current;
    return {
      token: requestToken,
      isSameIdentity: () => Boolean(
        identity && identity === authoritativeIdentityRef.current
        && identityEpoch === identityEpochRef.current && tokenRef.current
      ),
      canRetryAfterTokenChange: () => Boolean(
        identity && identity === authoritativeIdentityRef.current
        && identityEpoch === identityEpochRef.current
        && tokenRef.current && requestToken !== tokenRef.current
      ),
      isCurrent: () => isLiveAuthRequestCurrent({
        requestToken,
        requestGeneration,
        currentToken: tokenRef.current,
        currentGeneration: authGenerationRef.current,
      }),
    };
  }, []);

  const refreshDashboardSummary = useCallback(async (options?: { reason?: "visit" }): Promise<void> => {
    if (isPreviewMode) return Promise.resolve();
    const fresh = options?.reason !== "visit" || needsFreshDashboardFacts();
    const existing = dashboardSummaryFlightRef.current;
    if (existing?.sequence === dashboardSummaryRequestSeqRef.current && (!fresh || existing.fresh)) return existing.promise;
    const sequence = ++dashboardSummaryRequestSeqRef.current;
    const owner = beginLiveAuthRequest();
    const studioId = authoritativeStudioIdRef.current;
    const isCurrent = () => sequence === dashboardSummaryRequestSeqRef.current && owner.isSameIdentity();
    setDashboardSummaryLoadError(null);
    markPerformance("dashboard.summary_started");
    const fail = () => {
      if (isCurrent()) {
        setDashboardSummaryLoadError("Saved records are retained. Dashboard totals could not be refreshed. Please retry.");
        setDashboardSummaryLoaded(true);
      }
    };
    const promise = withCurrentLiveAuthRead(() => {
      const request = beginLiveAuthRequest();
      return { ...request, canRetryAfterTokenChange: () => isCurrent() && request.canRetryAfterTokenChange() };
    }, async (request) => {
      const summary = await api.get<DashboardSummary>(fresh ? "/dashboard/summary?fresh=true" : "/dashboard/summary", request.token,
        { timeoutMs: 35000, timeoutMessage: "Dashboard refresh timed out." });
      if (!isCurrent() || !request.isCurrent()) return;
      if (summary.auth.studio_id !== studioId) throw new Error("Dashboard scope changed. Please retry.");
      setDashboardSummary(summary);
      setDashboardSummaryLoaded(true);
      markPerformance("dashboard.summary_finished");
      measurePerformance("dashboard.summary_duration", "dashboard.summary_started", "dashboard.summary_finished");
    }, fail).catch((error) => { fail(); throw error; }).finally(() => {
      if (dashboardSummaryFlightRef.current?.sequence === sequence) dashboardSummaryFlightRef.current = null;
    });
    dashboardSummaryFlightRef.current = { sequence, fresh, promise };
    return promise;
  }, [beginLiveAuthRequest, isPreviewMode]);

  const reconcileScheduleAttempt = useCallback(async (
    intent: ScheduleRangeRefreshIntent
  ) => {
    const request = beginLiveAuthRequest();
    const coordinator = scheduleCoordinatorRef.current;
    const { startDate, endDate } = resolveScheduleReconciliationRange(
      coordinator,
      buildDeferredScheduleDateRange(new Date(), businessDateRef.current)
    );
    const generation = coordinator.generation;
    const dataRevision = coordinator.dataRevision;
    const rangeRequestSequence = coordinator.rangeRequestSequence + 1;
    const attendanceRequestSequence = coordinator.attendanceRequestSequence + 1;
    scheduleCoordinatorRef.current = {
      ...coordinator,
      attendanceRequestSequence,
      rangeRequestSequence,
    };

    const isCurrentScheduleWindowRead = () => {
      const current = scheduleCoordinatorRef.current;
      const sessionsAreCurrent = isScheduleReadCurrent({
        authCurrent: request.isCurrent(),
        currentGeneration: current.generation,
        currentDataRevision: current.dataRevision,
        currentRequestSequence: current.rangeRequestSequence,
        dataRevisionAtStart: dataRevision,
        generationAtStart: generation,
        mutationsInFlight: current.mutationsInFlight,
        requestSequenceAtStart: rangeRequestSequence,
      });
      const attendanceIsCurrent = isScheduleReadCurrent({
        authCurrent: request.isCurrent(),
        currentGeneration: current.generation,
        currentDataRevision: current.dataRevision,
        currentRequestSequence: current.attendanceRequestSequence,
        dataRevisionAtStart: dataRevision,
        generationAtStart: generation,
        mutationsInFlight: current.mutationsInFlight,
        requestSequenceAtStart: attendanceRequestSequence,
      });
      return sessionsAreCurrent && attendanceIsCurrent;
    };
    const scheduleWindow = await discardSupersededScheduleWindowFailure(
      () => fetchScheduleWindowRange(
        api,
        request.token,
        startDate,
        endDate,
        intent,
        canMaterializeScheduleRange(currentRoleRef.current)
      ),
      isCurrentScheduleWindowRead
    );

    if (!scheduleWindow || !isCurrentScheduleWindowRead()) {
      return;
    }

    const rangeSessions = scheduleWindow.sessions;
    const replacedSessionIds = Array.from(new Set([
      ...sessionsRef.current
        .filter((session) => session.date >= startDate && session.date <= endDate)
        .map((session) => session.id),
      ...rangeSessions.map((session) => session.id),
    ]));
    setTemplates(scheduleWindow.templates);
    setSessions((existing) => mergeSessionsForRange(existing, rangeSessions, startDate, endDate));
    setAttendance((existing) =>
      mergeAttendanceForSessions(
        existing,
        normalizeAttendanceRecords(scheduleWindow.attendance),
        replacedSessionIds
      )
    );
    scheduleCoordinatorRef.current = markScheduleCoordinatorSnapshotState(
      scheduleCoordinatorRef.current
    );
    setScheduleLoadError(null);
    setScheduleStatus("ready");
  }, [beginLiveAuthRequest, setSessions]);

  const reconcileSchedule = useCallback(async (intent: ScheduleRangeRefreshIntent) => {
    const requestToken = tokenRef.current;
    const requestGeneration = authGenerationRef.current;
    try {
      await scheduleReconciliationQueueRef.current(
        () => reconcileScheduleAttempt(intent),
        () => !scheduleCoordinatorRef.current.hasAuthoritativeSnapshot,
        intent,
        () => scheduleCoordinatorRef.current.mutationsInFlight === 0,
        scheduleReconciliationScopeRef.current
      );
    } catch (error) {
      if (
        requestToken === tokenRef.current
        && requestGeneration === authGenerationRef.current
      ) {
        setScheduleLoadError(
          error instanceof Error ? error.message : "Schedule could not be loaded."
        );
        setScheduleStatus("error");
      }
      throw error;
    }
  }, [reconcileScheduleAttempt]);

  const refreshSchedule = useCallback(async () => {
    if (isPreviewMode) {
      setScheduleLoadError(null);
      setScheduleStatus("ready");
      return;
    }

    const requestToken = tokenRef.current;
    const requestGeneration = authGenerationRef.current;
    if (!requestToken) {
      setScheduleLoadError(null);
      setScheduleStatus("idle");
      return;
    }

    const isCurrent = () => isLiveAuthRequestCurrent({
      requestToken,
      requestGeneration,
      currentToken: tokenRef.current,
      currentGeneration: authGenerationRef.current,
    });
    setScheduleLoadError(null);
    setScheduleStatus("loading");

    try {
      await reconcileSchedule("read");
      if (isCurrent()) {
        if (isAuthoritativeScheduleReady(scheduleCoordinatorRef.current)) {
          setScheduleStatus("ready");
        } else {
          setScheduleStatus("loading");
        }
      }
    } catch (error) {
      if (isCurrent()) {
        setScheduleLoadError(
          error instanceof Error ? error.message : "Schedule could not be loaded."
        );
        setScheduleStatus("error");
      }
      throw error;
    }
  }, [isPreviewMode, reconcileSchedule]);

  const commitPromotionHistoryCache = useCallback((studentId: string, items: Promotion[]) => {
    const next = setPromotionHistoryCacheItems(
      promotionHistoryCacheRef.current,
      studentId,
      items,
    );
    promotionHistoryCacheRef.current = next;
    setPromotionHistoryCache(next);
    if (isPreviewMode) save(KEYS.promotionHistory, next);
  }, [isPreviewMode]);

  const updateCurrentLadderId = useCallback((nextLadderId: string | null) => {
    setCurrentLadderIdState(nextLadderId);
    currentLadderIdRef.current = nextLadderId;
  }, []);

  const applyLadderSelection = useCallback((ladders: BeltLadder[], preferredLadderId?: string | null) => {
    setBeltLaddersLoadError(null);
    const orderedLadders = sortBeltLadders(ladders);
    const selectedLadder = selectBeltLadder(
      orderedLadders,
      preferredLadderId ?? currentLadderIdRef.current
    );

    setBeltLaddersState(orderedLadders);
    updateCurrentLadderId(selectedLadder?.id ?? null);
    setLadderNameState(selectedLadder?.name || "");
    setSubRankTermState(selectedLadder?.sub_rank_term || "Stripe");
    setBeltRanksState(selectedLadder?.ranks || []);
    if (isPreviewMode) save(KEYS.beltLadders, orderedLadders);

    return selectedLadder;
  }, [isPreviewMode, updateCurrentLadderId]);

  useSyncedRefValue(studentsRef, students);

  useEffect(() => {
    const previewUrls = previewStudentPhotoUrlsRef.current;
    return () => {
      Object.values(previewUrls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const commitStudents = useCallback(
    (
      next: Student[] | ((current: Student[]) => Student[]),
      options?: { mayBePartial?: boolean }
    ) => {
      setStudentsLoaded(true);
      setStudentsLoadError(null);
      setStudentsLastLoadedAt(Date.now());
      setStudentsMayBePartial(Boolean(options?.mayBePartial));
      setStudents((current) => {
        const resolved = typeof next === "function"
          ? (next as (current: Student[]) => Student[])(current)
          : next;
        studentsRevisionRef.current += 1;
        return resolved;
      });
    },
    []
  );

  useSyncedRefValue(leadsRef, leads);

  useSyncedRefValue(beltLaddersRef, beltLadders);

  useSyncedRefValue(beltRanksRef, beltRanks);


  useSyncedRefValue(templatesRef, templates);

  useSyncedRefValue(attendanceRef, attendance);

  useSyncedRefValue(eligibilityRef, eligibility);

  useSyncedRefValue(promotionHistoryCacheRef, promotionHistoryCache);

  useSyncedRefValue(staffMembersRef, staffMembers);

  const commitEligibilityRows = useCallback((ladderId: string | null, rows: EligibilityEntry[]) => {
    setEligibility(rows);
    eligibilityRef.current = rows;
    setEligibilityLadderId(ladderId);
    if (ladderId) {
      eligibilityCacheRef.current[ladderId] = rows;
    }
  }, []);

  const clearEligibilityState = useCallback(() => {
    eligibilityRequestSeqRef.current += 1;
    eligibilityCacheRef.current = {};
    commitEligibilityRows(null, []);
    setEligibilityPendingLadderId(null);
    setEligibilityLoadError(null);
  }, [commitEligibilityRows]);

  const applyLiveStudioDataResetState = useCallback((state: LiveStudioDataResetState) => {
    beltsHydratedRef.current = false;
    resetProgramScope();
    resetStaffScope();
    leadMutationScopeRef.current.settle();
    leadMutationScopeRef.current = createResourceScope();
    applyLiveStudioDataResetRefs({
      staffMembers: staffMembersRef,
      programs: programsRef,
      students: studentsRef,
      leads: leadsRef,
      beltLadders: beltLaddersRef,
      beltRanks: beltRanksRef,
      sessions: sessionsRef,
      templates: templatesRef,
      attendance: attendanceRef,
      eligibility: eligibilityRef,
      eligibilityCache: eligibilityCacheRef,
      promotionHistoryCache: promotionHistoryCacheRef,
      promotionHistoryRequests: promotionHistoryRequestsRef,
    }, state);
    setSubscriptionRequired(state.subscriptionRequired);
    setStudioNameState(state.studioName);
    setStudioLoadError(null);
    setBeltLaddersLoadError(null);
    setStaffMembers(state.staffMembers);
    setStaffLoaded(state.staffLoaded);
    setStaffLoadError(state.staffLoadError);
    setPrograms(state.programs);
    setProgramsLoaded(state.programsLoaded);
    setProgramsLoadError(state.programsLoadError);
    setProgramsUsageLoaded(false);
    setProgramsUsageLoadError(null);
    setDashboardSummaryLoadError(null);
    setDashboardSummary(state.dashboardSummary);
    setDashboardSummaryLoaded(state.dashboardSummaryLoaded);
    studentsRevisionRef.current += 1;
    setStudents(state.students);
    setStudentsLoaded(state.studentsLoaded);
    setStudentsLoadError(state.studentsLoadError);
    setStudentsLastLoadedAt(state.studentsLastLoadedAt);
    setStudentsMayBePartial(state.studentsMayBePartial);
    setLeads(state.leads);
    setLeadsLoaded(state.leadsLoaded);
    setLeadsLoadError(state.leadsLoadError);
    setBeltLaddersState(state.beltLadders);
    updateCurrentLadderId(state.currentLadderId);
    setLadderNameState(state.ladderName);
    setSubRankTermState(state.subRankTerm);
    setBeltRanksState(state.beltRanks);
    destructivelyResetScheduleCoordinator();
    setScheduleLoadError(state.scheduleLoadError);
    setScheduleStatus(state.scheduleStatus);
    setSessions(state.sessions);
    setTemplates(state.templates);
    setAttendance(state.attendance);
    eligibilityRequestSeqRef.current += 1;
    setEligibility(state.eligibility);
    setEligibilityLadderId(state.eligibilityLadderId);
    setEligibilityPendingLadderId(state.eligibilityPendingLadderId);
    setEligibilityLoadError(state.eligibilityLoadError);
    promotionHistoryGenerationRef.current += 1;
    setPromotionHistoryCache(state.promotionHistoryCache);
  }, [setPrograms, setProgramsLoaded, resetProgramScope, resetStaffScope, destructivelyResetScheduleCoordinator, setSessions, updateCurrentLadderId]);

  const resetLiveStudioState = useCallback(() => {
    identityEpochRef.current += 1;
    authGenerationRef.current = nextLiveStudioDataResetGeneration(authGenerationRef.current);
    dashboardSummaryRequestSeqRef.current += 1;
    authUserIdRef.current = null;
    setCurrentUser(null);
    setStudioTimezone("UTC");
    setCurrentStudioId(null);
    currentRoleRef.current = null;
    authoritativeIdentityRef.current = null;
    authoritativeStudioIdRef.current = null;
    setIdentityGeneration((value) => value + 1);
    setIdentityLoadError(null);
    setCurrentRole(null);
    setIdentityReady(false);
    setStaffProfilesAvailable(false);
    applyLiveStudioDataResetState(buildSignedOutStudioResetState());
  }, [applyLiveStudioDataResetState]);

  const commitAuthoritativeAuthProfile = useCallback((
    authProfile: AuthProfileResponse,
    legalNameRead?: { revision: number; epoch: number }
  ) => {
    authoritativeStudioIdRef.current = authProfile.studio_id ?? null;
    const identity = `${authProfile.user.id}:${authProfile.studio_id ?? ""}:${authProfile.role ?? ""}`;
    const preserveLegalName = legalNameRead !== undefined
      && legalNameRead.epoch === identityEpochRef.current
      && legalNameRead.revision < selfLegalNameRevisionRef.current
      && authoritativeIdentityRef.current === identity
      && authProfile.membership_status === "active";
    if (authoritativeIdentityRef.current !== identity) {
      identityEpochRef.current += 1;
      authoritativeIdentityRef.current = identity;
      setIdentityGeneration((value) => value + 1);
    }
    setIdentityLoadError(null);
    currentRoleRef.current = authProfile.role ?? null;
    setCurrentUser((current) => {
      const profile = buildAuthUserProfile(authProfile);
      return preserveLegalName && current?.id === profile.id
        ? { ...profile, legal_first_name: current.legal_first_name, legal_last_name: current.legal_last_name }
        : profile;
    });
    setCurrentStudioId(
      authProfile.membership_status === "active" ? authProfile.studio_id ?? null : null
    );
    setCurrentRole(authProfile.role ?? null);
    setStaffProfilesAvailable(isStaffProfilesAvailable(authProfile));
    setIdentityReady(true);
  }, []);

  const applySubscriptionRequiredState = useCallback((
    authProfile: AuthProfileResponse,
    sessionUser: { id: string; email?: string | null; user_metadata?: { full_name?: string | null } }
  ) => {
    identityEpochRef.current += 1;
    authGenerationRef.current = nextLiveStudioDataResetGeneration(authGenerationRef.current);
    dashboardSummaryRequestSeqRef.current += 1;

    authUserIdRef.current = sessionUser.id;
    commitAuthoritativeAuthProfile(authProfile);
    syncStoredStudioSessionCookies(
      sessionUser.id,
      authProfile.studio_id,
      authProfile.membership_status
    );

    applyLiveStudioDataResetState(buildSubscriptionRequiredStudioResetState());
  }, [applyLiveStudioDataResetState, commitAuthoritativeAuthProfile]);

  const applyAuthoritativeNoStudioState = useCallback((
    authProfile: AuthProfileResponse,
    sessionUser: { id: string; email?: string | null; user_metadata?: { full_name?: string | null } }
  ) => {
    syncStoredStudioSessionCookies(
      sessionUser.id,
      authProfile.studio_id,
      authProfile.membership_status
    );
    resetLiveStudioState();
    commitAuthoritativeAuthProfile(authProfile);
    setHydrated(true);
    router.replace(routeForMembershipStatus(authProfile.membership_status));
  }, [commitAuthoritativeAuthProfile, resetLiveStudioState, router]);

  const markSubscriptionRequired = useCallback(() => {
    identityEpochRef.current += 1;
    authGenerationRef.current = nextLiveStudioDataResetGeneration(authGenerationRef.current);
    dashboardSummaryRequestSeqRef.current += 1;
    // Subscription access gates studio data, not an already verified identity.
    // The recovery page still needs the dashboard shell and legal-name gate.
    applyLiveStudioDataResetState(buildSubscriptionRequiredStudioResetState());
  }, [applyLiveStudioDataResetState]);

  const clearSubscriptionRequired = useCallback(() => {
    const restored = buildSubscriptionAccessRestoreState();
    setSubscriptionRequired(restored.subscriptionRequired);
    setStaffLoaded(restored.staffLoaded);
    setStaffLoadError(restored.staffLoadError);
    setProgramsLoaded(restored.programsLoaded);
    setProgramsLoadError(restored.programsLoadError);
    setDashboardSummary(restored.dashboardSummary);
    setDashboardSummaryLoaded(restored.dashboardSummaryLoaded);
    setStudentsLoaded(restored.studentsLoaded);
    setStudentsLoadError(restored.studentsLoadError);
    setLeadsLoaded(restored.leadsLoaded);
    setLeadsLoadError(restored.leadsLoadError);
    destructivelyResetScheduleCoordinator();
    setScheduleLoadError(restored.scheduleLoadError);
    setScheduleStatus(restored.scheduleStatus);
  }, [setProgramsLoaded, destructivelyResetScheduleCoordinator]);

  useEffect(() => {
    if (!hydrated || !subscriptionRequired || pathname === "/subscription-required") {
      return;
    }

    router.replace("/subscription-required");
  }, [hydrated, pathname, router, subscriptionRequired]);

  const applyDemoResetResponse = useCallback((data: DemoResetResponse) => {
    resetProgramScope();
    setProgramsUsageLoaded(false);
    setProgramsUsageLoadError(null);
    dashboardSummaryRequestSeqRef.current += 1;
    destructivelyResetScheduleCoordinator(true);
    setStudioNameState(data.studio_name);
    commitStudents(data.students);
    setPrograms(data.programs || programsRef.current);
    setProgramsLoaded(true);
    setProgramsLoadError(null);
    setDashboardSummary(null);
    setDashboardSummaryLoaded(true);
    setScheduleLoadError(null);
    setScheduleStatus("ready");
    setLeads(data.leads);
    setLeadsLoaded(true);
    setLeadsLoadError(null);
    const selectedLadder = applyLadderSelection(
      resolveBootstrapLadders(data),
      data.primary_belt_ladder?.id ?? null
    );
    commitEligibilityRows(selectedLadder?.id ?? null, data.eligibility);
    setEligibilityPendingLadderId(null);
    setEligibilityLoadError(null);
    setTemplates(data.templates);
    setSessions(data.sessions.sort(compareSessions));
    setAttendance(data.attendance);
    clearPromotionHistoryCache();
  }, [setPrograms, setProgramsLoaded, resetProgramScope, applyLadderSelection, clearPromotionHistoryCache, commitEligibilityRows, commitStudents, destructivelyResetScheduleCoordinator, setSessions]);

  const applyClearedStudioData = useCallback((studioNameValue?: string) => {
    resetProgramScope();
    setProgramsUsageLoaded(false);
    setProgramsUsageLoadError(null);
    dashboardSummaryRequestSeqRef.current += 1;
    destructivelyResetScheduleCoordinator(true);
    if (studioNameValue) {
      setStudioNameState(studioNameValue);
      save(KEYS.studioName, studioNameValue);
    }
    commitStudents([]);
    setPrograms([]);
    setProgramsLoaded(true);
    setProgramsLoadError(null);
    setDashboardSummary(null);
    setDashboardSummaryLoaded(true);
    setScheduleLoadError(null);
    setScheduleStatus("ready");
    if (isPreviewMode) {
      save(KEYS.programs, []);
    }
    setLeads([]);
    setLeadsLoaded(true);
    setLeadsLoadError(null);
    setBeltLaddersState([]);
    updateCurrentLadderId(null);
    setLadderNameState("");
    setSubRankTermState("Stripe");
    setBeltRanksState([]);
    setTemplates([]);
    setSessions([]);
    setAttendance([]);
    clearEligibilityState();
    clearPromotionHistoryCache();
  }, [setPrograms, setProgramsLoaded, resetProgramScope,
    clearEligibilityState,
    clearPromotionHistoryCache,
    commitStudents,
    destructivelyResetScheduleCoordinator,
    isPreviewMode,
    setSessions,
    updateCurrentLadderId,
  ]);

  useEffect(() => {
    if (!isPreviewMode) {
      return;
    }

    const timer = window.setTimeout(() => {
      const hydrationDefaults = resolvePreviewLadderHydrationDefaults(
        {
          storedLadders: load(KEYS.beltLadders, MOCK_BELT_LADDERS),
          currentLadderId: currentLadderIdRef.current,
          fallbackLadders: MOCK_BELT_LADDERS,
          fallbackLadder: MOCK_BELT_LADDER,
        }
      );
      const hydratedLadderState = buildPreviewHydratedLadderState({
        previewLadders: hydrationDefaults.previewLadders,
        selectedPreviewLadder: hydrationDefaults.selectedPreviewLadder,
        storedRanks: load(KEYS.beltRanks, hydrationDefaults.defaultRanks),
        storedSubRankTerm: load(KEYS.subRankTerm, hydrationDefaults.defaultSubRankTerm),
        storedLadderName: load(KEYS.ladderName, hydrationDefaults.defaultLadderName),
        primaryEligibilityLadderId: MOCK_BELT_LADDER.id,
        primaryEligibilityRows: MOCK_ELIGIBILITY,
      });
      const hydratedStudents = load(KEYS.students, MOCK_STUDENTS);
      const hydratedPromotionHistory = load(KEYS.promotionHistory, {});
      const hydratedEligibility = buildPreviewEligibilityForLadder({
        ladderId: hydratedLadderState.eligibilityLadderId,
        beltLadders: hydratedLadderState.hydratedLadders,
        beltRanks: hydratedLadderState.hydratedLadders.find(
          (ladder) => ladder.id === hydratedLadderState.eligibilityLadderId
        )?.ranks || [],
        students: hydratedStudents,
        seedRows: hydratedLadderState.eligibilityRows,
        promotionHistoryByStudent: toPromotionHistoryByStudent(hydratedPromotionHistory),
      });

      setStudioNameState(load(KEYS.studioName, "My Studio"));
      commitStudents(hydratedStudents);
      promotionHistoryCacheRef.current = hydratedPromotionHistory;
      setPromotionHistoryCache(hydratedPromotionHistory);
      setPrograms(load(KEYS.programs, MOCK_PROGRAMS));
      setProgramsLoaded(true);
      setProgramsLoadError(null);
      setLeads(load(KEYS.leads, MOCK_LEADS));
      setLeadsLoaded(true);
      setLeadsLoadError(null);
      applyLadderSelection(hydratedLadderState.hydratedLadders, hydratedLadderState.eligibilityLadderId);
      commitEligibilityRows(
        hydratedLadderState.eligibilityLadderId,
        hydratedEligibility
      );
      setEligibilityPendingLadderId(null);
      setEligibilityLoadError(null);
      setTemplates(load(KEYS.templates, MOCK_CLASS_TEMPLATES));
      setSessions(load(KEYS.sessions, MOCK_SESSIONS).sort(compareSessions));
      setAttendance(load(KEYS.attendance, MOCK_ATTENDANCE));
      setStudentsLoaded(true);
      setStudentsLoadError(null);
      setCurrentUser((current) => current ? {
        ...current,
        legal_first_name: current.legal_first_name ?? "Demo",
        legal_last_name: current.legal_last_name ?? "User",
      } : current);
      setStaffProfilesAvailable(true);
      setIdentityReady(true);
      setIdentityGeneration((generation) => generation + 1);
      setHydrated(true);
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [setPrograms, setProgramsLoaded, applyLadderSelection, commitEligibilityRows, commitStudents, isPreviewMode, setSessions]);

  const previewEligibilityForLadder = useCallback((ladderId?: string | null): EligibilityEntry[] => {
    return buildPreviewEligibilityForLadder({
      ladderId,
      beltLadders: beltLaddersRef.current,
      beltRanks: beltRanksRef.current,
      students: studentsRef.current,
      seedRows: ladderId === MOCK_BELT_LADDER.id ? MOCK_ELIGIBILITY : [],
      promotionHistoryByStudent: toPromotionHistoryByStudent(promotionHistoryCacheRef.current),
    });
  }, []);

  const fetchEligibilityForLadder = useCallback(async (
    ladderId?: string | null,
    options?: { signal?: AbortSignal }
  ): Promise<EligibilityEntry[]> => {
    if (isPreviewMode) {
      return previewEligibilityForLadder(ladderId);
    }

    const authToken = tokenRef.current;
    if (!authToken) {
      throw new Error("Not authenticated");
    }

    if (!ladderId) {
      return [];
    }

    return api.get<EligibilityEntry[]>(
      `/belts/eligibility?ladder_id=${encodeURIComponent(ladderId)}`,
      authToken,
      options
    );
  }, [isPreviewMode, previewEligibilityForLadder]);

  const loadEligibilityForLadder = useCallback(async (
    ladderId?: string | null,
    options?: { force?: boolean }
  ): Promise<EligibilityEntry[]> => {
    const requestSeq = ++eligibilityRequestSeqRef.current;
    const liveRequest = isPreviewMode ? null : beginLiveAuthRequest();
    const isCurrentEligibilityRequest = () =>
      requestSeq === eligibilityRequestSeqRef.current &&
      currentLadderIdRef.current === ladderId &&
      (!liveRequest || liveRequest.isCurrent());
    setEligibilityLoadError(null);

    if (!ladderId) {
      commitEligibilityRows(null, []);
      setEligibilityPendingLadderId(null);
      return [];
    }

    const cachedRows = eligibilityCacheRef.current[ladderId];
    if (!options?.force && cachedRows) {
      if (isCurrentEligibilityRequest()) {
        commitEligibilityRows(ladderId, cachedRows);
        setEligibilityPendingLadderId(null);
      }

      void fetchEligibilityForLadder(ladderId)
        .then((rows) => {
          if (!isCurrentEligibilityRequest()) {
            return;
          }
          commitEligibilityRows(ladderId, rows);
          setEligibilityLoadError(null);
        })
        .catch((error) => {
          if (!isCurrentEligibilityRequest()) {
            return;
          }
          console.warn("Failed to refresh cached eligibility", error);
        });

      return cachedRows;
    }

    commitEligibilityRows(null, []);
    setEligibilityPendingLadderId(ladderId);

    try {
      const rows = await fetchEligibilityForLadder(ladderId);
      if (isCurrentEligibilityRequest()) {
        commitEligibilityRows(ladderId, rows);
        setEligibilityLoadError(null);
        setEligibilityPendingLadderId(null);
      }
      return rows;
    } catch (error) {
      if (isCurrentEligibilityRequest()) {
        commitEligibilityRows(null, []);
        setEligibilityPendingLadderId(null);
        setEligibilityLoadError(error instanceof Error ? error.message : "Eligibility could not be loaded.");
      }
      throw error;
    }
  }, [beginLiveAuthRequest, commitEligibilityRows, fetchEligibilityForLadder, isPreviewMode]);

  // Belt Tracker owns its initial eligibility read. Dashboard requests it only for a selected panel.
  useEffect(() => {
    if (pathname !== "/belt-tracker" || !identityReady || !currentLadderId
      || eligibilityLadderId === currentLadderId || eligibilityPendingLadderId
      || eligibilityLoadError) return;
    let current = true;
    queueMicrotask(() => {
      if (current) void loadEligibilityForLadder(currentLadderId).catch(() => undefined);
    });
    return () => { current = false; };
  }, [pathname, identityReady, currentLadderId, eligibilityLadderId,
    eligibilityPendingLadderId, eligibilityLoadError, loadEligibilityForLadder]);

  // Authentication and Data Fetching
  useEffect(() => {
    let mounted = true;
    let authNotificationRevision = 0;

    async function initializeLive(providedSession?: Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]) {
      const studentsRevisionAtStart = studentsRevisionRef.current;
      const programScope = programScopeRef.current;
      const programRevisionAtStart = programScope.revision;
      const programSequenceAtStart = ++programScope.sequence;
      const hadPendingProgramMutation = programScope.pending > 0;
      const ownsProgramBootstrap = () => !hadPendingProgramMutation
        && programScopeRef.current === programScope
        && programScope.sequence === programSequenceAtStart
        && programScope.revision === programRevisionAtStart && programScope.pending === 0;
      const leadMutationScope = leadMutationScopeRef.current;
      const leadMutationRevisionAtStart = leadMutationScope.revision;
      const leadReadSequenceAtStart = ++leadMutationScope.sequence;
      const hadPendingLeadMutation = leadMutationScope.pending > 0;
      const notificationRevision = authNotificationRevision;
      let session = providedSession;
      if (!session) {
        try {
          const result = await supabase.auth.getSession();
          if (!mounted || notificationRevision !== authNotificationRevision) return;
          if (result.error) throw result.error;
          session = result.data.session;
        } catch {
          if (!mounted || notificationRevision !== authNotificationRevision) return;
          // A refresh outage can leave the stored SDK session recoverable. Hide protected data,
          // but leave its storage and cookies intact so an explicit retry can recover.
          tokenRef.current = null;
          setToken(null);
          resetLiveStudioState();
          setIdentityLoadError("Your session could not be checked. Please retry.");
          setHydrated(true);
          return;
        }
      }
      if (!mounted || notificationRevision !== authNotificationRevision) {
        return;
      }

      if (!session) {
        tokenRef.current = null;
        setToken(null);
        clearStoredStudioSessionCookies();
        resetLiveStudioState();
        setHydrated(true);
        router.replace("/login");
        return;
      }

      const sessionToken = session.access_token;
      if (tokenRef.current !== sessionToken) {
        authGenerationRef.current += 1;
        dashboardSummaryRequestSeqRef.current += 1;
        destructivelyResetScheduleCoordinator();
      }
      const sessionGeneration = authGenerationRef.current;
      const isCurrentSession = () =>
        mounted &&
        isLiveAuthRequestCurrent({
          requestToken: sessionToken,
          requestGeneration: sessionGeneration,
          currentToken: tokenRef.current,
          currentGeneration: authGenerationRef.current,
        });

      tokenRef.current = sessionToken;
      authUserIdRef.current = session.user.id;
      setToken(sessionToken);
      setCurrentUser(buildSessionUserProfile(session.user));
      setInitialFeaturePending(true);
      setIdentityReady(false);
      setStaffProfilesAvailable(false);
      setIdentityLoadError(null);
      setHydrated(true);
      markPerformance("auth.session_resolved");
      const summarySequenceAtStart = dashboardSummaryRequestSeqRef.current;

      let workspaceRequest: ReturnType<typeof beginLiveAuthRequest> | null = null;
      const isInitializationCurrent = () => isCurrentSession()
        || Boolean(mounted && workspaceRequest?.isSameIdentity());
      try {
        markPerformance("workspace.started");
        // Allow the server's 30s interactive budget plus response transfer time.
        const legalNameRead = { revision: selfLegalNameRevisionRef.current, epoch: identityEpochRef.current };
        const workspaceData = await api.get<ApiDashboardWorkspaceResponse>("/dashboard/workspace", sessionToken, {
          timeoutMs: 35_000,
          timeoutMessage: "Workspace loading timed out. Please retry.",
        });
        markPerformance("workspace.finished");
        measurePerformance(
          "workspace.duration",
          "workspace.started",
          "workspace.finished"
        );

        if (isInitializationCurrent()) {
          const authProfile = parseAuthProfileResponse(workspaceData.auth);

          setSubscriptionRequired(false);
          commitAuthoritativeAuthProfile(authProfile, legalNameRead);
          syncStoredStudioSessionCookies(
            session.user.id,
            authProfile.studio_id,
            authProfile.membership_status
          );

          if (authProfile.membership_status !== "active" || !authProfile.studio_id) {
            applyAuthoritativeNoStudioState(authProfile, session.user);
            return;
          }

          workspaceRequest = beginLiveAuthRequest();
          setStudioTimezone(workspaceData.studio?.timezone ?? "UTC");
          setStudioNameState(workspaceData.studio?.name ?? "");
          setStudioLoadError(null);
          markPerformance("workspace.identity_ready");
          const initialPath = pathnameRef.current;
          const view = initialBootstrapView(initialPath);
          if (!view) return;
          const includedDatasets = bootstrapDatasets(view);
          // The protected shell is now usable. Only the route's feature payload
          // waits on this second request; failures cannot revoke verified identity.
          let criticalData: BootstrapResponse;
          markPerformance("dashboard.bootstrap_started");
          const featureRequest = { pathname: initialPath, controller: new AbortController() };
          bootstrapRequestRef.current = featureRequest;
          try {
            criticalData = await withCurrentLiveAuthRead(beginLiveAuthRequest, (request) =>
              api.get<BootstrapResponse>(`/dashboard/bootstrap?allow_partial=true&view=${view}`, request.token,
                { signal: featureRequest.controller.signal, timeoutMs: 35000, timeoutMessage: "Studio data loading timed out. Please retry." }), () => {});
          } catch (error) {
            if (featureRequest.controller.signal.aborted) return;
            if (!isInitializationCurrent()) return;
            if (isSubscriptionRequiredError(error) || isStaffArchivedError(error)) throw error;
            if (includedDatasets.has("students")) setStudentsLoadError("Student roster could not be loaded. Please retry.");
            if (ownsProgramBootstrap()) setProgramsLoadError("Programs could not be loaded. Please retry.");
            if (includedDatasets.has("leads")) setLeadsLoadError("Leads could not be loaded. Please retry.");
            return;
          } finally {
            if (bootstrapRequestRef.current === featureRequest) bootstrapRequestRef.current = null;
          }
          if (!isInitializationCurrent() || featureRequest.controller.signal.aborted) return;
          markPerformance("dashboard.bootstrap_finished");
          measurePerformance("dashboard.bootstrap_duration", "dashboard.bootstrap_started", "dashboard.bootstrap_finished");
          const featureAuth = parseAuthProfileResponse(criticalData.auth);
          if (featureAuth.user.id !== authProfile.user.id || featureAuth.studio_id !== authProfile.studio_id
            || featureAuth.role !== authProfile.role || featureAuth.membership_status !== "active") {
            resetLiveStudioState();
            setIdentityLoadError("Workspace access changed. Please retry.");
            return;
          }
          clearPromotionHistoryCache();
          const datasetErrors = criticalData.dataset_errors;
          setStudioNameState(datasetErrors?.studio ? "" : resolveBootstrapStudioName(criticalData));
          setStudioLoadError(datasetErrors?.studio ?? null);
          const bootstrapSummary = criticalData.summary ?? null;
          if (dashboardSummaryRequestSeqRef.current === summarySequenceAtStart && bootstrapSummary) {
            setDashboardSummary(bootstrapSummary);
            setDashboardSummaryLoaded(true);
          }
          if (ownsProgramBootstrap()) {
            if (!datasetErrors?.programs) setPrograms(criticalData.programs || []);
            setProgramsUsageLoaded(false);
            setProgramsUsageLoadError(null);
            setProgramsLoaded(!datasetErrors?.programs);
            setProgramsLoadError(datasetErrors?.programs ?? null);
          }
          if (includedDatasets.has("students") && studentsRevisionRef.current === studentsRevisionAtStart) {
            if (datasetErrors?.students) {
              setStudentsLoaded(false);
              setStudentsLoadError(datasetErrors.students);
              setStudentsMayBePartial(true);
            } else {
              commitStudents(criticalData.students, {
                mayBePartial: criticalData.students_may_be_partial
                  ?? criticalData.students.length >= (criticalData.students_page_size ?? 200),
              });
            }
          }
          if (includedDatasets.has("leads") && !hadPendingLeadMutation
            && leadMutationScope === leadMutationScopeRef.current
            && leadMutationScope.sequence === leadReadSequenceAtStart
            && leadMutationScope.revision === leadMutationRevisionAtStart
            && leadMutationScope.pending === 0) {
            if (!datasetErrors?.leads) setLeads(criticalData.leads);
            setLeadsLoaded(!datasetErrors?.leads);
            setLeadsLoadError(datasetErrors?.leads ?? null);
          }
          if (!includedDatasets.has("belts")) {
            // Omitted datasets remain unloaded so their owning route can request them.
          } else if (datasetErrors?.belts) {
            beltsHydratedRef.current = true;
            setBeltLaddersLoadError(datasetErrors.belts);
          } else {
            beltsHydratedRef.current = true;
            const selectedInitialLadder = applyLadderSelection(
              resolveBootstrapLadders(criticalData),
              criticalData.primary_belt_ladder?.id ?? null
            );
            if (!selectedInitialLadder) commitEligibilityRows(null, []);
          }

        }

        if (!isInitializationCurrent() || !["/dashboard", "/schedule"].includes(pathnameRef.current)) return;
        markPerformance("schedule.deferred_started");
        void refreshSchedule().then(() => {
          markPerformance("schedule.deferred_finished");
          measurePerformance(
            "schedule.deferred_duration",
            "schedule.deferred_started",
            "schedule.deferred_finished"
          );
        }).catch((error) => {
          console.error("Failed to load deferred dashboard data", error);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (isInitializationCurrent() && isStaffArchivedError(error)) {
          const authProfile = await api.get<unknown>(
            "/auth/me",
            tokenRef.current ?? sessionToken,
            { omitStudioHeader: true }
          )
            .then((response) => parseAuthProfileResponse(response))
            .catch(() => null);
          if (!isInitializationCurrent()) {
            return;
          }
          if (authProfile && (authProfile.membership_status !== "active" || !authProfile.studio_id)) {
            applyAuthoritativeNoStudioState(authProfile, session.user);
            return;
          }
        }
        if (isInitializationCurrent() && isSubscriptionRequiredError(error)) {
          const authProfile = await api.get<unknown>(
            "/auth/me",
            tokenRef.current ?? sessionToken,
            { omitStudioHeader: true }
          )
            .then((response) => parseAuthProfileResponse(response))
            .catch(() => null);
          if (!isInitializationCurrent()) {
            return;
          }
          if (authProfile) {
            if (authProfile.membership_status !== "active" || !authProfile.studio_id) {
              applyAuthoritativeNoStudioState(authProfile, session.user);
              return;
            }
            applySubscriptionRequiredState(authProfile, session.user);
          } else {
            markSubscriptionRequired();
            setIdentityLoadError("Your account and studio access could not be verified. Please retry.");
          }
          setHydrated(true);
          return;
        }
        if (isInitializationCurrent() && /Complete onboarding first|No studio found/i.test(message)) {
          resetLiveStudioState();
          setHydrated(true);
          router.replace("/onboarding");
          return;
        }
        if (isInitializationCurrent()) {
          const loadError = error instanceof Error
            ? error.message
            : "Initial studio data could not be loaded.";
          setIdentityReady(false);
          setStaffProfilesAvailable(false);
          setIdentityLoadError(loadError);
          setStudentsLoadError(loadError);
          if (ownsProgramBootstrap()) {
            setProgramsLoaded(false);
            setProgramsLoadError(loadError);
          }
          setLeadsLoaded(false);
          setLeadsLoadError(loadError);
          setDashboardSummary(null);
          setDashboardSummaryLoaded(true);
          setScheduleLoadError(loadError);
          setScheduleStatus("error");
          setHydrated(true);
        }
        console.error("Failed to load initial data", error);
      } finally {
        if (isInitializationCurrent()) setInitialFeaturePending(false);
      }
    }

    if (isPreviewMode) {
      return;
    }

    void initializeLive().catch((error) => {
      if (mounted) {
        setIdentityLoadError(error instanceof Error ? error.message : "Session could not be loaded.");
        setHydrated(true);
      }
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      // A fresh subscription also emits INITIAL_SESSION for an unchanged session.
      // It must not cancel a manual bootstrap retry waiting on getSession.
      if (event === "INITIAL_SESSION" && session
        && tokenRef.current === (session?.access_token ?? null)
        && authUserIdRef.current === (session?.user.id ?? null)) return;
      authNotificationRevision += 1;
      if (event === "INITIAL_SESSION" && !session) {
        // The SDK also emits this event when refreshing a stored session fails.
        // Confirm absence through getSession's error result outside the auth lock.
        tokenRef.current = null;
        setToken(null);
        resetLiveStudioState();
        setHydrated(true);
        const notificationRevision = authNotificationRevision;
        queueMicrotask(() => {
          if (mounted && notificationRevision === authNotificationRevision) {
            void initializeLive();
          }
        });
        return;
      }
      if (session) {
        const needsInitialization = authUserIdRef.current !== session.user.id
          || event === "USER_UPDATED"
          || (!authoritativeIdentityRef.current && tokenRef.current !== session.access_token);
        if (needsInitialization) {
          resetLiveStudioState();
          // Do not await a Supabase operation inside its auth notification lock.
          void initializeLive(session);
          return;
        }
        const tokenChanged = tokenRef.current !== session.access_token;
        if (tokenChanged) {
          const preservesScheduleGeneration = shouldPreserveScheduleMutationsOnAuthChange(
            event,
            authUserIdRef.current,
            session.user.id
          );
          if (scheduleCoordinatorRef.current.requestedRange) {
            setScheduleLoadError(null);
            setScheduleStatus("loading");
          }
          authGenerationRef.current += 1;
          if (preservesScheduleGeneration) {
            scheduleCoordinatorRef.current = refreshScheduleCoordinatorAuthState(
              scheduleCoordinatorRef.current
            );
          } else {
            destructivelyResetScheduleCoordinator();
          }
        }
        tokenRef.current = session.access_token;
        authUserIdRef.current = session.user.id;
        setToken(session.access_token);
        if (tokenChanged && scheduleCoordinatorRef.current.requestedRange) {
          void reconcileSchedule("read").catch((error) => {
            console.error("Failed to reconcile schedule after an auth token change", error);
          });
        }
      } else {
        tokenRef.current = null;
        authUserIdRef.current = null;
        setToken(null);
        clearStoredStudioSessionCookies();
        resetLiveStudioState();
        setHydrated(true);
        router.replace("/login");
      }
    });

    return () => {
      mounted = false;
      bootstrapRequestRef.current?.controller.abort();
      authListener?.subscription.unsubscribe();
    };
  }, [setPrograms, setProgramsLoaded, applyAuthoritativeNoStudioState, applyLadderSelection, applySubscriptionRequiredState, beginLiveAuthRequest, clearPromotionHistoryCache, commitAuthoritativeAuthProfile, commitEligibilityRows, commitStudents, destructivelyResetScheduleCoordinator, initializationAttempt, isPreviewMode, markSubscriptionRequired, reconcileSchedule, refreshSchedule, resetLiveStudioState, router, supabase]);

  // ── Persist helpers (for preview mode) ──
  const persistStudents = useCallback((next: Student[]) => {
    studentsRef.current = next;
    commitStudents(next);
    if (isPreviewMode) save(KEYS.students, next);
  }, [commitStudents, isPreviewMode]);

  const persistPrograms = useCallback((next: Program[]) => {
    const sorted = sortPrograms(next);
    setPrograms(sorted);
    setProgramsLoaded(true);
    setProgramsLoadError(null);
    if (isPreviewMode) save(KEYS.programs, sorted);
  }, [setPrograms, setProgramsLoaded, isPreviewMode]);

  const persistLeads = useCallback((next: Lead[]) => {
    setLeads(next);
    if (isPreviewMode) save(KEYS.leads, next);
  }, [isPreviewMode]);

  const {
    archiveProgram,
    createProgram,
    refreshPrograms,
    restoreProgram,
    updateProgram,
  } = useStoreProgramActions({
    applyLadderSelection,
    beginLiveAuthRequest,
    beltLaddersRef,
    currentLadderIdRef,
    isPreviewMode,
    persistPrograms,
    programsRef,
    programScopeRef,
    programsLoadedRef,
    refreshBeltsRef,
    setProgramsLoadError,
    setProgramsUsageLoaded,
    setProgramsUsageLoadError,
  });

  const persistBeltRanks = useCallback((next: BeltRank[]) => {
    setBeltRanksState(next);
    if (isPreviewMode) save(KEYS.beltRanks, next);
  }, [isPreviewMode]);

  const persistTemplates = useCallback((next: ClassTemplate[]) => {
    setTemplates(next);
    if (isPreviewMode) save(KEYS.templates, next);
  }, [isPreviewMode]);

  const persistSessions = useCallback((next: ClassSession[]) => {
    setSessions(next);
    if (isPreviewMode) save(KEYS.sessions, next);
  }, [isPreviewMode, setSessions]);

  const persistAttendance = useCallback((next: AttendanceRecord[]) => {
    setAttendance(next);
    if (isPreviewMode) save(KEYS.attendance, next);
  }, [isPreviewMode]);

  const onStudentMutation = useCallback(() => {
    invalidateEligibilityAfterStudentMutation({
      clearCurrentEligibility: () => commitEligibilityRows(null, []),
      currentLadderIdRef,
      eligibilityCacheRef,
      onRefreshError: (error) => {
        console.error("Failed to refresh belt eligibility after student mutation", error);
      },
      refreshEligibility: loadEligibilityForLadder,
    });
  }, [commitEligibilityRows, loadEligibilityForLadder]);

  // ── Students ──
  const {
    addStudent,
    deleteStudents,
    listStudentsPage,
    refreshStudents,
    updateStudent,
  } = useStoreStudentRosterActions({
    beginLiveAuthRequest,
    beltLaddersRef,
    beltRanksRef,
    commitStudents,
    isPreviewMode,
    onStudentMutation,
    persistStudents,
    previewStudentPhotoUrlsRef,
    programsRef,
    setStudentsLoadError,
    studentsMayBePartial,
    studentMutationEpochRef,
    studentRosterRequestSequenceRef,
    studentsRef,
    token,
  });

  const {
    deleteStudentPhoto,
    uploadStudentPhoto,
  } = useStoreStudentPhotoActions({
    beginLiveAuthRequest,
    commitStudents,
    isPreviewMode,
    previewStudentPhotoUrlsRef,
    studentMutationEpochRef,
    studentsMayBePartial,
    studentsRef,
  });

  const { importStudents } = useStoreStudentImportActions({
    beginLiveAuthRequest,
    beltLaddersRef,
    beltRanksRef,
    commitStudents,
    isPreviewMode,
    onStudentMutation,
    persistStudents,
    programsRef,
    refreshBeltsRef,
    refreshPrograms,
    setStudentsLoadError,
    studentMutationEpochRef,
    studentRosterRequestSequenceRef,
    studentsRef,
  });

  const {
    bulkAddTagsToStudents,
    bulkUpdateStudentStatus,
  } = useStoreStudentBulkActions({
    beginLiveAuthRequest,
    commitStudents,
    isPreviewMode,
    onStudentMutation,
    persistStudents,
    refreshStudents,
    studentMutationEpochRef,
    studentsMayBePartial,
    studentsRef,
  });

  const {
    addLead,
    convertLeadToStudent,
    deleteLead,
    refreshLeads,
    updateLead,
  } = useStoreLeadActions({
    businessDateRef,
    beginLeadMutation,
    leadMutationScopeRef,
    beginLiveAuthRequest,
    beltLaddersRef,
    beltRanksRef,
    isPreviewMode,
    leadsRef,
    onStudentMutation,
    persistLeads,
    persistStudents,
    programsRef,
    refreshStudents,
    setLeads,
    setLeadsLoaded,
    setLeadsLoadError,
    studentsRef,
  });

  // ── Belt tracker ──
  const {
    demoteStudent,
    loadPromotionHistory,
    promoteStudent,
    setBeltRanks,
    setCurrentLadder,
  } = useStoreBeltActions({
    applyLadderSelection,
    beginLiveAuthRequest,
    beltLaddersRef,
    beltRanksRef,
    commitPromotionHistoryCache,
    currentLadderIdRef,
    isPreviewMode,
    ladderName,
    loadEligibilityForLadder,
    persistBeltRanks,
    persistStudents,
    promotionHistoryCacheRef,
    promotionHistoryGenerationRef,
    promotionHistoryRequestsRef,
    refreshBeltsRef,
    refreshStudents,
    setEligibilityLoadError,
    setEligibilityPendingLadderId,
    studentsRef,
    subRankTerm,
  });

  // ── Schedule ──
  const {
    addSession,
    addTemplate,
    deleteSession,
    refreshScheduleRange,
    refreshSessionAttendance,
    toggleCheckIn,
  } = useStoreScheduleActions({
    attendanceRef,
    beginLiveAuthRequest,
    isPreviewMode,
    persistAttendance,
    persistSessions,
    persistTemplates,
    reconcileSchedule,
    scheduleCoordinatorRef,
    sessionsRef,
    setAttendance,
    setScheduleLoadError,
    setScheduleStatus,
    setSessions,
    setTemplates,
    templatesRef,
  });

  const onStaffLegalNameCommitted = useCallback((response: StaffLegalNameResponse) => {
    if (response.user_id !== authUserIdRef.current) return;
    selfLegalNameRevisionRef.current += 1;
    setCurrentUser((current) => current?.id === response.user_id
      ? { ...current, legal_first_name: response.legal_first_name, legal_last_name: response.legal_last_name }
      : current);
    setStaffProfilesAvailable(true);
  }, []);

  const revalidateSelfStaffAccess = useCallback(() => {
    clearStoredStudioSessionCookies();
    resetLiveStudioState();
    retryInitialization();
  }, [resetLiveStudioState, retryInitialization]);

  const {
    archiveStaff,
    inviteStaff,
    refreshStaff,
    removeStaff,
    scheduleStaffDeletion,
    unarchiveStaff,
    updateStaffLegalName,
    updateStaffRole,
  } = useStoreStaffActions({
    activeUserEmail: currentUser?.email || "",
    activeUserId,
    beginLiveAuthRequest,
    isPreviewMode,
    setStaffLoadError,
    setStaffLoaded,
    setStaffMembers,
    staffMembers,
    staffScopeRef,
    onLegalNameCommitted: onStaffLegalNameCommitted,
    revalidateSelfAccess: revalidateSelfStaffAccess,
  });

  const {
    clearStudioData,
    resetDemoData,
    setStudioName,
    updateUserLegalName,
    updateUserName,
  } = useStoreStudioActions({
    activeUserId,
    applyClearedStudioData,
    applyDemoResetResponse,
    attendanceRef,
    beginLiveAuthRequest,
    beltRanksRef,
    isPreviewMode,
    leadsRef,
    persistPrograms,
    sessionsRef,
    setCurrentUser,
    staffScopeRef,
    resetStaffScope,
    updateStaffLegalName,
    setStaffLoadError,
    setStaffLoaded,
    setStaffMembers,
    setStudioNameState,
    studentsRef,
    studioName,
    supabase,
  });

  useEffect(() => {
    if (isPreviewMode || !identityReady || subscriptionRequired || initialFeaturePending) return;
    const timer = window.setTimeout(() => {
      if (["/dashboard", "/belt-tracker"].includes(pathname) && !beltsHydratedRef.current) {
        beltsHydratedRef.current = true;
        void refreshBeltsRef.current?.().catch(() => setBeltLaddersLoadError("Belt plans could not be loaded. Please retry."));
      }
      if (pathname === "/dashboard" && scheduleStatus === "idle") void refreshSchedule().catch(() => undefined);
      if (pathname === "/dashboard" && !studentsLoaded && !studentsLoadError) {
        void refreshStudents().catch(() => undefined);
      }
      if (["/dashboard", "/leads", "/reports"].includes(pathname) && !leadsLoaded && !leadsLoadError) {
        void refreshLeads().catch(() => undefined);
      }
      const needsPrograms = ["/dashboard", "/settings", "/leads", "/reports", "/schedule", "/belt-tracker"].includes(pathname)
        || pathname === "/students" || pathname.startsWith("/students/");
      if (needsPrograms && !programsLoaded && !programsLoadError) {
        void refreshPrograms({ includeArchived: true }).catch(() => undefined);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [identityReady, initialFeaturePending, isPreviewMode, pathname, subscriptionRequired,
    studentsLoaded, studentsLoadError, leadsLoaded, leadsLoadError, programsLoaded, programsLoadError,
    refreshStudents, refreshLeads, refreshPrograms, refreshSchedule, scheduleStatus]);

  useEffect(() => {
    if (isPreviewMode || !identityReady) return;
    let disposed = false;
    let queued = false;
    let running = false;
    let refreshDataAllowed = true;
    async function drain() {
      if (disposed || running || !queued || pendingCommands()) return;
      queued = false;
      running = true;
      let request: ReturnType<typeof beginLiveAuthRequest> | null = null;
      try {
        request = beginLiveAuthRequest();
        let legalNameRead: { revision: number; epoch: number } | undefined;
        const workspace = await withCurrentLiveAuthRead(beginLiveAuthRequest, current => {
          legalNameRead = { revision: selfLegalNameRevisionRef.current, epoch: identityEpochRef.current };
          return api.get<ApiDashboardWorkspaceResponse>("/dashboard/workspace", current.token, { timeoutMs: 35000 });
        }, () => {});
        if (disposed || !request?.isSameIdentity()) return;
        const profile = parseAuthProfileResponse(workspace.auth);
        if (profile.user.id !== authUserIdRef.current || profile.studio_id !== authoritativeStudioIdRef.current
          || profile.role !== currentRoleRef.current || profile.membership_status !== "active") {
          // A changed access scope cannot reuse any of the previous scope's records.
          clearStoredStudioSessionCookies();
          resetLiveStudioState();
          retryInitialization();
          return;
        }
        if (pendingCommands() || queued) { queued = true; return; }
        if (subscriptionRequired) {
          clearSubscriptionRequired();
          retryInitialization();
          if (pathnameRef.current === "/subscription-required") router.replace("/dashboard");
          return;
        }
        commitAuthoritativeAuthProfile(profile, legalNameRead);
        setStudioNameState(workspace.studio?.name ?? "");
        setStudioTimezone(workspace.studio?.timezone ?? "UTC");
        setStudioLoadError(null);
        syncStoredStudioSessionCookies(profile.user.id, profile.studio_id, profile.membership_status);
        if (!refreshDataAllowed) return;
        if (pathnameRef.current === "/belt-tracker"
          || (pathnameRef.current.startsWith("/students/") && pathnameRef.current !== "/students/import")) {
          const owner = request;
          void Promise.resolve(refreshBeltsRef.current?.()).then(async () => {
            if (disposed || !owner.isSameIdentity()) return;
            if (pathnameRef.current === "/belt-tracker") await loadEligibilityForLadder(currentLadderIdRef.current, { force: true });
          }).catch(() => {
            if (!disposed && owner.isSameIdentity()) setBeltLaddersLoadError("Belt plans could not be refreshed. Please retry.");
          });
        }
        window.dispatchEvent(new Event(APP_DATA_REFRESH_EVENT));
      } catch (error) {
        if (disposed || !request?.isSameIdentity()) return;
        if (isSubscriptionRequiredError(error)) markSubscriptionRequired();
        else if (error && typeof error === "object" && "status" in error && Number(error.status) === 401) {
          tokenRef.current = null;
          setToken(null);
          clearStoredStudioSessionCookies();
          resetLiveStudioState();
          router.replace("/login");
        } else if (isStaffArchivedError(error) || (error && typeof error === "object" && "status" in error && Number(error.status) === 403)) {
          clearStoredStudioSessionCookies();
          resetLiveStudioState();
          retryInitialization();
        } else {
          setStudioLoadError("Workspace refresh is unavailable. Your current work is retained. Please retry when connected.");
        }
      } finally {
        running = false;
        if (queued && !disposed) void drain();
      }
    }
    const onResume = (event: Event) => {
      refreshDataAllowed = !(event instanceof CustomEvent && event.detail?.refreshData === false);
      queued = true;
      void drain();
    };
    const unsubscribe = subscribePendingCommands(() => { if (running) queued = true; void drain(); });
    window.addEventListener(APP_RESUME_EVENT, onResume);
    return () => { disposed = true; unsubscribe(); window.removeEventListener(APP_RESUME_EVENT, onResume); };
  }, [beginLiveAuthRequest, commitAuthoritativeAuthProfile, identityReady, isPreviewMode,
    clearSubscriptionRequired, loadEligibilityForLadder, markSubscriptionRequired,
    resetLiveStudioState, retryInitialization, router, subscriptionRequired]);

  // These confirmed business commands affect dashboard facts. Billing commands
  // live outside this store; dashboard route entry also requests fresh facts.
  const beginProjectionCommand = useCallback(() => {
    if (isPreviewMode) return () => {};
    markDashboardFactsChanged();
    const request = beginLiveAuthRequest();
    dashboardSummaryRequestSeqRef.current += 1;
    return () => {
      if (request.isSameIdentity()) {
        markDashboardFactsChanged();
        dashboardSummaryRequestSeqRef.current += 1;
        if (pathnameRef.current === "/dashboard") {
          void refreshDashboardSummary().catch(() => undefined);
        }
      }
    };
  }, [beginLiveAuthRequest, isPreviewMode, refreshDashboardSummary]);
  const reconciledCommands = {
    addStudent: useReconciledProjectionCommand(addStudent, beginProjectionCommand),
    updateStudent: useReconciledProjectionCommand(updateStudent, beginProjectionCommand),
    deleteStudents: useReconciledProjectionCommand(deleteStudents, beginProjectionCommand),
    bulkUpdateStudentStatus: useReconciledProjectionCommand(bulkUpdateStudentStatus, beginProjectionCommand),
    importStudents: useReconciledProjectionCommand(importStudents, beginProjectionCommand),
    addLead: useReconciledProjectionCommand(addLead, beginProjectionCommand),
    updateLead: useReconciledProjectionCommand(updateLead, beginProjectionCommand),
    deleteLead: useReconciledProjectionCommand(deleteLead, beginProjectionCommand),
    convertLeadToStudent: useReconciledProjectionCommand(convertLeadToStudent, beginProjectionCommand),
    toggleCheckIn: useReconciledProjectionCommand(toggleCheckIn, beginProjectionCommand),
    promoteStudent: useReconciledProjectionCommand(promoteStudent, beginProjectionCommand),
    demoteStudent: useReconciledProjectionCommand(demoteStudent, beginProjectionCommand),
    createProgram: useReconciledProjectionCommand(createProgram, beginProjectionCommand),
    updateProgram: useReconciledProjectionCommand(updateProgram, beginProjectionCommand),
    archiveProgram: useReconciledProjectionCommand(archiveProgram, beginProjectionCommand),
    restoreProgram: useReconciledProjectionCommand(restoreProgram, beginProjectionCommand),
    addSession: useReconciledProjectionCommand(addSession, beginProjectionCommand),
    deleteSession: useReconciledProjectionCommand(deleteSession, beginProjectionCommand),
    addTemplate: useReconciledProjectionCommand(addTemplate, beginProjectionCommand),
    setBeltRanks: useReconciledProjectionCommand(setBeltRanks, beginProjectionCommand),
  };

  const contextValues = useStoreContextValues({
    addLead: reconciledCommands.addLead,
    addSession: reconciledCommands.addSession,
    addStudent: reconciledCommands.addStudent,
    addTemplate: reconciledCommands.addTemplate,
    archiveStaff,
    archiveProgram: reconciledCommands.archiveProgram,
    attendance,
    beltLadders,
    beltLaddersLoadError,
    beltRanks,
    bulkAddTagsToStudents,
    bulkUpdateStudentStatus: reconciledCommands.bulkUpdateStudentStatus,
    clearStudioData,
    clearSubscriptionRequired,
    convertLeadToStudent: reconciledCommands.convertLeadToStudent,
    createProgram: reconciledCommands.createProgram,
    currentLadderId,
    currentRole,
    currentStudioId,
    currentUserId: activeUserId || "",
    dashboardSummary,
    dashboardSummaryLoaded,
    dashboardSummaryLoadError,
    refreshDashboardSummary,
    deleteLead: reconciledCommands.deleteLead,
    deleteSession: reconciledCommands.deleteSession,
    deleteStudentPhoto,
    deleteStudents: reconciledCommands.deleteStudents,
    demoteStudent: reconciledCommands.demoteStudent,
    eligibility,
    eligibilityLadderId,
    eligibilityLoadError,
    eligibilityPendingLadderId,
    importStudents: reconciledCommands.importStudents,
    inviteStaff,
    isPreviewMode,
    businessDate,
    studioTimezone,
    ladderName,
    leads,
    leadsLoaded,
    leadsLoadError,
    listStudentsPage,
    loadPromotionHistory,
    loadEligibilityForLadder,
    markSubscriptionRequired,
    programs,
    programsLoaded,
    programsUsageLoaded,
    programsUsageLoadError,
    programsLoadError,
    promoteStudent: reconciledCommands.promoteStudent,
    promotionHistoryCache,
    refreshLeads,
    refreshPrograms,
    refreshSchedule,
    refreshScheduleRange,
    refreshSessionAttendance,
    refreshStaff,
    refreshStudents,
    removeStaff,
    resetDemoData,
    restoreProgram: reconciledCommands.restoreProgram,
    scheduleLoadError,
    scheduleStatus,
    scheduleStaffDeletion,
    sessions,
    setBeltRanks: reconciledCommands.setBeltRanks,
    setCurrentLadder,
    setStudioName,
    staffLoadError,
    staffLoaded,
    staffMembers,
    staffProfilesAvailable,
    students,
    studentsLastLoadedAt,
    studentsLoadError,
    studentsLoaded,
    studentsMayBePartial,
    studioName,
    studioLoadError,
    subRankTerm,
    subscriptionRequired,
    templates,
    toggleCheckIn: reconciledCommands.toggleCheckIn,
    token,
    identityGeneration,
    identityReady,
    identityLoadError,
    retryInitialization,
    unarchiveStaff,
    updateLead: reconciledCommands.updateLead,
    updateProgram: reconciledCommands.updateProgram,
    updateStaffLegalName,
    updateStaffRole,
    updateStudent: reconciledCommands.updateStudent,
    updateUserLegalName,
    updateUserName,
    uploadStudentPhoto,
    userEmail: currentUser?.email || "",
    userName: currentUser?.full_name || "",
    legalFirstName: currentUser?.legal_first_name ?? "",
    legalLastName: currentUser?.legal_last_name ?? "",
  });

  return (
    <StoreContextProviders values={contextValues}>
      {children}
    </StoreContextProviders>
  );
}

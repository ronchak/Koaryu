"use client";

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
  StaffMember, StaffRoleName, DashboardSummary,
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
  isDashboardSummaryForStudio,
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
  const [identityReady, setIdentityReady] = useState(false);
  const [identityLoadError, setIdentityLoadError] = useState<string | null>(null);
  const [identityGeneration, setIdentityGeneration] = useState(0);
  const authoritativeIdentityRef = useRef<string | null>(null);
  const identityEpochRef = useRef(0);
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const retryInitialization = useCallback(() => setInitializationAttempt((value) => value + 1), []);
  const [token, setToken] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const authGenerationRef = useRef(0);
  const router = useRouter();
  const pathname = usePathname();
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
  const [dashboardSummaryLoaded, setDashboardSummaryLoaded] = useState(isPreviewMode);
  const dashboardSummaryRequestSeqRef = useRef(0);
  const studentsRef = useRef<Student[]>(students);
  const studentsRevisionRef = useRef(0);
  const studentMutationEpochRef = useRef(0);
  const studentRosterRequestSequenceRef = useRef(0);
  const previewStudentPhotoUrlsRef = useRef<Record<string, string>>({});
  const [programs, setPrograms] = useState<Program[]>(() =>
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
  const [programsUsageLoaded, setProgramsUsageLoaded] = useState(isPreviewMode);
  const [programsUsageLoadError, setProgramsUsageLoadError] = useState<string | null>(null);
  const [leads, setLeads] = useState<Lead[]>(() =>
    isPreviewMode ? MOCK_LEADS : []
  );
  const [leadsLoaded, setLeadsLoaded] = useState(isPreviewMode);
  const [leadsLoadError, setLeadsLoadError] = useState<string | null>(null);
  const leadsRef = useRef<Lead[]>(leads);
  const [beltLadders, setBeltLaddersState] = useState<BeltLadder[]>(() =>
    isPreviewMode ? MOCK_BELT_LADDERS : []
  );
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

  const reconcileScheduleAttempt = useCallback(async (
    intent: ScheduleRangeRefreshIntent
  ) => {
    const request = beginLiveAuthRequest();
    const coordinator = scheduleCoordinatorRef.current;
    const { startDate, endDate } = resolveScheduleReconciliationRange(
      coordinator,
      buildDeferredScheduleDateRange()
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

  useSyncedRefValue(programsRef, programs);

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
  }, [setProgramsLoaded, destructivelyResetScheduleCoordinator, setSessions, updateCurrentLadderId]);

  const resetLiveStudioState = useCallback(() => {
    identityEpochRef.current += 1;
    authGenerationRef.current = nextLiveStudioDataResetGeneration(authGenerationRef.current);
    dashboardSummaryRequestSeqRef.current += 1;
    authUserIdRef.current = null;
    setCurrentUser(null);
    setCurrentStudioId(null);
    currentRoleRef.current = null;
    authoritativeIdentityRef.current = null;
    setIdentityGeneration((value) => value + 1);
    setIdentityLoadError(null);
    setCurrentRole(null);
    setIdentityReady(false);
    setStaffProfilesAvailable(false);
    applyLiveStudioDataResetState(buildSignedOutStudioResetState());
  }, [applyLiveStudioDataResetState]);

  const commitAuthoritativeAuthProfile = useCallback((authProfile: AuthProfileResponse) => {
    const identity = `${authProfile.user.id}:${authProfile.studio_id ?? ""}:${authProfile.role ?? ""}`;
    if (authoritativeIdentityRef.current !== identity) {
      identityEpochRef.current += 1;
      authoritativeIdentityRef.current = identity;
      setIdentityGeneration((value) => value + 1);
    }
    setIdentityLoadError(null);
    currentRoleRef.current = authProfile.role ?? null;
    setCurrentUser(buildAuthUserProfile(authProfile));
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
  }, [setProgramsLoaded, applyLadderSelection, clearPromotionHistoryCache, commitEligibilityRows, commitStudents, destructivelyResetScheduleCoordinator, setSessions]);

  const applyClearedStudioData = useCallback((studioNameValue?: string) => {
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
  }, [setProgramsLoaded,
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
  }, [setProgramsLoaded, applyLadderSelection, commitEligibilityRows, commitStudents, isPreviewMode, setSessions]);

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
      setIdentityReady(false);
      setStaffProfilesAvailable(false);
      setIdentityLoadError(null);
      setHydrated(true);
      markPerformance("auth.session_resolved");

      try {
        markPerformance("dashboard.bootstrap_started");
        const criticalData = await api.get<BootstrapResponse>("/dashboard/bootstrap?allow_partial=true", sessionToken);
        markPerformance("dashboard.bootstrap_finished");
        measurePerformance(
          "dashboard.bootstrap_duration",
          "dashboard.bootstrap_started",
          "dashboard.bootstrap_finished"
        );

        if (isCurrentSession()) {
          const authProfile = parseAuthProfileResponse(criticalData.auth);

          setSubscriptionRequired(false);
          commitAuthoritativeAuthProfile(authProfile);
          syncStoredStudioSessionCookies(
            session.user.id,
            authProfile.studio_id,
            authProfile.membership_status
          );

          if (authProfile.membership_status !== "active" || !authProfile.studio_id) {
            applyAuthoritativeNoStudioState(authProfile, session.user);
            return;
          }

          clearPromotionHistoryCache();
          const datasetErrors = criticalData.dataset_errors;
          setStudioNameState(datasetErrors?.studio ? "" : resolveBootstrapStudioName(criticalData));
          setStudioLoadError(datasetErrors?.studio ?? null);
          const bootstrapSummary = criticalData.summary ?? null;
          setDashboardSummary(bootstrapSummary);
          setDashboardSummaryLoaded(Boolean(bootstrapSummary));
          if (!datasetErrors?.programs) setPrograms(criticalData.programs || []);
          setProgramsUsageLoaded(false);
          setProgramsUsageLoadError(null);
          setProgramsLoaded(!datasetErrors?.programs);
          setProgramsLoadError(datasetErrors?.programs ?? null);
          if (studentsRevisionRef.current === studentsRevisionAtStart) {
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
          if (!datasetErrors?.leads) setLeads(criticalData.leads);
          setLeadsLoaded(!datasetErrors?.leads);
          setLeadsLoadError(datasetErrors?.leads ?? null);
          if (datasetErrors?.belts) {
            setBeltLaddersLoadError(datasetErrors.belts);
          } else {
            const selectedInitialLadder = applyLadderSelection(
              resolveBootstrapLadders(criticalData),
              criticalData.primary_belt_ladder?.id ?? null
            );
            if (!selectedInitialLadder) commitEligibilityRows(null, []);
          }

          if (!bootstrapSummary) {
            const summaryRequestSeq = dashboardSummaryRequestSeqRef.current + 1;
            dashboardSummaryRequestSeqRef.current = summaryRequestSeq;
            const summaryStudioId = authProfile.studio_id;
            const summaryIdentityEpoch = identityEpochRef.current;
            const isSummaryOwnerCurrent = () => mounted
              && identityEpochRef.current === summaryIdentityEpoch
              && dashboardSummaryRequestSeqRef.current === summaryRequestSeq;
            const failSummary = (error: unknown) => {
              if (!isSummaryOwnerCurrent()) return;
              console.warn("Failed to load dashboard summary", error);
              setDashboardSummary(null);
              setDashboardSummaryLoaded(true);
            };

            markPerformance("dashboard.summary_started");
            void withCurrentLiveAuthRead(() => {
              const request = beginLiveAuthRequest();
              return {
                ...request,
                canRetryAfterTokenChange: () => isSummaryOwnerCurrent()
                  && request.canRetryAfterTokenChange(),
              };
            }, async (request) => {
              try {
                const summaryRes = await api.get<DashboardSummary>(
                  "/dashboard/summary",
                  request.token,
                  { timeoutMs: 30000, timeoutMessage: "Dashboard summary timed out." }
                );
                if (!isSummaryOwnerCurrent() || !request.isCurrent()
                  || !isDashboardSummaryForStudio(summaryRes, summaryStudioId)) return;
                setDashboardSummary(summaryRes);
                setDashboardSummaryLoaded(true);
                markPerformance("dashboard.summary_finished");
                measurePerformance(
                  "dashboard.summary_duration",
                  "dashboard.summary_started",
                  "dashboard.summary_finished",
                  { source: "deferred" }
                );
              } catch (error) {
                if (request.isCurrent()) failSummary(error);
                throw error;
              }
            }, failSummary).catch(() => undefined);
          }
        }

        if (!isCurrentSession()) return;
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
        if (isCurrentSession() && isStaffArchivedError(error)) {
          const authProfile = await api.get<unknown>(
            "/auth/me",
            sessionToken,
            { omitStudioHeader: true }
          )
            .then((response) => parseAuthProfileResponse(response))
            .catch(() => null);
          if (!isCurrentSession()) {
            return;
          }
          if (authProfile && (authProfile.membership_status !== "active" || !authProfile.studio_id)) {
            applyAuthoritativeNoStudioState(authProfile, session.user);
            return;
          }
        }
        if (isCurrentSession() && isSubscriptionRequiredError(error)) {
          const authProfile = await api.get<unknown>(
            "/auth/me",
            sessionToken,
            { omitStudioHeader: true }
          )
            .then((response) => parseAuthProfileResponse(response))
            .catch(() => null);
          if (!isCurrentSession()) {
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
        if (isCurrentSession() && /Complete onboarding first|No studio found/i.test(message)) {
          resetLiveStudioState();
          setHydrated(true);
          router.replace("/onboarding");
          return;
        }
        if (isCurrentSession()) {
          const loadError = error instanceof Error
            ? error.message
            : "Initial studio data could not be loaded.";
          setIdentityReady(false);
          setStaffProfilesAvailable(false);
          setIdentityLoadError(loadError);
          setStudentsLoadError(loadError);
          setProgramsLoaded(false);
          setProgramsLoadError(loadError);
          setLeadsLoaded(false);
          setLeadsLoadError(loadError);
          setDashboardSummary(null);
          setDashboardSummaryLoaded(true);
          setScheduleLoadError(loadError);
          setScheduleStatus("error");
          setHydrated(true);
        }
        console.error("Failed to load initial data", error);
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
          setScheduleLoadError(null);
          setScheduleStatus("loading");
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
        if (tokenChanged) {
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
      authListener?.subscription.unsubscribe();
    };
  }, [setProgramsLoaded, applyAuthoritativeNoStudioState, applyLadderSelection, applySubscriptionRequiredState, beginLiveAuthRequest, clearPromotionHistoryCache, commitAuthoritativeAuthProfile, commitEligibilityRows, commitStudents, destructivelyResetScheduleCoordinator, initializationAttempt, isPreviewMode, markSubscriptionRequired, reconcileSchedule, refreshSchedule, resetLiveStudioState, router, supabase]);

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
  }, [setProgramsLoaded, isPreviewMode]);

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
    setLadderName,
    setSubRankTerm,
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
    setLadderNameState,
    setSubRankTermState,
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
    setStaffProfilesAvailable,
    setStaffLoadError,
    setStaffLoaded,
    setStaffMembers,
    setStudioNameState,
    studentsRef,
    studioName,
    supabase,
  });

  const contextValues = useStoreContextValues({
    addLead,
    addSession,
    addStudent,
    addTemplate,
    archiveStaff,
    archiveProgram,
    attendance,
    beltLadders,
    beltLaddersLoadError,
    beltRanks,
    bulkAddTagsToStudents,
    bulkUpdateStudentStatus,
    clearStudioData,
    clearSubscriptionRequired,
    convertLeadToStudent,
    createProgram,
    currentLadderId,
    currentRole,
    currentStudioId,
    currentUserId: activeUserId || "",
    dashboardSummary,
    dashboardSummaryLoaded,
    deleteLead,
    deleteSession,
    deleteStudentPhoto,
    deleteStudents,
    demoteStudent,
    eligibility,
    eligibilityLadderId,
    eligibilityLoadError,
    eligibilityPendingLadderId,
    importStudents,
    inviteStaff,
    isPreviewMode,
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
    promoteStudent,
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
    restoreProgram,
    scheduleLoadError,
    scheduleStatus,
    scheduleStaffDeletion,
    sessions,
    setBeltRanks,
    setCurrentLadder,
    setLadderName,
    setStudioName,
    setSubRankTerm,
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
    toggleCheckIn,
    token,
    identityGeneration,
    identityReady,
    identityLoadError,
    retryInitialization,
    unarchiveStaff,
    updateLead,
    updateProgram,
    updateStaffLegalName,
    updateStaffRole,
    updateStudent,
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

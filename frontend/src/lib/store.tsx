"use client";

import React, { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LoadingScreen } from "@/components/loading-screen";
import { createClient } from "@/lib/supabase/client";
import { api, isSubscriptionRequiredError } from "@/lib/api";
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
import { fetchStudentPage } from "@/lib/store-student-pages";
import { useSyncedRefValue } from "@/lib/store-ref-sync";
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
  type PromotionHistoryCache,
  type PromotionHistoryRequests,
} from "@/lib/store-promotion-history";
import type {
  Student, Studio,
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
  shouldReconcileSchedule,
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
  buildLegacyBootstrapResponse,
  buildSessionUserProfile,
  isDashboardSummaryForStudio,
  isLiveAuthRequestCurrent,
  resolveBootstrapLadders,
  resolveBootstrapStudioName,
  type AuthUserProfile,
  type AuthProfileResponse,
  type BootstrapResponse,
} from "@/lib/store-bootstrap-model";
import {
  buildPreviewHydratedLadderState,
  resolvePreviewLadderHydrationDefaults,
  type DemoResetResponse,
} from "@/lib/studio-store-model";
import {
  sortPrograms,
} from "@/lib/program-store-model";
import { loadIndependentDataset } from "@/lib/page-dataset-readiness";

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
  const previewStudentPhotoUrlsRef = useRef<Record<string, string>>({});
  const [programs, setPrograms] = useState<Program[]>(() =>
    isPreviewMode ? MOCK_PROGRAMS : []
  );
  const [programsLoaded, setProgramsLoaded] = useState(isPreviewMode);
  const [programsLoadError, setProgramsLoadError] = useState<string | null>(null);
  const programsRef = useRef<Program[]>(programs);
  const [leads, setLeads] = useState<Lead[]>(() =>
    isPreviewMode ? MOCK_LEADS : []
  );
  const [leadsLoaded, setLeadsLoaded] = useState(isPreviewMode);
  const [leadsLoadError, setLeadsLoadError] = useState<string | null>(null);
  const leadsRef = useRef<Lead[]>(leads);
  const [beltLadders, setBeltLaddersState] = useState<BeltLadder[]>(() =>
    isPreviewMode ? MOCK_BELT_LADDERS : []
  );
  const beltLaddersRef = useRef<BeltLadder[]>(beltLadders);
  const [beltRanks, setBeltRanksState] = useState<BeltRank[]>(() =>
    isPreviewMode ? MOCK_BELT_LADDER.ranks : []
  );
  const beltRanksRef = useRef<BeltRank[]>(beltRanks);
  const refreshBeltsRef = useRef<((preferredLadderId?: string | null) => Promise<void>) | null>(null);
  const [sessions, setSessions] = useState<ClassSession[]>(() =>
    isPreviewMode ? MOCK_SESSIONS : []
  );
  const sessionsRef = useRef<ClassSession[]>(sessions);
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
  const [currentRole, setCurrentRole] = useState<StaffRoleName | null>(() =>
    isPreviewMode ? "admin" : null
  );
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
  const [promotionHistoryCache, setPromotionHistoryCache] = useState<PromotionHistoryCache>({});
  const promotionHistoryCacheRef = useRef<PromotionHistoryCache>(promotionHistoryCache);
  const promotionHistoryRequestsRef = useRef<PromotionHistoryRequests>({});
  const promotionHistoryGenerationRef = useRef(0);

  const clearPromotionHistoryCache = useCallback(() => {
    promotionHistoryGenerationRef.current += 1;
    promotionHistoryRequestsRef.current = {};
    promotionHistoryCacheRef.current = {};
    setPromotionHistoryCache({});
  }, []);

  const beginLiveAuthRequest = useCallback(() => {
    const requestToken = tokenRef.current;
    if (!requestToken) {
      throw new Error("Not authenticated");
    }
    const requestGeneration = authGenerationRef.current;
    return {
      token: requestToken,
      isCurrent: () => isLiveAuthRequestCurrent({
        requestToken,
        requestGeneration,
        currentToken: tokenRef.current,
        currentGeneration: authGenerationRef.current,
      }),
    };
  }, []);

  const reconcileScheduleAttempt = useCallback(async () => {
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

    const [templatesResult, sessionsResult, attendanceResult] = await Promise.allSettled([
      api.get<ClassTemplate[]>("/schedule/templates", request.token),
      api.post<ClassSession[]>(
        `/schedule/sessions/materialize?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`,
        {},
        request.token
      ),
      api.get<AttendanceRecord[]>(
        `/schedule/attendance?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`,
        request.token
      ),
    ]);

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
    if (!sessionsAreCurrent || !attendanceIsCurrent) {
      return;
    }

    const rejected = [templatesResult, sessionsResult, attendanceResult].find(
      (result) => result.status === "rejected"
    );
    if (rejected?.status === "rejected") {
      throw rejected.reason;
    }

    if (
      templatesResult.status !== "fulfilled"
      || sessionsResult.status !== "fulfilled"
      || attendanceResult.status !== "fulfilled"
    ) {
      return;
    }

    const rangeSessions = sessionsResult.value;
    const replacedSessionIds = Array.from(new Set([
      ...sessionsRef.current
        .filter((session) => session.date >= startDate && session.date <= endDate)
        .map((session) => session.id),
      ...rangeSessions.map((session) => session.id),
    ]));
    setTemplates(templatesResult.value);
    setSessions((existing) =>
      mergeSessionsForRange(existing, rangeSessions, startDate, endDate)
    );
    setAttendance((existing) =>
      mergeAttendanceForSessions(
        existing,
        normalizeAttendanceRecords(attendanceResult.value),
        replacedSessionIds
      )
    );
    scheduleCoordinatorRef.current = markScheduleCoordinatorSnapshotState(
      scheduleCoordinatorRef.current
    );
    setScheduleLoadError(null);
    setScheduleStatus("ready");
  }, [beginLiveAuthRequest]);

  const reconcileSchedule = useCallback(async () => {
    const requestToken = tokenRef.current;
    const requestGeneration = authGenerationRef.current;
    try {
      await scheduleReconciliationQueueRef.current(
        reconcileScheduleAttempt,
        () => shouldReconcileSchedule(scheduleCoordinatorRef.current)
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
      await reconcileSchedule();
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
    setPromotionHistoryCache((current) => {
      const next = setPromotionHistoryCacheItems(current, studentId, items);
      promotionHistoryCacheRef.current = next;
      return next;
    });
  }, []);

  const updateCurrentLadderId = useCallback((nextLadderId: string | null) => {
    setCurrentLadderIdState(nextLadderId);
    currentLadderIdRef.current = nextLadderId;
  }, []);

  const applyLadderSelection = useCallback((ladders: BeltLadder[], preferredLadderId?: string | null) => {
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

  useSyncedRefValue(sessionsRef, sessions);

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
    setStaffMembers(state.staffMembers);
    setStaffLoaded(state.staffLoaded);
    setStaffLoadError(state.staffLoadError);
    setPrograms(state.programs);
    setProgramsLoaded(state.programsLoaded);
    setProgramsLoadError(state.programsLoadError);
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
    scheduleCoordinatorRef.current = resetScheduleCoordinatorState(
      scheduleCoordinatorRef.current
    );
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
  }, [updateCurrentLadderId]);

  const resetLiveStudioState = useCallback(() => {
    authGenerationRef.current = nextLiveStudioDataResetGeneration(authGenerationRef.current);
    dashboardSummaryRequestSeqRef.current += 1;
    authUserIdRef.current = null;
    setCurrentUser(null);
    setCurrentRole(null);
    applyLiveStudioDataResetState(buildSignedOutStudioResetState());
  }, [applyLiveStudioDataResetState]);

  const applySubscriptionRequiredState = useCallback((
    authProfile: AuthProfileResponse,
    sessionUser: { id: string; email?: string | null; user_metadata?: { full_name?: string | null } }
  ) => {
    authGenerationRef.current = nextLiveStudioDataResetGeneration(authGenerationRef.current);
    dashboardSummaryRequestSeqRef.current += 1;
    const userProfile = buildAuthUserProfile(authProfile);

    authUserIdRef.current = sessionUser.id;
    setCurrentUser(userProfile);
    setCurrentRole(authProfile.role ?? null);
    syncStoredStudioSessionCookies(sessionUser.id, authProfile.studio_id);

    applyLiveStudioDataResetState(buildSubscriptionRequiredStudioResetState());
  }, [applyLiveStudioDataResetState]);

  const markSubscriptionRequired = useCallback(() => {
    authGenerationRef.current = nextLiveStudioDataResetGeneration(authGenerationRef.current);
    dashboardSummaryRequestSeqRef.current += 1;
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
    scheduleCoordinatorRef.current = resetScheduleCoordinatorState(
      scheduleCoordinatorRef.current
    );
    setScheduleLoadError(restored.scheduleLoadError);
    setScheduleStatus(restored.scheduleStatus);
  }, []);

  useEffect(() => {
    if (!hydrated || !subscriptionRequired || pathname === "/subscription-required") {
      return;
    }

    router.replace("/subscription-required");
  }, [hydrated, pathname, router, subscriptionRequired]);

  const applyDemoResetResponse = useCallback((data: DemoResetResponse) => {
    dashboardSummaryRequestSeqRef.current += 1;
    scheduleCoordinatorRef.current = resetScheduleCoordinatorState(
      scheduleCoordinatorRef.current,
      true
    );
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
  }, [applyLadderSelection, clearPromotionHistoryCache, commitEligibilityRows, commitStudents]);

  const applyClearedStudioData = useCallback((studioNameValue?: string) => {
    dashboardSummaryRequestSeqRef.current += 1;
    scheduleCoordinatorRef.current = resetScheduleCoordinatorState(
      scheduleCoordinatorRef.current,
      true
    );
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
  }, [
    clearEligibilityState,
    clearPromotionHistoryCache,
    commitStudents,
    isPreviewMode,
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

      setStudioNameState(load(KEYS.studioName, "My Studio"));
      commitStudents(load(KEYS.students, MOCK_STUDENTS));
      setPrograms(load(KEYS.programs, MOCK_PROGRAMS));
      setProgramsLoaded(true);
      setProgramsLoadError(null);
      setLeads(load(KEYS.leads, MOCK_LEADS));
      setLeadsLoaded(true);
      setLeadsLoadError(null);
      applyLadderSelection(hydratedLadderState.hydratedLadders, hydratedLadderState.eligibilityLadderId);
      commitEligibilityRows(
        hydratedLadderState.eligibilityLadderId,
        hydratedLadderState.eligibilityRows
      );
      setEligibilityPendingLadderId(null);
      setEligibilityLoadError(null);
      setTemplates(load(KEYS.templates, MOCK_CLASS_TEMPLATES));
      setSessions(load(KEYS.sessions, MOCK_SESSIONS).sort(compareSessions));
      setAttendance(load(KEYS.attendance, MOCK_ATTENDANCE));
      setStudentsLoaded(true);
      setStudentsLoadError(null);
      setHydrated(true);
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [applyLadderSelection, commitEligibilityRows, commitStudents, isPreviewMode]);

  const previewEligibilityForLadder = useCallback((ladderId?: string | null): EligibilityEntry[] => {
    return ladderId === MOCK_BELT_LADDER.id ? MOCK_ELIGIBILITY : [];
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

  // Authentication and Data Fetching
  useEffect(() => {
    let mounted = true;

    async function initializeLive() {
      const studentsRevisionAtStart = studentsRevisionRef.current;
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) {
        return;
      }

      if (!session) {
        tokenRef.current = null;
        setToken(null);
        clearStoredStudioSessionCookies();
        resetLiveStudioState();
        setHydrated(true);
        return;
      }

      const sessionToken = session.access_token;
      if (tokenRef.current !== sessionToken) {
        authGenerationRef.current += 1;
        dashboardSummaryRequestSeqRef.current += 1;
        scheduleCoordinatorRef.current = resetScheduleCoordinatorState(
          scheduleCoordinatorRef.current
        );
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
      setHydrated(true);
      markPerformance("auth.session_resolved");

      try {
        let criticalData: BootstrapResponse;
        let bootstrapStudentsError: string | null = null;
        let bootstrapProgramsError: string | null = null;
        let bootstrapLeadsError: string | null = null;
        let bootstrapBeltsError: string | null = null;
        let usedLegacyFallback = false;

        try {
          markPerformance("dashboard.bootstrap_started");
          criticalData = await api.get<BootstrapResponse>("/dashboard/bootstrap", sessionToken);
          markPerformance("dashboard.bootstrap_finished");
          measurePerformance(
            "dashboard.bootstrap_duration",
            "dashboard.bootstrap_started",
            "dashboard.bootstrap_finished"
          );
        } catch (bootstrapError) {
          usedLegacyFallback = true;
          if (isSubscriptionRequiredError(bootstrapError)) {
            const authProfile = await api.get<AuthProfileResponse>(
              "/auth/me",
              sessionToken
            );
            if (!isCurrentSession()) {
              return;
            }

            applySubscriptionRequiredState(authProfile, session.user);
            setHydrated(true);
            if (!authProfile.studio_id) {
              router.replace("/onboarding");
            }
            return;
          }

          const authProfile = await api.get<AuthProfileResponse>(
            "/auth/me",
            sessionToken,
            { omitStudioHeader: true }
          );
          if (!isCurrentSession()) {
            return;
          }

          if (!authProfile.studio_id) {
            syncStoredStudioSessionCookies(session.user.id, authProfile.studio_id);
            resetLiveStudioState();
            setCurrentUser(buildAuthUserProfile(authProfile));
            setCurrentRole(authProfile.role ?? null);
            setHydrated(true);
            router.replace("/onboarding");
            return;
          }

          const studioPromise = api.get<Studio>("/studios/current", sessionToken)
            .then((studioRes) => {
              if (isCurrentSession()) {
                setSubscriptionRequired(false);
                setCurrentUser(buildAuthUserProfile(authProfile));
                setCurrentRole(authProfile.role ?? null);
                syncStoredStudioSessionCookies(session.user.id, authProfile.studio_id);
                setStudioNameState(studioRes.name);
              }
              return studioRes;
            });

          void studioPromise.then(async () => {
            if (!isCurrentSession()) {
              return;
            }
            markPerformance("schedule.deferred_started");
            await refreshSchedule();
            markPerformance("schedule.deferred_finished");
            measurePerformance(
              "schedule.deferred_duration",
              "schedule.deferred_started",
              "schedule.deferred_finished"
            );
          }).catch((error) => {
            console.error("Failed to load deferred dashboard data", error);
          });

          const studentsPromise = loadIndependentDataset({
            context: studioPromise,
            fallback: { items: [], total: 0, page: 1, page_size: 200 },
            load: fetchStudentPage(
              sessionToken,
              { page: 1, pageSize: 200, sortKey: "name", sortDir: "asc" },
              { timeoutMs: 30000 }
            ),
            onError: (error) => {
              bootstrapStudentsError = error instanceof Error
                ? error.message
                : "Student roster could not be loaded.";
              if (isCurrentSession()) {
                studentsRef.current = [];
                setStudents([]);
                setStudentsLoaded(false);
                setStudentsLoadError(bootstrapStudentsError);
                setStudentsLastLoadedAt(null);
                setStudentsMayBePartial(false);
              }
            },
            onLoaded: (studentsPageRes) => {
              if (
                isCurrentSession()
                && studentsRevisionRef.current === studentsRevisionAtStart
              ) {
                commitStudents(studentsPageRes.items, {
                  mayBePartial: studentsPageRes.total > studentsPageRes.items.length,
                });
              }
            },
          });

          const programsPromise = loadIndependentDataset<Program[]>({
            context: studioPromise,
            fallback: [],
            load: api.get<Program[]>("/programs?include_archived=true", sessionToken),
            onError: (error) => {
              bootstrapProgramsError = error instanceof Error
                ? error.message
                : "Programs could not be loaded.";
              if (isCurrentSession()) {
                setPrograms([]);
                setProgramsLoaded(false);
                setProgramsLoadError(bootstrapProgramsError);
              }
            },
            onLoaded: (programsRes) => {
              if (isCurrentSession()) {
                setPrograms(programsRes);
                setProgramsLoaded(true);
                setProgramsLoadError(null);
              }
            },
          });

          const leadsPromise = loadIndependentDataset<Lead[]>({
            context: studioPromise,
            fallback: [],
            load: api.get<Lead[]>("/leads", sessionToken),
            onError: (error) => {
              bootstrapLeadsError = error instanceof Error
                ? error.message
                : "Leads could not be loaded.";
              if (isCurrentSession()) {
                setLeads([]);
                setLeadsLoaded(false);
                setLeadsLoadError(bootstrapLeadsError);
              }
            },
            onLoaded: (leadsRes) => {
              if (isCurrentSession()) {
                setLeads(leadsRes);
                setLeadsLoaded(true);
                setLeadsLoadError(null);
              }
            },
          });

          const beltLaddersPromise = loadIndependentDataset<BeltLadder[]>({
            context: studioPromise,
            fallback: [],
            load: api.get<BeltLadder[]>("/belts/ladders", sessionToken),
            onError: (error) => {
              bootstrapBeltsError = error instanceof Error
                ? error.message
                : "Belt ladders could not be loaded.";
              if (isCurrentSession()) {
                applyLadderSelection([], null);
                commitEligibilityRows(null, []);
                setEligibilityPendingLadderId(null);
                setEligibilityLoadError(bootstrapBeltsError);
              }
            },
            onLoaded: (beltLaddersRes) => {
              if (isCurrentSession()) {
                const selectedLadder = applyLadderSelection(
                  beltLaddersRes,
                  beltLaddersRes[0]?.id
                );
                if (selectedLadder) {
                  void loadEligibilityForLadder(selectedLadder.id, { force: true })
                    .catch(() => undefined);
                } else {
                  commitEligibilityRows(null, []);
                  setEligibilityPendingLadderId(null);
                  setEligibilityLoadError(null);
                }
              }
            },
          });

          const [
            studioRes,
            studentsPageRes,
            programsRes,
            leadsRes,
            beltLaddersRes,
          ] = await Promise.all([
            studioPromise,
            studentsPromise,
            programsPromise,
            leadsPromise,
            beltLaddersPromise,
          ]);

          criticalData = buildLegacyBootstrapResponse({
            auth: authProfile,
            studio: studioRes,
            studentsPage: studentsPageRes,
            programs: programsRes,
            leads: leadsRes,
            beltLadders: beltLaddersRes,
          });

          console.warn("Falling back to legacy dashboard bootstrap", bootstrapError);
        }

        if (isCurrentSession()) {
          const authProfile = criticalData.auth;
          const userProfile = buildAuthUserProfile(authProfile);

          setSubscriptionRequired(false);
          setCurrentUser(userProfile);
          setCurrentRole(authProfile.role ?? null);
          syncStoredStudioSessionCookies(session.user.id, authProfile.studio_id);

          if (!authProfile.studio_id) {
            resetLiveStudioState();
            setCurrentUser(userProfile);
            setCurrentRole(authProfile.role ?? null);
            setHydrated(true);
            router.replace("/onboarding");
            return;
          }

          clearPromotionHistoryCache();
          setStudioNameState(resolveBootstrapStudioName(criticalData));
          const bootstrapSummary = criticalData.summary ?? null;
          setDashboardSummary(bootstrapSummary);
          setDashboardSummaryLoaded(Boolean(bootstrapSummary));
          if (!usedLegacyFallback) {
            setPrograms(criticalData.programs || []);
            setProgramsLoaded(true);
            setProgramsLoadError(null);
            if (studentsRevisionRef.current === studentsRevisionAtStart) {
              commitStudents(criticalData.students, {
                mayBePartial: criticalData.students_may_be_partial
                  ?? criticalData.students.length >= (criticalData.students_page_size ?? 200),
              });
            }
            setLeads(criticalData.leads);
            setLeadsLoaded(true);
            setLeadsLoadError(null);
            const selectedInitialLadder = applyLadderSelection(
              resolveBootstrapLadders(criticalData),
              criticalData.primary_belt_ladder?.id ?? null
            );
            if (selectedInitialLadder) {
              void loadEligibilityForLadder(selectedInitialLadder.id, { force: true }).catch(() => undefined);
            } else {
              commitEligibilityRows(null, []);
            }
          }

          if (!bootstrapSummary) {
            const summaryRequestSeq = dashboardSummaryRequestSeqRef.current + 1;
            dashboardSummaryRequestSeqRef.current = summaryRequestSeq;
            const summaryToken = sessionToken;
            const summaryStudioId = authProfile.studio_id;

            void (async () => {
              markPerformance("dashboard.summary_started");
              const summaryRes = await api.get<DashboardSummary>(
                "/dashboard/summary",
                summaryToken,
                {
                  timeoutMs: 30000,
                  timeoutMessage: "Dashboard summary timed out.",
                }
              );
              if (
                !mounted ||
                authGenerationRef.current !== sessionGeneration ||
                dashboardSummaryRequestSeqRef.current !== summaryRequestSeq ||
                tokenRef.current !== summaryToken ||
                  !isDashboardSummaryForStudio(summaryRes, summaryStudioId)
              ) {
                return;
              }
              setDashboardSummary(summaryRes);
              setDashboardSummaryLoaded(true);
              markPerformance("dashboard.summary_finished");
              measurePerformance(
                "dashboard.summary_duration",
                "dashboard.summary_started",
                "dashboard.summary_finished",
                { source: "deferred" }
              );
            })().catch((error) => {
              if (
                !mounted ||
                authGenerationRef.current !== sessionGeneration ||
                dashboardSummaryRequestSeqRef.current !== summaryRequestSeq ||
                tokenRef.current !== summaryToken
              ) {
                return;
              }
              console.warn("Failed to load dashboard summary", error);
              setDashboardSummary(null);
              setDashboardSummaryLoaded(true);
            });
          }

          void api
            .get<Program[]>("/programs?include_archived=true", sessionToken)
            .then((programsRes) => {
              if (!isCurrentSession()) {
                return;
              }
                setPrograms(programsRes);
                setProgramsLoaded(true);
                setProgramsLoadError(null);
            })
            .catch((error) => {
              console.warn("Failed to refresh program usage after bootstrap", error);
            });
        }

        if (!usedLegacyFallback) {
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
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (isCurrentSession() && isSubscriptionRequiredError(error)) {
          const authProfile = await api.get<AuthProfileResponse>(
            "/auth/me",
            sessionToken
          ).catch(() => null);
          if (!isCurrentSession()) {
            return;
          }
          if (authProfile) {
            applySubscriptionRequiredState(authProfile, session.user);
          } else {
            markSubscriptionRequired();
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

    initializeLive();

    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        const tokenChanged = tokenRef.current !== session.access_token;
        if (tokenChanged) {
          setScheduleLoadError(null);
          setScheduleStatus("loading");
          authGenerationRef.current += 1;
          dashboardSummaryRequestSeqRef.current += 1;
          scheduleCoordinatorRef.current = shouldPreserveScheduleMutationsOnAuthChange(
            event,
            authUserIdRef.current,
            session.user.id
          )
            ? refreshScheduleCoordinatorAuthState(scheduleCoordinatorRef.current)
            : resetScheduleCoordinatorState(scheduleCoordinatorRef.current);
        }
        tokenRef.current = session.access_token;
        authUserIdRef.current = session.user.id;
        setToken(session.access_token);
        if (tokenChanged) {
          void reconcileSchedule().catch((error) => {
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
      }
    });

    return () => {
      mounted = false;
      authListener?.subscription.unsubscribe();
    };
  }, [applyLadderSelection, applySubscriptionRequiredState, clearPromotionHistoryCache, commitEligibilityRows, commitStudents, isPreviewMode, loadEligibilityForLadder, markSubscriptionRequired, reconcileSchedule, refreshSchedule, resetLiveStudioState, router, supabase]);

  // ── Persist helpers (for preview mode) ──
  const persistStudents = useCallback((next: Student[]) => {
    commitStudents(next);
    if (isPreviewMode) save(KEYS.students, next);
  }, [commitStudents, isPreviewMode]);

  const persistPrograms = useCallback((next: Program[]) => {
    const sorted = sortPrograms(next);
    setPrograms(sorted);
    setProgramsLoaded(true);
    setProgramsLoadError(null);
    if (isPreviewMode) save(KEYS.programs, sorted);
  }, [isPreviewMode]);

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
    refreshBeltsRef,
    setProgramsLoadError,
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
  }, [isPreviewMode]);

  const persistAttendance = useCallback((next: AttendanceRecord[]) => {
    setAttendance(next);
    if (isPreviewMode) save(KEYS.attendance, next);
  }, [isPreviewMode]);

  // ── Students ──
  const {
    addStudent,
    deleteStudents,
    listStudentsPage,
    refreshStudents,
    updateStudent,
  } = useStoreStudentRosterActions({
    beginLiveAuthRequest,
    commitStudents,
    isPreviewMode,
    persistStudents,
    previewStudentPhotoUrlsRef,
    programsRef,
    setStudentsLoadError,
    studentsMayBePartial,
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
    studentsMayBePartial,
    studentsRef,
  });

  const { importStudents } = useStoreStudentImportActions({
    beginLiveAuthRequest,
    beltLaddersRef,
    beltRanksRef,
    commitStudents,
    isPreviewMode,
    persistStudents,
    programsRef,
    refreshBeltsRef,
    refreshPrograms,
    setStudentsLoadError,
    studentsRef,
  });

  const {
    bulkAddTagsToStudents,
    bulkUpdateStudentStatus,
  } = useStoreStudentBulkActions({
    beginLiveAuthRequest,
    commitStudents,
    isPreviewMode,
    persistStudents,
    refreshStudents,
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
    isPreviewMode,
    leadsRef,
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
    commitEligibilityRows,
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
    inviteStaff,
    refreshStaff,
    removeStaff,
    updateStaffRole,
  } = useStoreStaffActions({
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
    archiveProgram,
    attendance,
    beltLadders,
    beltRanks,
    bulkAddTagsToStudents,
    bulkUpdateStudentStatus,
    clearStudioData,
    clearSubscriptionRequired,
    convertLeadToStudent,
    createProgram,
    currentLadderId,
    currentRole,
    currentUserId: activeUserId || "",
    dashboardSummary,
    dashboardSummaryLoaded,
    deleteLead,
    deleteSession,
    deleteStudentPhoto,
    deleteStudents,
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
    markSubscriptionRequired,
    programs,
    programsLoaded,
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
    sessions,
    setBeltRanks,
    setCurrentLadder,
    setLadderName,
    setStudioName,
    setSubRankTerm,
    staffLoadError,
    staffLoaded,
    staffMembers,
    students,
    studentsLastLoadedAt,
    studentsLoadError,
    studentsLoaded,
    studentsMayBePartial,
    studioName,
    subRankTerm,
    subscriptionRequired,
    templates,
    toggleCheckIn,
    token,
    updateLead,
    updateProgram,
    updateStaffRole,
    updateStudent,
    updateUserName,
    uploadStudentPhoto,
    userEmail: currentUser?.email || "",
    userName: currentUser?.full_name || "",
  });

  if (!hydrated) {
    return <LoadingScreen />;
  }

  return (
    <StoreContextProviders values={contextValues}>
      {children}
    </StoreContextProviders>
  );
}

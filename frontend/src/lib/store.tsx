"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import {
  clearActiveStudioIdCookie,
  clearStudioStateCookie,
  setActiveStudioIdCookie,
  setStudioStateCookie,
} from "@/lib/studio-state-cookie";
import type {
  Student, StudentCreate, StudentStatus,
  BulkStudentTagUpdateRequest, BulkStudentTagUpdateResponse,
  BulkStudentStatusUpdateRequest, BulkStudentStatusUpdateResponse,
  Lead, LeadSource,
  BeltRank, BeltLadder,
  ClassSession, ClassSessionCreate, ClassSessionDeleteScope,
  ClassTemplate, ClassTemplateCreate, AttendanceRecord, AttendanceStatus,
  CsvImportOptions, CsvImportRequest, CsvImportResult, EligibilityEntry, Promotion,
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
import { parseCalendarDate, toCalendarDateKey } from "@/lib/schedule-calendar";

interface AuthUserProfile {
  id: string;
  email: string;
  full_name?: string | null;
}

interface AuthProfileResponse {
  user: AuthUserProfile;
  studio_id: string | null;
  role: string | null;
}

interface StudentListPageResponse {
  items: Student[];
  total: number;
  page: number;
  page_size: number;
}

interface BootstrapResponse {
  auth: AuthProfileResponse;
  studio_name?: string | null;
  studio: {
    name: string;
  } | null;
  students: Student[];
  leads: Lead[];
  belt_ladders: BeltLadder[];
  primary_belt_ladder: BeltLadder | null;
}

interface DemoResetCounts {
  students: number;
  leads: number;
  belt_ranks: number;
  class_sessions: number;
  attendance_records: number;
}

interface DemoResetResponse {
  studio_name: string;
  students: Student[];
  leads: Lead[];
  belt_ladders: BeltLadder[];
  primary_belt_ladder: BeltLadder | null;
  eligibility: EligibilityEntry[];
  templates: ClassTemplate[];
  sessions: ClassSession[];
  attendance: AttendanceRecord[];
  counts: DemoResetCounts;
}

// ── Storage keys ─────────────────────────────────────────────────────────────
const KEYS = {
  students: "koaryu:students",
  leads: "koaryu:leads",
  beltRanks: "koaryu:beltRanks",
  sessions: "koaryu:sessions",
  templates: "koaryu:templates",
  attendance: "koaryu:attendance",
  studioName: "koaryu:studioName",
  subRankTerm: "koaryu:subRankTerm",
  ladderName: "koaryu:ladderName",
};

const DEMO_STUDIO_NAME = "River City Martial Arts";
const DASHBOARD_BOOTSTRAP_STUDENT_LIMIT = 200;
const PROMOTION_HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
const SCHEDULE_ATTENDANCE_BULK_THRESHOLD = 3;

interface PromotionHistoryCacheEntry {
  items: Promotion[];
  fetchedAt: number;
}

function load<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {}
  return fallback;
}

function save<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function clearPreviewStorage() {
  if (typeof window === "undefined") return;
  try {
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith("koaryu:")) {
        localStorage.removeItem(key);
      }
    });
  } catch {}
}

function localId() {
  return "s-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normalizeStudentIds(studentIds: string[]): string[] {
  return Array.from(
    new Set(studentIds.map((studentId) => studentId.trim()).filter(Boolean))
  );
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}

function applyAddedTagsToStudents(
  studentList: Student[],
  studentIds: string[],
  tagsToAdd: string[]
): Student[] {
  const studentIdSet = new Set(studentIds);
  const now = new Date().toISOString();

  return studentList.map((student) => {
    if (!studentIdSet.has(student.id)) {
      return student;
    }

    return {
      ...student,
      tags: Array.from(new Set([...(student.tags || []), ...tagsToAdd])),
      updated_at: now,
    };
  });
}

function applyStatusToStudents(
  studentList: Student[],
  studentIds: string[],
  status: StudentStatus
): Student[] {
  const studentIdSet = new Set(studentIds);
  const now = new Date().toISOString();

  return studentList.map((student) => {
    if (!studentIdSet.has(student.id)) {
      return student;
    }

    return {
      ...student,
      status,
      updated_at: now,
    };
  });
}

function compareSessions(a: ClassSession, b: ClassSession) {
  const dateCompare = a.date.localeCompare(b.date);
  if (dateCompare !== 0) {
    return dateCompare;
  }
  return a.start_time.localeCompare(b.start_time);
}

function mergeSessionsForRange(
  current: ClassSession[],
  fetched: ClassSession[],
  startDate: string,
  endDate: string
): ClassSession[] {
  return [
    ...current.filter((session) => session.date < startDate || session.date > endDate),
    ...fetched,
  ].sort(compareSessions);
}

function mergeAttendanceForSessions(
  current: AttendanceRecord[],
  fetched: AttendanceRecord[],
  replacedSessionIds: string[]
): AttendanceRecord[] {
  const replaced = new Set(replacedSessionIds);
  return [
    ...current.filter((record) => !replaced.has(record.session_id)),
    ...fetched,
  ];
}

function updateSessionAttendanceCount(
  sessionList: ClassSession[],
  sessionId: string,
  delta: number
): ClassSession[] {
  if (delta === 0) {
    return sessionList;
  }

  return sessionList.map((session) =>
    session.id === sessionId
      ? {
          ...session,
          attendance_count: Math.max(0, session.attendance_count + delta),
        }
      : session
  );
}

function toAttendanceCountDelta(
  previousStatus: AttendanceStatus | null,
  nextStatus: AttendanceStatus | null
) {
  const previousCount = previousStatus && previousStatus !== "absent" ? 1 : 0;
  const nextCount = nextStatus && nextStatus !== "absent" ? 1 : 0;
  return nextCount - previousCount;
}

function selectBeltLadder(
  ladders: BeltLadder[],
  preferredLadderId?: string | null
): BeltLadder | null {
  if (preferredLadderId) {
    const matched = ladders.find((ladder) => ladder.id === preferredLadderId);
    if (matched) {
      return matched;
    }
  }

  return ladders[0] ?? null;
}

function sortBeltLadders(ladders: BeltLadder[]): BeltLadder[] {
  return [...ladders].sort((left, right) => left.created_at.localeCompare(right.created_at));
}

function upsertBeltLadder(ladders: BeltLadder[], nextLadder: BeltLadder): BeltLadder[] {
  const next = ladders.filter((ladder) => ladder.id !== nextLadder.id);
  next.push(nextLadder);
  return sortBeltLadders(next);
}

function normalizeAttendanceRecords(records: AttendanceRecord[]): AttendanceRecord[] {
  return records.map((record) => ({
    ...record,
    student_name: record.student_name || "",
  }));
}

function getPreviewTemplateSessionDates(template: ClassTemplate): string[] {
  const start = parseCalendarDate(template.start_date);
  const end = template.end_date ? parseCalendarDate(template.end_date) : parseCalendarDate(template.start_date);
  if (!template.end_date) {
    end.setDate(end.getDate() + 84);
  }

  const dates: string[] = [];
  const current = new Date(start);
  while (current <= end) {
    if (current.getDay() === template.day_of_week) {
      dates.push(toCalendarDateKey(current));
    }
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// ── Context shape ────────────────────────────────────────────────────────────
interface StoreContextValue {
  // Config
  isPreviewMode: boolean;
  token: string | null;

  // Students
  students: Student[];
  studentsLoaded: boolean;
  studentsLoadError: string | null;
  studentsLastLoadedAt: number | null;
  studentsMayBePartial: boolean;
  addStudent: (data: StudentCreate) => Promise<Student>;
  updateStudent: (id: string, data: Partial<Student>) => Promise<void>;
  deleteStudents: (ids: string[]) => Promise<void>;
  bulkAddTagsToStudents: (
    studentIds: string[],
    tags: string[]
  ) => Promise<BulkStudentTagUpdateResponse>;
  bulkUpdateStudentStatus: (
    studentIds: string[],
    status: StudentStatus
  ) => Promise<BulkStudentStatusUpdateResponse>;
  importStudents: (
    file: File,
    rows: Record<string, string>[],
    mapping: Record<string, string>,
    options: CsvImportOptions,
    request?: { importKey?: string }
  ) => Promise<CsvImportResult>;
  refreshStudents: () => Promise<Student[]>;

  // Leads
  leads: Lead[];
  addLead: (data: Partial<Lead>) => Promise<void>;
  updateLead: (id: string, data: Partial<Lead>) => Promise<void>;
  deleteLead: (id: string) => Promise<void>;
  refreshLeads: () => Promise<Lead[]>;
  convertLeadToStudent: (leadId: string) => Promise<{ lead: Lead; studentId: string | null }>;

  // Belt Tracker
  beltLadders: BeltLadder[];
  beltRanks: BeltRank[];
  currentLadderId: string | null;
  setCurrentLadder: (ladderId: string) => Promise<void>;
  setBeltRanks: (ranks: BeltRank[], options?: { subRankTerm?: string }) => Promise<void>;
  ladderName: string;
  setLadderName: (name: string) => void;
  subRankTerm: string;
  setSubRankTerm: (term: string) => Promise<void>;
  eligibility: EligibilityEntry[];
  promotionHistoryByStudent: Record<string, Promotion[]>;
  loadPromotionHistory: (
    studentId: string,
    options?: { force?: boolean; signal?: AbortSignal }
  ) => Promise<Promotion[]>;
  promoteStudent: (studentId: string, toRankId: string, notes?: string) => Promise<Promotion>;

  // Schedule
  sessions: ClassSession[];
  addSession: (data: ClassSessionCreate) => Promise<void>;
  addTemplate: (data: ClassTemplateCreate) => Promise<ClassTemplate>;
  deleteSession: (sessionId: string, scope?: ClassSessionDeleteScope) => Promise<void>;
  refreshScheduleRange: (startDate: string, endDate: string) => Promise<ClassSession[]>;
  refreshSessionAttendance: (sessionId: string) => Promise<AttendanceRecord[]>;
  templates: ClassTemplate[];
  attendance: AttendanceRecord[];
  toggleCheckIn: (sessionId: string, studentId: string, name: string) => Promise<void>;

  // Studio
  studioName: string;
  userEmail: string;
  userName: string;
  setStudioName: (name: string) => Promise<void>;
  resetDemoData: () => Promise<DemoResetResponse>;
}

type ConfigStoreContextValue = Pick<StoreContextValue, "isPreviewMode" | "token">;
type StudentsStoreContextValue = Pick<
  StoreContextValue,
  | "studentsLoaded"
  | "studentsLoadError"
  | "studentsLastLoadedAt"
  | "studentsMayBePartial"
  | "students"
  | "addStudent"
  | "updateStudent"
  | "deleteStudents"
  | "bulkAddTagsToStudents"
  | "bulkUpdateStudentStatus"
  | "importStudents"
  | "refreshStudents"
>;
type LeadsStoreContextValue = Pick<
  StoreContextValue,
  | "leads"
  | "addLead"
  | "updateLead"
  | "deleteLead"
  | "refreshLeads"
  | "convertLeadToStudent"
>;
type BeltsStoreContextValue = Pick<
  StoreContextValue,
  | "beltLadders"
  | "beltRanks"
  | "currentLadderId"
  | "setCurrentLadder"
  | "setBeltRanks"
  | "ladderName"
  | "setLadderName"
  | "subRankTerm"
  | "setSubRankTerm"
  | "eligibility"
  | "promotionHistoryByStudent"
  | "loadPromotionHistory"
  | "promoteStudent"
>;
type ScheduleStoreContextValue = Pick<
  StoreContextValue,
  | "sessions"
  | "addSession"
  | "addTemplate"
  | "deleteSession"
  | "refreshScheduleRange"
  | "refreshSessionAttendance"
  | "templates"
  | "attendance"
  | "toggleCheckIn"
>;
type StudioStoreContextValue = Pick<
  StoreContextValue,
  "studioName" | "userEmail" | "userName" | "setStudioName" | "resetDemoData"
>;

const ConfigStoreContext = createContext<ConfigStoreContextValue | null>(null);
const StudentsStoreContext = createContext<StudentsStoreContextValue | null>(null);
const LeadsStoreContext = createContext<LeadsStoreContextValue | null>(null);
const BeltsStoreContext = createContext<BeltsStoreContextValue | null>(null);
const ScheduleStoreContext = createContext<ScheduleStoreContextValue | null>(null);
const StudioStoreContext = createContext<StudioStoreContextValue | null>(null);

function useRequiredContext<T>(context: React.Context<T | null>, name: string): T {
  const value = useContext(context);
  if (!value) {
    throw new Error(`${name} must be used within StoreProvider`);
  }
  return value;
}

export function useConfigStore(): ConfigStoreContextValue {
  return useRequiredContext(ConfigStoreContext, "useConfigStore");
}

export function useStudentStore(): StudentsStoreContextValue {
  return useRequiredContext(StudentsStoreContext, "useStudentStore");
}

export function useLeadStore(): LeadsStoreContextValue {
  return useRequiredContext(LeadsStoreContext, "useLeadStore");
}

export function useBeltStore(): BeltsStoreContextValue {
  return useRequiredContext(BeltsStoreContext, "useBeltStore");
}

export function useScheduleStore(): ScheduleStoreContextValue {
  return useRequiredContext(ScheduleStoreContext, "useScheduleStore");
}

export function useStudioStore(): StudioStoreContextValue {
  return useRequiredContext(StudioStoreContext, "useStudioStore");
}

export function useStore(): StoreContextValue {
  return {
    ...useConfigStore(),
    ...useStudentStore(),
    ...useLeadStore(),
    ...useBeltStore(),
    ...useScheduleStore(),
    ...useStudioStore(),
  };
}

// ── Provider ─────────────────────────────────────────────────────────────────
export function StoreProvider({ children }: { children: ReactNode }) {
  const isPreviewMode = process.env.NEXT_PUBLIC_PREVIEW_MODE === "true";
  const [hydrated, setHydrated] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const router = useRouter();
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
  const studentsRef = useRef<Student[]>(students);
  const studentsRevisionRef = useRef(0);
  const [leads, setLeads] = useState<Lead[]>(() =>
    isPreviewMode ? MOCK_LEADS : []
  );
  const leadsRef = useRef<Lead[]>(leads);
  const [beltLadders, setBeltLaddersState] = useState<BeltLadder[]>(() =>
    isPreviewMode ? [MOCK_BELT_LADDER] : []
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
  const [studioName, setStudioNameState] = useState(() =>
    isPreviewMode ? "My Studio" : ""
  );
  const [currentUser, setCurrentUser] = useState<AuthUserProfile | null>(() =>
    isPreviewMode
      ? { id: "preview-user", email: "demo@koaryu.local", full_name: "Demo User" }
      : null
  );
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
  const [promotionHistoryCache, setPromotionHistoryCache] = useState<Record<string, PromotionHistoryCacheEntry>>({});
  const promotionHistoryCacheRef = useRef<Record<string, PromotionHistoryCacheEntry>>(promotionHistoryCache);
  const promotionHistoryRequestsRef = useRef<Record<string, Promise<Promotion[]>>>({});
  const promotionHistoryGenerationRef = useRef(0);

  const clearPromotionHistoryCache = useCallback(() => {
    promotionHistoryGenerationRef.current += 1;
    promotionHistoryRequestsRef.current = {};
    promotionHistoryCacheRef.current = {};
    setPromotionHistoryCache({});
  }, []);

  const commitPromotionHistoryCache = useCallback((studentId: string, items: Promotion[]) => {
    setPromotionHistoryCache((current) => {
      const next = {
        ...current,
        [studentId]: {
          items,
          fetchedAt: Date.now(),
        },
      };
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

    return selectedLadder;
  }, [updateCurrentLadderId]);

  useEffect(() => {
    studentsRef.current = students;
  }, [students]);

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

  useEffect(() => {
    leadsRef.current = leads;
  }, [leads]);

  useEffect(() => {
    beltLaddersRef.current = beltLadders;
  }, [beltLadders]);

  useEffect(() => {
    beltRanksRef.current = beltRanks;
  }, [beltRanks]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    templatesRef.current = templates;
  }, [templates]);

  useEffect(() => {
    attendanceRef.current = attendance;
  }, [attendance]);

  useEffect(() => {
    eligibilityRef.current = eligibility;
  }, [eligibility]);

  useEffect(() => {
    promotionHistoryCacheRef.current = promotionHistoryCache;
  }, [promotionHistoryCache]);

  const resetLiveStudioState = useCallback(() => {
    setStudioNameState("");
    setCurrentUser(null);
    commitStudents([]);
    setStudentsLoaded(true);
    setStudentsLoadError(null);
    setLeads([]);
    setBeltLaddersState([]);
    updateCurrentLadderId(null);
    setLadderNameState("");
    setSubRankTermState("Stripe");
    setBeltRanksState([]);
    setSessions([]);
    setTemplates([]);
    setAttendance([]);
    setEligibility([]);
    clearPromotionHistoryCache();
  }, [clearPromotionHistoryCache, commitStudents, updateCurrentLadderId]);

  const applyDemoResetResponse = useCallback((data: DemoResetResponse) => {
    setStudioNameState(data.studio_name);
    commitStudents(data.students);
    setLeads(data.leads);
    applyLadderSelection(
      data.belt_ladders.length > 0
        ? data.belt_ladders
        : data.primary_belt_ladder
          ? [data.primary_belt_ladder]
          : [],
      data.primary_belt_ladder?.id ?? null
    );
    setEligibility(data.eligibility);
    setTemplates(data.templates);
    setSessions(data.sessions.sort(compareSessions));
    setAttendance(data.attendance);
    clearPromotionHistoryCache();
  }, [applyLadderSelection, clearPromotionHistoryCache, commitStudents]);

  useEffect(() => {
    if (!isPreviewMode) {
      return;
    }

    const timer = window.setTimeout(() => {
      const storedRanks = load(KEYS.beltRanks, MOCK_BELT_LADDER.ranks);
      const storedSubRankTerm = load(KEYS.subRankTerm, MOCK_BELT_LADDER.sub_rank_term || "Stripe");
      const storedLadderName = load(KEYS.ladderName, MOCK_BELT_LADDER.name);
      const previewLadder: BeltLadder = {
        ...MOCK_BELT_LADDER,
        name: storedLadderName,
        sub_rank_term: storedSubRankTerm,
        ranks: storedRanks,
      };

      setStudioNameState(load(KEYS.studioName, "My Studio"));
      commitStudents(load(KEYS.students, MOCK_STUDENTS));
      setLeads(load(KEYS.leads, MOCK_LEADS));
      applyLadderSelection([previewLadder], previewLadder.id);
      setEligibility(MOCK_ELIGIBILITY);
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
  }, [applyLadderSelection, commitStudents, isPreviewMode]);

  const fetchAllStudents = useCallback(async (
    authToken: string,
    options?: { timeoutMs?: number | null }
  ): Promise<Student[]> => {
    const pageSize = 200;
    let page = 1;
    let total = Number.POSITIVE_INFINITY;
    const collected: Student[] = [];

    while (collected.length < total) {
      const result = await api.get<StudentListPageResponse>(
        `/students?page=${page}&page_size=${pageSize}`,
        authToken,
        options
      );

      collected.push(...result.items);
      total = result.total;

      if (result.items.length < pageSize) {
        break;
      }

      page += 1;
    }

    return collected;
  }, []);

  // Authentication and Data Fetching
  useEffect(() => {
    let mounted = true;

    async function initializeLive() {
      const studentsRevisionAtStart = studentsRevisionRef.current;
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return;

      if (!session) {
        clearStudioStateCookie();
        clearActiveStudioIdCookie();
        resetLiveStudioState();
        setHydrated(true);
        return;
      }

      setToken(session.access_token);

      try {
        let criticalData: BootstrapResponse;

        try {
          criticalData = await api.get<BootstrapResponse>("/dashboard/bootstrap", session.access_token);
        } catch (bootstrapError) {
          const authProfile = await api.get<AuthProfileResponse>(
            "/auth/me",
            session.access_token,
            { omitStudioHeader: true }
          );
          if (!mounted) return;

          if (!authProfile.studio_id) {
            clearActiveStudioIdCookie();
            setStudioStateCookie(session.user.id, false);
            resetLiveStudioState();
            setCurrentUser(authProfile.user);
            setHydrated(true);
            router.replace("/onboarding");
            return;
          }

          const [
            studioRes,
            studentsRes,
            leadsRes,
            beltLaddersRes,
          ] = await Promise.all([
            api.get<{ name: string }>("/studios/current", session.access_token),
            fetchAllStudents(session.access_token, { timeoutMs: 30000 }),
            api.get<Lead[]>("/leads", session.access_token),
            api.get<BeltLadder[]>("/belts/ladders", session.access_token),
          ]);

          criticalData = {
            auth: authProfile,
            studio: studioRes,
            students: studentsRes,
            leads: leadsRes,
            belt_ladders: beltLaddersRes,
            primary_belt_ladder: beltLaddersRes[0] ?? null,
          };

          if (bootstrapError instanceof Error && !/404|API error: 404/.test(bootstrapError.message)) {
            console.warn("Falling back to legacy dashboard bootstrap", bootstrapError);
          }
        }

        if (mounted) {
          const authProfile = criticalData.auth;
          const userProfile = authProfile.user ?? {
            id: session.user.id,
            email: session.user.email || "",
            full_name: session.user.user_metadata?.full_name || null,
          };

          setCurrentUser(userProfile);
          setStudioStateCookie(session.user.id, Boolean(authProfile.studio_id));
          if (authProfile.studio_id) {
            setActiveStudioIdCookie(authProfile.studio_id);
          } else {
            clearActiveStudioIdCookie();
          }

          if (!authProfile.studio_id) {
            resetLiveStudioState();
            setCurrentUser(userProfile);
            setHydrated(true);
            router.replace("/onboarding");
            return;
          }

          clearPromotionHistoryCache();
          setStudioNameState(criticalData.studio_name || criticalData.studio?.name || "");
          if (studentsRevisionRef.current === studentsRevisionAtStart) {
            commitStudents(criticalData.students, {
              mayBePartial: criticalData.students.length >= DASHBOARD_BOOTSTRAP_STUDENT_LIMIT,
            });
          }
          setLeads(criticalData.leads);
          applyLadderSelection(
            criticalData.belt_ladders.length > 0
              ? criticalData.belt_ladders
              : criticalData.primary_belt_ladder
                ? [criticalData.primary_belt_ladder]
                : [],
            criticalData.primary_belt_ladder?.id ?? null
          );
          setHydrated(true);
        }

        void (async () => {
          const templatesRes = await api
            .get<ClassTemplate[]>("/schedule/templates", session.access_token)
            .catch(() => []);
          const selectedLadder = selectBeltLadder(
            beltLaddersRef.current,
            currentLadderIdRef.current
          );
          const eligibilityRes = selectedLadder
            ? await api
                .get<EligibilityEntry[]>(
                  `/belts/eligibility?ladder_id=${encodeURIComponent(selectedLadder.id)}`,
                  session.access_token
                )
                .catch(() => [])
            : [];

          const start = new Date();
          start.setDate(start.getDate() - 30);
          const end = new Date();
          end.setDate(end.getDate() + 60);

          const sessionsRes = await api.get<ClassSession[]>(
            `/schedule/sessions?start_date=${start.toISOString().split("T")[0]}&end_date=${end.toISOString().split("T")[0]}`,
            session.access_token
          ).catch(() => []);

          const attendanceRes = await api
            .get<AttendanceRecord[]>(
              `/schedule/attendance?start_date=${start.toISOString().split("T")[0]}&end_date=${end.toISOString().split("T")[0]}`,
              session.access_token
            )
            .catch(() => []);

          if (!mounted) {
            return;
          }

          setTemplates(templatesRes);
          setEligibility(eligibilityRes);
          setSessions(sessionsRes);
          setAttendance(normalizeAttendanceRecords(attendanceRes));
        })().catch((error) => {
          console.error("Failed to load deferred dashboard data", error);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (mounted && /Complete onboarding first|No studio found/i.test(message)) {
          resetLiveStudioState();
          setHydrated(true);
          router.replace("/onboarding");
          return;
        }
        if (mounted) {
          setStudentsLoadError(
            error instanceof Error ? error.message : "Failed to load the student roster."
          );
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
        setToken(session.access_token);
      } else {
        setToken(null);
        setCurrentUser(null);
        clearStudioStateCookie();
        clearActiveStudioIdCookie();
      }
    });

    return () => {
      mounted = false;
      authListener?.subscription.unsubscribe();
    };
  }, [applyLadderSelection, clearPromotionHistoryCache, commitStudents, fetchAllStudents, isPreviewMode, resetLiveStudioState, router, supabase]);

  // ── Persist helpers (for preview mode) ──
  const persistStudents = useCallback((next: Student[]) => {
    commitStudents(next);
    if (isPreviewMode) save(KEYS.students, next);
  }, [commitStudents, isPreviewMode]);

  const persistLeads = useCallback((next: Lead[]) => {
    setLeads(next);
    if (isPreviewMode) save(KEYS.leads, next);
  }, [isPreviewMode]);

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
  const addStudent = useCallback(async (data: StudentCreate): Promise<Student> => {
    if (isPreviewMode) {
      const newStudent: Student = {
        id: localId(),
        studio_id: "mock-studio",
        legal_first_name: data.legal_first_name,
        legal_last_name: data.legal_last_name,
        preferred_name: data.preferred_name,
        date_of_birth: data.date_of_birth,
        is_minor: data.date_of_birth ? (Date.now() - new Date(data.date_of_birth).getTime()) < 18 * 365.25 * 24 * 60 * 60 * 1000 : false,
        hold_start_date: data.hold_start_date,
        hold_end_date: data.hold_end_date,
        email: data.email,
        phone: data.phone,
        address_line1: data.address_line1,
        address_city: data.address_city,
        address_state: data.address_state,
        address_zip: data.address_zip,
        emergency_contact_name: data.emergency_contact_name,
        emergency_contact_phone: data.emergency_contact_phone,
        emergency_contact_relation: data.emergency_contact_relation,
        status: (data.status as StudentStatus) || "active",
        membership_start_date: data.membership_start_date || new Date().toISOString().split("T")[0],
        notes: data.notes,
        tags: data.tags || [],
        guardians: (data.guardians || []).map((g, i) => ({
          id: localId(),
          first_name: g.first_name,
          last_name: g.last_name,
          email: g.email,
          phone: g.phone,
          relation: g.relation,
          is_primary_contact: g.is_primary_contact ?? i === 0,
        })),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      persistStudents([newStudent, ...studentsRef.current]);
      return newStudent;
    } else {
      if (!token) throw new Error("Not authenticated");
      const res = await api.post<Student>("/students", data, token);
      commitStudents((current) => [res, ...current]);
      return res;
    }
  }, [commitStudents, isPreviewMode, persistStudents, studentsRef, token]);

  const updateStudent = useCallback(async (id: string, data: Partial<Student>) => {
    if (isPreviewMode) {
      const next = studentsRef.current.map(s => s.id === id ? { ...s, ...data, updated_at: new Date().toISOString() } : s);
      persistStudents(next);
    } else {
      if (!token) throw new Error("Not authenticated");
      const res = await api.patch<Student>(`/students/${id}`, data, token);
      commitStudents((current) => current.map((student) => student.id === id ? res : student));
    }
  }, [commitStudents, isPreviewMode, persistStudents, studentsRef, token]);

  const deleteStudents = useCallback(async (ids: string[]) => {
    if (isPreviewMode) {
      const idSet = new Set(ids);
      const next = studentsRef.current.filter(s => !idSet.has(s.id));
      persistStudents(next);
    } else {
      if (!token) throw new Error("Not authenticated");
      for (const id of ids) {
        await api.delete(`/students/${id}`, token);
      }
      const idSet = new Set(ids);
      commitStudents((current) => current.filter((student) => !idSet.has(student.id)));
    }
  }, [commitStudents, isPreviewMode, persistStudents, studentsRef, token]);

  const importStudents = useCallback(async (
    file: File,
    rows: Record<string, string>[],
    mapping: Record<string, string>,
    options: CsvImportOptions,
    request?: { importKey?: string }
  ): Promise<CsvImportResult> => {
    if (isPreviewMode) {
      const newStudents: Student[] = [];
      const issueRows: CsvImportResult["rows"] = [];
      const warnings: CsvImportResult["warnings"] = [];
      let validRows = 0;
      let normalizedStatusCount = 0;

      for (const [index, row] of rows.entries()) {
        const mapped: Record<string, string> = {};
        for (const [csvCol, koaryuField] of Object.entries(mapping)) {
          if (koaryuField && row[csvCol]) mapped[koaryuField] = row[csvCol];
        }

        const validStatuses: StudentStatus[] = ["active", "trialing", "inactive", "paused", "canceled"];
        const rawStatus = (mapped.status || "").trim().toLowerCase();
        const statusValue = mapped.status || "";
        const rowIssues: CsvImportResult["rows"][number]["issues"] = [];
        let normalizedStatus = rawStatus;

        if (!mapped.legal_first_name) {
          rowIssues.push({
            code: "missing_first_name",
            severity: "error",
            field: "legal_first_name",
            message: "Missing required field: first name",
          });
        }
        if (!mapped.legal_last_name) {
          rowIssues.push({
            code: "missing_last_name",
            severity: "error",
            field: "legal_last_name",
            message: "Missing required field: last name",
          });
        }
        if (mapped.status && options.status_alias_mode === "normalize" && rawStatus === "overdue") {
          normalizedStatus = "paused";
          mapped.status = normalizedStatus;
          normalizedStatusCount += 1;
          rowIssues.push({
            code: "normalized_status",
            severity: "warning",
            field: "status",
            value: statusValue,
            message: `Status "${statusValue}" will be imported as "paused".`,
          });
        } else if (mapped.status && !validStatuses.includes(rawStatus as StudentStatus)) {
          rowIssues.push({
            code: "invalid_status",
            severity: "error",
            field: "status",
            value: statusValue,
            message: `Invalid status "${mapped.status}". Must be one of: ${validStatuses.join(", ")}`,
          });
        }

        const isValid = !rowIssues.some((issue) => issue.severity === "error");

        if (rowIssues.length > 0) {
          issueRows.push({
            row_number: index + 2,
            data: mapped,
            issues: rowIssues,
            is_valid: isValid,
          });
        }

        if (!isValid) continue;

        validRows += 1;
        const status: StudentStatus = validStatuses.includes(normalizedStatus as StudentStatus)
          ? (normalizedStatus as StudentStatus)
          : "active";

        const tags = mapped.tags ? mapped.tags.split(",").map(t => t.trim()).filter(Boolean) : [];
        const dob = mapped.date_of_birth || undefined;
        const isMinor = dob ? (Date.now() - new Date(dob).getTime()) < 18 * 365.25 * 24 * 60 * 60 * 1000 : false;

        newStudents.push({
          id: localId(),
          studio_id: "mock-studio",
          legal_first_name: mapped.legal_first_name,
          legal_last_name: mapped.legal_last_name,
          preferred_name: mapped.preferred_name || undefined,
          date_of_birth: dob,
          is_minor: isMinor,
          email: mapped.email || undefined,
          phone: mapped.phone || undefined,
          address_line1: mapped.address_line1 || undefined,
          address_city: mapped.address_city || undefined,
          address_state: mapped.address_state || undefined,
          address_zip: mapped.address_zip || undefined,
          emergency_contact_name: mapped.emergency_contact_name || undefined,
          emergency_contact_phone: mapped.emergency_contact_phone || undefined,
          emergency_contact_relation: mapped.emergency_contact_relation || undefined,
          status,
          membership_start_date: mapped.membership_start_date || new Date().toISOString().split("T")[0],
          program_id: mapped.program_id || undefined,
          current_belt_rank_id: mapped.current_belt_rank_id || undefined,
          notes: mapped.notes || undefined,
          tags,
          guardians: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      if (normalizedStatusCount > 0) {
        warnings.push({
          code: "normalized_status",
          message: "Some student statuses will be normalized during import.",
          severity: "warning",
          row_numbers: issueRows
            .filter((item) => item.issues.some((issue) => issue.code === "normalized_status"))
            .map((item) => item.row_number),
          field: "status",
          values: ["overdue"],
        });
      }
      if (newStudents.length > 0) {
        persistStudents([...newStudents, ...studentsRef.current]);
      }
      return {
        total_rows: rows.length,
        valid_rows: validRows,
        error_rows: issueRows.filter((item) => !item.is_valid).length,
        rows: issueRows,
        warnings,
        setup_issues: [],
        actions_available: {
          can_create_missing_programs: false,
          can_create_missing_belts: false,
          can_import_without_unresolved_belt: false,
        },
        created_programs: [],
        created_ladders: [],
        created_belts: [],
        imported_without_belt_count: 0,
        normalized_status_count: normalizedStatusCount,
        imported_count: newStudents.length,
      };
    } else {
      if (!token) throw new Error("Not authenticated");

      const importKey = request?.importKey?.trim();
      const formData = new FormData();
      const requestPayload: CsvImportRequest = {
        mapping,
        options,
        ...(importKey ? {
          import_key: importKey,
          idempotency_key: importKey,
        } : {}),
      };

      formData.append("file", file);
      formData.append("payload", JSON.stringify(requestPayload));
      if (importKey) {
        formData.append("import_key", importKey);
        formData.append("idempotency_key", importKey);
      }

      const result = await api.postForm<CsvImportResult>(
        "/students/import/execute",
        formData,
        token,
        {
          timeoutMs: null,
          headers: importKey ? {
            "Idempotency-Key": importKey,
            "X-Import-Key": importKey,
          } : undefined,
          networkErrorMessage:
            "The connection dropped before Koaryu could confirm whether this import finished. Do not start a brand-new import yet. Wait a moment, then retry with this same file and option set so the same import key is reused.",
        }
      );

      const shouldRefreshStudents = true;
      const shouldRefreshBelts =
        result.imported_count > 0 ||
        result.reused_result ||
        result.created_programs.length > 0 ||
        result.created_ladders.length > 0 ||
        result.created_belts.length > 0;

      try {
        const refreshOperations: Promise<unknown>[] = [];

        if (shouldRefreshStudents) {
          refreshOperations.push(
            fetchAllStudents(token, { timeoutMs: 30000 }).then((refreshedStudents) => {
              commitStudents(refreshedStudents);
            })
          );
        }

        if (shouldRefreshBelts) {
          refreshOperations.push(refreshBeltsRef.current?.() ?? Promise.resolve());
        }

        await Promise.all(refreshOperations);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to refresh students after import.";
        setStudentsLoadError(message);
        throw new Error(
          `The import finished, but Koaryu could not refresh the Students list afterward. ${message}`
        );
      }

      return result;
    }
  }, [commitStudents, fetchAllStudents, isPreviewMode, persistStudents, studentsRef, token]);

  const refreshStudents = useCallback(async (): Promise<Student[]> => {
    if (isPreviewMode) {
      return studentsRef.current;
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    try {
      const nextStudents = await fetchAllStudents(token, { timeoutMs: 30000 });
      commitStudents(nextStudents);
      return nextStudents;
    } catch (error) {
      setStudentsLoadError(
        error instanceof Error ? error.message : "Failed to load students."
      );
      throw error;
    }
  }, [commitStudents, fetchAllStudents, isPreviewMode, token]);

  const bulkAddTagsToStudents = useCallback(async (
    studentIds: string[],
    tags: string[]
  ): Promise<BulkStudentTagUpdateResponse> => {
    const normalizedStudentIds = normalizeStudentIds(studentIds);
    const normalizedTags = normalizeTags(tags);

    if (normalizedStudentIds.length === 0) {
      throw new Error("Select at least one student.");
    }

    if (normalizedTags.length === 0) {
      throw new Error("Enter at least one tag.");
    }

    const payload: BulkStudentTagUpdateRequest = {
      student_ids: normalizedStudentIds,
      tags_to_add: normalizedTags,
      tags_to_remove: [],
    };

    if (isPreviewMode) {
      const selectedIdSet = new Set(normalizedStudentIds);
      const nextStudents = applyAddedTagsToStudents(
        studentsRef.current,
        normalizedStudentIds,
        normalizedTags
      );
      persistStudents(nextStudents);

      return {
        updated: studentsRef.current.filter((student) => selectedIdSet.has(student.id)).length,
      };
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    let response: BulkStudentTagUpdateResponse;
    try {
      response = await api.post<BulkStudentTagUpdateResponse>(
        "/students/bulk/tags",
        payload,
        token
      );
    } catch (error) {
      try {
        await refreshStudents();
      } catch (refreshError) {
        console.error("Failed to refresh students after bulk tag update error", refreshError);
      }
      throw error;
    }

    try {
      await refreshStudents();
    } catch (error) {
      console.error("Failed to refresh students after bulk tag update", error);
      commitStudents((current) => applyAddedTagsToStudents(current, normalizedStudentIds, normalizedTags));
    }

    return response;
  }, [commitStudents, isPreviewMode, persistStudents, refreshStudents, studentsRef, token]);

  const bulkUpdateStudentStatus = useCallback(async (
    studentIds: string[],
    status: StudentStatus
  ): Promise<BulkStudentStatusUpdateResponse> => {
    const normalizedStudentIds = normalizeStudentIds(studentIds);

    if (normalizedStudentIds.length === 0) {
      throw new Error("Select at least one student.");
    }

    const payload: BulkStudentStatusUpdateRequest = {
      student_ids: normalizedStudentIds,
      status,
    };

    if (isPreviewMode) {
      const selectedIdSet = new Set(normalizedStudentIds);
      persistStudents(applyStatusToStudents(studentsRef.current, normalizedStudentIds, status));

      return {
        updated: studentsRef.current.filter((student) => selectedIdSet.has(student.id)).length,
      };
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    let response: BulkStudentStatusUpdateResponse;
    try {
      response = await api.post<BulkStudentStatusUpdateResponse>(
        "/students/bulk/status",
        payload,
        token
      );
    } catch (error) {
      try {
        await refreshStudents();
      } catch (refreshError) {
        console.error("Failed to refresh students after bulk status update error", refreshError);
      }
      throw error;
    }

    try {
      await refreshStudents();
    } catch (error) {
      console.error("Failed to refresh students after bulk status update", error);
      commitStudents((current) => applyStatusToStudents(current, normalizedStudentIds, status));
    }

    return response;
  }, [commitStudents, isPreviewMode, persistStudents, refreshStudents, studentsRef, token]);

  // ── Leads ──
  const addLead = useCallback(async (data: Partial<Lead>) => {
    if (isPreviewMode) {
      const newLead: Lead = {
        id: localId(),
        studio_id: "mock-studio",
        first_name: data.first_name || "",
        last_name: data.last_name || "",
        email: data.email,
        phone: data.phone,
        source: (data.source as LeadSource) || "walk_in",
        stage: "inquiry",
        program_interest: data.program_interest,
        is_minor: data.is_minor || false,
        guardian_name: data.guardian_name,
        guardian_email: data.guardian_email,
        guardian_phone: data.guardian_phone,
        follow_up_date: data.follow_up_date,
        notes: data.notes,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      persistLeads([newLead, ...leadsRef.current]);
    } else {
      if (!token) throw new Error("Not authenticated");
      const res = await api.post<Lead>("/leads", data, token);
      setLeads((current) => [res, ...current]);
    }
  }, [isPreviewMode, leadsRef, persistLeads, token]);

  const updateLead = useCallback(async (id: string, data: Partial<Lead>) => {
    if (isPreviewMode) {
      const next = leadsRef.current.map(l => l.id === id ? { ...l, ...data, updated_at: new Date().toISOString() } : l);
      persistLeads(next);
    } else {
      if (!token) throw new Error("Not authenticated");
      const res = await api.patch<Lead>(`/leads/${id}`, data, token);
      setLeads((current) => current.map((lead) => lead.id === id ? res : lead));
    }
  }, [isPreviewMode, leadsRef, persistLeads, token]);

  const deleteLead = useCallback(async (id: string) => {
    if (isPreviewMode) {
      persistLeads(leadsRef.current.filter(l => l.id !== id));
    } else {
      if (!token) throw new Error("Not authenticated");
      await api.delete(`/leads/${id}`, token);
      setLeads((current) => current.filter((lead) => lead.id !== id));
    }
  }, [isPreviewMode, leadsRef, persistLeads, token]);

  const refreshLeads = useCallback(async (): Promise<Lead[]> => {
    if (isPreviewMode) {
      return leadsRef.current;
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const result = await api.get<Lead[]>("/leads", token);
    setLeads(result);
    return result;
  }, [isPreviewMode, token]);

  const fetchEligibilityForLadder = useCallback(async (ladderId?: string | null): Promise<EligibilityEntry[]> => {
    if (isPreviewMode) {
      return MOCK_ELIGIBILITY;
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    if (!ladderId) {
      return [];
    }

    return api.get<EligibilityEntry[]>(
      `/belts/eligibility?ladder_id=${encodeURIComponent(ladderId)}`,
      token
    );
  }, [isPreviewMode, token]);

  const refreshBelts = useCallback(async (preferredLadderId?: string | null) => {
    if (isPreviewMode) {
      return;
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const beltLaddersRes = await api.get<BeltLadder[]>("/belts/ladders", token);
    const selectedLadder = applyLadderSelection(
      beltLaddersRes,
      preferredLadderId ?? currentLadderIdRef.current
    );
    const eligibilityRes = selectedLadder
      ? await fetchEligibilityForLadder(selectedLadder.id).catch(() => [])
      : [];
    setEligibility(eligibilityRes);
  }, [applyLadderSelection, fetchEligibilityForLadder, isPreviewMode, token]);
  useEffect(() => {
    refreshBeltsRef.current = refreshBelts;
  }, [refreshBelts]);

  const setCurrentLadder = useCallback(async (ladderId: string) => {
    if (isPreviewMode) {
      const selectedLadder = applyLadderSelection(beltLaddersRef.current, ladderId);
      if (selectedLadder) {
        setEligibility(MOCK_ELIGIBILITY);
      }
      return;
    }

    const selectedLadder = applyLadderSelection(beltLaddersRef.current, ladderId);
    if (!selectedLadder) {
      await (refreshBeltsRef.current?.(ladderId) ?? Promise.resolve());
      return;
    }

    const refreshedEligibility = await fetchEligibilityForLadder(selectedLadder.id).catch(
      (error) => {
        setEligibility([]);
        throw error;
      }
    );
    setEligibility(refreshedEligibility);
  }, [applyLadderSelection, fetchEligibilityForLadder, isPreviewMode]);

  const ensureCurrentLadder = useCallback(async (termOverride?: string) => {
    if (isPreviewMode) {
      const selectedPreviewLadder = selectBeltLadder(
        beltLaddersRef.current,
        currentLadderIdRef.current
      );
      return {
        id: selectedPreviewLadder?.id || "mock-ladder",
        sub_rank_term: termOverride || selectedPreviewLadder?.sub_rank_term || subRankTerm,
      };
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    if (currentLadderIdRef.current) {
      return {
        id: currentLadderIdRef.current,
        sub_rank_term: termOverride || subRankTerm,
      };
    }

    const existingLadders = await api.get<BeltLadder[]>("/belts/ladders", token);
    const existingSelectedLadder = applyLadderSelection(existingLadders);

    if (existingSelectedLadder) {
      return {
        id: existingSelectedLadder.id,
        sub_rank_term: existingSelectedLadder.sub_rank_term || "Stripe",
      };
    }

    const created = await api.post<BeltLadder>(
      "/belts/ladders",
      {
        name: ladderName || "Default Belt Ladder",
        sub_rank_term: termOverride || subRankTerm,
      },
      token
    );

    applyLadderSelection([created], created.id);
    return {
      id: created.id,
      sub_rank_term: created.sub_rank_term || termOverride || "Stripe",
    };
  }, [applyLadderSelection, isPreviewMode, ladderName, subRankTerm, token]);

  const convertLeadToStudent = useCallback(async (leadId: string) => {
    const lead = leadsRef.current.find((item) => item.id === leadId);
    if (!lead) {
      throw new Error("Lead not found");
    }

    if (lead.converted_student_id) {
      throw new Error("This lead has already been converted.");
    }

    if (isPreviewMode) {
      const studentId = localId();
      const now = new Date().toISOString();
      const membershipStartDate = new Date().toISOString().split("T")[0];

      const newStudent: Student = {
        id: studentId,
        studio_id: "mock-studio",
        legal_first_name: lead.first_name,
        legal_last_name: lead.last_name,
        preferred_name: undefined,
        date_of_birth: undefined,
        is_minor: lead.is_minor,
        hold_start_date: undefined,
        hold_end_date: undefined,
        email: lead.email,
        phone: lead.phone,
        address_line1: undefined,
        address_city: undefined,
        address_state: undefined,
        address_zip: undefined,
        emergency_contact_name: undefined,
        emergency_contact_phone: undefined,
        emergency_contact_relation: undefined,
        status: "active",
        membership_start_date: membershipStartDate,
        program_id: undefined,
        current_belt_rank_id: undefined,
        stripe_customer_id: undefined,
        notes: lead.notes,
        tags: ["converted-lead"],
        guardians: lead.is_minor && lead.guardian_name
          ? [
              {
                id: localId(),
                first_name: lead.guardian_name.split(" ")[0] || lead.guardian_name,
                last_name: lead.guardian_name.split(" ").slice(1).join(" "),
                email: lead.guardian_email,
                phone: lead.guardian_phone,
                relation: undefined,
                is_primary_contact: true,
              },
            ]
          : [],
        created_at: now,
        updated_at: now,
      };

      const updatedLead: Lead = {
        ...lead,
        stage: "enrolled",
        converted_student_id: studentId,
        updated_at: now,
      };

      persistStudents([newStudent, ...studentsRef.current]);
      persistLeads(leadsRef.current.map((item) => (item.id === leadId ? updatedLead : item)));

      return {
        lead: updatedLead,
        studentId,
      };
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const membershipStartDate = new Date().toISOString().split("T")[0];
    const result = await api.post<Lead>(
      `/leads/${leadId}/convert`,
      {
        status: "active",
        membership_start_date: membershipStartDate,
      },
      token
    );

    setLeads((current) => current.map((item) => (item.id === leadId ? result : item)));
    try {
      await refreshStudents();
    } catch (error) {
      console.error("Failed to refresh students after lead conversion", error);
    }

    return {
      lead: result,
      studentId: result.converted_student_id ?? null,
    };
  }, [isPreviewMode, leadsRef, persistLeads, persistStudents, refreshStudents, studentsRef, token]);

  // ── Belt tracker ──
  const setBeltRanks = useCallback(async (ranks: BeltRank[], options?: { subRankTerm?: string }) => {
    if (isPreviewMode) {
      const selectedPreviewLadder = selectBeltLadder(
        beltLaddersRef.current,
        currentLadderIdRef.current
      );
      const nextSubRankTerm = options?.subRankTerm?.trim() || selectedPreviewLadder?.sub_rank_term || subRankTerm;
      persistBeltRanks(ranks);
      const nextPreviewLadder: BeltLadder = {
        ...(selectedPreviewLadder || MOCK_BELT_LADDER),
        id: selectedPreviewLadder?.id || "mock-ladder",
        name: selectedPreviewLadder?.name || ladderName || MOCK_BELT_LADDER.name,
        sub_rank_term: nextSubRankTerm,
        ranks,
      };
      applyLadderSelection([nextPreviewLadder], nextPreviewLadder.id);
    } else {
      const desiredSubRankTerm = options?.subRankTerm?.trim() || undefined;
      const ladder = await ensureCurrentLadder(desiredSubRankTerm);
      const nextSubRankTerm = desiredSubRankTerm || ladder.sub_rank_term || "Stripe";
      const syncPayload = {
        sub_rank_term: nextSubRankTerm,
        ranks: ranks.map((rank, index) => ({
          ...(rank.id && !rank.id.startsWith("local-") ? { id: rank.id } : {}),
          name: rank.name,
          color_hex: rank.color_hex,
          display_order: index,
          min_classes: rank.min_classes,
          min_months: rank.min_months,
          requires_approval: rank.requires_approval,
          is_tip: rank.is_tip,
          tip_color_hex: rank.is_tip ? rank.tip_color_hex ?? null : null,
        })),
      };

      const syncedLadder = await api.post<BeltLadder>(
        `/belts/ladders/${ladder.id}/sync`,
        syncPayload,
        token || undefined
      );
      const nextLadders = upsertBeltLadder(beltLaddersRef.current, syncedLadder);
      applyLadderSelection(nextLadders, syncedLadder.id);

      const refreshedEligibility = await fetchEligibilityForLadder(syncedLadder.id)
        .catch(() => eligibilityRef.current);
      setEligibility(refreshedEligibility);
    }
  }, [applyLadderSelection, ensureCurrentLadder, fetchEligibilityForLadder, isPreviewMode, ladderName, persistBeltRanks, subRankTerm, token]);

  const setLadderName = useCallback((name: string) => {
    setLadderNameState(name);
    if (isPreviewMode) save(KEYS.ladderName, name);
  }, [isPreviewMode]);

  const setSubRankTerm = useCallback(async (term: string) => {
    const nextTerm = term.trim() || "Stripe";

    if (isPreviewMode) {
      const selectedPreviewLadder = selectBeltLadder(
        beltLaddersRef.current,
        currentLadderIdRef.current
      );
      setSubRankTermState(nextTerm);
      if (selectedPreviewLadder) {
        applyLadderSelection(
          upsertBeltLadder(beltLaddersRef.current, {
            ...selectedPreviewLadder,
            sub_rank_term: nextTerm,
          }),
          selectedPreviewLadder.id
        );
      }
      save(KEYS.subRankTerm, nextTerm);
      return;
    }

    const ladder = await ensureCurrentLadder(nextTerm);
    if (ladder.sub_rank_term !== nextTerm) {
      await api.patch(
        `/belts/ladders/${ladder.id}`,
        { sub_rank_term: nextTerm },
        token || undefined
      );
    }
    await refreshBelts(ladder.id);
  }, [applyLadderSelection, ensureCurrentLadder, isPreviewMode, refreshBelts, token]);

  const loadPromotionHistory = useCallback(async (
    studentId: string,
    options?: { force?: boolean; signal?: AbortSignal }
  ): Promise<Promotion[]> => {
    const cached = promotionHistoryCacheRef.current[studentId];
    const cacheIsFresh = cached
      && Date.now() - cached.fetchedAt < PROMOTION_HISTORY_CACHE_TTL_MS;

    if (cached && !options?.force && cacheIsFresh) {
      return cached.items;
    }

    const inFlightRequest = promotionHistoryRequestsRef.current[studentId];
    if (inFlightRequest && !options?.force) {
      return inFlightRequest;
    }

    if (isPreviewMode) {
      return cached?.items ?? [];
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const generation = promotionHistoryGenerationRef.current;
    const request = api
      .get<Promotion[]>(
        `/belts/promotions?student_id=${encodeURIComponent(studentId)}&include_names=false`,
        token,
        {
          timeoutMs: 6000,
          timeoutMessage: "Promotion history took too long to load. Please try again.",
        }
      )
      .then((result) => {
        if (generation === promotionHistoryGenerationRef.current) {
          commitPromotionHistoryCache(studentId, result);
        }
        return result;
      })
      .finally(() => {
        if (promotionHistoryRequestsRef.current[studentId] === request) {
          delete promotionHistoryRequestsRef.current[studentId];
        }
      });

    promotionHistoryRequestsRef.current[studentId] = request;
    return request;
  }, [commitPromotionHistoryCache, isPreviewMode, token]);

  const promoteStudent = useCallback(async (studentId: string, toRankId: string, notes?: string) => {
    if (isPreviewMode) {
      const student = studentsRef.current.find((item) => item.id === studentId);
      if (!student) {
        throw new Error("Student not found");
      }

      const targetRank = beltRanksRef.current.find((rank) => rank.id === toRankId);
      if (!targetRank) {
        throw new Error("Target rank not found");
      }

      const now = new Date().toISOString();
      persistStudents(
        studentsRef.current.map((item) =>
          item.id === studentId
            ? { ...item, current_belt_rank_id: toRankId, updated_at: now }
            : item
        )
      );

      const promotion = {
        id: localId(),
        studio_id: student.studio_id,
        student_id: studentId,
        from_rank_id: student.current_belt_rank_id,
        to_rank_id: toRankId,
        promoted_by: "preview-user",
        notes,
        promoted_at: now,
        student_name: student.preferred_name || `${student.legal_first_name} ${student.legal_last_name}`,
        from_rank_name: beltRanksRef.current.find((rank) => rank.id === student.current_belt_rank_id)?.name,
        to_rank_name: targetRank.name,
      };

      const existing = promotionHistoryCacheRef.current[studentId]?.items ?? [];
      commitPromotionHistoryCache(
        studentId,
        [promotion, ...existing.filter((item) => item.id !== promotion.id)]
      );

      return promotion;
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const result = await api.post<Promotion>(
      "/belts/promote",
      {
        student_id: studentId,
        to_rank_id: toRankId,
        notes,
      },
      token
    );

    const existing = promotionHistoryCacheRef.current[studentId]?.items ?? [];
    commitPromotionHistoryCache(
      studentId,
      [result, ...existing.filter((item) => item.id !== result.id)]
    );

    await Promise.all([refreshStudents(), refreshBelts(currentLadderIdRef.current)]);
    return result;
  }, [beltRanksRef, commitPromotionHistoryCache, isPreviewMode, persistStudents, refreshBelts, refreshStudents, studentsRef, token]);

  // ── Schedule ──
  const refreshScheduleRange = useCallback(async (startDate: string, endDate: string): Promise<ClassSession[]> => {
    if (isPreviewMode) {
      return sessionsRef.current.filter((session) => session.date >= startDate && session.date <= endDate);
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const rangeSessions = await api.get<ClassSession[]>(
      `/schedule/sessions?start_date=${startDate}&end_date=${endDate}`,
      token
    );
    const replacedSessionIds = Array.from(
      new Set([
        ...sessionsRef.current
          .filter((session) => session.date >= startDate && session.date <= endDate)
          .map((session) => session.id),
        ...rangeSessions.map((session) => session.id),
      ])
    );

    setSessions((current) => mergeSessionsForRange(current, rangeSessions, startDate, endDate));
    const attendanceQuery = rangeSessions.length >= SCHEDULE_ATTENDANCE_BULK_THRESHOLD
      ? `/schedule/attendance?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`
      : `/schedule/attendance?${rangeSessions
          .map((sessionItem) => `session_ids=${encodeURIComponent(sessionItem.id)}`)
          .join("&")}`;

    if (rangeSessions.length > 0) {
      void api
        .get<AttendanceRecord[]>(attendanceQuery, token)
        .then((records) => {
          setAttendance((current) =>
            mergeAttendanceForSessions(
              current,
              normalizeAttendanceRecords(records),
              replacedSessionIds
            )
          );
        })
        .catch((error) => {
          console.error("Failed to refresh schedule attendance", error);
        });
    } else {
      setAttendance((current) =>
        mergeAttendanceForSessions(current, [], replacedSessionIds)
      );
    }
    return rangeSessions;
  }, [isPreviewMode, token]);

  const refreshSessionAttendance = useCallback(async (sessionId: string): Promise<AttendanceRecord[]> => {
    if (isPreviewMode) {
      return attendanceRef.current.filter((record) => record.session_id === sessionId);
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const records = await api.get<AttendanceRecord[]>(
      `/schedule/attendance?session_ids=${encodeURIComponent(sessionId)}`,
      token
    );
    const normalizedRecords = normalizeAttendanceRecords(records);
    setAttendance((current) => mergeAttendanceForSessions(current, normalizedRecords, [sessionId]));
    return normalizedRecords;
  }, [isPreviewMode, token]);

  const addTemplate = useCallback(async (data: ClassTemplateCreate): Promise<ClassTemplate> => {
    if (isPreviewMode) {
      const startDate = data.start_date || new Date().toISOString().split("T")[0];
      const newTemplate: ClassTemplate = {
        id: localId(),
        studio_id: "mock-studio",
        name: data.name,
        day_of_week: data.day_of_week,
        start_time: data.start_time,
        end_time: data.end_time,
        start_date: startDate,
        end_date: data.end_date,
        instructor_id: data.instructor_id,
        program_id: data.program_id,
        capacity: data.capacity,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      persistTemplates([...templatesRef.current, newTemplate]);

      const existingKeys = new Set(
        sessionsRef.current
          .filter((session) => session.template_id)
          .map((session) => `${session.template_id}:${session.date}`)
      );
      const generatedSessions = getPreviewTemplateSessionDates(newTemplate)
        .filter((dateValue) => !existingKeys.has(`${newTemplate.id}:${dateValue}`))
        .map((dateValue) => ({
          id: localId(),
          studio_id: "mock-studio",
          template_id: newTemplate.id,
          name: newTemplate.name,
          date: dateValue,
          start_time: newTemplate.start_time,
          end_time: newTemplate.end_time,
          instructor_id: newTemplate.instructor_id,
          program_id: newTemplate.program_id,
          capacity: newTemplate.capacity,
          status: "scheduled" as const,
          created_at: new Date().toISOString(),
          attendance_count: 0,
        }));
      if (generatedSessions.length > 0) {
        persistSessions([...sessionsRef.current, ...generatedSessions].sort(compareSessions));
      }
      return newTemplate;
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const res = await api.post<ClassTemplate>("/schedule/templates", data, token);
    setTemplates((current) =>
      [...current, res].sort((left, right) => {
        const dayCompare = left.day_of_week - right.day_of_week;
        if (dayCompare !== 0) {
          return dayCompare;
        }
        return left.start_time.localeCompare(right.start_time);
      })
    );
    return res;
  }, [isPreviewMode, persistSessions, persistTemplates, sessionsRef, templatesRef, token]);

  const addSession = useCallback(async (data: ClassSessionCreate) => {
    if (isPreviewMode) {
      const newSession: ClassSession = {
        id: localId(),
        studio_id: "mock-studio",
        name: data.name || "Untitled Class",
        date: data.date || new Date().toISOString().split("T")[0],
        start_time: data.start_time || "18:00",
        end_time: data.end_time || "19:30",
        capacity: data.capacity,
        status: "scheduled",
        created_at: new Date().toISOString(),
        attendance_count: 0,
      };
      persistSessions([...sessionsRef.current, newSession].sort(compareSessions));
    } else {
      if (!token) throw new Error("Not authenticated");
      const res = await api.post<ClassSession>("/schedule/sessions", data, token);
      setSessions((current) => [...current, res].sort(compareSessions));
    }
  }, [isPreviewMode, persistSessions, sessionsRef, token]);

  const deleteSession = useCallback(async (sessionId: string, scope: ClassSessionDeleteScope = "session") => {
    const sessionToDelete = sessionsRef.current.find((session) => session.id === sessionId);
    if (!sessionToDelete) {
      throw new Error("Class session not found");
    }

    if (isPreviewMode) {
      if (scope === "future_series" && sessionToDelete.template_id) {
        const templateId = sessionToDelete.template_id;
        persistTemplates(
          templatesRef.current.map((template) =>
            template.id === templateId
              ? {
                  ...template,
                  is_active: false,
                  end_date: sessionToDelete.date,
                  updated_at: new Date().toISOString(),
                }
              : template
          )
        );
        persistSessions(
          sessionsRef.current.filter(
            (session) =>
              session.template_id !== templateId || session.date < sessionToDelete.date
          )
        );
        return;
      }

      persistSessions(sessionsRef.current.filter((session) => session.id !== sessionId));
      persistAttendance(attendanceRef.current.filter((record) => record.session_id !== sessionId));
      return;
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const query = scope === "future_series" ? "?scope=future_series" : "";
    await api.delete(`/schedule/sessions/${sessionId}${query}`, token);

    if (scope === "future_series" && sessionToDelete.template_id) {
      const templateId = sessionToDelete.template_id;
      const removedSessionIds = new Set(
        sessionsRef.current
          .filter(
            (session) =>
              session.template_id === templateId && session.date >= sessionToDelete.date
          )
          .map((session) => session.id)
      );
      setTemplates((current) =>
        current.map((template) =>
          template.id === templateId
            ? {
                ...template,
                is_active: false,
                end_date: sessionToDelete.date,
              }
            : template
        )
      );
      setSessions((current) =>
        current.filter(
          (session) =>
            session.template_id !== templateId || session.date < sessionToDelete.date
        )
      );
      setAttendance((current) =>
        current.filter((record) => !removedSessionIds.has(record.session_id))
      );
      return;
    }

    setSessions((current) => current.filter((session) => session.id !== sessionId));
    setAttendance((current) => current.filter((record) => record.session_id !== sessionId));
  }, [attendanceRef, isPreviewMode, persistAttendance, persistSessions, persistTemplates, sessionsRef, templatesRef, token]);

  const toggleCheckIn = useCallback(async (sessionId: string, studentId: string, name: string) => {
    if (isPreviewMode) {
      const existing = attendanceRef.current.find(
        a => a.session_id === sessionId && a.student_id === studentId
      );
      let next: AttendanceRecord[];
      if (existing) {
        const cycle: AttendanceStatus[] = ["present", "late", "absent"];
        const idx = cycle.indexOf(existing.status);
        const previousStatus = existing.status;
        let nextStatusForCount: AttendanceStatus | null = previousStatus;
        if (idx === cycle.length - 1) {
          next = attendanceRef.current.filter(a => a !== existing);
          nextStatusForCount = null;
        } else {
          next = attendanceRef.current.map(a =>
            a === existing ? { ...a, status: cycle[idx + 1] } : a
          );
          nextStatusForCount = cycle[idx + 1];
        }
        setSessions((current) =>
          updateSessionAttendanceCount(
            current,
            sessionId,
            toAttendanceCountDelta(previousStatus, nextStatusForCount)
          )
        );
      } else {
        next = [
          ...attendanceRef.current,
          {
            id: localId(),
            studio_id: "mock-studio",
            session_id: sessionId,
            student_id: studentId,
            status: "present" as AttendanceStatus,
            checked_in_at: new Date().toISOString(),
            student_name: name,
          },
        ];
        setSessions((current) =>
          updateSessionAttendanceCount(
            current,
            sessionId,
            toAttendanceCountDelta(null, "present")
          )
        );
      }
      persistAttendance(next);
    } else {
      if (!token) throw new Error("Not authenticated");

      const cycle: AttendanceStatus[] = ["present", "late", "absent"];
      const existing = attendanceRef.current.find(
        (record) => record.session_id === sessionId && record.student_id === studentId
      );
      const previousStatus = existing?.status ?? null;
      const currentIndex = existing ? cycle.indexOf(existing.status) : -1;
      const nextStatus: AttendanceStatus | null =
        existing && currentIndex === cycle.length - 1
          ? null
          : cycle[(currentIndex + 1 + cycle.length) % cycle.length];

      setAttendance((current) => {
        const next = current.filter(
          (record) => !(record.session_id === sessionId && record.student_id === studentId)
        );
        if (nextStatus) {
          next.push(
            existing
              ? { ...existing, status: nextStatus }
              : {
                  id: `optimistic-${sessionId}-${studentId}`,
                  studio_id: "",
                  session_id: sessionId,
                  student_id: studentId,
                  status: nextStatus,
                  checked_in_at: new Date().toISOString(),
                  student_name: name,
                }
          );
        }
        return next;
      });
      setSessions((current) =>
        updateSessionAttendanceCount(
          current,
          sessionId,
          toAttendanceCountDelta(previousStatus, nextStatus)
        )
      );

      try {
        if (!nextStatus) {
          await api.delete(
            `/schedule/attendance?session_id=${encodeURIComponent(sessionId)}&student_id=${encodeURIComponent(studentId)}`,
            token
          );
          return;
        }

        const res = await api.post<AttendanceRecord>(
          "/schedule/attendance",
          {
            session_id: sessionId,
            student_id: studentId,
            status: nextStatus,
          },
          token
        );

        setAttendance((current) => {
          const next = current.filter(
            (record) => !(record.session_id === sessionId && record.student_id === studentId)
          );
          next.push({
            ...res,
            student_name: existing?.student_name || name,
          });
          return next;
        });
      } catch (error) {
        setAttendance((current) => {
          const next = current.filter(
            (record) => !(record.session_id === sessionId && record.student_id === studentId)
          );
          if (existing) {
            next.push(existing);
          }
          return next;
        });
        setSessions((current) =>
          updateSessionAttendanceCount(
            current,
            sessionId,
            toAttendanceCountDelta(nextStatus, previousStatus)
          )
        );
        throw error;
      }
    }
  }, [attendanceRef, isPreviewMode, persistAttendance, token]);

  // ── Studio ──
  const setStudioName = useCallback(async (name: string) => {
    if (isPreviewMode) {
      setStudioNameState(name);
      save(KEYS.studioName, name);
    } else {
      if (!token) throw new Error("Not authenticated");
      await api.patch("/studios/current", { name }, token);
      setStudioNameState(name);
    }
  }, [isPreviewMode, token]);

  const resetDemoData = useCallback(async (): Promise<DemoResetResponse> => {
    if (isPreviewMode) {
      clearPreviewStorage();
      const previewResponse: DemoResetResponse = {
        studio_name: DEMO_STUDIO_NAME,
        students: MOCK_STUDENTS,
        leads: MOCK_LEADS,
        belt_ladders: [MOCK_BELT_LADDER],
        primary_belt_ladder: MOCK_BELT_LADDER,
        eligibility: MOCK_ELIGIBILITY,
        templates: MOCK_CLASS_TEMPLATES,
        sessions: [...MOCK_SESSIONS].sort(compareSessions),
        attendance: MOCK_ATTENDANCE,
        counts: {
          students: MOCK_STUDENTS.length,
          leads: MOCK_LEADS.length,
          belt_ranks: MOCK_BELT_LADDER.ranks.length,
          class_sessions: MOCK_SESSIONS.length,
          attendance_records: MOCK_ATTENDANCE.length,
        },
      };

      save(KEYS.studioName, previewResponse.studio_name);
      save(KEYS.students, previewResponse.students);
      save(KEYS.leads, previewResponse.leads);
      save(KEYS.beltRanks, MOCK_BELT_LADDER.ranks);
      save(KEYS.sessions, previewResponse.sessions);
      save(KEYS.templates, previewResponse.templates);
      save(KEYS.attendance, previewResponse.attendance);
      save(KEYS.subRankTerm, MOCK_BELT_LADDER.sub_rank_term || "Stripe");
      save(KEYS.ladderName, MOCK_BELT_LADDER.name);

      applyDemoResetResponse(previewResponse);
      return previewResponse;
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const response = await api.post<DemoResetResponse>(
      "/demo/reset",
      {},
      token,
      {
        timeoutMs: 60000,
        timeoutMessage: "Demo reset is taking longer than expected. Please try again in a moment.",
      }
    );
    applyDemoResetResponse(response);
    return response;
  }, [applyDemoResetResponse, isPreviewMode, token]);

  // ── Context values ──
  const configValue = useMemo<ConfigStoreContextValue>(() => ({
    isPreviewMode,
    token,
  }), [isPreviewMode, token]);

  const studentsValue = useMemo<StudentsStoreContextValue>(() => ({
    studentsLoaded,
    studentsLoadError,
    studentsLastLoadedAt,
    studentsMayBePartial,
    students,
    addStudent,
    updateStudent,
    deleteStudents,
    bulkAddTagsToStudents,
    bulkUpdateStudentStatus,
    importStudents,
    refreshStudents,
  }), [
    studentsLoaded,
    studentsLoadError,
    studentsLastLoadedAt,
    studentsMayBePartial,
    addStudent,
    bulkAddTagsToStudents,
    bulkUpdateStudentStatus,
    deleteStudents,
    importStudents,
    refreshStudents,
    students,
    updateStudent,
  ]);

  const leadsValue = useMemo<LeadsStoreContextValue>(() => ({
    leads,
    addLead,
    updateLead,
    deleteLead,
    refreshLeads,
    convertLeadToStudent,
  }), [
    addLead,
    convertLeadToStudent,
    deleteLead,
    leads,
    refreshLeads,
    updateLead,
  ]);

  const promotionHistoryByStudent = useMemo<Record<string, Promotion[]>>(
    () => Object.fromEntries(
      Object.entries(promotionHistoryCache).map(([studentId, entry]) => [studentId, entry.items])
    ),
    [promotionHistoryCache]
  );

  const beltsValue = useMemo<BeltsStoreContextValue>(() => ({
    beltLadders,
    beltRanks,
    currentLadderId,
    setCurrentLadder,
    setBeltRanks,
    ladderName,
    setLadderName,
    subRankTerm,
    setSubRankTerm,
    eligibility,
    promotionHistoryByStudent,
    loadPromotionHistory,
    promoteStudent,
  }), [
    beltLadders,
    beltRanks,
    currentLadderId,
    eligibility,
    ladderName,
    loadPromotionHistory,
    promotionHistoryByStudent,
    setCurrentLadder,
    promoteStudent,
    setBeltRanks,
    setLadderName,
    setSubRankTerm,
    subRankTerm,
  ]);

  const scheduleValue = useMemo<ScheduleStoreContextValue>(() => ({
    sessions,
    addSession,
    addTemplate,
    deleteSession,
    refreshScheduleRange,
    refreshSessionAttendance,
    templates,
    attendance,
    toggleCheckIn,
  }), [
    addSession,
    addTemplate,
    attendance,
    deleteSession,
    refreshScheduleRange,
    refreshSessionAttendance,
    sessions,
    templates,
    toggleCheckIn,
  ]);

  const studioValue = useMemo<StudioStoreContextValue>(() => ({
    studioName,
    userEmail: currentUser?.email || "",
    userName: currentUser?.full_name || "",
    resetDemoData,
    setStudioName,
  }), [currentUser, resetDemoData, setStudioName, studioName]);

  if (!hydrated) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <ConfigStoreContext.Provider value={configValue}>
      <StudentsStoreContext.Provider value={studentsValue}>
        <LeadsStoreContext.Provider value={leadsValue}>
          <BeltsStoreContext.Provider value={beltsValue}>
            <ScheduleStoreContext.Provider value={scheduleValue}>
              <StudioStoreContext.Provider value={studioValue}>
                {children}
              </StudioStoreContext.Provider>
            </ScheduleStoreContext.Provider>
          </BeltsStoreContext.Provider>
        </LeadsStoreContext.Provider>
      </StudentsStoreContext.Provider>
    </ConfigStoreContext.Provider>
  );
}

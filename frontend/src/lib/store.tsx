"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LoadingScreen } from "@/components/loading-screen";
import { createClient } from "@/lib/supabase/client";
import { api, isSubscriptionRequiredError } from "@/lib/api";
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
  Program, ProgramCreate, ProgramUpdate,
  StaffInviteCreate, StaffMember, StaffRoleName,
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
  role: StaffRoleName | null;
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
  programs?: Program[];
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
  programs?: Program[];
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

type StudentUpdatePayload = Partial<Student> & {
  program_ids?: string[];
};

// ── Storage keys ─────────────────────────────────────────────────────────────
const KEYS = {
  students: "koaryu:students",
  leads: "koaryu:leads",
  beltRanks: "koaryu:beltRanks",
  sessions: "koaryu:sessions",
  templates: "koaryu:templates",
  attendance: "koaryu:attendance",
  programs: "koaryu:programs",
  beltLadders: "koaryu:beltLadders",
  studioName: "koaryu:studioName",
  subRankTerm: "koaryu:subRankTerm",
  ladderName: "koaryu:ladderName",
};

const DEMO_STUDIO_NAME = "River City Martial Arts";
const PROMOTION_HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
const SCHEDULE_ATTENDANCE_BULK_THRESHOLD = 3;
const MOCK_PROGRAMS: Program[] = [
  {
    id: "program-bjj-core",
    studio_id: "mock-studio",
    name: "Brazilian Jiu-Jitsu Core",
    description: "Shared rank plan for kids, adults, fundamentals, and no-gi.",
    color_hex: "#38BDF8",
    sort_order: 10,
    is_system: false,
    archived_at: null,
    created_at: "2026-04-21T09:00:00Z",
    updated_at: "2026-04-21T09:00:00Z",
    usage: { student_count: 18, active_student_count: 17, class_count: 4, active_class_count: 4, lead_count: 5, belt_ladder_count: 1 },
  },
  {
    id: "program-tae-kwon-do",
    studio_id: "mock-studio",
    name: "Tae Kwon Do Fundamentals",
    description: "Foundational forms, footwork, sparring, and confidence.",
    color_hex: "#F59E0B",
    sort_order: 20,
    is_system: false,
    archived_at: null,
    created_at: "2026-04-21T09:00:00Z",
    updated_at: "2026-04-21T09:00:00Z",
    usage: { student_count: 4, active_student_count: 4, class_count: 1, active_class_count: 1, lead_count: 1, belt_ladder_count: 1 },
  },
  {
    id: "program-unassigned",
    studio_id: "mock-studio",
    name: "Unassigned",
    description: "Students awaiting program assignment.",
    color_hex: "#94A3B8",
    sort_order: 9999,
    is_system: true,
    archived_at: null,
    created_at: "2026-04-21T09:00:00Z",
    updated_at: "2026-04-21T09:00:00Z",
    usage: { student_count: 0, active_student_count: 0, class_count: 0, active_class_count: 0, lead_count: 0, belt_ladder_count: 0 },
  },
];
const MOCK_TAE_KWON_DO_RANKS: BeltRank[] = [
  {
    id: "tkd-rank-1",
    ladder_id: "ladder-tae-kwon-do",
    studio_id: "mock-studio",
    name: "White Belt",
    color_hex: "#FFFFFF",
    display_order: 0,
    min_classes: 0,
    min_months: 0,
    requires_approval: false,
    is_tip: false,
    created_at: "2026-04-21T09:00:00Z",
  },
  {
    id: "tkd-rank-1a",
    ladder_id: "ladder-tae-kwon-do",
    studio_id: "mock-studio",
    name: "Yellow Stripe",
    color_hex: "#FFFFFF",
    tip_color_hex: "#EAB308",
    display_order: 1,
    min_classes: 5,
    min_months: 1,
    requires_approval: false,
    is_tip: true,
    created_at: "2026-04-21T09:00:00Z",
  },
  {
    id: "tkd-rank-2",
    ladder_id: "ladder-tae-kwon-do",
    studio_id: "mock-studio",
    name: "Yellow Belt",
    color_hex: "#EAB308",
    display_order: 2,
    min_classes: 10,
    min_months: 2,
    requires_approval: true,
    is_tip: false,
    created_at: "2026-04-21T09:00:00Z",
  },
  {
    id: "tkd-rank-2a",
    ladder_id: "ladder-tae-kwon-do",
    studio_id: "mock-studio",
    name: "Green Stripe",
    color_hex: "#FFFFFF",
    tip_color_hex: "#22C55E",
    display_order: 3,
    min_classes: 14,
    min_months: 3,
    requires_approval: false,
    is_tip: true,
    created_at: "2026-04-21T09:00:00Z",
  },
  {
    id: "tkd-rank-3",
    ladder_id: "ladder-tae-kwon-do",
    studio_id: "mock-studio",
    name: "Green Belt",
    color_hex: "#22C55E",
    display_order: 4,
    min_classes: 18,
    min_months: 4,
    requires_approval: true,
    is_tip: false,
    created_at: "2026-04-21T09:00:00Z",
  },
  {
    id: "tkd-rank-3a",
    ladder_id: "ladder-tae-kwon-do",
    studio_id: "mock-studio",
    name: "Blue Stripe",
    color_hex: "#FFFFFF",
    tip_color_hex: "#3B82F6",
    display_order: 5,
    min_classes: 22,
    min_months: 5,
    requires_approval: false,
    is_tip: true,
    created_at: "2026-04-21T09:00:00Z",
  },
  {
    id: "tkd-rank-4",
    ladder_id: "ladder-tae-kwon-do",
    studio_id: "mock-studio",
    name: "Blue Belt",
    color_hex: "#3B82F6",
    display_order: 6,
    min_classes: 28,
    min_months: 6,
    requires_approval: true,
    is_tip: false,
    created_at: "2026-04-21T09:00:00Z",
  },
];
const MOCK_TAE_KWON_DO_LADDER: BeltLadder = {
  id: "ladder-tae-kwon-do",
  studio_id: "mock-studio",
  name: "Tae Kwon Do Fundamentals",
  program_id: "program-tae-kwon-do",
  sub_rank_term: "Stripe",
  created_at: "2026-04-21T09:00:00Z",
  updated_at: "2026-04-21T09:00:00Z",
  ranks: MOCK_TAE_KWON_DO_RANKS,
};
const MOCK_BELT_LADDERS: BeltLadder[] = [MOCK_BELT_LADDER, MOCK_TAE_KWON_DO_LADDER];
const MOCK_STAFF_MEMBERS: StaffMember[] = [
  {
    id: "preview-staff-admin",
    studio_id: "mock-studio",
    user_id: "preview-user",
    email: "demo@koaryu.local",
    full_name: "Demo User",
    role: "admin",
    status: "active",
    invited_by: null,
    created_at: "2026-04-21T09:00:00Z",
    updated_at: "2026-04-21T09:00:00Z",
    last_sign_in_at: "2026-04-24T21:00:00Z",
  },
  {
    id: "preview-staff-instructor",
    studio_id: "mock-studio",
    user_id: "preview-instructor",
    email: "sensei@rivercity.example",
    full_name: "Maya Chen",
    role: "instructor",
    status: "active",
    invited_by: "preview-user",
    created_at: "2026-04-22T15:30:00Z",
    updated_at: "2026-04-22T15:30:00Z",
    last_sign_in_at: "2026-04-24T18:15:00Z",
  },
  {
    id: "preview-staff-front-desk",
    studio_id: "mock-studio",
    user_id: "preview-front-desk",
    email: "frontdesk@rivercity.example",
    full_name: "Jordan Lee",
    role: "front_desk",
    status: "pending",
    invited_by: "preview-user",
    created_at: "2026-04-23T11:45:00Z",
    updated_at: "2026-04-23T11:45:00Z",
    last_sign_in_at: null,
  },
];

const STAFF_ROLE_ORDER: Record<StaffRoleName, number> = {
  admin: 0,
  instructor: 1,
  front_desk: 2,
};

function sortStaffMembers(items: StaffMember[], currentUserId?: string | null): StaffMember[] {
  return [...items].sort((a, b) => {
    if (currentUserId && a.user_id === currentUserId && b.user_id !== currentUserId) return -1;
    if (currentUserId && b.user_id === currentUserId && a.user_id !== currentUserId) return 1;
    const roleDelta = STAFF_ROLE_ORDER[a.role] - STAFF_ROLE_ORDER[b.role];
    if (roleDelta !== 0) return roleDelta;
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return a.created_at.localeCompare(b.created_at);
  });
}

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
  subscriptionRequired: boolean;
  markSubscriptionRequired: () => void;
  clearSubscriptionRequired: () => void;

  // Students
  students: Student[];
  studentsLoaded: boolean;
  studentsLoadError: string | null;
  studentsLastLoadedAt: number | null;
  studentsMayBePartial: boolean;
  addStudent: (data: StudentCreate) => Promise<Student>;
  updateStudent: (id: string, data: StudentUpdatePayload) => Promise<void>;
  deleteStudents: (ids: string[]) => Promise<void>;
  uploadStudentPhoto: (studentId: string, file: File) => Promise<Student>;
  deleteStudentPhoto: (studentId: string) => Promise<Student>;
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

  // Programs
  programs: Program[];
  programsLoaded: boolean;
  programsLoadError: string | null;
  refreshPrograms: (options?: { includeArchived?: boolean }) => Promise<Program[]>;
  createProgram: (data: ProgramCreate) => Promise<Program>;
  updateProgram: (id: string, data: ProgramUpdate) => Promise<Program>;
  archiveProgram: (id: string) => Promise<Program>;
  restoreProgram: (id: string) => Promise<Program>;

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
  eligibilityLadderId: string | null;
  eligibilityPendingLadderId: string | null;
  eligibilityLoadError: string | null;
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
  currentUserId: string;
  currentRole: StaffRoleName | null;
  userEmail: string;
  userName: string;
  staffMembers: StaffMember[];
  staffLoaded: boolean;
  staffLoadError: string | null;
  setStudioName: (name: string) => Promise<void>;
  refreshStaff: () => Promise<StaffMember[]>;
  inviteStaff: (data: StaffInviteCreate) => Promise<StaffMember>;
  updateStaffRole: (id: string, role: StaffRoleName) => Promise<StaffMember>;
  removeStaff: (id: string) => Promise<void>;
  resetDemoData: () => Promise<DemoResetResponse>;
}

type ConfigStoreContextValue = Pick<
  StoreContextValue,
  "isPreviewMode" | "token" | "subscriptionRequired" | "markSubscriptionRequired" | "clearSubscriptionRequired"
>;
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
  | "uploadStudentPhoto"
  | "deleteStudentPhoto"
  | "bulkAddTagsToStudents"
  | "bulkUpdateStudentStatus"
  | "importStudents"
	| "refreshStudents"
>;
type ProgramsStoreContextValue = Pick<
  StoreContextValue,
  | "programs"
  | "programsLoaded"
  | "programsLoadError"
  | "refreshPrograms"
  | "createProgram"
  | "updateProgram"
  | "archiveProgram"
  | "restoreProgram"
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
  | "eligibilityLadderId"
  | "eligibilityPendingLadderId"
  | "eligibilityLoadError"
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
  | "studioName"
  | "currentUserId"
  | "currentRole"
  | "userEmail"
  | "userName"
  | "staffMembers"
  | "staffLoaded"
  | "staffLoadError"
  | "setStudioName"
  | "refreshStaff"
  | "inviteStaff"
  | "updateStaffRole"
  | "removeStaff"
  | "resetDemoData"
>;

const ConfigStoreContext = createContext<ConfigStoreContextValue | null>(null);
const StudentsStoreContext = createContext<StudentsStoreContextValue | null>(null);
const ProgramsStoreContext = createContext<ProgramsStoreContextValue | null>(null);
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

export function useProgramStore(): ProgramsStoreContextValue {
  return useRequiredContext(ProgramsStoreContext, "useProgramStore");
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
    ...useProgramStore(),
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
  const [subscriptionRequired, setSubscriptionRequired] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
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
  const [studioName, setStudioNameState] = useState(() =>
    isPreviewMode ? "My Studio" : ""
  );
  const [currentUser, setCurrentUser] = useState<AuthUserProfile | null>(() =>
    isPreviewMode
      ? { id: "preview-user", email: "demo@koaryu.local", full_name: "Demo User" }
      : null
  );
  const activeUserId = currentUser?.id || null;
  const [currentRole, setCurrentRole] = useState<StaffRoleName | null>(() =>
    isPreviewMode ? "admin" : null
  );
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>(() =>
    isPreviewMode ? MOCK_STAFF_MEMBERS : []
  );
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
    if (isPreviewMode) save(KEYS.beltLadders, orderedLadders);

    return selectedLadder;
  }, [isPreviewMode, updateCurrentLadderId]);

  useEffect(() => {
    studentsRef.current = students;
  }, [students]);

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

  useEffect(() => {
    leadsRef.current = leads;
  }, [leads]);

  useEffect(() => {
    programsRef.current = programs;
  }, [programs]);

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

  const resetLiveStudioState = useCallback(() => {
    setSubscriptionRequired(false);
    setStudioNameState("");
    setCurrentUser(null);
    setCurrentRole(null);
    setStaffMembers([]);
    setStaffLoaded(false);
    setStaffLoadError(null);
    setPrograms([]);
    setProgramsLoaded(false);
    setProgramsLoadError(null);
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
    clearEligibilityState();
    clearPromotionHistoryCache();
  }, [clearEligibilityState, clearPromotionHistoryCache, commitStudents, updateCurrentLadderId]);

  const applySubscriptionRequiredState = useCallback((
    authProfile: AuthProfileResponse,
    sessionUser: { id: string; email?: string | null; user_metadata?: { full_name?: string | null } }
  ) => {
    const userProfile = authProfile.user ?? {
      id: sessionUser.id,
      email: sessionUser.email || "",
      full_name: sessionUser.user_metadata?.full_name || null,
    };

    setSubscriptionRequired(true);
    setCurrentUser(userProfile);
    setCurrentRole(authProfile.role);
    setStudioStateCookie(sessionUser.id, Boolean(authProfile.studio_id));
    if (authProfile.studio_id) {
      setActiveStudioIdCookie(authProfile.studio_id);
    } else {
      clearActiveStudioIdCookie();
    }

    setStudioNameState("");
    setStaffMembers([]);
    setStaffLoaded(true);
    setStaffLoadError("Koaryu Core subscription required.");
    setPrograms([]);
    setProgramsLoaded(true);
    setProgramsLoadError("Koaryu Core subscription required.");
    setStudents([]);
    studentsRevisionRef.current += 1;
    setStudentsLoaded(true);
    setStudentsLastLoadedAt(Date.now());
    setStudentsMayBePartial(false);
    setStudentsLoadError("Koaryu Core subscription required.");
    setLeads([]);
    setBeltLaddersState([]);
    updateCurrentLadderId(null);
    setLadderNameState("");
    setSubRankTermState("Stripe");
    setBeltRanksState([]);
    setSessions([]);
    setTemplates([]);
    setAttendance([]);
    clearEligibilityState();
    clearPromotionHistoryCache();
  }, [clearEligibilityState, clearPromotionHistoryCache, updateCurrentLadderId]);

  const markSubscriptionRequired = useCallback(() => {
    setSubscriptionRequired(true);
    setStaffLoaded(true);
    setStaffLoadError("Koaryu Core subscription required.");
    setPrograms([]);
    setProgramsLoaded(true);
    setProgramsLoadError("Koaryu Core subscription required.");
    setStudents([]);
    studentsRevisionRef.current += 1;
    setStudentsLoaded(true);
    setStudentsLastLoadedAt(Date.now());
    setStudentsMayBePartial(false);
    setStudentsLoadError("Koaryu Core subscription required.");
    setLeads([]);
    setBeltLaddersState([]);
    updateCurrentLadderId(null);
    setLadderNameState("");
    setSubRankTermState("Stripe");
    setBeltRanksState([]);
    setSessions([]);
    setTemplates([]);
    setAttendance([]);
    clearEligibilityState();
    clearPromotionHistoryCache();
  }, [clearEligibilityState, clearPromotionHistoryCache, updateCurrentLadderId]);

  const clearSubscriptionRequired = useCallback(() => {
    setSubscriptionRequired(false);
    setStudentsLoadError(null);
    setProgramsLoadError(null);
    setStaffLoadError(null);
  }, []);

  useEffect(() => {
    if (!hydrated || !subscriptionRequired || pathname === "/subscription-required") {
      return;
    }

    router.replace("/subscription-required");
  }, [hydrated, pathname, router, subscriptionRequired]);

  const applyDemoResetResponse = useCallback((data: DemoResetResponse) => {
    setStudioNameState(data.studio_name);
    commitStudents(data.students);
    setPrograms(data.programs || programsRef.current);
    setProgramsLoaded(true);
    setProgramsLoadError(null);
    setLeads(data.leads);
    const selectedLadder = applyLadderSelection(
      data.belt_ladders.length > 0
        ? data.belt_ladders
        : data.primary_belt_ladder
          ? [data.primary_belt_ladder]
          : [],
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

  useEffect(() => {
    if (!isPreviewMode) {
      return;
    }

    const timer = window.setTimeout(() => {
      const storedLadders = load(KEYS.beltLadders, MOCK_BELT_LADDERS);
      const previewLadders = storedLadders.length ? storedLadders : MOCK_BELT_LADDERS;
      const selectedPreviewLadder = selectBeltLadder(previewLadders, currentLadderIdRef.current) || previewLadders[0];
      const storedRanks = load(KEYS.beltRanks, selectedPreviewLadder?.ranks || MOCK_BELT_LADDER.ranks);
      const storedSubRankTerm = load(KEYS.subRankTerm, selectedPreviewLadder?.sub_rank_term || "Stripe");
      const storedLadderName = load(KEYS.ladderName, selectedPreviewLadder?.name || MOCK_BELT_LADDER.name);
      const hydratedLadders = previewLadders.map((ladder) =>
        ladder.id === selectedPreviewLadder?.id
          ? { ...ladder, name: storedLadderName, sub_rank_term: storedSubRankTerm, ranks: storedRanks }
          : ladder
      );

      setStudioNameState(load(KEYS.studioName, "My Studio"));
      commitStudents(load(KEYS.students, MOCK_STUDENTS));
      setPrograms(load(KEYS.programs, MOCK_PROGRAMS));
      setProgramsLoaded(true);
      setProgramsLoadError(null);
      setLeads(load(KEYS.leads, MOCK_LEADS));
      applyLadderSelection(hydratedLadders, selectedPreviewLadder?.id ?? null);
      commitEligibilityRows(
        selectedPreviewLadder?.id ?? null,
        selectedPreviewLadder?.id === MOCK_BELT_LADDER.id ? MOCK_ELIGIBILITY : []
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
    setEligibilityLoadError(null);

    if (!ladderId) {
      commitEligibilityRows(null, []);
      setEligibilityPendingLadderId(null);
      return [];
    }

    const cachedRows = eligibilityCacheRef.current[ladderId];
    if (!options?.force && cachedRows) {
      commitEligibilityRows(ladderId, cachedRows);
      setEligibilityPendingLadderId(null);

      void fetchEligibilityForLadder(ladderId)
        .then((rows) => {
          if (requestSeq !== eligibilityRequestSeqRef.current || currentLadderIdRef.current !== ladderId) {
            return;
          }
          commitEligibilityRows(ladderId, rows);
          setEligibilityLoadError(null);
        })
        .catch((error) => {
          if (requestSeq !== eligibilityRequestSeqRef.current || currentLadderIdRef.current !== ladderId) {
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
      if (requestSeq === eligibilityRequestSeqRef.current && currentLadderIdRef.current === ladderId) {
        commitEligibilityRows(ladderId, rows);
        setEligibilityLoadError(null);
        setEligibilityPendingLadderId(null);
      }
      return rows;
    } catch (error) {
      if (requestSeq === eligibilityRequestSeqRef.current && currentLadderIdRef.current === ladderId) {
        commitEligibilityRows(null, []);
        setEligibilityPendingLadderId(null);
        setEligibilityLoadError(error instanceof Error ? error.message : "Eligibility could not be loaded.");
      }
      throw error;
    }
  }, [commitEligibilityRows, fetchEligibilityForLadder]);

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

      tokenRef.current = session.access_token;
      setToken(session.access_token);
      setHydrated(true);

      try {
        let criticalData: BootstrapResponse;

        try {
          criticalData = await api.get<BootstrapResponse>("/dashboard/bootstrap", session.access_token);
        } catch (bootstrapError) {
          if (isSubscriptionRequiredError(bootstrapError)) {
            const authProfile = await api.get<AuthProfileResponse>(
              "/auth/me",
              session.access_token
            );
            if (!mounted) return;

            applySubscriptionRequiredState(authProfile, session.user);
            setHydrated(true);
            if (!authProfile.studio_id) {
              router.replace("/onboarding");
            }
            return;
          }

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
            setCurrentRole(authProfile.role);
            setHydrated(true);
            router.replace("/onboarding");
            return;
          }

          const [
            studioRes,
            studentsRes,
            programsRes,
            leadsRes,
            beltLaddersRes,
          ] = await Promise.all([
            api.get<{ name: string }>("/studios/current", session.access_token),
            fetchAllStudents(session.access_token, { timeoutMs: 30000 }),
            api.get<Program[]>("/programs?include_archived=true", session.access_token).catch(() => []),
            api.get<Lead[]>("/leads", session.access_token),
            api.get<BeltLadder[]>("/belts/ladders", session.access_token),
          ]);

          criticalData = {
            auth: authProfile,
            studio: studioRes,
            students: studentsRes,
            programs: programsRes,
            leads: leadsRes,
            belt_ladders: beltLaddersRes,
            primary_belt_ladder: beltLaddersRes[0] ?? null,
          };

          console.warn("Falling back to legacy dashboard bootstrap", bootstrapError);
        }

        if (mounted) {
          const authProfile = criticalData.auth;
          const userProfile = authProfile.user ?? {
            id: session.user.id,
            email: session.user.email || "",
            full_name: session.user.user_metadata?.full_name || null,
          };

          setSubscriptionRequired(false);
          setCurrentUser(userProfile);
          setCurrentRole(authProfile.role);
          setStudioStateCookie(session.user.id, Boolean(authProfile.studio_id));
          if (authProfile.studio_id) {
            setActiveStudioIdCookie(authProfile.studio_id);
          } else {
            clearActiveStudioIdCookie();
          }

          if (!authProfile.studio_id) {
            resetLiveStudioState();
            setCurrentUser(userProfile);
            setCurrentRole(authProfile.role);
            setHydrated(true);
            router.replace("/onboarding");
            return;
          }

          clearPromotionHistoryCache();
          setStudioNameState(criticalData.studio_name || criticalData.studio?.name || "");
          setPrograms(criticalData.programs || []);
          setProgramsLoaded(true);
          setProgramsLoadError(null);
          if (studentsRevisionRef.current === studentsRevisionAtStart) {
            commitStudents(criticalData.students, {
              mayBePartial: true,
            });
          }
          setLeads(criticalData.leads);
          const selectedInitialLadder = applyLadderSelection(
            criticalData.belt_ladders.length > 0
              ? criticalData.belt_ladders
              : criticalData.primary_belt_ladder
                ? [criticalData.primary_belt_ladder]
                : [],
            criticalData.primary_belt_ladder?.id ?? null
          );
          if (selectedInitialLadder) {
            void loadEligibilityForLadder(selectedInitialLadder.id, { force: true }).catch(() => undefined);
          } else {
            commitEligibilityRows(null, []);
          }

          void api
            .get<Program[]>("/programs?include_archived=true", session.access_token)
            .then((programsRes) => {
              if (!mounted) {
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

        void (async () => {
          const start = new Date();
          start.setDate(start.getDate() - 30);
          const end = new Date();
          end.setDate(end.getDate() + 60);
          const startDate = start.toISOString().split("T")[0];
          const endDate = end.toISOString().split("T")[0];

          const [templatesRes, sessionsRes, attendanceRes] = await Promise.all([
            api
              .get<ClassTemplate[]>("/schedule/templates", session.access_token)
              .catch(() => []),
            api
              .get<ClassSession[]>(
                `/schedule/sessions?start_date=${startDate}&end_date=${endDate}`,
                session.access_token
              )
              .catch(() => []),
            api
              .get<AttendanceRecord[]>(
                `/schedule/attendance?start_date=${startDate}&end_date=${endDate}`,
                session.access_token
              )
              .catch(() => []),
          ]);

          if (!mounted) {
            return;
          }

          setTemplates(templatesRes);
          setSessions(sessionsRes);
          setAttendance(normalizeAttendanceRecords(attendanceRes));
        })().catch((error) => {
          console.error("Failed to load deferred dashboard data", error);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (mounted && isSubscriptionRequiredError(error)) {
          const authProfile = await api.get<AuthProfileResponse>(
            "/auth/me",
            session.access_token
          ).catch(() => null);
          if (!mounted) return;
          if (authProfile) {
            applySubscriptionRequiredState(authProfile, session.user);
          } else {
            setSubscriptionRequired(true);
            setStudentsLoaded(true);
            setStudentsLoadError("Koaryu Core subscription required.");
            setProgramsLoaded(true);
            setProgramsLoadError("Koaryu Core subscription required.");
          }
          setHydrated(true);
          return;
        }
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
        tokenRef.current = session.access_token;
        setToken(session.access_token);
      } else {
        tokenRef.current = null;
        setToken(null);
        setSubscriptionRequired(false);
        setCurrentUser(null);
        setCurrentRole(null);
        setStaffMembers([]);
        setStaffLoaded(false);
        setStaffLoadError(null);
        setPrograms([]);
        setProgramsLoaded(false);
        setProgramsLoadError(null);
        clearStudioStateCookie();
        clearActiveStudioIdCookie();
      }
    });

    return () => {
      mounted = false;
      authListener?.subscription.unsubscribe();
    };
  }, [applyLadderSelection, applySubscriptionRequiredState, clearPromotionHistoryCache, commitEligibilityRows, commitStudents, fetchAllStudents, isPreviewMode, loadEligibilityForLadder, resetLiveStudioState, router, supabase]);

  // ── Persist helpers (for preview mode) ──
  const persistStudents = useCallback((next: Student[]) => {
    commitStudents(next);
    if (isPreviewMode) save(KEYS.students, next);
  }, [commitStudents, isPreviewMode]);

  const persistPrograms = useCallback((next: Program[]) => {
    const sorted = [...next].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    setPrograms(sorted);
    setProgramsLoaded(true);
    setProgramsLoadError(null);
    if (isPreviewMode) save(KEYS.programs, sorted);
  }, [isPreviewMode]);

  const persistLeads = useCallback((next: Lead[]) => {
    setLeads(next);
    if (isPreviewMode) save(KEYS.leads, next);
  }, [isPreviewMode]);

  const refreshPrograms = useCallback(async (options?: { includeArchived?: boolean }): Promise<Program[]> => {
    if (isPreviewMode) {
      const stored = load(KEYS.programs, MOCK_PROGRAMS);
      persistPrograms(stored);
      return stored;
    }
    if (!token) throw new Error("Not authenticated");
    setProgramsLoadError(null);
    try {
      const result = await api.get<Program[]>(
        `/programs?include_archived=${options?.includeArchived ? "true" : "false"}`,
        token
      );
      persistPrograms(result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load programs.";
      setProgramsLoadError(message);
      throw error;
    }
  }, [isPreviewMode, persistPrograms, token]);

  const createProgram = useCallback(async (data: ProgramCreate): Promise<Program> => {
    if (isPreviewMode) {
      const now = new Date().toISOString();
      const programId = localId();
      const created: Program = {
        id: programId,
        studio_id: "mock-studio",
        name: data.name,
        description: data.description,
        color_hex: data.color_hex || "#64748B",
        sort_order: data.sort_order ?? programsRef.current.length * 10,
        is_system: false,
        archived_at: null,
        created_at: now,
        updated_at: now,
        usage: { student_count: 0, active_student_count: 0, class_count: 0, active_class_count: 0, lead_count: 0, belt_ladder_count: 1 },
      };
      const ladder: BeltLadder = {
        id: localId(),
        studio_id: "mock-studio",
        name: created.name,
        program_id: programId,
        sub_rank_term: "Stripe",
        created_at: now,
        updated_at: now,
        ranks: [],
      };
      persistPrograms([...programsRef.current, created]);
      applyLadderSelection([...beltLaddersRef.current, ladder], currentLadderIdRef.current || ladder.id);
      return created;
    }
    if (!token) throw new Error("Not authenticated");
    const created = await api.post<Program>("/programs", data, token);
    persistPrograms([...programsRef.current.filter((program) => program.id !== created.id), created]);
    await (refreshBeltsRef.current?.(currentLadderIdRef.current).catch(() => undefined) ?? Promise.resolve());
    return created;
  }, [applyLadderSelection, isPreviewMode, persistPrograms, token]);

  const updateProgram = useCallback(async (id: string, data: ProgramUpdate): Promise<Program> => {
    if (isPreviewMode) {
      const updated = programsRef.current.map((program) =>
        program.id === id ? { ...program, ...data, updated_at: new Date().toISOString() } : program
      );
      persistPrograms(updated);
      if (data.name) {
        const nextLadders = beltLaddersRef.current.map((ladder) =>
          ladder.program_id === id ? { ...ladder, name: data.name || ladder.name, updated_at: new Date().toISOString() } : ladder
        );
        applyLadderSelection(nextLadders, currentLadderIdRef.current);
      }
      return updated.find((program) => program.id === id)!;
    }
    if (!token) throw new Error("Not authenticated");
    const updated = await api.patch<Program>(`/programs/${id}`, data, token);
    persistPrograms(programsRef.current.map((program) => program.id === id ? updated : program));
    await (refreshBeltsRef.current?.(currentLadderIdRef.current).catch(() => undefined) ?? Promise.resolve());
    return updated;
  }, [applyLadderSelection, isPreviewMode, persistPrograms, token]);

  const archiveProgram = useCallback(async (id: string): Promise<Program> => {
    if (isPreviewMode) {
      const updated = programsRef.current.map((program) =>
        program.id === id ? { ...program, archived_at: new Date().toISOString(), updated_at: new Date().toISOString() } : program
      );
      persistPrograms(updated);
      return updated.find((program) => program.id === id)!;
    }
    if (!token) throw new Error("Not authenticated");
    const archived = await api.post<Program>(`/programs/${id}/archive`, {}, token);
    persistPrograms(programsRef.current.map((program) => program.id === id ? archived : program));
    return archived;
  }, [isPreviewMode, persistPrograms, token]);

  const restoreProgram = useCallback(async (id: string): Promise<Program> => {
    if (isPreviewMode) {
      const updated = programsRef.current.map((program) =>
        program.id === id ? { ...program, archived_at: null, updated_at: new Date().toISOString() } : program
      );
      persistPrograms(updated);
      return updated.find((program) => program.id === id)!;
    }
    if (!token) throw new Error("Not authenticated");
    const restored = await api.post<Program>(`/programs/${id}/restore`, {}, token);
    persistPrograms(programsRef.current.map((program) => program.id === id ? restored : program));
    return restored;
  }, [isPreviewMode, persistPrograms, token]);

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
	      const selectedProgramIds = data.program_ids?.length
	        ? data.program_ids
	        : data.program_id
	          ? [data.program_id]
	          : ["program-unassigned"];
	      const now = new Date().toISOString();
	      const membershipStart = data.membership_start_date || now.split("T")[0];
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
	        membership_start_date: membershipStart,
	        program_id: selectedProgramIds[0],
	        current_belt_rank_id: data.current_belt_rank_id,
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
	        program_memberships: selectedProgramIds.map((programId) => {
	          const program = programsRef.current.find((item) => item.id === programId);
	          return {
	            id: localId(),
	            studio_id: "mock-studio",
	            student_id: "preview-pending",
	            program_id: programId,
	            program_name: program?.name,
	            program_color_hex: program?.color_hex,
	            status: "active" as const,
	            started_at: membershipStart,
	            ended_at: null,
	            current_belt_rank_id: programId === selectedProgramIds[0] ? data.current_belt_rank_id : undefined,
	            created_at: now,
	            updated_at: now,
	          };
	        }),
	        created_at: now,
	        updated_at: now,
	      };
      newStudent.program_memberships = (newStudent.program_memberships ?? []).map((membership) => ({
	        ...membership,
	        student_id: newStudent.id,
	      }));
	      persistStudents([newStudent, ...studentsRef.current]);
	      return newStudent;
    } else {
      if (!token) throw new Error("Not authenticated");
      const res = await api.post<Student>("/students", data, token);
      commitStudents((current) => [res, ...current]);
      return res;
    }
  }, [commitStudents, isPreviewMode, persistStudents, studentsRef, token]);

  const updateStudent = useCallback(async (id: string, data: StudentUpdatePayload) => {
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
      ids.forEach((studentId) => {
        const photoUrl = previewStudentPhotoUrlsRef.current[studentId];
        if (photoUrl) {
          URL.revokeObjectURL(photoUrl);
          delete previewStudentPhotoUrlsRef.current[studentId];
        }
      });
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

  const uploadStudentPhoto = useCallback(async (studentId: string, file: File): Promise<Student> => {
    if (isPreviewMode) {
      const student = studentsRef.current.find((item) => item.id === studentId);
      if (!student) {
        throw new Error("Student not found");
      }

      const existingUrl = previewStudentPhotoUrlsRef.current[studentId];
      if (existingUrl) {
        URL.revokeObjectURL(existingUrl);
      }

      const now = new Date().toISOString();
      const photoUrl = URL.createObjectURL(file);
      previewStudentPhotoUrlsRef.current[studentId] = photoUrl;
      const updated: Student = {
        ...student,
        photo_path: `preview/students/${studentId}/${file.name}`,
        photo_url: photoUrl,
        photo_updated_at: now,
        updated_at: now,
      };

      commitStudents((current) =>
        current.map((item) => item.id === studentId ? updated : item)
      );
      return updated;
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const body = new FormData();
    body.append("file", file);
    const updated = await api.postForm<Student>(`/students/${studentId}/photo`, body, token);
    commitStudents((current) =>
      current.some((item) => item.id === studentId)
        ? current.map((item) => item.id === studentId ? updated : item)
        : [updated, ...current]
    );
    return updated;
  }, [commitStudents, isPreviewMode, studentsRef, token]);

  const deleteStudentPhoto = useCallback(async (studentId: string): Promise<Student> => {
    if (isPreviewMode) {
      const student = studentsRef.current.find((item) => item.id === studentId);
      if (!student) {
        throw new Error("Student not found");
      }

      const existingUrl = previewStudentPhotoUrlsRef.current[studentId];
      if (existingUrl) {
        URL.revokeObjectURL(existingUrl);
        delete previewStudentPhotoUrlsRef.current[studentId];
      }

      const updated: Student = {
        ...student,
        photo_path: null,
        photo_url: null,
        photo_updated_at: null,
        updated_at: new Date().toISOString(),
      };

      commitStudents((current) =>
        current.map((item) => item.id === studentId ? updated : item)
      );
      return updated;
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const updated = await api.delete<Student>(`/students/${studentId}/photo`, token);
    commitStudents((current) =>
      current.some((item) => item.id === studentId)
        ? current.map((item) => item.id === studentId ? updated : item)
        : [updated, ...current]
    );
    return updated;
  }, [commitStudents, isPreviewMode, studentsRef, token]);

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

        refreshOperations.push(refreshPrograms({ includeArchived: true }));

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
  }, [commitStudents, fetchAllStudents, isPreviewMode, persistStudents, refreshPrograms, studentsRef, token]);

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
        program_id: data.program_id,
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
    await loadEligibilityForLadder(selectedLadder?.id ?? null, { force: true }).catch(() => undefined);
  }, [applyLadderSelection, isPreviewMode, loadEligibilityForLadder, token]);
  useEffect(() => {
    refreshBeltsRef.current = refreshBelts;
  }, [refreshBelts]);

  const setCurrentLadder = useCallback(async (ladderId: string) => {
    if (isPreviewMode) {
      const selectedLadder = applyLadderSelection(beltLaddersRef.current, ladderId);
      commitEligibilityRows(
        selectedLadder?.id ?? null,
        previewEligibilityForLadder(selectedLadder?.id)
      );
      setEligibilityPendingLadderId(null);
      setEligibilityLoadError(null);
      return;
    }

    const selectedLadder = applyLadderSelection(beltLaddersRef.current, ladderId);
    if (!selectedLadder) {
      await (refreshBeltsRef.current?.(ladderId) ?? Promise.resolve());
      return;
    }

    await loadEligibilityForLadder(selectedLadder.id);
  }, [applyLadderSelection, commitEligibilityRows, isPreviewMode, loadEligibilityForLadder, previewEligibilityForLadder]);

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

    throw new Error("Create a program in Settings before configuring ranks.");
  }, [applyLadderSelection, isPreviewMode, subRankTerm, token]);

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
      const selectedProgramId = lead.program_id || "program-unassigned";
      const selectedProgram = programsRef.current.find((program) => program.id === selectedProgramId);

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
        program_id: selectedProgramId,
        current_belt_rank_id: undefined,
        program_memberships: [
          {
            id: localId(),
            studio_id: "mock-studio",
            student_id: studentId,
            program_id: selectedProgramId,
            program_name: selectedProgram?.name,
            program_color_hex: selectedProgram?.color_hex,
            status: "active",
            started_at: membershipStartDate,
            ended_at: null,
            current_belt_rank_id: null,
            current_belt_rank_name: null,
            current_belt_rank_color: null,
            created_at: now,
            updated_at: now,
          },
        ],
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
        program_id: lead.program_id || undefined,
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
      applyLadderSelection(upsertBeltLadder(beltLaddersRef.current, nextPreviewLadder), nextPreviewLadder.id);
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

      await loadEligibilityForLadder(syncedLadder.id, { force: true }).catch(() => undefined);
    }
  }, [applyLadderSelection, ensureCurrentLadder, isPreviewMode, ladderName, loadEligibilityForLadder, persistBeltRanks, subRankTerm, token]);

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

  const refreshStaff = useCallback(async (): Promise<StaffMember[]> => {
    if (isPreviewMode) {
      const sorted = sortStaffMembers(staffMembers, activeUserId);
      setStaffMembers(sorted);
      setStaffLoaded(true);
      setStaffLoadError(null);
      return sorted;
    }

    if (!token) throw new Error("Not authenticated");

    try {
      const result = await api.get<StaffMember[]>("/staff", token);
      const sorted = sortStaffMembers(result, activeUserId);
      setStaffMembers(sorted);
      setStaffLoaded(true);
      setStaffLoadError(null);
      return sorted;
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "";
      const message =
        rawMessage && rawMessage !== "Internal Server Error"
          ? rawMessage
          : "Staff could not be loaded. Please try again.";
      setStaffLoaded(true);
      setStaffLoadError(message);
      throw error;
    }
  }, [activeUserId, isPreviewMode, staffMembers, token]);

  const inviteStaff = useCallback(async (data: StaffInviteCreate): Promise<StaffMember> => {
    if (isPreviewMode) {
      const now = new Date().toISOString();
      const normalizedEmail = data.email.trim().toLowerCase();
      const previewMember: StaffMember = {
        id: `preview-staff-${Date.now()}`,
        studio_id: "mock-studio",
        user_id: `preview-staff-user-${Date.now()}`,
        email: normalizedEmail,
        full_name: null,
        role: data.role,
        status: "pending",
        invited_by: activeUserId || "preview-user",
        created_at: now,
        updated_at: now,
        last_sign_in_at: null,
      };
      setStaffMembers((current) =>
        sortStaffMembers([...current, previewMember], activeUserId)
      );
      setStaffLoaded(true);
      setStaffLoadError(null);
      return previewMember;
    }

    if (!token) throw new Error("Not authenticated");

    const result = await api.post<StaffMember>("/staff/invitations", data, token);
    setStaffMembers((current) =>
      sortStaffMembers([...current.filter((member) => member.id !== result.id), result], activeUserId)
    );
    setStaffLoaded(true);
    setStaffLoadError(null);
    return result;
  }, [activeUserId, isPreviewMode, token]);

  const updateStaffRole = useCallback(async (
    id: string,
    role: StaffRoleName
  ): Promise<StaffMember> => {
    if (isPreviewMode) {
      let updated: StaffMember | null = null;
      setStaffMembers((current) =>
        sortStaffMembers(
          current.map((member) => {
            if (member.id !== id) return member;
            updated = { ...member, role, updated_at: new Date().toISOString() };
            return updated;
          }),
          activeUserId
        )
      );
      if (!updated) throw new Error("Staff member not found.");
      return updated;
    }

    if (!token) throw new Error("Not authenticated");

    const result = await api.patch<StaffMember>(`/staff/${id}`, { role }, token);
    setStaffMembers((current) =>
      sortStaffMembers(current.map((member) => (member.id === id ? result : member)), activeUserId)
    );
    return result;
  }, [activeUserId, isPreviewMode, token]);

  const removeStaff = useCallback(async (id: string): Promise<void> => {
    if (isPreviewMode) {
      setStaffMembers((current) => current.filter((member) => member.id !== id));
      return;
    }

    if (!token) throw new Error("Not authenticated");

    await api.delete(`/staff/${id}`, token);
    setStaffMembers((current) => current.filter((member) => member.id !== id));
  }, [isPreviewMode, token]);

  const resetDemoData = useCallback(async (): Promise<DemoResetResponse> => {
    if (isPreviewMode) {
      clearPreviewStorage();
      const previewResponse: DemoResetResponse = {
        studio_name: DEMO_STUDIO_NAME,
        programs: MOCK_PROGRAMS,
        students: MOCK_STUDENTS,
        leads: MOCK_LEADS,
        belt_ladders: MOCK_BELT_LADDERS,
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
      save(KEYS.programs, MOCK_PROGRAMS);
      save(KEYS.beltLadders, MOCK_BELT_LADDERS);
      save(KEYS.leads, previewResponse.leads);
      save(KEYS.beltRanks, MOCK_BELT_LADDER.ranks);
      save(KEYS.sessions, previewResponse.sessions);
      save(KEYS.templates, previewResponse.templates);
      save(KEYS.attendance, previewResponse.attendance);
      save(KEYS.subRankTerm, MOCK_BELT_LADDER.sub_rank_term || "Stripe");
      save(KEYS.ladderName, MOCK_BELT_LADDER.name);
      setStaffMembers(MOCK_STAFF_MEMBERS);
      setStaffLoaded(true);
      setStaffLoadError(null);
      persistPrograms(MOCK_PROGRAMS);

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
  }, [applyDemoResetResponse, isPreviewMode, persistPrograms, token]);

  // ── Context values ──
  const configValue = useMemo<ConfigStoreContextValue>(() => ({
    isPreviewMode,
    token,
    subscriptionRequired,
    markSubscriptionRequired,
    clearSubscriptionRequired,
  }), [clearSubscriptionRequired, isPreviewMode, markSubscriptionRequired, subscriptionRequired, token]);

  const studentsValue = useMemo<StudentsStoreContextValue>(() => ({
    studentsLoaded,
    studentsLoadError,
    studentsLastLoadedAt,
    studentsMayBePartial,
    students,
    addStudent,
    updateStudent,
    deleteStudents,
    uploadStudentPhoto,
    deleteStudentPhoto,
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
    deleteStudentPhoto,
    deleteStudents,
    importStudents,
    refreshStudents,
    students,
    updateStudent,
    uploadStudentPhoto,
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

  const programsValue = useMemo<ProgramsStoreContextValue>(() => ({
    programs,
    programsLoaded,
    programsLoadError,
    refreshPrograms,
    createProgram,
    updateProgram,
    archiveProgram,
    restoreProgram,
  }), [
    archiveProgram,
    createProgram,
    programs,
    programsLoaded,
    programsLoadError,
    refreshPrograms,
    restoreProgram,
    updateProgram,
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
    eligibilityLadderId,
    eligibilityPendingLadderId,
    eligibilityLoadError,
    promotionHistoryByStudent,
    loadPromotionHistory,
    promoteStudent,
  }), [
    beltLadders,
    beltRanks,
    currentLadderId,
    eligibility,
    eligibilityLadderId,
    eligibilityLoadError,
    eligibilityPendingLadderId,
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
    currentUserId: activeUserId || "",
    currentRole,
    userEmail: currentUser?.email || "",
    userName: currentUser?.full_name || "",
    staffMembers,
    staffLoaded,
    staffLoadError,
    refreshStaff,
    inviteStaff,
    updateStaffRole,
    removeStaff,
    resetDemoData,
    setStudioName,
  }), [
    activeUserId,
    currentRole,
    currentUser,
    inviteStaff,
    refreshStaff,
    removeStaff,
    resetDemoData,
    setStudioName,
    staffLoadError,
    staffLoaded,
    staffMembers,
    studioName,
    updateStaffRole,
  ]);

  if (!hydrated) {
    return <LoadingScreen />;
  }

  return (
    <ConfigStoreContext.Provider value={configValue}>
      <StudentsStoreContext.Provider value={studentsValue}>
        <ProgramsStoreContext.Provider value={programsValue}>
          <LeadsStoreContext.Provider value={leadsValue}>
            <BeltsStoreContext.Provider value={beltsValue}>
              <ScheduleStoreContext.Provider value={scheduleValue}>
                <StudioStoreContext.Provider value={studioValue}>
                  {children}
                </StudioStoreContext.Provider>
              </ScheduleStoreContext.Provider>
            </BeltsStoreContext.Provider>
          </LeadsStoreContext.Provider>
        </ProgramsStoreContext.Provider>
      </StudentsStoreContext.Provider>
    </ConfigStoreContext.Provider>
  );
}

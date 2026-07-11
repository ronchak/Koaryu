"use client";

import { createContext, useContext, type Context } from "react";

import type {
  AttendanceRecord,
  BeltLadder,
  BeltRank,
  BulkStudentStatusUpdateResponse,
  BulkStudentTagUpdateResponse,
  ClassSession,
  ClassSessionCreate,
  ClassSessionDeleteScope,
  ClassTemplate,
  ClassTemplateCreate,
  CsvImportOptions,
  CsvImportResult,
  DashboardSummary,
  EligibilityEntry,
  Lead,
  Program,
  ProgramCreate,
  ProgramUpdate,
  Promotion,
  StaffInviteCreate,
  StaffMember,
  StaffRoleName,
  Student,
  StudentCreate,
  StudentListResponse,
  StudentStatus,
  StudentUpdate,
} from "@/types";
import type { SessionAttendanceRefreshResult } from "@/lib/schedule-store-model";
import type { StudentListQuery } from "@/lib/student-list-page";
import type {
  DemoResetResponse,
  StudioDataClearResponse,
} from "@/lib/studio-store-model";
import type { DatasetLoadStatus } from "@/lib/page-dataset-readiness";

export interface StoreContextValue {
  isPreviewMode: boolean;
  token: string | null;
  subscriptionRequired: boolean;
  markSubscriptionRequired: () => void;
  clearSubscriptionRequired: () => void;

  dashboardSummary: DashboardSummary | null;
  dashboardSummaryLoaded: boolean;

  students: Student[];
  studentsLoaded: boolean;
  studentsLoadError: string | null;
  studentsLastLoadedAt: number | null;
  studentsMayBePartial: boolean;
  addStudent: (data: StudentCreate) => Promise<Student>;
  updateStudent: (id: string, data: StudentUpdate) => Promise<Student>;
  deleteStudents: (ids: string[]) => Promise<void>;
  uploadStudentPhoto: (studentId: string, file: File) => Promise<Student>;
  deleteStudentPhoto: (studentId: string) => Promise<Student>;
  bulkAddTagsToStudents: (
    studentIds: string[],
    tags: string[],
    options?: { refreshMode?: "full" | "local" }
  ) => Promise<BulkStudentTagUpdateResponse>;
  bulkUpdateStudentStatus: (
    studentIds: string[],
    status: StudentStatus,
    options?: { refreshMode?: "full" | "local" }
  ) => Promise<BulkStudentStatusUpdateResponse>;
  importStudents: (
    file: File,
    rows: Record<string, string>[],
    mapping: Record<string, string>,
    options: CsvImportOptions,
    request?: { importKey?: string }
  ) => Promise<CsvImportResult>;
  refreshStudents: () => Promise<Student[]>;
  listStudentsPage: (
    query?: StudentListQuery,
    options?: { signal?: AbortSignal; timeoutMs?: number | null }
  ) => Promise<StudentListResponse>;

  programs: Program[];
  programsLoaded: boolean;
  programsLoadError: string | null;
  refreshPrograms: (options?: { includeArchived?: boolean }) => Promise<Program[]>;
  createProgram: (data: ProgramCreate) => Promise<Program>;
  updateProgram: (id: string, data: ProgramUpdate) => Promise<Program>;
  archiveProgram: (id: string) => Promise<Program>;
  restoreProgram: (id: string) => Promise<Program>;

  leads: Lead[];
  leadsLoaded: boolean;
  leadsLoadError: string | null;
  addLead: (data: Partial<Lead>) => Promise<void>;
  updateLead: (id: string, data: Partial<Lead>) => Promise<void>;
  deleteLead: (id: string) => Promise<void>;
  refreshLeads: () => Promise<Lead[]>;
  convertLeadToStudent: (leadId: string) => Promise<{ lead: Lead; studentId: string | null }>;

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

  sessions: ClassSession[];
  addSession: (data: ClassSessionCreate) => Promise<void>;
  addTemplate: (data: ClassTemplateCreate) => Promise<ClassTemplate>;
  deleteSession: (sessionId: string, scope?: ClassSessionDeleteScope) => Promise<void>;
  refreshScheduleRange: (startDate: string, endDate: string) => Promise<ClassSession[]>;
  refreshSessionAttendance: (sessionId: string) => Promise<SessionAttendanceRefreshResult>;
  refreshSchedule: () => Promise<void>;
  scheduleLoadError: string | null;
  scheduleStatus: DatasetLoadStatus;
  templates: ClassTemplate[];
  attendance: AttendanceRecord[];
  toggleCheckIn: (sessionId: string, studentId: string, name: string) => Promise<void>;

  studioName: string;
  currentUserId: string;
  currentRole: StaffRoleName | null;
  userEmail: string;
  userName: string;
  staffMembers: StaffMember[];
  staffLoaded: boolean;
  staffLoadError: string | null;
  setStudioName: (name: string) => Promise<void>;
  updateUserName: (name: string) => Promise<void>;
  refreshStaff: () => Promise<StaffMember[]>;
  inviteStaff: (data: StaffInviteCreate) => Promise<StaffMember>;
  updateStaffRole: (id: string, role: StaffRoleName) => Promise<StaffMember>;
  removeStaff: (id: string) => Promise<void>;
  resetDemoData: () => Promise<DemoResetResponse>;
  clearStudioData: () => Promise<StudioDataClearResponse>;
}

export type ConfigStoreContextValue = Pick<
  StoreContextValue,
  | "isPreviewMode"
  | "token"
  | "subscriptionRequired"
  | "markSubscriptionRequired"
  | "clearSubscriptionRequired"
  | "currentRole"
>;
export type DashboardStoreContextValue = Pick<
  StoreContextValue,
  | "dashboardSummary"
  | "dashboardSummaryLoaded"
>;
export type StudentsStoreContextValue = Pick<
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
  | "listStudentsPage"
>;
export type ProgramsStoreContextValue = Pick<
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
export type LeadsStoreContextValue = Pick<
  StoreContextValue,
  | "leads"
  | "leadsLoaded"
  | "leadsLoadError"
  | "addLead"
  | "updateLead"
  | "deleteLead"
  | "refreshLeads"
  | "convertLeadToStudent"
>;
export type BeltsStoreContextValue = Pick<
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
export type ScheduleStoreContextValue = Pick<
  StoreContextValue,
  | "sessions"
  | "addSession"
  | "addTemplate"
  | "deleteSession"
  | "refreshScheduleRange"
  | "refreshSessionAttendance"
  | "refreshSchedule"
  | "scheduleLoadError"
  | "scheduleStatus"
  | "templates"
  | "attendance"
  | "toggleCheckIn"
>;
export type StudioStoreContextValue = Pick<
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
  | "updateUserName"
  | "refreshStaff"
  | "inviteStaff"
  | "updateStaffRole"
  | "removeStaff"
  | "resetDemoData"
  | "clearStudioData"
>;

export const ConfigStoreContext = createContext<ConfigStoreContextValue | null>(null);
export const DashboardStoreContext = createContext<DashboardStoreContextValue | null>(null);
export const StudentsStoreContext = createContext<StudentsStoreContextValue | null>(null);
export const ProgramsStoreContext = createContext<ProgramsStoreContextValue | null>(null);
export const LeadsStoreContext = createContext<LeadsStoreContextValue | null>(null);
export const BeltsStoreContext = createContext<BeltsStoreContextValue | null>(null);
export const ScheduleStoreContext = createContext<ScheduleStoreContextValue | null>(null);
export const StudioStoreContext = createContext<StudioStoreContextValue | null>(null);

function useRequiredContext<T>(context: Context<T | null>, name: string): T {
  const value = useContext(context);
  if (!value) {
    throw new Error(`${name} must be used within StoreProvider`);
  }
  return value;
}

export function useConfigStore(): ConfigStoreContextValue {
  return useRequiredContext(ConfigStoreContext, "useConfigStore");
}

export function useDashboardStore(): DashboardStoreContextValue {
  return useRequiredContext(DashboardStoreContext, "useDashboardStore");
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
    ...useDashboardStore(),
    ...useStudentStore(),
    ...useProgramStore(),
    ...useLeadStore(),
    ...useBeltStore(),
    ...useScheduleStore(),
    ...useStudioStore(),
  };
}

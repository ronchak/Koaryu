import type {
  AttendanceRecord,
  BeltLadder,
  BeltRank,
  ClassSession,
  ClassTemplate,
  DashboardSummary,
  EligibilityEntry,
  Lead,
  Program,
  StaffMember,
  Student,
} from "@/types";
import type {
  PromotionHistoryCache,
  PromotionHistoryRequests,
} from "@/lib/store-promotion-history";

export const SUBSCRIPTION_REQUIRED_MESSAGE = "Koaryu Core subscription required.";

export interface LiveStudioDataResetState {
  subscriptionRequired: boolean;
  studioName: string;
  staffMembers: StaffMember[];
  staffLoaded: boolean;
  staffLoadError: string | null;
  programs: Program[];
  programsLoaded: boolean;
  programsLoadError: string | null;
  dashboardSummary: DashboardSummary | null;
  dashboardSummaryLoaded: boolean;
  students: Student[];
  studentsLoaded: boolean;
  studentsLoadError: string | null;
  studentsLastLoadedAt: number | null;
  studentsMayBePartial: boolean;
  leads: Lead[];
  beltLadders: BeltLadder[];
  currentLadderId: string | null;
  ladderName: string;
  subRankTerm: string;
  beltRanks: BeltRank[];
  sessions: ClassSession[];
  templates: ClassTemplate[];
  attendance: AttendanceRecord[];
  eligibility: EligibilityEntry[];
  eligibilityLadderId: string | null;
  eligibilityPendingLadderId: string | null;
  eligibilityLoadError: string | null;
  eligibilityCache: Record<string, EligibilityEntry[]>;
  promotionHistoryCache: PromotionHistoryCache;
}

type WritableResetRef<T> = {
  current: T;
};

export interface LiveStudioDataResetRefs {
  staffMembers: WritableResetRef<StaffMember[]>;
  programs: WritableResetRef<Program[]>;
  students: WritableResetRef<Student[]>;
  leads: WritableResetRef<Lead[]>;
  beltLadders: WritableResetRef<BeltLadder[]>;
  beltRanks: WritableResetRef<BeltRank[]>;
  sessions: WritableResetRef<ClassSession[]>;
  templates: WritableResetRef<ClassTemplate[]>;
  attendance: WritableResetRef<AttendanceRecord[]>;
  eligibility: WritableResetRef<EligibilityEntry[]>;
  eligibilityCache: WritableResetRef<Record<string, EligibilityEntry[]>>;
  promotionHistoryCache: WritableResetRef<PromotionHistoryCache>;
  promotionHistoryRequests: WritableResetRef<PromotionHistoryRequests>;
}

export function applyLiveStudioDataResetRefs(
  refs: LiveStudioDataResetRefs,
  state: LiveStudioDataResetState
) {
  refs.staffMembers.current = state.staffMembers;
  refs.programs.current = state.programs;
  refs.students.current = state.students;
  refs.leads.current = state.leads;
  refs.beltLadders.current = state.beltLadders;
  refs.beltRanks.current = state.beltRanks;
  refs.sessions.current = state.sessions;
  refs.templates.current = state.templates;
  refs.attendance.current = state.attendance;
  refs.eligibility.current = state.eligibility;
  refs.eligibilityCache.current = state.eligibilityCache;
  refs.promotionHistoryCache.current = state.promotionHistoryCache;
  refs.promotionHistoryRequests.current = {};
}

export function nextLiveStudioDataResetGeneration(currentGeneration: number): number {
  return currentGeneration + 1;
}

export function buildSignedOutStudioResetState(): LiveStudioDataResetState {
  return {
    subscriptionRequired: false,
    studioName: "",
    staffMembers: [],
    staffLoaded: false,
    staffLoadError: null,
    programs: [],
    programsLoaded: false,
    programsLoadError: null,
    dashboardSummary: null,
    dashboardSummaryLoaded: true,
    students: [],
    studentsLoaded: true,
    studentsLoadError: null,
    studentsLastLoadedAt: null,
    studentsMayBePartial: false,
    leads: [],
    beltLadders: [],
    currentLadderId: null,
    ladderName: "",
    subRankTerm: "Stripe",
    beltRanks: [],
    sessions: [],
    templates: [],
    attendance: [],
    eligibility: [],
    eligibilityLadderId: null,
    eligibilityPendingLadderId: null,
    eligibilityLoadError: null,
    eligibilityCache: {},
    promotionHistoryCache: {},
  };
}

export function buildSubscriptionRequiredStudioResetState(): LiveStudioDataResetState {
  return {
    ...buildSignedOutStudioResetState(),
    subscriptionRequired: true,
    staffLoaded: true,
    staffLoadError: SUBSCRIPTION_REQUIRED_MESSAGE,
    programsLoaded: true,
    programsLoadError: SUBSCRIPTION_REQUIRED_MESSAGE,
    studentsLoadError: SUBSCRIPTION_REQUIRED_MESSAGE,
  };
}

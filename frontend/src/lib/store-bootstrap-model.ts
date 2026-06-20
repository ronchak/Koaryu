import type {
  AuthResponse,
  BeltLadder,
  DashboardBootstrapResponse,
  DashboardBootstrapStudioSummary,
  DashboardSummary,
  Lead,
  Program,
  Student,
  StudentListResponse,
  UserProfile,
} from "@/types";

export type AuthUserProfile = UserProfile;
export type AuthProfileResponse = AuthResponse;
export type BootstrapResponse = Omit<
  DashboardBootstrapResponse,
  "auth" | "students" | "programs" | "leads" | "belt_ladders" | "primary_belt_ladder"
> & {
  auth: AuthProfileResponse;
  students: Student[];
  students_total?: number;
  students_page_size?: number;
  students_may_be_partial?: boolean;
  programs: Program[];
  leads: Lead[];
  belt_ladders: BeltLadder[];
  primary_belt_ladder: BeltLadder | null;
};

export interface SessionUserProfileSource {
  id: string;
  email?: string | null;
  user_metadata?: {
    full_name?: string | null;
  } | null;
}

export function buildSessionUserProfile(sessionUser: SessionUserProfileSource): AuthUserProfile {
  return {
    id: sessionUser.id,
    email: sessionUser.email || "",
    full_name: sessionUser.user_metadata?.full_name || null,
  };
}

export function buildAuthUserProfile(authProfile: AuthProfileResponse): AuthUserProfile {
  return authProfile.user;
}

export function resolveBootstrapStudioName(data: Pick<BootstrapResponse, "studio_name" | "studio">): string {
  return data.studio_name || data.studio?.name || "";
}

export function resolveBootstrapLadders(
  data: Pick<BootstrapResponse, "belt_ladders" | "primary_belt_ladder">
): BeltLadder[] {
  return data.belt_ladders.length > 0
    ? data.belt_ladders
    : data.primary_belt_ladder
      ? [data.primary_belt_ladder]
      : [];
}

export function buildLegacyBootstrapResponse({
  auth,
  studio,
  studentsPage,
  programs,
  leads,
  beltLadders,
}: {
  auth: AuthProfileResponse;
  studio: DashboardBootstrapStudioSummary;
  studentsPage: StudentListResponse;
  programs: Program[];
  leads: Lead[];
  beltLadders: BeltLadder[];
}): BootstrapResponse {
  return {
    auth,
    studio,
    students: studentsPage.items,
    students_total: studentsPage.total,
    students_page_size: studentsPage.page_size,
    students_may_be_partial: studentsPage.total > studentsPage.items.length,
    programs,
    leads,
    belt_ladders: beltLadders,
    primary_belt_ladder: beltLadders[0] ?? null,
  };
}

export function buildDeferredScheduleDateRange(now = new Date()): {
  startDate: string;
  endDate: string;
} {
  const start = new Date(now);
  start.setDate(start.getDate() - 30);
  const end = new Date(now);
  end.setDate(end.getDate() + 60);

  return {
    startDate: start.toISOString().split("T")[0],
    endDate: end.toISOString().split("T")[0],
  };
}

export function isDashboardSummaryForStudio(
  summary: DashboardSummary,
  studioId: string | null
): boolean {
  return summary.auth.studio_id === studioId;
}

export function isLiveAuthRequestCurrent({
  requestToken,
  requestGeneration,
  currentToken,
  currentGeneration,
}: {
  requestToken: string;
  requestGeneration: number;
  currentToken: string | null;
  currentGeneration: number;
}): boolean {
  return currentToken === requestToken && currentGeneration === requestGeneration;
}

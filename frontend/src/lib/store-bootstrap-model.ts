import type {
  AuthResponse,
  BeltLadder,
  DashboardBootstrapResponse,
  DashboardSummary,
  Lead,
  Program,
  Student,
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
  students_total?: number | null;
  students_page_size?: number;
  students_may_be_partial?: boolean;
  programs: Program[];
  leads: Lead[];
  belt_ladders: BeltLadder[];
  primary_belt_ladder: BeltLadder | null;
};

export function parseAuthProfileResponse(value: unknown): AuthProfileResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Auth response is invalid.");
  }

  const membershipStatus = (value as { membership_status?: unknown }).membership_status;
  if (
    membershipStatus !== "none" &&
    membershipStatus !== "active" &&
    membershipStatus !== "archived"
  ) {
    throw new Error("Auth response is missing explicit membership_status.");
  }

  return value as AuthProfileResponse;
}

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

export function isStaffProfilesAvailable(authProfile: {
  staff_profiles_available?: unknown;
}): boolean {
  return authProfile.staff_profiles_available === true;
}

export function resolveBootstrapStudioName(
  data: Pick<BootstrapResponse, "studio_name" | "studio">,
): string {
  return data.studio_name || data.studio?.name || "";
}

export function resolveBootstrapLadders(
  data: Pick<BootstrapResponse, "belt_ladders" | "primary_belt_ladder">,
): BeltLadder[] {
  return data.belt_ladders.length > 0
    ? data.belt_ladders
    : data.primary_belt_ladder
      ? [data.primary_belt_ladder]
      : [];
}

export function buildDeferredScheduleDateRange(
  now = new Date(),
  businessDate = now.toISOString().slice(0, 10),
): {
  startDate: string;
  endDate: string;
} {
  const shift = (days: number) => {
    const date = new Date(`${businessDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  return { startDate: shift(-30), endDate: shift(60) };
}

export function isDashboardSummaryForStudio(
  summary: DashboardSummary,
  studioId: string | null,
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

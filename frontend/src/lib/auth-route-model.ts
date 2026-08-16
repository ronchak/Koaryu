import type { MembershipStatus } from "@/types";

export const ACCOUNT_ARCHIVED_ROUTE = "/account-archived";

export interface MembershipRouteInput {
  authenticated: boolean;
  hasStudio: boolean;
  isAuthRoute: boolean;
  isOnboardingRoute: boolean;
  membershipStatus: MembershipStatus;
  pathname: string;
}

export function routeForMembershipStatus(status: MembershipStatus): string {
  return status === "archived" ? ACCOUNT_ARCHIVED_ROUTE : "/onboarding";
}

export function resolveMembershipRoute({
  authenticated,
  hasStudio,
  isAuthRoute,
  isOnboardingRoute,
  membershipStatus,
  pathname,
}: MembershipRouteInput): string | null {
  const isArchivedRoute =
    pathname === ACCOUNT_ARCHIVED_ROUTE || pathname.startsWith(`${ACCOUNT_ARCHIVED_ROUTE}/`);

  if (!authenticated) {
    return isAuthRoute ? null : "/login";
  }

  if (membershipStatus === "archived") {
    return isArchivedRoute ? null : ACCOUNT_ARCHIVED_ROUTE;
  }

  if (isArchivedRoute) {
    return membershipStatus === "active" ? "/dashboard" : "/onboarding";
  }

  if (isAuthRoute) {
    return membershipStatus === "active" && hasStudio ? "/dashboard" : "/onboarding";
  }

  if (isOnboardingRoute && membershipStatus === "active" && hasStudio) {
    return "/dashboard";
  }

  if ((membershipStatus === "none" || !hasStudio) && !isOnboardingRoute) {
    return "/onboarding";
  }

  return null;
}

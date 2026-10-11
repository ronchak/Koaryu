import {
  clearActiveStudioIdCookie,
  clearStudioStateCookie,
  setActiveStudioIdCookie,
  setStudioStateCookie,
  type StudioMembershipStatus,
} from "@/lib/studio-state-cookie";
import { purgeDashboardLayoutNamespace } from "@/lib/dashboard-layout-store";
import { purgeHomePreferencesNamespace } from "@/lib/dashboard/home-preferences";

export function clearStoredStudioSessionCookies() {
  clearStudioStateCookie();
  clearActiveStudioIdCookie();
  // The old layout store goes with the old page in Phase 5; until then purge both.
  purgeDashboardLayoutNamespace();
  purgeHomePreferencesNamespace();
}

export function syncStoredStudioSessionCookies(
  userId: string,
  studioId: string | null | undefined,
  membershipStatus: StudioMembershipStatus = studioId ? "active" : "none",
) {
  const hasStudio = membershipStatus === "active" && Boolean(studioId);
  setStudioStateCookie(userId, hasStudio, membershipStatus);
  if (hasStudio && studioId) {
    setActiveStudioIdCookie(studioId);
  } else {
    clearActiveStudioIdCookie();
  }
}

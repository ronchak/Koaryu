import {
  clearActiveStudioIdCookie,
  clearStudioStateCookie,
  setActiveStudioIdCookie,
  setStudioStateCookie,
  type StudioMembershipStatus,
} from "@/lib/studio-state-cookie";
import { purgeDashboardLayoutNamespace } from "@/lib/dashboard-layout-store";

export function clearStoredStudioSessionCookies() {
  clearStudioStateCookie();
  clearActiveStudioIdCookie();
  purgeDashboardLayoutNamespace();
}

export function syncStoredStudioSessionCookies(
  userId: string,
  studioId: string | null | undefined,
  membershipStatus: StudioMembershipStatus = studioId ? "active" : "none"
) {
  const hasStudio = membershipStatus === "active" && Boolean(studioId);
  setStudioStateCookie(userId, hasStudio, membershipStatus);
  if (hasStudio && studioId) {
    setActiveStudioIdCookie(studioId);
  } else {
    clearActiveStudioIdCookie();
  }
}

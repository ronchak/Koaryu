import {
  clearActiveStudioIdCookie,
  clearStudioStateCookie,
  setActiveStudioIdCookie,
  setStudioStateCookie,
  type StudioMembershipStatus,
} from "@/lib/studio-state-cookie";

export function clearStoredStudioSessionCookies() {
  clearStudioStateCookie();
  clearActiveStudioIdCookie();
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

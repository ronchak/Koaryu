import {
  clearActiveStudioIdCookie,
  clearStudioStateCookie,
  setActiveStudioIdCookie,
  setStudioStateCookie,
} from "@/lib/studio-state-cookie";

export function clearStoredStudioSessionCookies() {
  clearStudioStateCookie();
  clearActiveStudioIdCookie();
}

export function syncStoredStudioSessionCookies(
  userId: string,
  studioId: string | null | undefined
) {
  setStudioStateCookie(userId, Boolean(studioId));
  if (studioId) {
    setActiveStudioIdCookie(studioId);
  } else {
    clearActiveStudioIdCookie();
  }
}

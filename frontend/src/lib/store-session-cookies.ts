import {
  clearActiveStudioIdCookie,
  clearStudioStateCookie,
  setActiveStudioIdCookie,
  setStudioStateCookie,
  type StudioMembershipStatus,
} from "@/lib/studio-state-cookie";
import { purgeHomePreferencesNamespace } from "@/lib/dashboard/home-preferences";

// The old dashboard kept its layout under this prefix. Browsers that used it still hold keys
// named with user and studio ids, so sign-out keeps removing them.
const OLD_DASHBOARD_LAYOUT_PREFIX = "koaryu:dashboard-layout:";

function purgeOldDashboardLayoutKeys() {
  try {
    const storage = window.localStorage;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(OLD_DASHBOARD_LAYOUT_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // No storage, or the browser refused; there is nothing to purge.
  }
}

export function clearStoredStudioSessionCookies() {
  clearStudioStateCookie();
  clearActiveStudioIdCookie();
  purgeOldDashboardLayoutKeys();
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

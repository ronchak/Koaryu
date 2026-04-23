export const STUDIO_STATE_COOKIE = "koaryu-studio-state";
export const STUDIO_STATE_COOKIE_MAX_AGE_SECONDS = 300;
export const ACTIVE_STUDIO_COOKIE = "koaryu-active-studio";
export const ACTIVE_STUDIO_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type ParsedStudioStateCookie = {
  userId: string;
  hasStudio: boolean;
};

export function serializeStudioStateCookie(userId: string, hasStudio: boolean) {
  return `${userId}|${hasStudio ? "1" : "0"}`;
}

export function parseStudioStateCookie(
  value: string | null | undefined
): ParsedStudioStateCookie | null {
  if (!value) {
    return null;
  }

  let decodedValue = value;

  try {
    decodedValue = decodeURIComponent(value);
  } catch {
    return null;
  }

  const [userId, hasStudioFlag, ...rest] = decodedValue.split("|");

  if (!userId || rest.length > 0 || (hasStudioFlag !== "0" && hasStudioFlag !== "1")) {
    return null;
  }

  return {
    userId,
    hasStudio: hasStudioFlag === "1",
  };
}

export function setStudioStateCookie(userId: string, hasStudio: boolean) {
  if (typeof document === "undefined") {
    return;
  }

  const parts = [
    `${STUDIO_STATE_COOKIE}=${encodeURIComponent(
      serializeStudioStateCookie(userId, hasStudio)
    )}`,
    "Path=/",
    `Max-Age=${STUDIO_STATE_COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ];

  if (window.location.protocol === "https:") {
    parts.push("Secure");
  }

  document.cookie = parts.join("; ");
}

export function clearStudioStateCookie() {
  if (typeof document === "undefined") {
    return;
  }

  const parts = [
    `${STUDIO_STATE_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
  ];

  if (window.location.protocol === "https:") {
    parts.push("Secure");
  }

  document.cookie = parts.join("; ");
}

function readCookieValue(name: string): string | null {
  if (typeof document === "undefined") {
    return null;
  }

  const prefix = `${name}=`;
  const entry = document.cookie
    .split("; ")
    .find((cookiePart) => cookiePart.startsWith(prefix));

  if (!entry) {
    return null;
  }

  try {
    return decodeURIComponent(entry.slice(prefix.length));
  } catch {
    return null;
  }
}

export function getActiveStudioIdCookie() {
  return readCookieValue(ACTIVE_STUDIO_COOKIE);
}

export function setActiveStudioIdCookie(studioId: string) {
  if (typeof document === "undefined" || !studioId) {
    return;
  }

  const parts = [
    `${ACTIVE_STUDIO_COOKIE}=${encodeURIComponent(studioId)}`,
    "Path=/",
    `Max-Age=${ACTIVE_STUDIO_COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ];

  if (window.location.protocol === "https:") {
    parts.push("Secure");
  }

  document.cookie = parts.join("; ");
}

export function clearActiveStudioIdCookie() {
  if (typeof document === "undefined") {
    return;
  }

  const parts = [
    `${ACTIVE_STUDIO_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
  ];

  if (window.location.protocol === "https:") {
    parts.push("Secure");
  }

  document.cookie = parts.join("; ");
}

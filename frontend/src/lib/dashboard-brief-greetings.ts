const MAX_FIRST_NAME_LENGTH = 24;

/**
 * Pulls a display-safe first name out of a stored profile name. Returns `null`
 * when nothing usable is left.
 */
export function resolveDashboardOwnerFirstName(rawName: string | null | undefined): string | null {
  if (typeof rawName !== "string") {
    return null;
  }

  const firstToken = rawName.trim().split(/\s+/)[0] ?? "";
  const cleaned = firstToken.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.'-]+$/gu, "");
  if (!cleaned || cleaned.length > MAX_FIRST_NAME_LENGTH || cleaned.includes("@")) {
    return null;
  }

  return cleaned;
}

const DEFAULT_AUTH_CALLBACK_PATH = "/dashboard";
const AUTH_CALLBACK_ALLOWED_NEXT_PATHS = new Set([
  "/dashboard",
  "/onboarding",
  "/reset-password",
]);

export function resolveAuthCallbackNextPath(requestedNextPath: string | null) {
  if (!requestedNextPath || !requestedNextPath.startsWith("/") || requestedNextPath.startsWith("//")) {
    return DEFAULT_AUTH_CALLBACK_PATH;
  }

  let parsed: URL;
  try {
    parsed = new URL(requestedNextPath, "https://koaryu.local");
  } catch {
    return DEFAULT_AUTH_CALLBACK_PATH;
  }

  if (parsed.origin !== "https://koaryu.local") {
    return DEFAULT_AUTH_CALLBACK_PATH;
  }

  const nextPath = parsed.pathname;
  return AUTH_CALLBACK_ALLOWED_NEXT_PATHS.has(nextPath)
    ? `${nextPath}${parsed.search}${parsed.hash}`
    : DEFAULT_AUTH_CALLBACK_PATH;
}

import { isAiAuthorizationId } from "./mcp-connections.ts";

const DEFAULT_AUTH_CALLBACK_PATH = "/dashboard";
const AUTH_CALLBACK_ALLOWED_NEXT_PATHS = new Set(["/dashboard", "/onboarding", "/reset-password"]);

export function resolveAuthCallbackNextPath(requestedNextPath: string | null) {
  if (
    !requestedNextPath ||
    !requestedNextPath.startsWith("/") ||
    requestedNextPath.startsWith("//")
  ) {
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
  if (nextPath === "/connect/authorize") {
    const id = parsed.searchParams.get("authorization_id");
    return isAiAuthorizationId(id)
      ? `/connect/authorize?authorization_id=${id}`
      : DEFAULT_AUTH_CALLBACK_PATH;
  }
  return AUTH_CALLBACK_ALLOWED_NEXT_PATHS.has(nextPath)
    ? `${nextPath}${parsed.search}${parsed.hash}`
    : DEFAULT_AUTH_CALLBACK_PATH;
}

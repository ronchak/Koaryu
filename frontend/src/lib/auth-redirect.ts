import { resolveAuthCallbackNextPath } from "./auth-callback";

const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");

export function getAuthCallbackUrl() {
  const origin = configuredSiteUrl || (typeof window !== "undefined" ? window.location.origin : "");

  const next =
    typeof window !== "undefined"
      ? resolveAuthCallbackNextPath(new URLSearchParams(window.location.search).get("next"))
      : "/dashboard";
  return `${origin}/auth/callback${next.startsWith("/connect/authorize?") ? `?next=${encodeURIComponent(next)}` : ""}`;
}

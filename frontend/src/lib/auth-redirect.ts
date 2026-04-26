const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");

export function getAuthCallbackUrl() {
  const origin =
    configuredSiteUrl ||
    (typeof window !== "undefined" ? window.location.origin : "");

  return `${origin}/auth/callback`;
}

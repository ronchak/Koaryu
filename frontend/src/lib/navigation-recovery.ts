const RECOVERY_ROUTES = new Set([
  "dashboard", "students", "leads", "schedule", "belt-tracker", "reports",
  "settings", "billing", "automations", "account", "help", "login", "signup",
  "onboarding", "account-archived", "subscription-required",
]);

/** Only application destinations can be retried; never accept an external URL. */
export function navigationRecoveryPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/")
    || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return "/dashboard";
  try {
    const url = new URL(value, "https://recovery.invalid");
    if (url.origin !== "https://recovery.invalid" || !RECOVERY_ROUTES.has(url.pathname.split("/")[1])) return "/dashboard";
    url.searchParams.delete("_rsc");
    return url.pathname + url.search;
  } catch {
    return "/dashboard";
  }
}

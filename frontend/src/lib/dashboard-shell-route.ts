const ROUTE_LABELS: readonly [string, string][] = [
  ["/students/import", "Students / Import"],
  ["/students/", "Students / Record"],
  ["/students", "Students"],
  ["/belt-tracker", "Belt Tracker"],
  ["/leads", "Leads"],
  ["/schedule", "Schedule"],
  ["/billing", "Billing"],
  ["/automations", "Automations"],
  ["/reports", "Reports"],
  ["/settings", "Settings"],
  ["/account/profile", "Account / Profile"],
  ["/account/settings", "Account / Settings"],
  ["/account/personalization", "Account / Personalization"],
  ["/account/notifications", "Account / Notifications"],
  ["/account/data", "Account / Data"],
  ["/account", "Account"],
  ["/help/get-started", "Help / Get Started"],
  ["/help/release-notes", "Help / Release Notes"],
  ["/help/downloads", "Help / Downloads"],
  ["/help/contact", "Help / Contact"],
  ["/help", "Help"],
  ["/subscription-required", "Subscription Required"],
  ["/dashboard", "Dashboard / My Home"],
];

export function resolveDashboardRouteSlug(pathname: string): string {
  const match = ROUTE_LABELS.find(([route]) => (
    route.endsWith("/") ? pathname.startsWith(route) : pathname === route || pathname.startsWith(`${route}/`)
  ));
  return match?.[1] ?? "Koaryu / Workspace";
}

export function formatDashboardRole(role: unknown): string {
  if (role === "admin") return "Admin";
  if (role === "front_desk") return "Front desk";
  if (role === "instructor") return "Instructor";
  return "Role unavailable";
}

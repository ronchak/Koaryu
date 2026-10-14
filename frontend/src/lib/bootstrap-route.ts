import { shouldUseDerivedRosterFilters } from "./students-page-model.ts";

export type BootstrapView =
  "home" | "students" | "schedule" | "settings" | "leads" | "reports" | "training";
export function initialBootstrapView(
  pathname: string,
  { isPreviewMode = false, pagedRosterEnabled = true } = {},
): BootstrapView | null {
  const route = pathname.split("/")[1];
  // Workspace already supplies Home's shell; its facts come from /dashboard/home.
  if (route === "dashboard") return null;
  if (route === "students")
    return shouldUseDerivedRosterFilters({
      fullRosterRequested: false,
      hasNewStudentFilter: false,
      inactivityThreshold: null,
      isPreviewMode,
      pagedRosterEnabled,
    })
      ? "students"
      : "home";
  if (route === "belt-tracker") return "training";
  if (["schedule", "settings", "leads", "reports"].includes(route)) return route as BootstrapView;
  return null;
}
export function bootstrapDatasets(view: BootstrapView): ReadonlySet<string> {
  return new Set([
    "studio",
    "programs",
    ...(view === "students" ? ["students"] : []),
    ...(["leads", "reports"].includes(view) ? ["leads"] : []),
    ...(view === "training" ? ["belts"] : []),
  ]);
}

export type BootstrapView =
  "dashboard" | "students" | "schedule" | "settings" | "leads" | "reports" | "training";
export function initialBootstrapView(pathname: string): BootstrapView | null {
  const route = pathname.split("/")[1];
  if (route === "belt-tracker") return "training";
  if (["dashboard", "students", "schedule", "settings", "leads", "reports"].includes(route))
    return route as BootstrapView;
  return null;
}
export function bootstrapDatasets(view: BootstrapView): ReadonlySet<string> {
  return new Set([
    "studio",
    "programs",
    ...(["dashboard", "students"].includes(view) ? ["students"] : []),
    ...(["dashboard", "leads", "reports"].includes(view) ? ["leads"] : []),
    ...(["dashboard", "training"].includes(view) ? ["belts"] : []),
  ]);
}

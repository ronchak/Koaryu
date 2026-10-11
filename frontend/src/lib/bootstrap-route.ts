export type BootstrapView =
  "home" | "students" | "schedule" | "settings" | "leads" | "reports" | "training";
export function initialBootstrapView(pathname: string): BootstrapView | null {
  const route = pathname.split("/")[1];
  // Home reads its facts from /dashboard/home; its bootstrap carries only the studio and programs.
  if (route === "dashboard") return "home";
  if (route === "belt-tracker") return "training";
  if (["students", "schedule", "settings", "leads", "reports"].includes(route))
    return route as BootstrapView;
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

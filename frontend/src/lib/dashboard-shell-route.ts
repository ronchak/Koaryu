

export function formatDashboardRole(role: unknown): string {
  if (role === "admin") return "Admin";
  if (role === "front_desk") return "Front desk";
  if (role === "instructor") return "Instructor";
  return "Role unavailable";
}

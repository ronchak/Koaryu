export function formatRoleLabel(role?: string | null): string {
  if (role === "admin") return "Admin";
  if (role === "instructor") return "Instructor";
  if (role === "front_desk") return "Front desk";
  return "Member";
}

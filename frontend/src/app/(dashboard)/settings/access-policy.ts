export function canAccessSettings(currentRole: string | null): boolean {
  return currentRole === "admin";
}

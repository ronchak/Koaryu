import type { StaffRoleName } from "@/types";
export type StaffPermission =
  | "manage_roster_bulk"
  | "manage_schedule"
  | "configure_belts"
  | "promote_students"
  | "convert_leads"
  | "take_attendance";
const ROLE_PERMISSIONS: Record<StaffRoleName, ReadonlySet<StaffPermission>> = {
  admin: new Set([
    "manage_roster_bulk",
    "manage_schedule",
    "configure_belts",
    "promote_students",
    "convert_leads",
    "take_attendance",
  ]),
  front_desk: new Set([
    "manage_roster_bulk",
    "manage_schedule",
    "convert_leads",
    "take_attendance",
  ]),
  instructor: new Set(["promote_students", "take_attendance"]),
};
export function hasStaffPermission(
  role: StaffRoleName | null,
  permission: StaffPermission
): boolean {
  return role ? ROLE_PERMISSIONS[role].has(permission) : false;
}

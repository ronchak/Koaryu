import type { StaffRoleName } from "@/types";
export type StaffPermission =
  | "create_students"
  | "manage_student_lifecycle"
  | "manage_roster_bulk"
  | "manage_schedule"
  | "manage_leads"
  | "configure_belts"
  | "promote_students"
  | "convert_leads"
  | "take_attendance";
const ROLE_PERMISSIONS: Record<StaffRoleName, ReadonlySet<StaffPermission>> = {
  admin: new Set([
    "create_students",
    "manage_student_lifecycle",
    "manage_roster_bulk",
    "manage_schedule",
    "manage_leads",
    "configure_belts",
    "promote_students",
    "convert_leads",
    "take_attendance",
  ]),
  front_desk: new Set([
    "create_students",
    "manage_student_lifecycle",
    "manage_roster_bulk",
    "manage_schedule",
    "manage_leads",
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

export function canMaterializeScheduleRange(role: StaffRoleName | null): boolean {
  return hasStaffPermission(role, "take_attendance");
}

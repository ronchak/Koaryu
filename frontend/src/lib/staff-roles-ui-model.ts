import type { StaffMember } from "../types/index.ts";

export function getDisplayedStaffIdentity(member: StaffMember): string {
  return member.deletion_confirmation_name;
}

export function filterStaffMembersForDisplay(
  members: StaffMember[],
  showArchived: boolean
): StaffMember[] {
  return showArchived
    ? members
    : members.filter((member) => member.status !== "archived");
}

export function countActiveAdminMembers(members: StaffMember[]): number {
  return members.filter(
    (member) => member.status === "active" && member.role === "admin"
  ).length;
}

export function isLastActiveAdmin(
  members: StaffMember[],
  member: StaffMember
): boolean {
  return (
    member.status === "active"
    && member.role === "admin"
    && countActiveAdminMembers(members) <= 1
  );
}

export function normalizeStaffConfirmationInput(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function matchesStaffDeletionConfirmation(
  member: StaffMember,
  value: string
): boolean {
  return normalizeStaffConfirmationInput(value) === getDisplayedStaffIdentity(member);
}

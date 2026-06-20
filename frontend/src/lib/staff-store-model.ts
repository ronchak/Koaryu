import type { StaffInviteCreate, StaffMember, StaffRoleName } from "@/types";

const STAFF_ROLE_ORDER: Record<StaffRoleName, number> = {
  admin: 0,
  instructor: 1,
  front_desk: 2,
};

export function sortStaffMembers(
  members: StaffMember[],
  currentUserId?: string | null
): StaffMember[] {
  return [...members].sort((a, b) => {
    if (currentUserId && a.user_id === currentUserId && b.user_id !== currentUserId) return -1;
    if (currentUserId && b.user_id === currentUserId && a.user_id !== currentUserId) return 1;
    const roleDelta = STAFF_ROLE_ORDER[a.role] - STAFF_ROLE_ORDER[b.role];
    if (roleDelta !== 0) return roleDelta;
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return a.created_at.localeCompare(b.created_at);
  });
}

export function buildPreviewStaffInvite(
  data: StaffInviteCreate,
  activeUserId: string | null | undefined,
  {
    now = new Date(),
    nowMs = Date.now(),
  }: {
    now?: Date;
    nowMs?: number;
  } = {}
): StaffMember {
  const nowIso = now.toISOString();
  const normalizedEmail = data.email.trim().toLowerCase();

  return {
    id: `preview-staff-${nowMs}`,
    studio_id: "mock-studio",
    user_id: `preview-staff-user-${nowMs}`,
    email: normalizedEmail,
    full_name: null,
    role: data.role,
    status: "pending",
    invited_by: activeUserId || "preview-user",
    created_at: nowIso,
    updated_at: nowIso,
    last_sign_in_at: null,
  };
}

export function upsertStaffMember(
  members: StaffMember[],
  nextMember: StaffMember,
  currentUserId?: string | null
): StaffMember[] {
  return sortStaffMembers(
    [...members.filter((member) => member.id !== nextMember.id), nextMember],
    currentUserId
  );
}

export function applyStaffRoleUpdate(
  members: StaffMember[],
  id: string,
  role: StaffRoleName,
  currentUserId?: string | null,
  nowIso = new Date().toISOString()
): { members: StaffMember[]; updated: StaffMember | null } {
  let updated: StaffMember | null = null;
  const nextMembers = members.map((member) => {
    if (member.id !== id) {
      return member;
    }

    updated = { ...member, role, updated_at: nowIso };
    return updated;
  });

  return {
    members: sortStaffMembers(nextMembers, currentUserId),
    updated,
  };
}

import { normalizeLegalName } from "./legal-name-model.ts";
import type {
  StaffDeletionRequestCreate,
  StaffDeletionRequestResponse,
  StaffInviteCreate,
  StaffLegalNameResponse,
  StaffMember,
  StaffRoleName,
  StaffStatus,
} from "@/types";

const STAFF_ROLE_ORDER: Record<StaffRoleName, number> = {
  admin: 0,
  instructor: 1,
  front_desk: 2,
};

const STAFF_STATUS_ORDER: Record<StaffStatus, number> = {
  active: 0,
  pending: 1,
  archived: 2,
};

export type StaffLifecycleAction = "archive" | "unarchive" | "scheduleDeletion";

export interface StaffLifecyclePreviewContext {
  currentUserId?: string | null;
  ownerUserId?: string | null;
}

export function normalizeStaffInvite(data: StaffInviteCreate): StaffInviteCreate {
  const normalized = {
    email: data.email.trim().toLowerCase(),
    role: data.role,
    full_name: normalizeLegalName(data.full_name),
    legal_first_name: normalizeLegalName(data.legal_first_name),
    legal_last_name: normalizeLegalName(data.legal_last_name),
  } satisfies StaffInviteCreate;

  if (!normalized.full_name) {
    throw new Error("Display name is required.");
  }
  if (!normalized.legal_first_name) {
    throw new Error("Legal first name is required.");
  }
  if (!normalized.legal_last_name) {
    throw new Error("Legal last name is required.");
  }

  return normalized;
}

export function sortStaffMembers(
  members: StaffMember[],
  currentUserId?: string | null
): StaffMember[] {
  return [...members].sort((a, b) => {
    if (currentUserId && a.user_id === currentUserId && b.user_id !== currentUserId) return -1;
    if (currentUserId && b.user_id === currentUserId && a.user_id !== currentUserId) return 1;
    const roleDelta = STAFF_ROLE_ORDER[a.role] - STAFF_ROLE_ORDER[b.role];
    if (roleDelta !== 0) return roleDelta;
    const statusDelta = STAFF_STATUS_ORDER[a.status] - STAFF_STATUS_ORDER[b.status];
    if (statusDelta !== 0) return statusDelta;
    return a.created_at.localeCompare(b.created_at);
  });
}

export function buildStaffListPath(includeArchived = false): string {
  return includeArchived ? "/staff?include_archived=true" : "/staff";
}

export function normalizeStaffConfirmationName(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new Error("Confirmation name is required.");
  }
  return normalized;
}

export function buildStaffDeletionRequest(
  confirmationName: string,
  reason?: string | null
): StaffDeletionRequestCreate {
  const payload: StaffDeletionRequestCreate = {
    confirmation_name: normalizeStaffConfirmationName(confirmationName),
  };
  const normalizedReason = reason?.trim() || undefined;
  if (normalizedReason) {
    payload.reason = normalizedReason;
  }
  return payload;
}

export function countActiveStaffAdmins(members: StaffMember[]): number {
  return members.filter((member) => member.status === "active" && member.role === "admin").length;
}

export function getPendingInviteRevokeError(
  members: StaffMember[],
  id: string
): string | null {
  const member = members.find((candidate) => candidate.id === id);
  if (!member) {
    return "Staff member not found.";
  }
  return member.status === "pending"
    ? null
    : "Only pending staff invitations can be revoked.";
}

export function getStaffLifecyclePreviewError(
  members: StaffMember[],
  id: string,
  action: StaffLifecycleAction,
  { currentUserId, ownerUserId }: StaffLifecyclePreviewContext = {}
): string | null {
  const member = members.find((candidate) => candidate.id === id);
  if (!member) {
    return "Staff member not found.";
  }

  if (member.user_id && member.user_id === currentUserId) {
    return "Preview cannot change the current user's staff lifecycle.";
  }

  if (member.user_id && member.user_id === ownerUserId) {
    return "Preview cannot change the studio owner's staff lifecycle.";
  }

  if (action === "archive") {
    if (member.status === "active" && member.role === "admin" && countActiveStaffAdmins(members) <= 1) {
      return "Preview cannot archive the last active admin.";
    }
    return null;
  }

  if (action === "unarchive") {
    return null;
  }

  if (member.status !== "archived") {
    return "Preview can schedule deletion only for an archived staff member.";
  }
  if (!member.user_id) {
    return "Preview cannot schedule deletion for a staff member without a linked user.";
  }
  return null;
}

function applyStaffLifecycleTransition(
  members: StaffMember[],
  id: string,
  action: "archive" | "unarchive",
  currentUserId?: string | null,
  nowIso = new Date().toISOString()
): { members: StaffMember[]; updated: StaffMember | null } {
  let updated: StaffMember | null = null;
  const nextMembers = members.map((member) => {
    if (member.id !== id) {
      return member;
    }

    updated = action === "archive"
      ? { ...member, status: "archived", archived_at: member.archived_at || nowIso, updated_at: nowIso }
      : { ...member, status: "active", archived_at: null, updated_at: nowIso };
    return updated;
  });

  return {
    members: sortStaffMembers(nextMembers, currentUserId),
    updated,
  };
}

export function applyStaffArchive(
  members: StaffMember[],
  id: string,
  currentUserId?: string | null,
  nowIso = new Date().toISOString()
) {
  return applyStaffLifecycleTransition(members, id, "archive", currentUserId, nowIso);
}

export function applyStaffUnarchive(
  members: StaffMember[],
  id: string,
  currentUserId?: string | null,
  nowIso = new Date().toISOString()
) {
  return applyStaffLifecycleTransition(members, id, "unarchive", currentUserId, nowIso);
}

export function buildPreviewStaffDeletionResponse(
  member: StaffMember,
  reason: string | null | undefined,
  requesterEmail: string,
  {
    now = new Date(),
    nowMs = Date.now(),
  }: {
    now?: Date;
    nowMs?: number;
  } = {}
): StaffDeletionRequestResponse {
  const requestedAt = now.toISOString();
  const scheduledFor = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: `preview-deletion-${nowMs}`,
    user_id: member.user_id || `preview-staff-user-${nowMs}`,
    studio_id: member.studio_id,
    requester_email: requesterEmail || "preview@example.test",
    status: "scheduled",
    requested_at: requestedAt,
    scheduled_for: scheduledFor,
    canceled_at: null,
    completed_at: null,
    reason: reason?.trim() || null,
  };
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
  const normalized = normalizeStaffInvite(data);

  return {
    id: `preview-staff-${nowMs}`,
    studio_id: "mock-studio",
    user_id: `preview-staff-user-${nowMs}`,
    email: normalized.email,
    full_name: normalized.full_name,
    deletion_confirmation_name: normalized.full_name,
    legal_first_name: normalized.legal_first_name,
    legal_last_name: normalized.legal_last_name,
    role: normalized.role,
    status: "pending",
    archived_at: null,
    invited_by: activeUserId || "preview-user",
    created_at: nowIso,
    updated_at: nowIso,
    last_sign_in_at: null,
  };
}

export function mergeStaffLegalNameResponse(
  members: StaffMember[],
  response: StaffLegalNameResponse
): { members: StaffMember[]; updated: StaffMember | null } {
  let updated: StaffMember | null = null;
  const nextMembers = members.map((member) => {
    if (member.user_id !== response.user_id) {
      return member;
    }

    updated = {
      ...member,
      legal_first_name: response.legal_first_name,
      legal_last_name: response.legal_last_name,
    };
    return updated;
  });

  return { members: nextMembers, updated };
}

export function applyStaffLegalNameUpdate(
  members: StaffMember[],
  userId: string,
  firstName: string,
  lastName: string
): { members: StaffMember[]; updated: StaffMember | null } {
  return mergeStaffLegalNameResponse(members, {
    user_id: userId,
    legal_first_name: firstName,
    legal_last_name: lastName,
  });
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

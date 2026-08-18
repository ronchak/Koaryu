"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { Input } from "@/components/ui/input";
import { ModalFrame } from "@/components/ui/modal-frame";
import { normalizeLegalName, normalizeLegalNameDraft } from "@/lib/legal-name-model";
import {
  countActiveAdminMembers,
  filterStaffMembersForDisplay,
  getDisplayedStaffIdentity,
  isLastActiveAdmin,
  matchesStaffDeletionConfirmation,
  normalizeStaffConfirmationInput,
} from "@/lib/staff-roles-ui-model";
import { useConfigStore, useStudioStore } from "@/lib/store";
import type { StaffMember, StaffRoleName } from "@/types";
import { Archive, AlertTriangle, MailPlus, Pencil, RefreshCw, RotateCcw, Trash2, Users } from "lucide-react";

type PendingLifecycleAction = {
  id: string;
  action: "archive" | "unarchive" | "delete";
} | null;

const ROLE_LABELS: Record<StaffRoleName, string> = {
  admin: "Admin",
  instructor: "Instructor",
  front_desk: "Front Desk",
};

const ROLE_OPTIONS: StaffRoleName[] = ["admin", "instructor", "front_desk"];

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function isValidEmail(value: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

function roleBadgeVariant(role: StaffRoleName) {
  if (role === "admin") return "accent";
  if (role === "instructor") return "default";
  return "warning";
}

function StaffSkeletonRows() {
  return (
    <div className="divide-y divide-border border border-border rounded-[6px] overflow-hidden">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="grid grid-cols-[1fr_140px_100px_120px_180px] gap-3 p-3">
          <div className="space-y-2">
            <div className="h-3 w-36 bg-surface-raised rounded" />
            <div className="h-3 w-48 bg-surface-raised rounded" />
          </div>
          <div className="h-7 bg-surface-raised rounded" />
          <div className="h-5 w-16 bg-surface-raised rounded" />
          <div className="h-3 w-20 bg-surface-raised rounded" />
          <div className="h-7 bg-surface-raised rounded" />
        </div>
      ))}
    </div>
  );
}

function StaffIdentity({
  member,
  currentUserId,
  staffProfilesAvailable,
}: {
  member: StaffMember;
  currentUserId: string;
  staffProfilesAvailable: boolean;
}) {
  const displayName = getDisplayedStaffIdentity(member);
  const email = member.email.trim();
  const legalName = member.legal_first_name?.trim() && member.legal_last_name?.trim()
    ? `${member.legal_first_name} ${member.legal_last_name}`
    : "Not provided";

  return (
    <div className="min-w-0">
      {staffProfilesAvailable ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2 min-w-0">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-normal text-muted">Display name</p>
              <p className="text-sm font-medium text-text-primary truncate">{displayName}</p>
            </div>
            {member.user_id === currentUserId && <Badge variant="accent">You</Badge>}
          </div>
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-normal text-muted">Legal name</p>
            <p className="text-xs text-text-secondary truncate">{legalName}</p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-medium text-text-primary truncate">{displayName}</p>
          {member.user_id === currentUserId && <Badge variant="accent">You</Badge>}
        </div>
      )}
      {email ? <p className="text-xs text-muted truncate">{email}</p> : null}
    </div>
  );
}

interface StaffRowProps {
  member: StaffMember;
  currentUserId: string;
  canManageStaff: boolean;
  staffProfilesAvailable: boolean;
  isLastActiveAdmin: boolean;
  pendingRoleId: string | null;
  pendingRemoveId: string | null;
  pendingLifecycle: PendingLifecycleAction;
  pendingLegalNameUserId: string | null;
  legalNameTargetUserId: string | null;
  legalFirstName: string;
  legalLastName: string;
  legalNameError: string;
  legalNameCanSubmit: boolean;
  onRoleChange: (member: StaffMember, role: StaffRoleName) => void;
  onRemove: (member: StaffMember) => void;
  onArchive: (member: StaffMember) => void;
  onUnarchive: (member: StaffMember) => void;
  onScheduleDeletion: (member: StaffMember) => void;
  onEditLegalName: (member: StaffMember) => void;
  onLegalNameFirstChange: (value: string) => void;
  onLegalNameLastChange: (value: string) => void;
  onLegalNameSave: (event: FormEvent<HTMLFormElement>) => void;
  onLegalNameCancel: () => void;
}

function StaffRow({
  member,
  currentUserId,
  canManageStaff,
  staffProfilesAvailable,
  isLastActiveAdmin,
  pendingRoleId,
  pendingRemoveId,
  pendingLifecycle,
  pendingLegalNameUserId,
  legalNameTargetUserId,
  legalFirstName,
  legalLastName,
  legalNameError,
  legalNameCanSubmit,
  onRoleChange,
  onRemove,
  onArchive,
  onUnarchive,
  onScheduleDeletion,
  onEditLegalName,
  onLegalNameFirstChange,
  onLegalNameLastChange,
  onLegalNameSave,
  onLegalNameCancel,
}: StaffRowProps) {
  const isRolePending = pendingRoleId === member.id;
  const isRemovePending = pendingRemoveId === member.id;
  const isLifecyclePending = pendingLifecycle?.id === member.id;
  const hasUserId = member.user_id !== null && member.user_id !== undefined;
  const isArchived = member.status === "archived";
  const isLegalNameEditing = !isArchived && hasUserId && legalNameTargetUserId === member.user_id;
  const isLegalNamePending = !isArchived && hasUserId && pendingLegalNameUserId === member.user_id;
  const rowDate = isArchived ? member.archived_at || member.updated_at : member.created_at;
  const dateLabel = isArchived ? "Archived" : member.status === "pending" ? "Invited" : "Added";

  return (
    <div
      data-staff-status={member.status}
      className={`grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_140px_100px_120px_180px] md:items-center ${
        isArchived ? "border-l-4 border-warning bg-warning/[0.06]" : ""
      }`}
    >
      <div className="min-w-0">
        <StaffIdentity
          member={member}
          currentUserId={currentUserId}
          staffProfilesAvailable={staffProfilesAvailable}
        />
        {staffProfilesAvailable && isLegalNameEditing && (
          <form onSubmit={onLegalNameSave} className="mt-3 space-y-3 border-t border-border pt-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Legal first name"
                value={legalFirstName}
                onChange={(event) => onLegalNameFirstChange(event.target.value)}
                autoComplete="given-name"
                required
                disabled={isLegalNamePending}
              />
              <Input
                label="Legal last name"
                value={legalLastName}
                onChange={(event) => onLegalNameLastChange(event.target.value)}
                autoComplete="family-name"
                required
                disabled={isLegalNamePending}
              />
            </div>
            <p aria-live="polite" className="min-h-4 text-xs text-danger">{legalNameError}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onLegalNameCancel}
                disabled={isLegalNamePending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                isLoading={isLegalNamePending}
                disabled={!legalNameCanSubmit}
              >
                {isLegalNamePending ? "Saving..." : "Save legal name"}
              </Button>
            </div>
          </form>
        )}
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-normal text-muted md:hidden mb-1">Role</p>
        {canManageStaff && !isArchived ? (
          <select
            value={member.role}
            disabled={isRolePending || isLastActiveAdmin}
            onChange={(event) => onRoleChange(member, event.target.value as StaffRoleName)}
            className="w-full px-2 py-1.5 text-xs bg-surface-raised border border-border rounded-[6px] text-text-primary disabled:opacity-50"
          >
            {ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        ) : (
          <Badge variant={roleBadgeVariant(member.role)}>{ROLE_LABELS[member.role]}</Badge>
        )}
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-normal text-muted md:hidden mb-1">Status</p>
        <Badge variant={member.status === "active" ? "success" : "warning"}>
          {member.status === "active" ? "Active" : member.status === "pending" ? "Pending" : "Archived"}
        </Badge>
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-normal text-muted md:hidden mb-1">{dateLabel}</p>
        <p className="text-xs text-text-secondary">{formatDate(rowDate)}</p>
      </div>

      {canManageStaff && (
        <div className="flex flex-wrap items-center gap-1">
          {staffProfilesAvailable && member.status === "active" && hasUserId && !isLegalNameEditing && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onEditLegalName(member)}
              disabled={pendingLegalNameUserId !== null}
              title="Edit legal name"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit legal name
            </Button>
          )}
          {member.status === "pending" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onRemove(member)}
              disabled={isRemovePending || isLifecyclePending}
              className="justify-start md:justify-center text-danger hover:text-danger"
              title="Revoke invitation"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {isRemovePending ? "Working..." : "Revoke"}
            </Button>
          ) : isArchived ? (
            <>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onUnarchive(member)}
                disabled={isLifecyclePending}
                title="Restore studio access"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {pendingLifecycle?.action === "unarchive" ? "Restoring..." : "Unarchive"}
              </Button>
              {hasUserId ? (
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={() => onScheduleDeletion(member)}
                  disabled={isLifecyclePending}
                  className="justify-start md:justify-center"
                  title="Schedule permanent deletion"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {pendingLifecycle?.action === "delete" ? "Scheduling..." : "Delete"}
                </Button>
              ) : (
                <span className="text-xs text-muted" role="status">
                  No linked account to delete
                </span>
              )}
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onArchive(member)}
              disabled={isLifecyclePending || isLastActiveAdmin}
              className="justify-start md:justify-center text-warning hover:text-warning"
              title={isLastActiveAdmin ? "At least one active admin must remain." : "Revoke access and preserve the staff row"}
            >
              <Archive className="w-3.5 h-3.5" />
              {pendingLifecycle?.action === "archive" ? "Archiving..." : "Archive"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function StaffRolesSection() {
  const { isPreviewMode } = useConfigStore();
  const {
    currentRole,
    currentUserId,
    userEmail,
    staffProfilesAvailable,
    staffMembers,
    staffLoaded,
    staffLoadError,
    refreshStaff,
    inviteStaff,
    updateUserLegalName,
    updateStaffLegalName,
    updateStaffRole,
    removeStaff,
    archiveStaff,
    unarchiveStaff,
    scheduleStaffDeletion,
  } = useStudioStore();

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteFullName, setInviteFullName] = useState("");
  const [inviteLegalFirstName, setInviteLegalFirstName] = useState("");
  const [inviteLegalLastName, setInviteLegalLastName] = useState("");
  const [inviteRole, setInviteRole] = useState<StaffRoleName>("instructor");
  const [inviteInFlight, setInviteInFlight] = useState(false);
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [pendingLifecycle, setPendingLifecycle] = useState<PendingLifecycleAction>(null);
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [dismissedStaffLoadError, setDismissedStaffLoadError] = useState("");
  const [removeTarget, setRemoveTarget] = useState<StaffMember | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<StaffMember | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StaffMember | null>(null);
  const [deletionConfirmationInput, setDeletionConfirmationInput] = useState("");
  const [deletionError, setDeletionError] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [isStaffRefreshPending, setIsStaffRefreshPending] = useState(false);
  const [legalNameTarget, setLegalNameTarget] = useState<StaffMember | null>(null);
  const [legalFirstName, setLegalFirstName] = useState("");
  const [legalLastName, setLegalLastName] = useState("");
  const [pendingLegalNameUserId, setPendingLegalNameUserId] = useState<string | null>(null);
  const [legalNameError, setLegalNameError] = useState("");
  const staffRefreshInFlightRef = useRef<Promise<void> | null>(null);

  const canManageStaff = currentRole === "admin";
  const visibleStaffMembers = filterStaffMembersForDisplay(staffMembers, showArchived);
  const activeAdminCount = countActiveAdminMembers(staffMembers);
  const normalizedLegalNameDraft = normalizeLegalNameDraft({
    firstName: legalFirstName,
    lastName: legalLastName,
  });
  const legalNameCanSubmit = Boolean(
    normalizedLegalNameDraft.firstName && normalizedLegalNameDraft.lastName
  );
  const deletionIdentity = deleteTarget ? getDisplayedStaffIdentity(deleteTarget) : "";
  const normalizedDeletionConfirmation = normalizeStaffConfirmationInput(deletionConfirmationInput);
  const deletionCanSubmit = Boolean(
    deleteTarget
    && normalizedDeletionConfirmation
    && matchesStaffDeletionConfirmation(deleteTarget, deletionConfirmationInput)
  );

  const refreshRoster = useCallback(async (includeArchived: boolean) => {
    if (staffRefreshInFlightRef.current) {
      return staffRefreshInFlightRef.current;
    }

    setIsStaffRefreshPending(true);
    const request = refreshStaff(includeArchived)
      .then(() => undefined)
      .finally(() => {
        if (staffRefreshInFlightRef.current === request) {
          staffRefreshInFlightRef.current = null;
          setIsStaffRefreshPending(false);
        }
      });
    staffRefreshInFlightRef.current = request;
    return request;
  }, [refreshStaff]);

  useEffect(() => {
    if (!canManageStaff || staffLoaded) return;
    void refreshRoster(false).catch(() => {
      // Store-owned error state is rendered below.
    });
  }, [canManageStaff, refreshRoster, staffLoaded]);

  async function handleRefresh() {
    setMessage("");
    setActionError("");
    setShowArchived(false);
    try {
      await refreshRoster(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Staff could not be loaded.");
    }
  }

  async function handleArchivedToggle(event: React.ChangeEvent<HTMLInputElement>) {
    if (isStaffRefreshPending) return;

    const nextShowArchived = event.target.checked;
    const previousShowArchived = showArchived;
    setMessage("");
    setActionError("");
    setShowArchived(nextShowArchived);
    try {
      await refreshRoster(nextShowArchived);
    } catch (error) {
      setShowArchived(previousShowArchived);
      setActionError(error instanceof Error ? error.message : "Staff could not be loaded.");
    }
  }

  async function handleInvite(event: React.FormEvent) {
    event.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
    const fullName = normalizeLegalName(inviteFullName);
    const normalizedInviteLegalName = normalizeLegalNameDraft({
      firstName: inviteLegalFirstName,
      lastName: inviteLegalLastName,
    });
    setMessage("");
    setActionError("");

    if (!email) {
      setActionError("Email is required.");
      return;
    }
    if (!isValidEmail(email)) {
      setActionError("Enter a valid email.");
      return;
    }
    if (!fullName) {
      setActionError("Display name is required.");
      return;
    }
    if (!normalizedInviteLegalName.firstName) {
      setActionError("Legal first name is required.");
      return;
    }
    if (!normalizedInviteLegalName.lastName) {
      setActionError("Legal last name is required.");
      return;
    }

    setInviteInFlight(true);
    try {
      await inviteStaff({
        email,
        role: inviteRole,
        full_name: fullName,
        legal_first_name: normalizedInviteLegalName.firstName,
        legal_last_name: normalizedInviteLegalName.lastName,
      });
      setInviteEmail("");
      setInviteFullName("");
      setInviteLegalFirstName("");
      setInviteLegalLastName("");
      setMessage(
        isPreviewMode
          ? `Preview staff added for ${email}.`
          : `Invite sent to ${email}.`
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to send invite.");
    } finally {
      setInviteInFlight(false);
    }
  }

  async function handleRoleChange(member: StaffMember, role: StaffRoleName) {
    if (member.role === role) return;
    setMessage("");
    setActionError("");
    setPendingRoleId(member.id);
    try {
      await updateStaffRole(member.id, role);
      setMessage(`${member.email} is now ${ROLE_LABELS[role]}.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to update role.");
    } finally {
      setPendingRoleId(null);
    }
  }

  async function runRemove(member: StaffMember) {
    if (member.status !== "pending") return;
    setMessage("");
    setActionError("");
    setPendingRemoveId(member.id);
    try {
      await removeStaff(member.id);
      setMessage(`Invite revoked for ${getDisplayedStaffIdentity(member)}.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to remove staff member.");
    } finally {
      setPendingRemoveId(null);
      setRemoveTarget(null);
    }
  }

  function handleRemove(member: StaffMember) {
    if (member.status !== "pending") return;
    setRemoveTarget(member);
  }

  async function runArchive(member: StaffMember) {
    setMessage("");
    setActionError("");
    setPendingLifecycle({ id: member.id, action: "archive" });
    try {
      await archiveStaff(member.id);
      setMessage(
        `${getDisplayedStaffIdentity(member)} was archived. Studio access was revoked immediately; the staff row was preserved and can be restored.`
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to archive staff member.");
    } finally {
      setPendingLifecycle(null);
      setArchiveTarget(null);
    }
  }

  function handleArchive(member: StaffMember) {
    if (member.status !== "active") return;
    setMessage("");
    setActionError("");
    setArchiveTarget(member);
  }

  async function handleUnarchive(member: StaffMember) {
    if (member.status !== "archived") return;

    setMessage("");
    setActionError("");
    setPendingLifecycle({ id: member.id, action: "unarchive" });
    try {
      const unarchivedMember = await unarchiveStaff(member.id);
      setMessage(
        unarchivedMember.status === "active"
          ? `${getDisplayedStaffIdentity(member)} was unarchived and studio access is restored.`
          : `${getDisplayedStaffIdentity(member)} was unarchived but the membership remains pending.`
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to unarchive staff member.");
    } finally {
      setPendingLifecycle(null);
    }
  }

  function handleScheduleDeletion(member: StaffMember) {
    if (
      member.status !== "archived"
      || member.user_id === null
      || member.user_id === undefined
    ) return;

    setMessage("");
    setActionError("");
    setDeletionError("");
    setDeletionConfirmationInput("");
    setDeleteTarget(member);
  }

  function closeDeletionModal(force = false) {
    if (!force && pendingLifecycle?.action === "delete") return;
    setDeleteTarget(null);
    setDeletionConfirmationInput("");
    setDeletionError("");
  }

  async function runScheduleDeletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deleteTarget || pendingLifecycle?.action === "delete") return;

    if (!deletionCanSubmit) {
      setDeletionError(`Type ${deletionIdentity} exactly to confirm deletion.`);
      return;
    }

    setDeletionError("");
    setMessage("");
    setActionError("");
    setPendingLifecycle({ id: deleteTarget.id, action: "delete" });
    try {
      const response = await scheduleStaffDeletion(
        deleteTarget.id,
        deletionConfirmationInput
      );
      setMessage(
        `Permanent account/profile deletion for ${deletionIdentity} is scheduled for ${formatDateTime(response.scheduled_for)} through the existing 30-day lifecycle. It is not immediate: the archived membership/profile remains until the existing worker completes the scheduled deletion; frozen audit history remains retained.`
      );
      closeDeletionModal(true);
    } catch (error) {
      setDeletionError(
        error instanceof Error ? error.message : "Failed to schedule staff deletion."
      );
    } finally {
      setPendingLifecycle(null);
    }
  }

  function handleEditLegalName(member: StaffMember) {
    if (member.user_id === null || member.user_id === undefined) return;
    setMessage("");
    setLegalNameError("");
    setLegalNameTarget(member);
    setLegalFirstName(member.legal_first_name || "");
    setLegalLastName(member.legal_last_name || "");
  }

  function handleCancelLegalNameEdit() {
    if (pendingLegalNameUserId !== null) return;
    setLegalNameTarget(null);
    setLegalNameError("");
  }

  async function handleLegalNameSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingLegalNameUserId !== null) return;

    const target = legalNameTarget;
    if (!target || target.user_id === null || target.user_id === undefined) return;

    if (!legalNameCanSubmit) {
      setLegalNameError("Enter both legal first and last names.");
      return;
    }

    setMessage("");
    setActionError("");
    setLegalNameError("");
    setPendingLegalNameUserId(target.user_id);

    try {
      if (target.user_id === currentUserId) {
        await updateUserLegalName(
          normalizedLegalNameDraft.firstName,
          normalizedLegalNameDraft.lastName
        );
      } else {
        await updateStaffLegalName(
          target.user_id,
          normalizedLegalNameDraft.firstName,
          normalizedLegalNameDraft.lastName
        );
      }
      setLegalNameTarget(null);
      setMessage(`Legal name updated for ${target.email}.`);
    } catch (error) {
      setLegalNameError(error instanceof Error ? error.message : "Failed to update legal name.");
    } finally {
      setPendingLegalNameUserId(null);
    }
  }

  if (!canManageStaff) {
    return (
      <section className="bg-surface border border-border rounded-[6px] p-5">
        <div className="flex items-center gap-2 mb-3">
          <Users className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-medium text-text-primary">Staff & Roles</h3>
        </div>
        <div className="bg-surface-raised border border-border rounded-[6px] p-4">
          <p className="text-xs text-muted mb-2">Your role</p>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-text-primary truncate">{userEmail || "Signed-in staff member"}</p>
              <p className="text-xs text-muted">Admins manage staff invitations and roles.</p>
            </div>
            <Badge variant={currentRole ? roleBadgeVariant(currentRole) : "default"}>
              {currentRole ? ROLE_LABELS[currentRole] : "No role"}
            </Badge>
          </div>
        </div>
      </section>
    );
  }

  return (
    <>
    <section className="bg-surface border border-border rounded-[6px] p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-accent" />
            <h3 className="text-sm font-medium text-text-primary">Staff & Roles</h3>
            <Badge variant="default">{visibleStaffMembers.length}</Badge>
          </div>
          <p className="text-xs text-muted mt-1">
            Invite staff and manage their roles. {activeAdminCount} active {activeAdminCount === 1 ? "admin" : "admins"}.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <label className="flex min-h-11 items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => void handleArchivedToggle(event)}
              disabled={isStaffRefreshPending}
              aria-label="Show archived staff"
              className="accent-[var(--accent)] cursor-pointer disabled:cursor-not-allowed"
            />
            <span>Show archived</span>
            {isStaffRefreshPending ? <span className="text-muted">Loading...</span> : null}
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void handleRefresh()}
            disabled={isStaffRefreshPending}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      <form onSubmit={handleInvite} className="grid gap-3 md:grid-cols-2 md:items-end mb-4">
        <Input
          label="Email"
          type="email"
          value={inviteEmail}
          onChange={(event) => setInviteEmail(event.target.value)}
          placeholder="instructor@example.com"
          disabled={inviteInFlight}
          required
        />
        <Input
          label="Display name"
          value={inviteFullName}
          onChange={(event) => setInviteFullName(event.target.value)}
          placeholder="Their display name"
          disabled={inviteInFlight}
          required
        />
        <Input
          label="Legal first name"
          value={inviteLegalFirstName}
          onChange={(event) => setInviteLegalFirstName(event.target.value)}
          placeholder="Legal first name"
          autoComplete="given-name"
          disabled={inviteInFlight}
          required
        />
        <Input
          label="Legal last name"
          value={inviteLegalLastName}
          onChange={(event) => setInviteLegalLastName(event.target.value)}
          placeholder="Legal last name"
          autoComplete="family-name"
          disabled={inviteInFlight}
          required
        />
        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-text-secondary font-medium" htmlFor="staff-role">
            Role
          </label>
          <select
            id="staff-role"
            value={inviteRole}
            onChange={(event) => setInviteRole(event.target.value as StaffRoleName)}
            disabled={inviteInFlight}
            className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary disabled:opacity-50"
          >
            {ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="primary" size="md" isLoading={inviteInFlight}>
          <MailPlus className="w-3.5 h-3.5" />
          {inviteInFlight ? "Sending..." : "Send invite"}
        </Button>
      </form>

      {(message || actionError || (staffLoadError && dismissedStaffLoadError !== staffLoadError)) && (
        <div className="mb-4 space-y-2">
          {message && (
            <DismissibleNotice
              tone="success"
              onDismiss={() => setMessage("")}
              className="text-xs"
            >
              {message}
            </DismissibleNotice>
          )}
          {actionError && (
            <DismissibleNotice
              tone="danger"
              onDismiss={() => setActionError("")}
              className="text-xs"
            >
              {actionError}
            </DismissibleNotice>
          )}
          {staffLoadError && dismissedStaffLoadError !== staffLoadError && (
            <DismissibleNotice
              tone="danger"
              onDismiss={() => setDismissedStaffLoadError(staffLoadError)}
              className="text-xs"
            >
              {staffLoadError}
            </DismissibleNotice>
          )}
        </div>
      )}

      {!staffLoaded ? (
        <StaffSkeletonRows />
      ) : visibleStaffMembers.length === 0 ? (
        <div className="border border-border rounded-[6px] p-4 text-sm text-text-secondary">
          {staffMembers.length > 0 && !showArchived
            ? "No active staff members. Turn on Show archived to view preserved archived rows."
            : "No staff invited yet."}
        </div>
      ) : (
        <div className="divide-y divide-border border border-border rounded-[6px] overflow-hidden">
          <div className="hidden md:grid md:grid-cols-[minmax(0,1fr)_140px_100px_120px_180px] gap-3 px-3 py-2 text-[11px] uppercase tracking-normal text-muted bg-surface-raised">
            <span>Staff</span>
            <span>Role</span>
            <span>Status</span>
            <span>Date</span>
            <span>Action</span>
          </div>
          {visibleStaffMembers.map((member) => (
            <StaffRow
              key={member.id}
              member={member}
              currentUserId={currentUserId}
              canManageStaff={canManageStaff}
              staffProfilesAvailable={staffProfilesAvailable}
              isLastActiveAdmin={isLastActiveAdmin(staffMembers, member)}
              pendingRoleId={pendingRoleId}
              pendingRemoveId={pendingRemoveId}
              pendingLifecycle={pendingLifecycle}
              pendingLegalNameUserId={pendingLegalNameUserId}
              legalNameTargetUserId={legalNameTarget?.user_id ?? null}
              legalFirstName={legalFirstName}
              legalLastName={legalLastName}
              legalNameError={legalNameError}
              legalNameCanSubmit={legalNameCanSubmit}
              onRoleChange={handleRoleChange}
              onRemove={handleRemove}
              onArchive={handleArchive}
              onUnarchive={handleUnarchive}
              onScheduleDeletion={handleScheduleDeletion}
              onEditLegalName={handleEditLegalName}
              onLegalNameFirstChange={setLegalFirstName}
              onLegalNameLastChange={setLegalLastName}
              onLegalNameSave={handleLegalNameSave}
              onLegalNameCancel={handleCancelLegalNameEdit}
            />
          ))}
        </div>
      )}
    </section>
    {removeTarget ? (
      <ModalFrame
        role="alertdialog"
        ariaLabelledBy="staff-remove-title"
        ariaDescribedBy="staff-remove-description"
        onBackdropClick={() => setRemoveTarget(null)}
        panelClassName="w-[min(92vw,28rem)] rounded-[6px] border border-border bg-surface p-5 shadow-2xl shadow-black/25"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] bg-danger/10 text-danger">
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 id="staff-remove-title" className="text-sm font-semibold text-text-primary">
              Revoke staff invite?
            </h2>
            <p id="staff-remove-description" className="mt-2 text-sm leading-6 text-text-secondary">
              This revokes the pending invitation for {getDisplayedStaffIdentity(removeTarget)}. No staff account is deleted.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setRemoveTarget(null)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            isLoading={pendingRemoveId === removeTarget.id}
            onClick={() => void runRemove(removeTarget)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Revoke invite
          </Button>
        </div>
      </ModalFrame>
    ) : null}
    {archiveTarget ? (
      <ModalFrame
        role="alertdialog"
        ariaLabelledBy="staff-archive-title"
        ariaDescribedBy="staff-archive-description"
        onBackdropClick={() => {
          if (pendingLifecycle?.action !== "archive") {
            setArchiveTarget(null);
          }
        }}
        panelClassName="w-[min(92vw,30rem)] rounded-[6px] border border-border bg-surface p-5 shadow-2xl shadow-black/25"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] bg-warning/10 text-warning">
            <Archive className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 id="staff-archive-title" className="text-sm font-semibold text-text-primary">
              Archive staff access?
            </h2>
            <p id="staff-archive-description" className="mt-2 text-sm leading-6 text-text-secondary">
              Archive {getDisplayedStaffIdentity(archiveTarget)} to revoke studio access immediately. The staff row and its history are preserved so an admin can restore access later.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setArchiveTarget(null)}
            disabled={pendingLifecycle?.action === "archive"}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            isLoading={pendingLifecycle?.action === "archive"}
            onClick={() => void runArchive(archiveTarget)}
          >
            <Archive className="h-3.5 w-3.5" />
            {pendingLifecycle?.action === "archive" ? "Archiving..." : "Archive access"}
          </Button>
        </div>
      </ModalFrame>
    ) : null}
    {deleteTarget ? (
      <ModalFrame
        role="alertdialog"
        ariaLabelledBy="staff-delete-title"
        ariaDescribedBy="staff-delete-description"
        onBackdropClick={closeDeletionModal}
        panelClassName="w-[min(92vw,32rem)] rounded-[6px] border border-border bg-surface p-5 shadow-2xl shadow-black/25"
      >
        <form onSubmit={runScheduleDeletion}>
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] bg-danger/10 text-danger">
              <AlertTriangle className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 id="staff-delete-title" className="text-sm font-semibold text-text-primary">
                Schedule permanent deletion?
              </h2>
              <p id="staff-delete-description" className="mt-2 text-sm leading-6 text-text-secondary">
                This schedules permanent account/profile deletion for the archived staff account through the existing 30-day lifecycle. It is not immediate, and audit history is retained.
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-[6px] border border-warning/25 bg-warning/5 p-3">
            <p className="text-[11px] uppercase tracking-normal text-muted">Displayed identity</p>
            <p className="mt-1 break-words text-sm font-medium text-text-primary">{deletionIdentity}</p>
            <p className="mt-2 text-xs leading-5 text-text-secondary">
              Type this identity exactly to confirm. Whitespace at the edges and repeated whitespace are normalized; capitalization remains case-sensitive.
            </p>
          </div>

          <div className="mt-4">
            <Input
              label={`Type ${deletionIdentity} to confirm`}
              value={deletionConfirmationInput}
              onChange={(event) => {
                setDeletionConfirmationInput(event.target.value);
                setDeletionError("");
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={pendingLifecycle?.action === "delete"}
              error={deletionError}
            />
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => closeDeletionModal()}
              disabled={pendingLifecycle?.action === "delete"}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              size="sm"
              isLoading={pendingLifecycle?.action === "delete"}
              disabled={!deletionCanSubmit}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {pendingLifecycle?.action === "delete" ? "Scheduling..." : "Schedule deletion"}
            </Button>
          </div>
        </form>
      </ModalFrame>
    ) : null}
    </>
  );
}

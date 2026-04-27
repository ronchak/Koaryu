"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { Input } from "@/components/ui/input";
import { useConfigStore, useStudioStore } from "@/lib/store";
import type { StaffMember, StaffRoleName } from "@/types";
import { MailPlus, RefreshCw, Trash2, Users } from "lucide-react";

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
        <div key={index} className="grid grid-cols-[1fr_130px_110px_120px_90px] gap-3 p-3">
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

function StaffIdentity({ member, currentUserId }: { member: StaffMember; currentUserId: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <p className="text-sm font-medium text-text-primary truncate">
          {member.full_name || member.email}
        </p>
        {member.user_id === currentUserId && <Badge variant="accent">You</Badge>}
      </div>
      <p className="text-xs text-muted truncate">{member.email}</p>
    </div>
  );
}

interface StaffRowProps {
  member: StaffMember;
  currentUserId: string;
  canManageStaff: boolean;
  onlyAdminSelf: boolean;
  pendingRoleId: string | null;
  pendingRemoveId: string | null;
  onRoleChange: (member: StaffMember, role: StaffRoleName) => void;
  onRemove: (member: StaffMember) => void;
}

function StaffRow({
  member,
  currentUserId,
  canManageStaff,
  onlyAdminSelf,
  pendingRoleId,
  pendingRemoveId,
  onRoleChange,
  onRemove,
}: StaffRowProps) {
  const isRolePending = pendingRoleId === member.id;
  const isRemovePending = pendingRemoveId === member.id;
  const isCurrentUser = member.user_id === currentUserId;
  const disableProtectedAdmin = isCurrentUser && onlyAdminSelf;
  const actionLabel = member.status === "pending" ? "Revoke" : "Remove";

  return (
    <div className="grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_140px_100px_120px_90px] md:items-center">
      <StaffIdentity member={member} currentUserId={currentUserId} />

      <div>
        <p className="text-[11px] uppercase tracking-normal text-muted md:hidden mb-1">Role</p>
        {canManageStaff ? (
          <select
            value={member.role}
            disabled={isRolePending || disableProtectedAdmin}
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
          {member.status === "active" ? "Active" : "Pending"}
        </Badge>
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-normal text-muted md:hidden mb-1">
          {member.status === "pending" ? "Invited" : "Added"}
        </p>
        <p className="text-xs text-text-secondary">{formatDate(member.created_at)}</p>
      </div>

      {canManageStaff && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onRemove(member)}
          disabled={isRemovePending || disableProtectedAdmin}
          className="justify-start md:justify-center text-danger hover:text-danger"
          title={disableProtectedAdmin ? "At least one admin must remain." : actionLabel}
        >
          <Trash2 className="w-3.5 h-3.5" />
          {isRemovePending ? "Working..." : actionLabel}
        </Button>
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
    staffMembers,
    staffLoaded,
    staffLoadError,
    refreshStaff,
    inviteStaff,
    updateStaffRole,
    removeStaff,
  } = useStudioStore();

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<StaffRoleName>("instructor");
  const [inviteInFlight, setInviteInFlight] = useState(false);
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [dismissedStaffLoadError, setDismissedStaffLoadError] = useState("");

  const canManageStaff = currentRole === "admin";
  const adminCount = useMemo(
    () => staffMembers.filter((member) => member.role === "admin").length,
    [staffMembers]
  );

  useEffect(() => {
    if (!canManageStaff || staffLoaded) return;
    void refreshStaff().catch(() => {
      // Store-owned error state is rendered below.
    });
  }, [canManageStaff, refreshStaff, staffLoaded]);

  async function handleRefresh() {
    setMessage("");
    setActionError("");
    try {
      await refreshStaff();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Staff could not be loaded.");
    }
  }

  async function handleInvite(event: React.FormEvent) {
    event.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
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

    setInviteInFlight(true);
    try {
      await inviteStaff({ email, role: inviteRole });
      setInviteEmail("");
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

  async function handleRemove(member: StaffMember) {
    const confirmed = window.confirm(`${member.status === "pending" ? "Revoke invite for" : "Remove"} ${member.email}?`);
    if (!confirmed) return;

    setMessage("");
    setActionError("");
    setPendingRemoveId(member.id);
    try {
      await removeStaff(member.id);
      setMessage(
        member.status === "pending"
          ? `Invite revoked for ${member.email}.`
          : `${member.email} was removed from staff.`
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to remove staff member.");
    } finally {
      setPendingRemoveId(null);
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
    <section className="bg-surface border border-border rounded-[6px] p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-accent" />
            <h3 className="text-sm font-medium text-text-primary">Staff & Roles</h3>
            <Badge variant="default">{staffMembers.length}</Badge>
          </div>
          <p className="text-xs text-muted mt-1">Invite staff and manage their roles.</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={handleRefresh}>
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </Button>
      </div>

      <form onSubmit={handleInvite} className="grid gap-3 md:grid-cols-[minmax(0,1fr)_150px_auto] md:items-end mb-4">
        <Input
          label="Email"
          type="email"
          value={inviteEmail}
          onChange={(event) => setInviteEmail(event.target.value)}
          placeholder="instructor@example.com"
          disabled={inviteInFlight}
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
      ) : staffMembers.length === 0 ? (
        <div className="border border-border rounded-[6px] p-4 text-sm text-text-secondary">
          No staff invited yet.
        </div>
      ) : (
        <div className="divide-y divide-border border border-border rounded-[6px] overflow-hidden">
          <div className="hidden md:grid md:grid-cols-[minmax(0,1fr)_140px_100px_120px_90px] gap-3 px-3 py-2 text-[11px] uppercase tracking-normal text-muted bg-surface-raised">
            <span>Staff</span>
            <span>Role</span>
            <span>Status</span>
            <span>Added</span>
            <span>Action</span>
          </div>
          {staffMembers.map((member) => (
            <StaffRow
              key={member.id}
              member={member}
              currentUserId={currentUserId}
              canManageStaff={canManageStaff}
              onlyAdminSelf={member.user_id === currentUserId && member.role === "admin" && adminCount <= 1}
              pendingRoleId={pendingRoleId}
              pendingRemoveId={pendingRemoveId}
              onRoleChange={handleRoleChange}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}
    </section>
  );
}

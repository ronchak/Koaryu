"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CreditCard, ExternalLink, Lock, LogOut, Mail, ShieldCheck, Trash2, Users } from "lucide-react";
import {
  AccountInfoRow,
  AccountLinkTile,
  AccountNotice,
  AccountPageShell,
  AccountSection,
} from "@/components/account-page-shell";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import { useConfigStore } from "@/lib/store";
import { clearActiveStudioIdCookie, clearStudioStateCookie } from "@/lib/studio-state-cookie";
import { useStudioStore } from "@/lib/store";
import type { AccountDeletionRequest, Studio } from "@/types";

function roleLabel(role?: string | null) {
  if (role === "admin") return "Admin";
  if (role === "instructor") return "Instructor";
  if (role === "front_desk") return "Front desk";
  return "Member";
}

export default function AccountSettingsPage() {
  const { token } = useConfigStore();
  const { currentRole, currentUserId, refreshStaff, staffMembers, studioName, userEmail } = useStudioStore();
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [isSendingReset, setIsSendingReset] = useState(false);
  const [isSigningOutEverywhere, setIsSigningOutEverywhere] = useState(false);
  const [isSchedulingDeletion, setIsSchedulingDeletion] = useState(false);
  const [isCancelingDeletion, setIsCancelingDeletion] = useState(false);
  const [isTransferringOwnership, setIsTransferringOwnership] = useState(false);
  const [deletionRequest, setDeletionRequest] = useState<AccountDeletionRequest | null>(null);
  const [nextOwnerId, setNextOwnerId] = useState("");
  const [accessMessage, setAccessMessage] = useState("");
  const [accessError, setAccessError] = useState("");
  const [ownershipMessage, setOwnershipMessage] = useState("");
  const [ownershipError, setOwnershipError] = useState("");
  const [deletionMessage, setDeletionMessage] = useState("");
  const [deletionError, setDeletionError] = useState("");
  const isAdmin = currentRole === "admin";

  useEffect(() => {
    if (!token) return;

    const controller = new AbortController();
    api
      .get<AccountDeletionRequest | null>("/account/deletion-request", token, { signal: controller.signal })
      .then(setDeletionRequest)
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setDeletionError(error instanceof Error ? error.message : "Could not load account deletion status.");
      });

    return () => {
      controller.abort();
    };
  }, [token]);

  useEffect(() => {
    if (!isAdmin) return;
    void refreshStaff().catch(() => undefined);
  }, [isAdmin, refreshStaff]);

  async function handlePasswordReset() {
    if (!userEmail) return;

    setIsSendingReset(true);
    setAccessMessage("");
    setAccessError("");

    try {
      const redirectTo = typeof window === "undefined"
        ? undefined
        : `${window.location.origin}/auth/callback?next=/reset-password`;
      const { error } = await supabase.auth.resetPasswordForEmail(userEmail, { redirectTo });
      if (error) {
        throw error;
      }
      setAccessMessage(`Password reset email sent to ${userEmail}.`);
    } catch (error) {
      setAccessError(error instanceof Error ? error.message : "Could not send a password reset email.");
    } finally {
      setIsSendingReset(false);
    }
  }

  async function handleSignOutEverywhere() {
    setIsSigningOutEverywhere(true);
    setAccessMessage("");
    setAccessError("");

    try {
      const { error } = await supabase.auth.signOut({ scope: "global" });
      if (error) {
        throw error;
      }
      clearStudioStateCookie();
      clearActiveStudioIdCookie();
      router.push("/login");
      router.refresh();
    } catch (error) {
      setAccessError(error instanceof Error ? error.message : "Could not sign out everywhere.");
      setIsSigningOutEverywhere(false);
    }
  }

  async function handleScheduleDeletion() {
    const confirmed = window.confirm("Are you sure this is a permanent decision?");
    if (!confirmed || !token) return;

    setIsSchedulingDeletion(true);
    setDeletionMessage("");
    setDeletionError("");

    try {
      const request = await api.post<AccountDeletionRequest>("/account/deletion-request", {}, token);
      setDeletionRequest(request);
      setDeletionMessage(`Your account has been scheduled for deletion within 30 days. You have until ${formatDeadline(request.scheduled_for)} to cancel deletion.`);
    } catch (error) {
      setDeletionError(error instanceof Error ? error.message : "Could not schedule account deletion.");
    } finally {
      setIsSchedulingDeletion(false);
    }
  }

  async function handleCancelDeletion() {
    if (!token) return;

    setIsCancelingDeletion(true);
    setDeletionMessage("");
    setDeletionError("");

    try {
      await api.post<AccountDeletionRequest | null>("/account/deletion-request/cancel", {}, token);
      setDeletionRequest(null);
      setDeletionMessage("Account deletion canceled.");
    } catch (error) {
      setDeletionError(error instanceof Error ? error.message : "Could not cancel account deletion.");
    } finally {
      setIsCancelingDeletion(false);
    }
  }

  async function handleTransferOwnership() {
    if (!token || !nextOwnerId) return;

    setIsTransferringOwnership(true);
    setOwnershipMessage("");
    setOwnershipError("");

    try {
      await api.patch<Studio>("/studios/current", { owner_id: nextOwnerId }, token);
      setOwnershipMessage("Studio ownership transferred.");
      setNextOwnerId("");
      await refreshStaff();
    } catch (error) {
      setOwnershipError(error instanceof Error ? error.message : "Could not transfer studio ownership.");
    } finally {
      setIsTransferringOwnership(false);
    }
  }

  const ownerCandidates = staffMembers.filter(
    (member) => member.user_id && member.user_id !== currentUserId && member.role === "admin" && member.status === "active"
  );

  return (
    <AccountPageShell
      title="Account settings"
      description="Review account-level security and move to the right studio administration tools."
    >
      <AccountSection title="Sign-in and access">
        <AccountInfoRow label="Login email" value={userEmail || "Not available"} />
        <AccountInfoRow label="Current studio" value={studioName || "Not selected"} />
        <AccountInfoRow
          label="Current role"
          value={roleLabel(currentRole)}
          detail="Role changes are managed by studio admins from staff settings."
        />
      </AccountSection>

      <div className="grid gap-4 md:grid-cols-2">
        <AccountLinkTile
          href="/account/profile"
          icon={Lock}
          title="Profile and identity"
          description="Update the name shown to your team and audit records."
        />
        <AccountLinkTile
          href="/settings"
          icon={Users}
          title="Studio settings"
          description="Manage programs, staff, demo reset, and studio data controls."
          badge={isAdmin ? "Admin" : "View"}
        />
        <AccountLinkTile
          href="/billing"
          icon={CreditCard}
          title="Billing workspace"
          description="Manage Koaryu Core, Connect readiness, plans, payers, and invoices."
        />
        <AccountLinkTile
          href="/privacy"
          icon={ShieldCheck}
          title="Privacy and data"
          description="Review Koaryu's privacy posture for studio and student records."
        />
      </div>

      <AccountSection title="Security notes">
        <AccountNotice>
          Koaryu uses Supabase Auth for authentication. Password reset emails and global sign-out are available here,
          while studio membership and role-based permissions are managed by Koaryu.
        </AccountNotice>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handlePasswordReset}
            isLoading={isSendingReset}
            disabled={!userEmail || isSigningOutEverywhere}
          >
            <Mail className="h-3.5 w-3.5" />
            {isSendingReset ? "Sending..." : "Send password reset"}
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={handleSignOutEverywhere}
            isLoading={isSigningOutEverywhere}
            disabled={isSendingReset}
          >
            <LogOut className="h-3.5 w-3.5" />
            {isSigningOutEverywhere ? "Signing out..." : "Sign out everywhere"}
          </Button>
          <Link
            href="/help/contact"
            className="inline-flex items-center gap-2 text-sm text-accent hover:text-accent-hover"
          >
            Contact support about access
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>
        {accessMessage && <p role="status" aria-live="polite" className="mt-3 text-xs text-success">{accessMessage}</p>}
        {accessError && <p role="alert" className="mt-3 text-xs text-danger">{accessError}</p>}
      </AccountSection>

      {isAdmin && (
        <AccountSection
          title="Studio ownership"
          description="Transfer ownership to another active admin before deleting an owner account."
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex flex-1 flex-col gap-1.5 text-sm">
              <span className="font-medium text-text-primary">New owner</span>
              <select
                value={nextOwnerId}
                onChange={(event) => setNextOwnerId(event.target.value)}
                className="px-3 py-2 text-sm"
              >
                <option value="">Select an active admin</option>
                {ownerCandidates.map((member) => (
                  <option key={member.id} value={member.user_id ?? ""}>
                    {member.full_name || member.email}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleTransferOwnership}
              isLoading={isTransferringOwnership}
              disabled={!nextOwnerId || isTransferringOwnership}
            >
              Transfer ownership
            </Button>
          </div>
          {ownerCandidates.length === 0 && (
            <p className="mt-3 text-xs text-muted">
              Add and confirm another admin in Studio Settings before transferring ownership.
            </p>
          )}
          {ownershipMessage && <p role="status" aria-live="polite" className="mt-3 text-xs text-success">{ownershipMessage}</p>}
          {ownershipError && <p role="alert" className="mt-3 text-xs text-danger">{ownershipError}</p>}
        </AccountSection>
      )}

      <AccountSection title="Account deletion" description="Request deletion for your Koaryu login account.">
        {deletionRequest ? (
          <div className="space-y-3">
            <AccountNotice>
              Your account has been scheduled for deletion within 30 days. You have until{" "}
              <span className="font-medium text-text-primary">{formatDeadline(deletionRequest.scheduled_for)}</span>{" "}
              to cancel deletion.
            </AccountNotice>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleCancelDeletion}
              isLoading={isCancelingDeletion}
              disabled={isSchedulingDeletion}
            >
              Cancel deletion request
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={handleScheduleDeletion}
              isLoading={isSchedulingDeletion}
              disabled={isCancelingDeletion}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {isSchedulingDeletion ? "Scheduling..." : "Delete account"}
            </Button>
          </div>
        )}
        {deletionMessage && <p role="status" aria-live="polite" className="mt-3 text-xs text-success">{deletionMessage}</p>}
        {deletionError && <p role="alert" className="mt-3 text-xs text-danger">{deletionError}</p>}
      </AccountSection>
    </AccountPageShell>
  );
}

function formatDeadline(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

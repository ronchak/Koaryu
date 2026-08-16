"use client";

import { useEffect, useRef, useState } from "react";
import { Save, UserCircle } from "lucide-react";
import { AccountSection } from "@/components/account-page-shell";
import { Button } from "@/components/ui/button";
import { resolveDashboardOwnerFirstName } from "@/lib/dashboard-brief-greetings";
import { useStudioStore } from "@/lib/store";

const SAVED_MESSAGE_MS = 2500;

/**
 * Per-account display-name editor. The value lives on the signed-in account
 * itself (Supabase `user_metadata.full_name`) and is used for cosmetic,
 * in-app display only.
 *
 * Shared by `/account/settings` and `/account/profile` so the two never drift.
 */
export function AccountNameSection({
  title = "Your name",
  description = "This display name belongs to your login, not to the studio. Each staff account sets its own.",
}: {
  title?: string;
  description?: string;
}) {
  const {
    legalFirstName,
    legalLastName,
    staffProfilesAvailable,
    updateUserName,
    userEmail,
    userName,
  } = useStudioStore();
  const [nameDraft, setNameDraft] = useState(userName);
  const [hasEditedName, setHasEditedName] = useState(false);
  // Until the field is touched it mirrors the stored name, so a save made
  // elsewhere (or a late auth bootstrap) shows up here without an effect.
  const nameValue = hasEditedName ? nameDraft : userName;
  const [isSaving, setIsSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");
  const [error, setError] = useState("");
  const savedTimeoutRef = useRef<number | null>(null);

  const normalizedNameDraft = nameValue.trim();
  const normalizedUserName = (userName || "").trim();
  const canSave = Boolean(normalizedNameDraft) && normalizedNameDraft !== normalizedUserName;
  const greetingName = resolveDashboardOwnerFirstName(normalizedNameDraft);

  useEffect(() => {
    return () => {
      if (savedTimeoutRef.current) {
        window.clearTimeout(savedTimeoutRef.current);
      }
    };
  }, []);

  async function handleSave() {
    setIsSaving(true);
    setError("");
    setSavedMessage("");

    try {
      await updateUserName(normalizedNameDraft);
      setHasEditedName(false);
      setSavedMessage("Display name updated.");

      if (savedTimeoutRef.current) {
        window.clearTimeout(savedTimeoutRef.current);
      }
      savedTimeoutRef.current = window.setTimeout(() => {
        setSavedMessage("");
        savedTimeoutRef.current = null;
      }, SAVED_MESSAGE_MS);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update your name.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <AccountSection title={title} description={description}>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/20 text-accent">
            <UserCircle className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text-primary">{userName || "Name not set"}</p>
            <p className="truncate text-xs text-muted">{userEmail || "Email unavailable"}</p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-text-primary">Display name</span>
            <input
              value={nameValue}
              onChange={(event) => {
                setHasEditedName(true);
                setNameDraft(event.target.value);
              }}
              placeholder="Your display name"
              className="px-3 py-2 text-sm"
            />
            <span className="text-xs text-muted">
              {greetingName
                ? `The dashboard will greet you as "${greetingName}".`
                : "For cosmetic, in-app display only."}
            </span>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-text-primary">Email</span>
            <input value={userEmail} disabled className="px-3 py-2 text-sm opacity-75" />
            <span className="text-xs text-muted">
              Managed by your sign-in provider.
            </span>
          </label>
        </div>

        {staffProfilesAvailable && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-text-primary">Legal first name</span>
              <input
                value={legalFirstName}
                readOnly
                aria-readonly="true"
                className="px-3 py-2 text-sm opacity-75"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-text-primary">Legal last name</span>
              <input
                value={legalLastName}
                readOnly
                aria-readonly="true"
                className="px-3 py-2 text-sm opacity-75"
              />
            </label>
            <p className="text-xs text-muted sm:col-span-2">
              Legal-name changes are managed by an admin in staff management.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            isLoading={isSaving}
            disabled={!canSave}
          >
            <Save className="h-3.5 w-3.5" />
            {isSaving ? "Saving..." : "Save display name"}
          </Button>
          {savedMessage && <span className="text-xs text-success">{savedMessage}</span>}
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>
      </div>
    </AccountSection>
  );
}

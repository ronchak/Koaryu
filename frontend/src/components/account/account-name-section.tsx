"use client";

import { useEffect, useRef, useState } from "react";
import { Save, UserCircle } from "lucide-react";
import { AccountSection } from "@/components/account-page-shell";
import { Button } from "@/components/ui/button";
import { resolveDashboardOwnerFirstName } from "@/lib/dashboard-brief-greetings";
import { useStudioStore } from "@/lib/store";

const SAVED_MESSAGE_MS = 2500;

/**
 * Per-account name editor. The name lives on the signed-in account itself
 * (Supabase `user_metadata.full_name`), so each staff login — instructors
 * included — carries its own name into the staff roster and audit records.
 *
 * Shared by `/account/settings` and `/account/profile` so the two never drift.
 */
export function AccountNameSection({
  title = "Your name",
  description = "This name belongs to your login, not to the studio. Each staff account sets its own.",
}: {
  title?: string;
  description?: string;
}) {
  const { updateUserName, userEmail, userName } = useStudioStore();
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
      setSavedMessage("Name updated.");

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
            <span className="font-medium text-text-primary">Full name</span>
            <input
              value={nameValue}
              onChange={(event) => {
                setHasEditedName(true);
                setNameDraft(event.target.value);
              }}
              placeholder="Your name"
              className="px-3 py-2 text-sm"
            />
            <span className="text-xs text-muted">
              {greetingName
                ? `The dashboard will greet you as "${greetingName}".`
                : "Shown on the staff roster, in exports, and in audit history."}
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

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            isLoading={isSaving}
            disabled={!canSave}
          >
            <Save className="h-3.5 w-3.5" />
            {isSaving ? "Saving..." : "Save name"}
          </Button>
          {savedMessage && <span className="text-xs text-success">{savedMessage}</span>}
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>
      </div>
    </AccountSection>
  );
}

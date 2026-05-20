"use client";

import { useEffect, useRef, useState } from "react";
import { Save, UserCircle } from "lucide-react";
import {
  AccountInfoRow,
  AccountNotice,
  AccountPageShell,
  AccountSection,
} from "@/components/account-page-shell";
import { Button } from "@/components/ui/button";
import { useStudioStore } from "@/lib/store";

export default function ProfilePage() {
  const { currentRole, studioName, updateUserName, userEmail, userName } = useStudioStore();
  const [nameDraft, setNameDraft] = useState(userName);
  const [hasEditedName, setHasEditedName] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");
  const [error, setError] = useState("");
  const savedTimeoutRef = useRef<number | null>(null);
  const normalizedNameDraft = nameDraft.trim();
  const normalizedUserName = (userName || "").trim();
  const canSaveProfile = Boolean(normalizedNameDraft) && normalizedNameDraft !== normalizedUserName;

  useEffect(() => {
    if (hasEditedName) return undefined;

    const timer = window.setTimeout(() => {
      setNameDraft(userName);
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [hasEditedName, userName]);

  useEffect(() => {
    return () => {
      if (savedTimeoutRef.current) {
        window.clearTimeout(savedTimeoutRef.current);
      }
    };
  }, []);

  async function handleSaveProfile() {
    const nextName = nameDraft.trim();
    setIsSaving(true);
    setError("");
    setSavedMessage("");

    try {
      await updateUserName(nextName);
      setHasEditedName(false);
      setSavedMessage("Profile updated.");

      if (savedTimeoutRef.current) {
        window.clearTimeout(savedTimeoutRef.current);
      }
      savedTimeoutRef.current = window.setTimeout(() => {
        setSavedMessage("");
        savedTimeoutRef.current = null;
      }, 2500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update profile.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <AccountPageShell
      title="Profile"
      description="Your personal Koaryu identity for staff records, exports, and audit history."
    >
      <AccountSection
        title="Personal details"
        description="Your email comes from Supabase Auth. Display name updates are saved to your account metadata."
      >
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/20 text-accent">
              <UserCircle className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text-primary">{userName || "Koaryu user"}</p>
              <p className="truncate text-xs text-muted">{userEmail || "Email unavailable"}</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-text-primary">Display name</span>
              <input
                value={nameDraft}
                onChange={(event) => {
                  setHasEditedName(true);
                  setNameDraft(event.target.value);
                }}
                placeholder="Your name"
                className="px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-text-primary">Email</span>
              <input value={userEmail} disabled className="px-3 py-2 text-sm opacity-75" />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              onClick={handleSaveProfile}
              isLoading={isSaving}
              disabled={!canSaveProfile}
            >
              <Save className="h-3.5 w-3.5" />
              {isSaving ? "Saving..." : "Save profile"}
            </Button>
            {savedMessage && <span className="text-xs text-success">{savedMessage}</span>}
            {error && <span className="text-xs text-danger">{error}</span>}
          </div>

          <AccountNotice>
            Email changes are intentionally handled through the authentication provider so login and verification stay
            consistent. Display name changes update your Koaryu staff identity immediately.
          </AccountNotice>
        </div>
      </AccountSection>

      <AccountSection title="Workspace context">
        <AccountInfoRow label="Studio" value={studioName || "Not selected"} />
        <AccountInfoRow label="Role" value={currentRole || "member"} />
      </AccountSection>
    </AccountPageShell>
  );
}

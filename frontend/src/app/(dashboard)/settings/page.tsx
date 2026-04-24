"use client";

import { useRef, useState } from "react";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { useConfigStore, useStudioStore } from "@/lib/store";
import { Save, Check, RotateCcw } from "lucide-react";

export default function SettingsPage() {
  const { isPreviewMode } = useConfigStore();
  const { studioName, setStudioName, resetDemoData } = useStudioStore();
  const [nameDraft, setNameDraft] = useState("");
  const [hasEditedName, setHasEditedName] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isResettingDemo, setIsResettingDemo] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [demoResetMessage, setDemoResetMessage] = useState("");
  const [demoResetError, setDemoResetError] = useState("");
  const savedTimeoutRef = useRef<number | null>(null);
  const demoResetTimeoutRef = useRef<number | null>(null);
  const name = hasEditedName ? nameDraft : studioName;

  async function handleSave() {
    const nextName = name.trim();

    if (!nextName) {
      setError("Studio name is required");
      return;
    }

    setIsSaving(true);
    setError("");
    setSaved(false);

    try {
      await setStudioName(nextName);
      setNameDraft(nextName);
      setHasEditedName(false);
      setSaved(true);

      if (savedTimeoutRef.current) {
        window.clearTimeout(savedTimeoutRef.current);
      }

      savedTimeoutRef.current = window.setTimeout(() => {
        setSaved(false);
        savedTimeoutRef.current = null;
      }, 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDemoReset() {
    setIsResettingDemo(true);
    setDemoResetError("");
    setDemoResetMessage("");

    try {
      const result = await resetDemoData();
      setNameDraft(result.studio_name);
      setHasEditedName(false);
      setDemoResetMessage(
        `Demo reset: ${result.counts.students} students, ${result.counts.leads} leads, ${result.counts.class_sessions} classes.`
      );

      if (demoResetTimeoutRef.current) {
        window.clearTimeout(demoResetTimeoutRef.current);
      }

      demoResetTimeoutRef.current = window.setTimeout(() => {
        setDemoResetMessage("");
        demoResetTimeoutRef.current = null;
      }, 3500);
    } catch (err: unknown) {
      setDemoResetError(err instanceof Error ? err.message : "Failed to reset demo data");
    } finally {
      setIsResettingDemo(false);
    }
  }

  return (
    <>
      <Header title="Settings" description="Studio configuration and preferences." />
      <div className="flex-1 p-8">
        <div className="max-w-xl space-y-6">
          {/* Studio info */}
          <section className="bg-surface border border-border rounded-[6px] p-5">
            <h3 className="text-sm font-medium text-text-primary mb-4">Studio Information</h3>
            <div className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-text-secondary font-medium">Studio Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setHasEditedName(true);
                    setNameDraft(e.target.value);
                  }}
                  placeholder="My Studio"
                  className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </div>
              <div className="flex items-center gap-2">
                <Button variant="primary" size="sm" onClick={handleSave} isLoading={isSaving}>
                  {saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                  {saved ? "Saved" : isSaving ? "Saving..." : "Save"}
                </Button>
                {saved && <span className="text-xs text-success">Settings updated</span>}
                {error && <span className="text-xs text-danger">{error}</span>}
              </div>
            </div>
          </section>

          {/* Staff section */}
          <section className="bg-surface border border-border rounded-[6px] p-5">
            <h3 className="text-sm font-medium text-text-primary mb-1">Staff & Roles</h3>
            <p className="text-xs text-muted">
              Invite instructors and front-desk staff with role-based permissions. Available after connecting Supabase.
            </p>
          </section>

          {/* Data section */}
          <section className="bg-surface border border-border rounded-[6px] p-5">
            <h3 className="text-sm font-medium text-text-primary mb-1">Demo Data</h3>
            <p className="text-xs text-muted mb-3">
              {isPreviewMode
                ? "Restore the browser preview dataset to a polished demo state."
                : "Restore the current studio to the polished demo dataset."}
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant="danger"
                size="sm"
                onClick={handleDemoReset}
                isLoading={isResettingDemo}
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {isResettingDemo ? "Resetting..." : "Reset demo studio"}
              </Button>
              {demoResetMessage && <span className="text-xs text-success">{demoResetMessage}</span>}
              {demoResetError && <span className="text-xs text-danger">{demoResetError}</span>}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

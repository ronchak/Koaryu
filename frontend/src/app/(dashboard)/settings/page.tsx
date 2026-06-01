"use client";

import { useEffect, useRef, useState } from "react";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { ProgramsSection } from "@/components/settings/programs-section";
import { StaffRolesSection } from "@/components/settings/staff-roles-section";
import { api } from "@/lib/api";
import { useConfigStore, useStudioStore } from "@/lib/store";
import { AlertTriangle, Save, Check, RotateCcw, Trash2 } from "lucide-react";

export default function SettingsPage() {
  const { isPreviewMode, token } = useConfigStore();
  const { currentRole, studioName, setStudioName, resetDemoData, clearStudioData } = useStudioStore();
  const [nameDraft, setNameDraft] = useState("");
  const [hasEditedName, setHasEditedName] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isResettingDemo, setIsResettingDemo] = useState(false);
  const [isClearingData, setIsClearingData] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [demoResetMessage, setDemoResetMessage] = useState("");
  const [demoResetError, setDemoResetError] = useState("");
  const [demoToolsEnabled, setDemoToolsEnabled] = useState(false);
  const [clearDataMessage, setClearDataMessage] = useState("");
  const [clearDataError, setClearDataError] = useState("");
  const savedTimeoutRef = useRef<number | null>(null);
  const demoResetTimeoutRef = useRef<number | null>(null);
  const clearDataTimeoutRef = useRef<number | null>(null);
  const name = hasEditedName ? nameDraft : studioName;
  const canManageStudioData = currentRole === "admin" && (isPreviewMode || demoToolsEnabled);

  useEffect(() => {
    if (isPreviewMode) {
      return;
    }

    if (!token) {
      return;
    }

    let canceled = false;
    void api
      .get<{ enabled: boolean }>("/demo/capabilities", token)
      .then((result) => {
        if (!canceled) {
          setDemoToolsEnabled(Boolean(result.enabled));
        }
      })
      .catch(() => {
        if (!canceled) {
          setDemoToolsEnabled(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [isPreviewMode, token]);

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
    const confirmed = window.confirm(
      "This will replace the current studio data with demo students, leads, belts, classes, and billing examples. Continue?"
    );
    if (!confirmed) return;

    setIsResettingDemo(true);
    setDemoResetError("");
    setDemoResetMessage("");
    setClearDataError("");
    setClearDataMessage("");

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

  async function handleClearData() {
    const confirmed = window.confirm("Are you sure this is going to delete everything?");
    if (!confirmed) return;

    setIsClearingData(true);
    setClearDataError("");
    setClearDataMessage("");
    setDemoResetError("");
    setDemoResetMessage("");

    try {
      const result = await clearStudioData();
      setNameDraft(result.studio_name);
      setHasEditedName(false);
      setClearDataMessage(
        `Cleared: ${result.counts.students} students, ${result.counts.leads} leads, ${result.counts.class_sessions} classes.`
      );

      if (clearDataTimeoutRef.current) {
        window.clearTimeout(clearDataTimeoutRef.current);
      }

      clearDataTimeoutRef.current = window.setTimeout(() => {
        setClearDataMessage("");
        clearDataTimeoutRef.current = null;
      }, 3500);
    } catch (err: unknown) {
      setClearDataError(err instanceof Error ? err.message : "Failed to clear studio data");
    } finally {
      setIsClearingData(false);
    }
  }

  return (
    <>
      <Header title="Settings" description="Studio configuration and preferences." />
      <div className="flex-1 p-8">
        <div className="max-w-3xl space-y-6">
          {/* Studio info */}
          <section className="bg-surface border border-border rounded-[6px] p-5">
            <h3 className="text-sm font-medium text-text-primary mb-4">Studio Information</h3>
            <div className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="settings-studio-name" className="text-xs text-text-secondary font-medium">Studio Name</label>
                <input
                  id="settings-studio-name"
                  name="studio_name"
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

          <ProgramsSection />

          <StaffRolesSection />

          {/* Data section */}
          {canManageStudioData ? (
          <section className="rounded-[6px] border border-danger/25 bg-danger/5 p-5">
            <h3 className="text-sm font-medium text-text-primary mb-1">Studio Data</h3>
            <p className="text-xs text-text-secondary mb-4">
              Replace or clear this studio&apos;s working records when preparing a demo or resetting a workspace.
            </p>
            <div className="space-y-4">
              <div>
                <div className="mb-4 flex items-start gap-3">
                  <AlertTriangle className="w-4 h-4 text-danger mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-danger">Danger zone</p>
                    <p className="text-xs text-text-secondary mt-1">
                      These actions replace or permanently remove working studio records. Use them only when you mean
                      to reset this workspace.
                    </p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-4 flex-wrap border-t border-danger/15 pt-4">
                    <div>
                      <p className="text-sm font-medium text-text-primary">Load demo studio</p>
                      <p className="text-xs text-text-secondary">
                        {isPreviewMode
                          ? "Restore the browser preview dataset to a polished demo state."
                          : "Replace this studio with demo students, leads, belts, classes, and billing examples."}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleDemoReset}
                      isLoading={isResettingDemo}
                      disabled={!canManageStudioData || isClearingData}
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      {isResettingDemo ? "Loading..." : "Load demo studio"}
                    </Button>
                  </div>
                  {demoResetMessage && <p role="status" aria-live="polite" className="text-xs text-success">{demoResetMessage}</p>}
                  {demoResetError && <p role="alert" className="text-xs text-danger">{demoResetError}</p>}

                  <div className="flex items-start justify-between gap-4 flex-wrap border-t border-danger/15 pt-4">
                    <div>
                      <p className="text-sm font-medium text-text-primary">Clear studio data</p>
                      <p className="text-xs text-text-secondary">
                        Permanently deletes students, leads, programs, belts, schedule, attendance, and studio billing
                        records. This cannot be undone.
                      </p>
                    </div>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={handleClearData}
                      isLoading={isClearingData}
                      disabled={!canManageStudioData || isResettingDemo}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      {isClearingData ? "Clearing..." : "Clear studio data"}
                    </Button>
                  </div>
                  {clearDataMessage && <p role="status" aria-live="polite" className="text-xs text-success">{clearDataMessage}</p>}
                  {clearDataError && <p role="alert" className="text-xs text-danger">{clearDataError}</p>}
                </div>

              </div>
            </div>
          </section>
          ) : null}
        </div>
      </div>
    </>
  );
}

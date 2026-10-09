"use client";
import { useResumeRefresh } from "@/lib/use-resume-refresh";

import { useEffect, useRef, useState } from "react";
import { markDashboardReadiness } from "@/lib/performance";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { ModalFrame } from "@/components/ui/modal-frame";
import { OperationsIndex, OperationsSurface } from "@/components/operations/operations-surface";
import { ProgramsSection } from "@/components/settings/programs-section";
import { StaffRolesSection } from "@/components/settings/staff-roles-section";
import type { StudioDataClearResponse } from "@/lib/studio-store-model";
import type { ApiAutomationClearEffects } from "@/types/generated/api-contracts";
import { api } from "@/lib/api";
import { useConfigStore, useStudioStore, useProgramStore } from "@/lib/store";
import { AlertTriangle, Save, Check, RotateCcw, Trash2 } from "lucide-react";
import { canAccessSettings } from "./access-policy";

type StudioDataConfirmAction = "demo-reset" | "clear-data" | null;

export default function SettingsPage() {
  const { currentUserId, currentStudioId, currentRole, identityGeneration, identityReady, staffLoaded, staffLoadError, refreshStaff } = useStudioStore();
  const { programsLoaded, programsUsageLoaded, programsLoadError, programsUsageLoadError, refreshPrograms } = useProgramStore();
  useResumeRefresh(() => currentRole === "admin" ? Promise.allSettled([refreshStaff(), refreshPrograms({ includeArchived: true })]) : undefined);
  const completeReady = identityReady && (!canAccessSettings(currentRole)
    || (staffLoaded && !staffLoadError && programsLoaded && programsUsageLoaded && !programsLoadError && !programsUsageLoadError));
  useEffect(() => markDashboardReadiness("settings", identityGeneration, {
    useful: identityReady, complete: completeReady,
  }), [identityGeneration, identityReady, completeReady]);

  return (
    <OperationsSurface page="settings">
      <Header title="Settings" />
      {canAccessSettings(currentRole) ? <AdminSettingsContent key={JSON.stringify([currentUserId, currentStudioId, currentRole, identityGeneration])} /> : <SettingsAccessNotice />}
    </OperationsSurface>
  );
}

function SettingsAccessNotice() {
  return (
    <div className="flex-1 p-8">
      <div className="max-w-3xl">
        <section
          aria-labelledby="settings-access-title"
          className="rounded-[14px] bg-accent/10 p-4"
        >
          <h2 id="settings-access-title" className="text-sm font-medium text-text-primary">
            Admin access required
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-text-secondary">
            Only studio admins can view and manage studio settings. Ask a studio admin if you need access.
          </p>
        </section>
      </div>
    </div>
  );
}

function AdminSettingsContent() {
  const { isPreviewMode, token } = useConfigStore();
  const { currentRole, studioName, setStudioName, resetDemoData, clearStudioData } = useStudioStore();
  const [nameDraft, setNameDraft] = useState("");
  const [hasEditedName, setHasEditedName] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const [isResettingDemo, setIsResettingDemo] = useState(false);
  const [isClearingData, setIsClearingData] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [demoResetError, setDemoResetError] = useState("");
  const [demoCapability, setDemoCapability] = useState<{ token: string; enabled: boolean } | null>(null);
  const [dataResult, setDataResult] = useState<{ action: Exclude<StudioDataConfirmAction, null>; response: StudioDataClearResponse } | null>(null);
  const dataActionRef = useRef(false);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const [clearDataError, setClearDataError] = useState("");
  const [confirmAction, setConfirmAction] = useState<StudioDataConfirmAction>(null);
  const savedTimeoutRef = useRef<number | null>(null);
  const name = hasEditedName ? nameDraft : studioName;
  const canManageStudioData = currentRole === "admin" && (isPreviewMode || (demoCapability?.token === token && demoCapability?.enabled === true));
  const confirmDialog = confirmAction === "demo-reset"
    ? {
        title: "Load demo studio?",
        description: isPreviewMode
          ? "This replaces the browser preview dataset with the polished demo state."
          : "This replaces the current studio data with demo students, leads, belts, classes, and billing examples.",
        actionText: "Load demo studio",
        variant: "secondary" as const,
        icon: <RotateCcw className="h-3.5 w-3.5" />,
      }
    : confirmAction === "clear-data"
      ? {
          title: "Clear studio data?",
          description:
            "This permanently deletes students, leads, programs, belts, schedule, attendance, and billing records for this studio. This cannot be undone.",
          actionText: "Clear studio data",
          variant: "danger" as const,
          icon: <Trash2 className="h-3.5 w-3.5" />,
        }
      : null;

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
          setDemoCapability({ token, enabled: result.enabled === true });
        }
      })
      .catch(() => {
        if (!canceled) {
          setDemoCapability({ token, enabled: false });
        }
      });

    return () => {
      canceled = true;
    };
  }, [isPreviewMode, token]);

  async function handleSave() {
    if (savingRef.current) return;
    const nextName = name.trim();

    if (!nextName) {
      setError("Studio name is required");
      return;
    }

    savingRef.current = true;
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
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  function requestStudioDataAction(action: Exclude<StudioDataConfirmAction, null>) {
    if (!canManageStudioData || dataActionRef.current) return;
    setConfirmAction(action);
  }

  async function handleConfirmStudioDataAction() {
    const action = confirmAction;
    if (!action || !canManageStudioData || dataActionRef.current) return;
    dataActionRef.current = true;
    setDataResult(null);
    setConfirmAction(null);
    setIsResettingDemo(action === "demo-reset");
    setIsClearingData(action === "clear-data");
    setDemoResetError("");
    setClearDataError("");
    try {
      const response = await (action === "demo-reset" ? resetDemoData() : clearStudioData());
      if (!mountedRef.current) return;
      setNameDraft(response.studio_name);
      setHasEditedName(false);
      setDataResult({ action, response });
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : "Could not confirm the studio data action. Check the studio before trying again.";
      if (action === "demo-reset") setDemoResetError(message);
      else setClearDataError(message);
    } finally {
      if (mountedRef.current) {
        dataActionRef.current = false;
        setIsResettingDemo(false);
        setIsClearingData(false);
      }
    }
  }

  return (
    <>
      <OperationsIndex
        label="Settings section index"
        items={[
          { href: "#studio", label: "Studio", meta: "Admin-owned identity" },
          { href: "#programs", label: "Programs", meta: "Curriculum structure" },
          { href: "#staff-roles", label: "Staff & roles", meta: "Access ownership" },
          { href: "#data-controls", label: "Data controls", meta: "Restricted workspace actions" },
        ]}
      />
      <div className="flex-1 p-4 sm:p-8" data-settings-folio="admin-ownership">
        <div className="max-w-5xl space-y-8">
          {/* Studio info */}
          <section id="studio" className="scroll-mt-8 bg-surface p-4" data-settings-owner="studio-admin">
            <p className="mb-1 text-xs font-medium text-muted">Owned by studio admin · Workspace identity</p>
            <h2 className="mb-4 text-base font-semibold text-text-primary">Studio information</h2>
            <div className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="settings-studio-name" className="text-xs text-text-secondary font-medium">Studio Name</label>
                <input
                  id="settings-studio-name"
                  name="studio_name"
                  type="text"
                  value={name}
                  disabled={isSaving}
                  onChange={(e) => {
                    if (savingRef.current) return;
                    setHasEditedName(true);
                    setNameDraft(e.target.value);
                  }}
                  placeholder="My Studio"
                  className="w-full rounded-[10px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary placeholder:text-muted"
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

          <section id="programs" className="scroll-mt-8" data-settings-owner="program-admin">
            <p className="px-4 pt-4 text-xs font-medium text-muted">Owned by studio admin · Curriculum structure</p>
            <ProgramsSection />
          </section>

          <section id="staff-roles" className="scroll-mt-8" data-settings-owner="access-admin">
            <p className="px-4 pt-4 text-xs font-medium text-muted">Owned by studio admin · Staff access</p>
            <StaffRolesSection />
          </section>

          {/* Data section */}
          {canManageStudioData ? (
          <section id="data-controls" className="scroll-mt-8 bg-danger/5 p-4" data-settings-owner="restricted-admin">
            <p className="mb-1 text-xs font-medium text-danger">Restricted admin ownership · Destructive workspace actions</p>
            <h2 className="mb-1 text-base font-semibold text-text-primary">Studio data</h2>
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
                    <p className="mt-2 text-xs text-text-secondary">{automationConsequences}</p>
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
                      onClick={() => requestStudioDataAction("demo-reset")}
                      isLoading={isResettingDemo}
                      disabled={!canManageStudioData || isClearingData}
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      {isResettingDemo ? "Loading..." : "Load demo studio"}
                    </Button>
                  </div>
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
                      onClick={() => requestStudioDataAction("clear-data")}
                      isLoading={isClearingData}
                      disabled={!canManageStudioData || isResettingDemo}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      {isClearingData ? "Clearing..." : "Clear studio data"}
                    </Button>
                  </div>
                  {clearDataError && <p role="alert" className="text-xs text-danger">{clearDataError}</p>}
                </div>

              </div>
            </div>
          </section>
          ) : (
            <section id="data-controls" className="scroll-mt-8 bg-surface p-4" data-settings-owner="restricted-admin">
              <p className="mb-1 text-xs font-medium text-muted">Restricted admin ownership</p>
              <h2 className="text-base font-semibold text-text-primary">Data controls</h2>
              <p className="mt-2 text-sm text-text-secondary">
                Reset and clear actions are unavailable unless this workspace is explicitly allowlisted for demo tooling.
              </p>
            </section>
          )}
        </div>
      </div>
      {dataResult && <StudioDataResult result={dataResult} preview={isPreviewMode} onDismiss={() => setDataResult(null)} />}
      {confirmDialog && canManageStudioData ? (
        <ModalFrame
          role="alertdialog"
          ariaLabelledBy="studio-data-confirm-title"
          ariaDescribedBy="studio-data-confirm-description"
          onBackdropClick={() => setConfirmAction(null)}
          panelClassName="w-[min(92vw,28rem)] rounded-[18px] bg-surface p-4"
        >
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-danger/10 text-danger">
              <AlertTriangle className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 id="studio-data-confirm-title" className="text-sm font-semibold text-text-primary">
                {confirmDialog.title}
              </h2>
              <p id="studio-data-confirm-description" className="mt-2 text-sm leading-6 text-text-secondary">
                {confirmDialog.description} {automationConsequences}
              </p>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmAction(null)}>
              Cancel
            </Button>
            <Button type="button" variant={confirmDialog.variant} size="sm" onClick={handleConfirmStudioDataAction}>
              {confirmDialog.icon}
              {confirmDialog.actionText}
            </Button>
          </div>
        </ModalFrame>
      ) : null}
    </>
  );
}

const automationConsequences = "Trial appointments and belt-test records are removed. Published workflows and the missed-class rule pause. Safe pending work is canceled; sending may finish. Saved automation definitions and original operation history, including saved details, are retained.";

const effectLabels: Record<keyof ApiAutomationClearEffects, string> = {
  workflows_paused: "Published workflows paused",
  workflow_runs_cancelled: "Workflow runs canceled",
  workflow_cancellation_intents_added: "Workflow cancellation requests added",
  attendance_deliveries_cancelled: "Missed-class deliveries canceled",
  belt_test_events_deleted: "Belt-test events removed",
  belt_test_recipients_deleted: "Belt-test recipients removed",
  sending_attempts_preserved: "Sending attempts retained; sending may finish",
  unknown_attempts_preserved: "Attempts with unknown outcomes retained",
  attendance_rule_paused: "Missed-class rule paused",
};

function StudioDataResult({ result, preview, onDismiss }: {
  result: { action: Exclude<StudioDataConfirmAction, null>; response: StudioDataClearResponse };
  preview: boolean;
  onDismiss: () => void;
}) {
  const { counts, automation } = result.response;
  return <section role="status" aria-label="Studio data result" className="mx-4 mb-8 max-w-5xl bg-surface p-4 sm:mx-8">
    <h2 className="text-sm font-semibold text-text-primary">{result.action === "demo-reset" ? "Demo studio loaded" : "Studio data cleared"}</h2>
    <p className="mt-2 text-sm text-text-secondary">
      {result.action === "demo-reset" ? "Seeded" : "Removed"}: {counts.students} students, {counts.leads} leads, {counts.belt_ranks} belt ranks, {counts.class_sessions} classes, {counts.attendance_records} attendance records.
    </p>
    {preview && <p className="mt-2 text-sm text-text-secondary">Preview automation effects are sample numbers.</p>}
    <dl className="my-3 grid gap-2 text-sm">
      {(Object.keys(effectLabels) as (keyof ApiAutomationClearEffects)[]).map((key) => <div key={key} className="flex justify-between gap-4">
        <dt className="min-w-0 text-text-secondary">{effectLabels[key]}</dt>
        <dd className="shrink-0 font-medium text-text-primary">{typeof automation[key] === "boolean" ? (automation[key] ? "Yes" : "No") : automation[key]}</dd>
      </div>)}
    </dl>
    <p className="mb-3 text-xs text-text-secondary">{automationConsequences}</p>
    <Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss result</Button>
  </section>;
}

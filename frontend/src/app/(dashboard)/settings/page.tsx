"use client";
import { useResumeRefresh } from "@/lib/use-resume-refresh";

import { useEffect, useRef, useState } from "react";
import { markDashboardReadiness } from "@/lib/performance";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { CalmState, HorizonPage, HorizonPanel, ToneChip } from "@/components/ui/horizon-parts";
import { ModalFrame } from "@/components/ui/modal-frame";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { ProgramsSection } from "@/components/settings/programs-section";
import { SettingsIndex } from "@/components/settings/settings-index";
import { StaffRolesSection } from "@/components/settings/staff-roles-section";
import styles from "@/components/settings/settings.module.css";
import type { StudioDataClearResponse } from "@/lib/studio-store-model";
import type { ApiAutomationClearEffects } from "@/types/generated/api-contracts";
import { api } from "@/lib/api";
import { useConfigStore, useStudioStore, useProgramStore } from "@/lib/store";
import { AlertTriangle, Save, Check, Lock, RotateCcw, Trash2 } from "lucide-react";
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
      <Header
        eyebrow="Studio"
        title="Settings"
        description="Your studio's name, programs and who has access. Only admins see this page."
      />
      {canAccessSettings(currentRole) ? <AdminSettingsContent key={JSON.stringify([currentUserId, currentStudioId, currentRole, identityGeneration])} /> : <SettingsAccessNotice />}
    </OperationsSurface>
  );
}

function SettingsAccessNotice() {
  return (
    <HorizonPage width="narrow">
      <HorizonPanel title="Admin access required" titleId="settings-access-title">
        <CalmState
          tone="neutral"
          icon={<Lock />}
          title="Only studio admins can view and manage studio settings."
          detail="Ask a studio admin if you need access."
        />
      </HorizonPanel>
    </HorizonPage>
  );
}

function AdminSettingsContent() {
  const { isPreviewMode, token } = useConfigStore();
  const { currentRole, studioName, setStudioName, resetDemoData, clearStudioData, staffMembers, staffLoaded } = useStudioStore();
  const { programs, programsLoaded } = useProgramStore();
  const activeProgramCount = (programs ?? []).filter((program) => !program.archived_at).length;
  const staffCount = (staffMembers ?? []).filter((member) => member.status !== "archived").length;
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
      <HorizonPage>
        <div className={styles.layout} data-settings-folio="admin-ownership">
          <SettingsIndex
            label="Settings section index"
            items={[
              { href: "#studio", label: "Studio", meta: studioName || "Name not set" },
              {
                href: "#programs",
                label: "Programs",
                meta: programsLoaded ? `${activeProgramCount} active` : "Curriculum structure",
              },
              {
                href: "#staff-roles",
                label: "Staff & roles",
                meta: staffLoaded
                  ? `${staffCount} ${staffCount === 1 ? "person" : "people"}`
                  : "Access ownership",
              },
              {
                href: "#data-controls",
                label: "Data controls",
                meta: canManageStudioData ? "Reset and clear" : "Locked",
                tone: canManageStudioData ? "alert" : "neutral",
              },
            ]}
          />
          <div className={styles.sections}>
            <div id="studio" data-settings-owner="studio-admin">
              <HorizonPanel
                title="Studio"
                titleId="settings-studio-title"
                description="The name your staff see across Koaryu."
              >
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleSave();
                  }}
                >
                  <div className={styles.fieldRow}>
                    <div>
                      <label htmlFor="settings-studio-name" className={styles.fieldLabel}>
                        Studio name
                      </label>
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
                    <Button type="submit" variant="primary" size="md" isLoading={isSaving}>
                      {saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                      {saved ? "Saved" : isSaving ? "Saving..." : "Save"}
                    </Button>
                  </div>
                  {saved || error ? (
                    <p className={styles.fieldStatus}>
                      {saved && <span className="text-success">Settings updated</span>}
                      {error && <span className="text-danger">{error}</span>}
                    </p>
                  ) : null}
                </form>
              </HorizonPanel>
            </div>

            <div id="programs" data-settings-owner="program-admin">
              <ProgramsSection />
            </div>

            <div id="staff-roles" data-settings-owner="access-admin">
              <StaffRolesSection />
            </div>

            {/* Data section */}
            {canManageStudioData ? (
              <div id="data-controls" data-settings-owner="restricted-admin">
                <p className={styles.dangerLead}>Danger zone</p>
                <HorizonPanel
                  className={styles.danger}
                  title="Studio data"
                  titleId="settings-data-title"
                  description="Replace or clear this studio's working records when preparing a demo or resetting a workspace."
                >
                  <div className={styles.dangerNote}>
                    <ToneChip tone="alert" size={32}>
                      <AlertTriangle />
                    </ToneChip>
                    <div>
                      <p>
                        <strong className="text-danger">
                          These actions replace or permanently remove working studio records.
                        </strong>{" "}
                        Use them only when you mean to reset this workspace.
                      </p>
                      <p>{automationConsequences}</p>
                    </div>
                  </div>

                  <div className={styles.dangerRows}>
                    <div className={styles.dangerRow}>
                      <div>
                        <strong>Load demo studio</strong>
                        <p>
                          {isPreviewMode
                            ? "Restore the browser preview dataset to a polished demo state."
                            : "Replace this studio with demo students, leads, belts, classes, and billing examples."}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="md"
                        onClick={() => requestStudioDataAction("demo-reset")}
                        isLoading={isResettingDemo}
                        disabled={!canManageStudioData || isClearingData}
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        {isResettingDemo ? "Loading..." : "Load demo studio"}
                      </Button>
                    </div>
                    {demoResetError && (
                      <p role="alert" className="text-sm text-danger">
                        {demoResetError}
                      </p>
                    )}

                    <div className={styles.dangerRow}>
                      <div>
                        <strong>Clear studio data</strong>
                        <p>
                          Permanently deletes students, leads, programs, belts, schedule, attendance,
                          and studio billing records. This cannot be undone.
                        </p>
                      </div>
                      <Button
                        variant="danger"
                        size="md"
                        onClick={() => requestStudioDataAction("clear-data")}
                        isLoading={isClearingData}
                        disabled={!canManageStudioData || isResettingDemo}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        {isClearingData ? "Clearing..." : "Clear studio data"}
                      </Button>
                    </div>
                    {clearDataError && (
                      <p role="alert" className="text-sm text-danger">
                        {clearDataError}
                      </p>
                    )}
                  </div>
                </HorizonPanel>
              </div>
            ) : (
              <div id="data-controls" data-settings-owner="restricted-admin">
                <HorizonPanel title="Data controls" titleId="settings-data-title">
                  <CalmState
                    tone="neutral"
                    icon={<Lock />}
                    title="Reset and clear are turned off"
                    detail="Reset and clear actions are unavailable unless this workspace is explicitly allowlisted for demo tooling."
                  />
                </HorizonPanel>
              </div>
            )}
            {dataResult && (
              <StudioDataResult
                result={dataResult}
                preview={isPreviewMode}
                onDismiss={() => setDataResult(null)}
              />
            )}
          </div>
        </div>
      </HorizonPage>
      {confirmDialog && canManageStudioData ? (
        <ModalFrame
          role="alertdialog"
          ariaLabelledBy="studio-data-confirm-title"
          ariaDescribedBy="studio-data-confirm-description"
          onBackdropClick={() => setConfirmAction(null)}
          panelClassName="w-[min(92vw,30rem)] rounded-[18px] bg-surface p-5"
        >
          <div className="flex items-start gap-3">
            <ToneChip tone="alert" size={40}>
              <AlertTriangle />
            </ToneChip>
            <div className="min-w-0">
              <h2 id="studio-data-confirm-title" className="text-base font-bold text-text-primary">
                {confirmDialog.title}
              </h2>
              <p
                id="studio-data-confirm-description"
                className="mt-2 text-sm leading-6 text-text-secondary"
              >
                {confirmDialog.description} {automationConsequences}
              </p>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="md" onClick={() => setConfirmAction(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={confirmDialog.variant}
              size="md"
              onClick={handleConfirmStudioDataAction}
            >
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
  return (
    <section role="status" aria-label="Studio data result" className={styles.result}>
      <h2 className="text-base font-bold text-text-primary">
        {result.action === "demo-reset" ? "Demo studio loaded" : "Studio data cleared"}
      </h2>
      <p className="mt-2 text-sm text-text-secondary">
        {result.action === "demo-reset" ? "Seeded" : "Removed"}: {counts.students} students,{" "}
        {counts.leads} leads, {counts.belt_ranks} belt ranks, {counts.class_sessions} classes,{" "}
        {counts.attendance_records} attendance records.
      </p>
      {preview && (
        <p className="mt-2 text-sm text-text-secondary">
          Preview automation effects are sample numbers.
        </p>
      )}
      <dl>
        {(Object.keys(effectLabels) as (keyof ApiAutomationClearEffects)[]).map((key) => (
          <div key={key}>
            <dt className="min-w-0 text-text-secondary">{effectLabels[key]}</dt>
            <dd className="shrink-0 text-text-primary">
              {typeof automation[key] === "boolean"
                ? automation[key]
                  ? "Yes"
                  : "No"
                : automation[key]}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mb-3 text-sm text-text-secondary">{automationConsequences}</p>
      <Button variant="secondary" size="sm" onClick={onDismiss}>
        Dismiss result
      </Button>
    </section>
  );
}

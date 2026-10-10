"use client";

import { useResumeRefresh } from "@/lib/use-resume-refresh";

import { useEffect, useRef, useState } from "react";
import { markDashboardReadiness } from "@/lib/performance";
import { LeadLedgerLoading } from "@/components/leads/lead-ledger-loading";
import { Header } from "@/components/header";
import { AddLeadModal } from "@/components/leads/add-lead-modal";
import { LeadDetailInspector } from "@/components/leads/lead-detail-modal";
import {
  LeadTrialAppointments,
  TrialAppointmentRecovery,
} from "@/components/leads/lead-trial-appointments";
import { LeadLedgerLoadError, LeadPipelineBoard } from "@/components/leads/lead-pipeline-board";
import { LostLeadsSection } from "@/components/leads/lost-leads-section";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { useLeadsPageController } from "@/lib/leads-page-controller";
import { useConfigStore, useLeadStore, useProgramStore, useStudioStore } from "@/lib/store";
import { UserPlus } from "lucide-react";
import styles from "@/components/leads/leads-ledger.module.css";

export default function LeadsPage() {
  const { currentRole, isPreviewMode, token, businessDate, studioTimezone } = useConfigStore();
  const { programs, programsLoaded, programsLoadError, programsUsageLoadError, refreshPrograms } =
    useProgramStore();
  const {
    staffMembers,
    staffLoaded,
    staffLoadError,
    refreshStaff,
    identityReady,
    identityGeneration,
  } = useStudioStore();
  const {
    leads: baseLeads,
    addLead,
    leadCreate,
    checkLeadCreateResult,
    updateLead,
    convertLeadToStudent,
    followUpLead,
    leadOperations,
    trialAppointments,
    leadsLoaded,
    leadsLoadError,
    refreshLeads,
  } = useLeadStore();
  const trialReady =
    identityReady &&
    (isPreviewMode || currentRole === "admin") &&
    trialAppointments.trialStorage.isCurrent();
  const [trialLifetime, setTrialLifetime] = useState(() => ({
    current: trialAppointments.trialStorage.isCurrent,
    generation: 0,
  }));
  const [programRead, setProgramRead] = useState<"idle" | "loading" | "unavailable">("idle");
  if (trialReady && !trialLifetime.current()) {
    setProgramRead("idle");
    setTrialLifetime({
      current: trialAppointments.trialStorage.isCurrent,
      generation: trialLifetime.generation + 1,
    });
  }
  const trialRecoveryLeadIds = new Set(
    [...trialAppointments.trialOperations.values()]
      .filter(
        (view) =>
          view.isCurrent() &&
          view.locked &&
          view.ownsLeadReservation &&
          !["submitting", "checking"].includes(view.status),
      )
      .map((view) => view.leadId),
  );
  const refreshTrialPrograms = async () => {
    const current = trialLifetime.current;
    if (!current()) return;
    setProgramRead("loading");
    try {
      await refreshPrograms({ includeArchived: true, force: true });
      if (current()) setProgramRead("idle");
    } catch {
      if (current()) setProgramRead("unavailable");
    }
  };
  // The existing staff endpoint is admin-only. Other roles must not wait on a
  // dataset they cannot read; admins need it for assignment names and selectors.
  const requiresStaff = currentRole === "admin";
  useEffect(() => {
    if (!identityReady || isPreviewMode || !requiresStaff || staffLoaded || staffLoadError) return;
    void refreshStaff().catch(() => undefined);
  }, [identityReady, isPreviewMode, requiresStaff, staffLoaded, staffLoadError, refreshStaff]);
  const usefulReady = identityReady && leadsLoaded && !leadsLoadError;
  const completeReady =
    usefulReady &&
    programsLoaded &&
    !programsLoadError &&
    !programsUsageLoadError &&
    (!requiresStaff || (staffLoaded && !staffLoadError));
  useEffect(
    () =>
      markDashboardReadiness("leads", identityGeneration, {
        useful: usefulReady,
        complete: completeReady,
      }),
    [identityGeneration, usefulReady, completeReady],
  );
  const today = businessDate;
  const controller = useLeadsPageController({
    addLead,
    leadCreate,
    checkLeadCreateResult,
    baseLeads,
    convertLeadToStudent,
    currentRole,
    followUpLead,
    identityGeneration,
    identityReady,
    isPreviewMode,
    leadOperations,
    trialRecoveryLeadIds,
    programs,
    today,
    token,
    updateLead,
  });
  useResumeRefresh(() => {
    controller.retrySelectedLeadActivities();
    return Promise.allSettled([
      refreshLeads(),
      refreshPrograms({ includeArchived: true }),
      ...(currentRole === "admin" ? [refreshStaff()] : []),
    ]);
  });
  const { activePrograms, enrolledCount, lostLeads, programById, selectedLead, totalActive } =
    controller.model;
  const observedTrials = useRef(new WeakSet<object>());
  useEffect(() => {
    if (!trialReady) return;
    for (const view of trialAppointments.trialOperations.values()) {
      if (
        !view.isCurrent() ||
        !["confirmed", "unavailable"].includes(view.status) ||
        observedTrials.current.has(view)
      )
        continue;
      observedTrials.current.add(view);
      if (selectedLead?.id === view.leadId) controller.retrySelectedLeadActivities();
    }
  }, [trialReady, trialAppointments, selectedLead?.id, controller]);
  const activeStaff = staffMembers.filter((member) => member.status === "active");
  const staffById = new Map(staffMembers.map((member) => [member.id, member]));
  const currentAssignedStaff = selectedLead?.assigned_staff_id
    ? (staffById.get(selectedLead.assigned_staff_id) ?? null)
    : null;

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${styles.pageRoot}`}>
      <Header
        title="Leads"
        description={
          leadsLoaded
            ? `${totalActive} active · ${enrolledCount} enrolled · ${lostLeads.length} lost`
            : leadsLoadError
              ? "Lead totals unavailable"
              : "Loading lead totals"
        }
      >
        <Button
          variant={controller.showLost ? "secondary" : "ghost"}
          size="sm"
          onClick={() => controller.setShowLost(!controller.showLost)}
        >
          {leadsLoaded ? `Lost (${lostLeads.length})` : "Lost"}
        </Button>
        {controller.canManageLeads ? (
          <Button variant="primary" size="sm" onClick={controller.openAddLeadModal}>
            <UserPlus className="w-3.5 h-3.5" />
            Add lead
          </Button>
        ) : null}
      </Header>

      {trialReady && (
        <TrialAppointmentRecovery
          facade={trialAppointments}
          leads={baseLeads}
          pendingLeadIds={controller.pendingLeadIds}
        />
      )}

      {!controller.showAddLead && controller.leadCreateMessage ? (
        <div role="status" className="px-4 pt-4 text-sm text-text-secondary sm:px-6 lg:px-8">
          <p>{controller.leadCreateMessage}</p>
          {controller.canCheckLeadCreate ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void controller.handleCheckLeadCreateResult()}
            >
              Check result
            </Button>
          ) : null}
        </div>
      ) : null}
      {requiresStaff && staffLoadError ? (
        <div role="alert" className="px-4 pt-4 sm:px-6 lg:px-8">
          <p className="text-sm text-danger">Staff assignments are unavailable. {staffLoadError}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refreshStaff().catch(() => undefined)}
          >
            Retry staff assignments
          </Button>
        </div>
      ) : requiresStaff && !staffLoaded ? (
        <p role="status" className="px-4 pt-4 text-sm text-muted sm:px-6 lg:px-8">
          Loading staff assignments...
        </p>
      ) : null}

      {controller.leadActionError && !selectedLead && (
        <div className="px-4 pt-4 sm:px-6 lg:px-8">
          <DismissibleNotice tone="danger" onDismiss={controller.dismissLeadActionError}>
            {controller.leadActionError}
          </DismissibleNotice>
        </div>
      )}

      {controller.actionMessage && !selectedLead && (
        <div className="px-4 pt-4 sm:px-6 lg:px-8">
          <DismissibleNotice tone="success" onDismiss={controller.dismissActionMessage}>
            {controller.actionMessage}
          </DismissibleNotice>
        </div>
      )}

      {leadsLoaded && leadsLoadError ? (
        <div role="alert" className="px-4 pt-4 sm:px-6 lg:px-8">
          <p className="text-sm text-danger">{leadsLoadError} Showing the last loaded leads.</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refreshLeads().catch(() => undefined)}
          >
            Retry lead roster
          </Button>
        </div>
      ) : null}

      <div className="flex-1 flex flex-col overflow-x-hidden">
        <div className={styles.leadWorkbench} data-inspector-open={Boolean(selectedLead)}>
          {leadsLoadError && !leadsLoaded ? (
            <LeadLedgerLoadError
              error={leadsLoadError}
              onRetry={() => void refreshLeads().catch(() => undefined)}
            />
          ) : !leadsLoaded ? (
            <LeadLedgerLoading canManageLeads={controller.canManageLeads} />
          ) : (
            <LeadPipelineBoard
              canConvertLeads={controller.canConvertLeads}
              canManageLeads={controller.canManageLeads}
              leads={controller.model.obligationLedgerLeads}
              pendingLeadIds={controller.pendingLeadIds}
              recoveringLeadIds={controller.recoveringLeadIds}
              programById={programById}
              selectedLeadId={selectedLead?.id ?? null}
              staffById={staffById}
              today={today}
              onAddLead={controller.openAddLeadModal}
              onKeyboardMoveLead={controller.handleKeyboardMoveLead}
              onSelectLead={controller.selectLead}
            />
          )}

          {selectedLead && (
            <LeadDetailInspector
              key={selectedLead.id}
              activities={controller.selectedLeadActivities}
              activityError={controller.selectedLeadActivityError}
              activityStatus={controller.selectedLeadActivityStatus}
              activeStaff={activeStaff}
              currentAssignedStaff={currentAssignedStaff}
              canConvertLeads={controller.canConvertLeads}
              canManageLeads={controller.canManageLeads}
              followUpValue={controller.getFollowUpInputValue(selectedLead)}
              lead={selectedLead}
              leadActionError={controller.leadActionError}
              leadActionMessage={controller.actionMessage}
              pendingLeadIds={controller.pendingLeadIds}
              followUpRecovery={controller.followUpRecoveries.get(selectedLead.id) ?? null}
              trialRecoveryPending={trialRecoveryLeadIds.has(selectedLead.id)}
              trialAppointments={
                trialReady ? (
                  <LeadTrialAppointments
                    key={`${identityGeneration}:${trialLifetime.generation}:${selectedLead.id}`}
                    lead={selectedLead}
                    facade={trialAppointments}
                    timezone={studioTimezone}
                    preview={isPreviewMode}
                    reserved={controller.pendingLeadIds.has(selectedLead.id)}
                    isCurrent={trialLifetime.current}
                    references={{
                      programs,
                      status:
                        programRead === "loading"
                          ? "loading"
                          : programsLoadError ||
                              programsUsageLoadError ||
                              programRead === "unavailable"
                            ? "unavailable"
                            : programsLoaded
                              ? "ready"
                              : "loading",
                      retry: () => void refreshTrialPrograms(),
                    }}
                  />
                ) : undefined
              }
              onRetryFollowUp={controller.handleRetryFollowUp}
              programById={programById}
              today={today}
              onAssignStaff={controller.handleAssignedStaff}
              onClose={controller.clearSelectedLead}
              onConvertLead={controller.handleConvertLead}
              onDismissError={controller.dismissLeadActionError}
              onDismissMessage={controller.dismissActionMessage}
              onFollowUpValueChange={controller.setFollowUpInputValue}
              onMarkContacted={controller.handleMarkContacted}
              onMarkLost={controller.handleMarkLost}
              onRetryActivities={controller.retrySelectedLeadActivities}
              onRescheduleLead={controller.handleRescheduleLead}
              onStageSelection={controller.handleStageSelection}
            />
          )}
        </div>

        {controller.showLost && (
          <LostLeadsSection
            lostLeads={lostLeads}
            onClose={() => controller.setShowLost(false)}
            onSelectLead={controller.selectLead}
          />
        )}
      </div>

      {controller.canManageLeads && controller.showAddLead && (
        <AddLeadModal
          activePrograms={activePrograms}
          activeStaff={activeStaff}
          addLeadError={controller.addLeadError}
          isAddingLead={controller.isAddingLead}
          createLocked={controller.addLeadLocked}
          createMessage={controller.leadCreateMessage}
          canCheckResult={controller.canCheckLeadCreate}
          isCheckingResult={controller.isCheckingLead}
          onCheckResult={controller.handleCheckLeadCreateResult}
          programById={programById}
          selectedProgramId={controller.addLeadProgramId}
          today={today}
          onClose={controller.closeAddLeadModal}
          onDismissError={controller.dismissAddLeadError}
          onProgramChange={controller.setAddLeadProgramId}
          onSubmit={controller.handleAddLead}
          onEdit={controller.handleAddLeadFormEdit}
        />
      )}
    </div>
  );
}

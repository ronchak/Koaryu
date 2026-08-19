"use client";

import { Header } from "@/components/header";
import { AddLeadModal } from "@/components/leads/add-lead-modal";
import { LeadDetailInspector } from "@/components/leads/lead-detail-modal";
import {
  LeadLedgerLoadError,
  LeadLedgerLoading,
  LeadPipelineBoard,
} from "@/components/leads/lead-pipeline-board";
import { LostLeadsSection } from "@/components/leads/lost-leads-section";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { useLeadsPageController } from "@/lib/leads-page-controller";
import { todayDateString } from "@/lib/leads-page-model";
import { useConfigStore, useLeadStore, useProgramStore, useStudioStore } from "@/lib/store";
import { UserPlus } from "lucide-react";
import styles from "@/components/leads/leads-ledger.module.css";

export default function LeadsPage() {
  const { currentRole, isPreviewMode, token } = useConfigStore();
  const { programs } = useProgramStore();
  const { staffMembers } = useStudioStore();
  const {
    leads: baseLeads,
    addLead,
    updateLead,
    convertLeadToStudent,
    leadsLoaded,
    leadsLoadError,
    refreshLeads,
  } = useLeadStore();
  const today = todayDateString();
  const controller = useLeadsPageController({
    addLead,
    baseLeads,
    convertLeadToStudent,
    currentRole,
    isPreviewMode,
    programs,
    today,
    token,
    updateLead,
  });
  const {
    activePrograms,
    enrolledCount,
    lostLeads,
    programById,
    selectedLead,
    totalActive,
  } = controller.model;
  const activeStaff = staffMembers.filter((member) => member.status === "active");
  const staffById = new Map(staffMembers.map((member) => [member.id, member]));
  const currentAssignedStaff = selectedLead?.assigned_staff_id
    ? staffById.get(selectedLead.assigned_staff_id) ?? null
    : null;

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${styles.pageRoot}`}>
      <Header
        title="Leads"
        description={`${totalActive} active · ${enrolledCount} enrolled · ${lostLeads.length} lost`}
      >
        <Button
          variant={controller.showLost ? "secondary" : "ghost"}
          size="sm"
          onClick={() => controller.setShowLost(!controller.showLost)}
        >
          Lost ({lostLeads.length})
        </Button>
        {controller.canManageLeads ? (
          <Button
            variant="primary"
            size="sm"
            onClick={controller.openAddLeadModal}
          >
            <UserPlus className="w-3.5 h-3.5" />
            Add lead
          </Button>
        ) : null}
      </Header>

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

      <div className="flex-1 flex flex-col overflow-x-hidden">
        <div className={styles.leadWorkbench} data-inspector-open={Boolean(selectedLead)}>
          {leadsLoadError ? (
            <LeadLedgerLoadError
              error={leadsLoadError}
              onRetry={() => void refreshLeads().catch(() => undefined)}
            />
          ) : !leadsLoaded ? (
            <LeadLedgerLoading />
          ) : (
            <LeadPipelineBoard
              canConvertLeads={controller.canConvertLeads}
              canManageLeads={controller.canManageLeads}
              leads={controller.model.obligationLedgerLeads}
              pendingLeadId={controller.pendingLeadId}
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
              pendingLeadId={controller.pendingLeadId}
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
          programById={programById}
          selectedProgramId={controller.addLeadProgramId}
          today={today}
          onClose={controller.closeAddLeadModal}
          onDismissError={controller.dismissAddLeadError}
          onProgramChange={controller.setAddLeadProgramId}
          onSubmit={controller.handleAddLead}
        />
      )}
    </div>
  );
}

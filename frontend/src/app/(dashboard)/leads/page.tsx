"use client";

import { Header } from "@/components/header";
import { AddLeadModal } from "@/components/leads/add-lead-modal";
import { FollowUpPanel } from "@/components/leads/follow-up-panel";
import { LeadDetailModal } from "@/components/leads/lead-detail-modal";
import { LeadPipelineBoard } from "@/components/leads/lead-pipeline-board";
import { LostLeadsSection } from "@/components/leads/lost-leads-section";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { useLeadsPageController } from "@/lib/leads-page-controller";
import { todayDateString } from "@/lib/leads-page-model";
import { useConfigStore, useLeadStore, useProgramStore } from "@/lib/store";
import { UserPlus } from "lucide-react";

export default function LeadsPage() {
  const { currentRole, isPreviewMode, token } = useConfigStore();
  const { programs } = useProgramStore();
  const {
    leads: baseLeads,
    addLead,
    updateLead,
    convertLeadToStudent,
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
    draggedLeadRecord,
    dueTodayCount,
    enrolledCount,
    followUpQueue,
    leadsByStage,
    lostLeads,
    overdueCount,
    programById,
    selectedLead,
    totalActive,
    upcomingFollowUps,
  } = controller.model;

  return (
    <>
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
        {controller.canManageLeads ? <FollowUpPanel
          dueTodayCount={dueTodayCount}
          followUpQueue={followUpQueue}
          overdueCount={overdueCount}
          pendingLeadId={controller.pendingLeadId}
          programById={programById}
          today={today}
          upcomingFollowUps={upcomingFollowUps}
          getFollowUpInputValue={controller.getFollowUpInputValue}
          onFollowUpInputChange={controller.setFollowUpInputValue}
          onMarkContacted={controller.handleMarkContacted}
          onRescheduleLead={controller.handleRescheduleLead}
          onSelectLead={controller.selectLead}
        /> : null}

        <LeadPipelineBoard
          canConvertLeads={controller.canConvertLeads}
          canManageLeads={controller.canManageLeads}
          draggedLeadId={controller.draggedLead}
          draggedLeadRecord={draggedLeadRecord}
          dropTargetStage={controller.dropTargetStage}
          leadsByStage={leadsByStage}
          pendingLeadId={controller.pendingLeadId}
          programById={programById}
          today={today}
          onAddLead={controller.openAddLeadModal}
          onCardDragEnd={controller.clearDragState}
          onCardDragStart={controller.handleCardDragStart}
          onDrop={controller.handleDrop}
          onKeyboardMoveLead={controller.handleKeyboardMoveLead}
          onSelectLead={controller.selectLead}
          onStageDragLeave={controller.handleStageDragLeave}
          onStageDragOver={controller.handleStageDragOver}
        />

        {controller.showLost && (
          <LostLeadsSection
            lostLeads={lostLeads}
            onClose={() => controller.setShowLost(false)}
            onSelectLead={controller.selectLead}
          />
        )}
      </div>

      {selectedLead && (
        <LeadDetailModal
          canConvertLeads={controller.canConvertLeads}
          canManageLeads={controller.canManageLeads}
          followUpValue={controller.getFollowUpInputValue(selectedLead)}
          lead={selectedLead}
          leadActionError={controller.leadActionError}
          pendingLeadId={controller.pendingLeadId}
          programById={programById}
          today={today}
          onClose={controller.clearSelectedLead}
          onConvertLead={controller.handleConvertLead}
          onDismissError={controller.dismissLeadActionError}
          onFollowUpValueChange={controller.setFollowUpInputValue}
          onMarkContacted={controller.handleMarkContacted}
          onMarkLost={controller.handleMarkLost}
          onRescheduleLead={controller.handleRescheduleLead}
          onStageSelection={controller.handleStageSelection}
        />
      )}

      {controller.canManageLeads && controller.showAddLead && (
        <AddLeadModal
          activePrograms={activePrograms}
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
    </>
  );
}

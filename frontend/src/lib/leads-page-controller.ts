"use client";

import { useMemo, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import {
  PIPELINE_STAGES,
  buildLeadUpdateSuccessMessage,
  buildLeadsPageModel,
  buildOptimisticLeadUpdate,
  fullName,
  getLeadFollowUpInputValue,
  getNextStage,
  getStageLabel,
  removeOptimisticLeadUpdate,
} from "@/lib/leads-page-model";
import type { Lead, LeadStage, Program } from "@/types";

type LeadStoreActions = {
  addLead: (data: Partial<Lead>) => Promise<void>;
  convertLeadToStudent: (leadId: string) => Promise<{ lead: Lead; studentId: string | null }>;
  updateLead: (id: string, data: Partial<Lead>) => Promise<void>;
};

type LeadsPageControllerOptions = LeadStoreActions & {
  baseLeads: Lead[];
  isPreviewMode: boolean;
  programs: Program[];
  today: string;
  token: string | null;
};

export function useLeadsPageController({
  addLead,
  baseLeads,
  convertLeadToStudent,
  isPreviewMode,
  programs,
  today,
  token,
  updateLead,
}: LeadsPageControllerOptions) {
  const router = useRouter();
  const [showAddLead, setShowAddLead] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [showLost, setShowLost] = useState(false);
  const [draggedLead, setDraggedLead] = useState<string | null>(null);
  const [dropTargetStage, setDropTargetStage] = useState<LeadStage | null>(null);
  const [isAddingLead, setIsAddingLead] = useState(false);
  const [addLeadError, setAddLeadError] = useState<string | null>(null);
  const [pendingLeadId, setPendingLeadId] = useState<string | null>(null);
  const [leadActionError, setLeadActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [followUpDrafts, setFollowUpDrafts] = useState<Record<string, string>>({});
  const [optimisticLeads, setOptimisticLeads] = useState<Record<string, Lead>>({});
  const [addLeadProgramId, setAddLeadProgramId] = useState<string | null>(null);

  const model = useMemo(
    () =>
      buildLeadsPageModel({
        baseLeads,
        draggedLeadId: draggedLead,
        optimisticLeads,
        programs,
        selectedLeadId,
        today,
      }),
    [baseLeads, draggedLead, optimisticLeads, programs, selectedLeadId, today]
  );

  function getFollowUpInputValue(lead: Lead) {
    return getLeadFollowUpInputValue(lead, followUpDrafts, today);
  }

  function setFollowUpInputValue(leadId: string, value: string) {
    setFollowUpDrafts((current) => ({ ...current, [leadId]: value }));
  }

  function clearSelectedLead() {
    if (!pendingLeadId) {
      setSelectedLeadId(null);
    }
  }

  function clearDragState() {
    setDraggedLead(null);
    setDropTargetStage(null);
  }

  function openAddLeadModal() {
    setAddLeadError(null);
    setAddLeadProgramId(null);
    setShowAddLead(true);
  }

  function closeAddLeadModal() {
    setShowAddLead(false);
    setAddLeadProgramId(null);
  }

  function selectLead(leadId: string) {
    setLeadActionError(null);
    setSelectedLeadId(leadId);
  }

  function beginOptimisticLeadUpdate(lead: Lead, updates: Partial<Lead>) {
    const optimisticLead = buildOptimisticLeadUpdate(lead, updates);

    setOptimisticLeads((current) => ({
      ...current,
      [lead.id]: optimisticLead,
    }));

    return () => {
      setOptimisticLeads((current) => removeOptimisticLeadUpdate(current, lead.id));
    };
  }

  function handleCardDragStart(event: DragEvent<HTMLDivElement>, leadId: string) {
    setDraggedLead(leadId);
    setDropTargetStage(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", leadId);
  }

  function handleStageDragOver(event: DragEvent<HTMLDivElement>, stage: LeadStage) {
    if (!model.draggedLeadRecord) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    if (dropTargetStage !== stage) {
      setDropTargetStage(stage);
    }
  }

  function handleStageDragLeave(event: DragEvent<HTMLDivElement>, stage: LeadStage) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }

    if (dropTargetStage === stage) {
      setDropTargetStage(null);
    }
  }

  async function handleConvertLead(lead: Lead) {
    setLeadActionError(null);
    setPendingLeadId(lead.id);
    const rollbackOptimisticLead = beginOptimisticLeadUpdate(lead, {
      stage: "enrolled",
      follow_up_date: null,
    });

    try {
      const { studentId } = await convertLeadToStudent(lead.id);
      setSelectedLeadId(null);

      if (studentId) {
        router.push(`/students/${studentId}`);
      }
    } catch (error) {
      console.error("Failed to convert lead", error);
      setLeadActionError(
        error instanceof Error
          ? error.message
          : "Could not convert this lead into a student."
      );
    } finally {
      rollbackOptimisticLead();
      setPendingLeadId(null);
      clearDragState();
    }
  }

  async function handleAddLead(data: Partial<Lead>) {
    setAddLeadError(null);
    setActionMessage(null);
    setIsAddingLead(true);

    try {
      await addLead(data);
      closeAddLeadModal();
      setActionMessage("Lead added to the pipeline.");
    } catch (error) {
      console.error("Failed to add lead", error);
      setAddLeadError("Could not add this lead. Please try again.");
    } finally {
      setIsAddingLead(false);
    }
  }

  async function handleLeadUpdate(
    lead: Lead,
    updates: Partial<Lead>,
    options?: { closeAfterSuccess?: boolean }
  ) {
    setLeadActionError(null);
    setActionMessage(null);
    setPendingLeadId(lead.id);
    const rollbackOptimisticLead = beginOptimisticLeadUpdate(lead, updates);

    try {
      await updateLead(lead.id, updates);
      setActionMessage(buildLeadUpdateSuccessMessage(lead, updates));
      if (options?.closeAfterSuccess) {
        setSelectedLeadId(null);
      }
    } catch (error) {
      console.error("Failed to update lead", error);
      setLeadActionError(
        error instanceof Error
          ? error.message
          : "Could not save lead changes. Please try again."
      );
    } finally {
      rollbackOptimisticLead();
      setPendingLeadId(null);
      clearDragState();
    }
  }

  async function handleStageSelection(lead: Lead, nextStage: LeadStage) {
    if (nextStage === "enrolled") {
      await handleConvertLead(lead);
      return;
    }

    await handleLeadUpdate(lead, {
      stage: nextStage,
      lost_reason: nextStage === "closed_lost" ? lead.lost_reason ?? "other" : lead.lost_reason,
    });
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>, stage: LeadStage) {
    event.preventDefault();

    const droppedLeadId = event.dataTransfer.getData("text/plain") || draggedLead;
    if (!droppedLeadId) {
      clearDragState();
      return;
    }

    const lead = model.leads.find((candidate) => candidate.id === droppedLeadId);
    if (!lead || lead.stage === stage) {
      clearDragState();
      return;
    }

    if (stage === "enrolled") {
      await handleConvertLead(lead);
      return;
    }

    await handleLeadUpdate(lead, { stage });
  }

  async function handleKeyboardMoveLead(lead: Lead, direction: -1 | 1) {
    const currentIndex = PIPELINE_STAGES.findIndex((stage) => stage.id === lead.stage);
    if (currentIndex === -1) {
      return;
    }

    const nextStage = PIPELINE_STAGES[currentIndex + direction]?.id;
    if (!nextStage || nextStage === lead.stage || pendingLeadId === lead.id) {
      return;
    }

    await handleStageSelection(lead, nextStage);
  }

  async function logFollowUpActivity(leadId: string, description: string) {
    if (isPreviewMode || !token) {
      return;
    }

    await api.post(
      `/leads/${leadId}/activities`,
      {
        activity_type: "follow_up",
        description,
      },
      token
    );
  }

  async function handleRescheduleLead(lead: Lead) {
    const nextDate = getFollowUpInputValue(lead);
    if (!nextDate) {
      setLeadActionError("Choose a follow-up date before rescheduling.");
      return;
    }

    await handleLeadUpdate(lead, { follow_up_date: nextDate });
  }

  async function handleMarkContacted(lead: Lead, advanceStage: boolean) {
    setLeadActionError(null);
    setActionMessage(null);
    setPendingLeadId(lead.id);
    const nextStage = advanceStage ? getNextStage(lead.stage) : null;
    const rollbackOptimisticLead = beginOptimisticLeadUpdate(lead, {
      stage: nextStage ?? lead.stage,
      follow_up_date: null,
    });

    try {
      await logFollowUpActivity(
        lead.id,
        advanceStage && nextStage
          ? `Lead contacted and moved to ${getStageLabel(nextStage)}.`
          : "Lead contacted."
      );

      if (advanceStage && nextStage === "enrolled") {
        const { studentId } = await convertLeadToStudent(lead.id);
        setSelectedLeadId(null);
        if (studentId) {
          router.push(`/students/${studentId}`);
        }
        return;
      }

      await updateLead(lead.id, {
        stage: nextStage ?? lead.stage,
        follow_up_date: null,
      });
      setActionMessage(
        advanceStage && nextStage
          ? `${fullName(lead)} moved to ${getStageLabel(nextStage)}.`
          : `${fullName(lead)} marked contacted.`
      );

      if (selectedLeadId === lead.id && !advanceStage) {
        setSelectedLeadId(lead.id);
      }
    } catch (error) {
      console.error("Failed to update follow-up", error);
      setLeadActionError(
        error instanceof Error
          ? error.message
          : "Could not complete that follow-up action."
      );
    } finally {
      rollbackOptimisticLead();
      setPendingLeadId(null);
    }
  }

  function handleMarkLost(lead: Lead) {
    return handleLeadUpdate(
      lead,
      { stage: "closed_lost", lost_reason: "other" },
      { closeAfterSuccess: true }
    );
  }

  return {
    actionMessage,
    addLeadProgramId,
    addLeadError,
    clearDragState,
    clearSelectedLead,
    closeAddLeadModal,
    dismissActionMessage: () => setActionMessage(null),
    dismissAddLeadError: () => setAddLeadError(null),
    dismissLeadActionError: () => setLeadActionError(null),
    dropTargetStage,
    draggedLead,
    getFollowUpInputValue,
    handleAddLead,
    handleCardDragStart,
    handleConvertLead,
    handleDrop,
    handleMarkContacted,
    handleMarkLost,
    handleKeyboardMoveLead,
    handleRescheduleLead,
    handleStageDragLeave,
    handleStageDragOver,
    handleStageSelection,
    isAddingLead,
    leadActionError,
    model,
    openAddLeadModal,
    pendingLeadId,
    selectLead,
    setAddLeadProgramId,
    setFollowUpInputValue,
    setShowLost,
    showAddLead,
    showLost,
  };
}

export type LeadsPageController = ReturnType<typeof useLeadsPageController>;

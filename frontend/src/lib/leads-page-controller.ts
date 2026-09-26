"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, CommandOutcomeUnknown } from "@/lib/api";
import { hasStaffPermission } from "@/lib/staff-permissions";
import {
  PIPELINE_STAGES,
  buildLeadUpdateSuccessMessage,
  buildLeadsDatasetModel,
  selectLeadsPageModel,
  buildOptimisticLeadUpdate,
  fullName,
  getLeadFollowUpInputValue,
  getNextStage,
  getStageLabel,
  removeOptimisticLeadUpdate,
} from "@/lib/leads-page-model";
import type { Lead, LeadActivity, LeadStage, LostReason, Program, StaffRoleName } from "@/types";

import type { LeadFollowUpCommand } from "@/lib/store-lead-actions";

type LeadOperation = { scope: string; followUp?: LeadFollowUpCommand; unknown: boolean };

type LeadActivityStatus = "idle" | "loading" | "ready" | "error";

type LeadStoreActions = {
  addLead: (data: Partial<Lead>) => Promise<void>;
  convertLeadToStudent: (leadId: string) => Promise<{ lead: Lead; studentId: string | null }>;
  followUpLead: (leadId: string, command: LeadFollowUpCommand) => Promise<Lead>;
  updateLead: (id: string, data: Partial<Lead>) => Promise<void>;
};

type LeadsPageControllerOptions = LeadStoreActions & {
  baseLeads: Lead[];
  identityGeneration: number;
  identityReady: boolean;
  currentRole: StaffRoleName | null;
  isPreviewMode: boolean;
  programs: Program[];
  today: string;
  token: string | null;
};

export function useLeadsPageController({
  addLead,
  baseLeads,
  convertLeadToStudent,
  currentRole,
  followUpLead,
  identityGeneration,
  identityReady,
  isPreviewMode,
  programs,
  today,
  token,
  updateLead,
}: LeadsPageControllerOptions) {
  const router = useRouter();
  const canConvertLeads = hasStaffPermission(currentRole, "convert_leads");
  const canManageLeads = hasStaffPermission(currentRole, "manage_leads");
  const [showAddLead, setShowAddLead] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [showLost, setShowLost] = useState(false);
  const [addLeadOutcomeUnknown, setAddLeadOutcomeUnknown] = useState(false);
  const [isAddingLead, setIsAddingLead] = useState(false);
  const [addLeadError, setAddLeadError] = useState<string | null>(null);
  const scope = `${identityGeneration}:${identityReady}:${currentRole}:${isPreviewMode}`;
  const scopeRef = useRef<string | null>(scope);
  const selectedLeadIdRef = useRef(selectedLeadId);
  const ownersRef = useRef(new Map<string, LeadOperation>());
  const [pendingLeadIds, setPendingLeadIds] = useState<ReadonlySet<string>>(new Set());
  const [unknownFollowUpLeadIds, setUnknownFollowUpLeadIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [renderedScope, setRenderedScope] = useState(scope);
  const [leadActionError, setLeadActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [followUpDrafts, setFollowUpDrafts] = useState<Record<string, string>>({});
  const [optimisticLeads, setOptimisticLeads] = useState<Record<string, Lead>>({});
  const [addLeadProgramId, setAddLeadProgramId] = useState<string | null>(null);
  const [selectedLeadActivities, setSelectedLeadActivities] = useState<LeadActivity[]>([]);
  const [selectedLeadActivityError, setSelectedLeadActivityError] = useState<string | null>(null);
  const [selectedLeadActivityStatus, setSelectedLeadActivityStatus] =
    useState<LeadActivityStatus>("idle");
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);

  // Reset rendered state when access changes. In-flight closures retain their own
  // owner and cannot clear work claimed in the replacement scope.
  if (renderedScope !== scope) {
    setRenderedScope(scope);
    setPendingLeadIds(new Set());
    setUnknownFollowUpLeadIds(new Set());
    setOptimisticLeads({});
    setFollowUpDrafts({});
    setSelectedLeadActivities([]);
    setSelectedLeadActivityError(null);
    setSelectedLeadActivityStatus("idle");
    setSelectedLeadId(null);
    setLeadActionError(null);
    setActionMessage(null);
  }
  useLayoutEffect(() => {
    scopeRef.current = scope;
    selectedLeadIdRef.current = selectedLeadId;
    return () => {
      scopeRef.current = null;
    };
  }, [scope, selectedLeadId]);

  function ownsLead(leadId: string, owner: LeadOperation) {
    return scopeRef.current === owner.scope && ownersRef.current.get(leadId) === owner;
  }

  function claimLead(leadId: string, followUp?: LeadFollowUpCommand, retry = false) {
    if (!canManageLeads || !identityReady || scopeRef.current !== scope) return null;
    const existing = ownersRef.current.get(leadId);
    if (existing?.scope === scope && !(retry && existing.unknown)) return null;
    const owner: LeadOperation = { scope, followUp, unknown: false };
    ownersRef.current.set(leadId, owner);
    setPendingLeadIds((current) => new Set(current).add(leadId));
    setUnknownFollowUpLeadIds((current) => {
      const next = new Set(current);
      next.delete(leadId);
      return next;
    });
    setLeadActionError(null);
    setActionMessage(null);
    return owner;
  }

  function finishLead(leadId: string, owner: LeadOperation) {
    if (!ownsLead(leadId, owner)) return;
    setOptimisticLeads((current) => removeOptimisticLeadUpdate(current, leadId));
    if (owner.unknown) return;
    ownersRef.current.delete(leadId);
    setPendingLeadIds((current) => {
      const next = new Set(current);
      next.delete(leadId);
      return next;
    });
  }

  function closeCompletedLead(leadId: string, studentId?: string | null) {
    if (selectedLeadIdRef.current !== null && selectedLeadIdRef.current !== leadId) return;
    selectedLeadIdRef.current = null;
    setSelectedLeadId(null);
    if (studentId) router.push(`/students/${studentId}`);
  }

  const dataset = useMemo(
    () => buildLeadsDatasetModel({ baseLeads, optimisticLeads, programs, today }),
    [baseLeads, optimisticLeads, programs, today],
  );
  const model = useMemo(
    () => selectLeadsPageModel(dataset, selectedLeadId),
    [dataset, selectedLeadId],
  );

  useEffect(() => {
    if (!selectedLeadId || isPreviewMode || !token) return;

    const requestController = new AbortController();
    void api
      .get<LeadActivity[]>(`/leads/${selectedLeadId}/activities`, token, {
        signal: requestController.signal,
      })
      .then((activities) => {
        if (requestController.signal.aborted) return;
        setSelectedLeadActivities(activities);
        setSelectedLeadActivityStatus("ready");
      })
      .catch((error: unknown) => {
        if (requestController.signal.aborted) return;
        setSelectedLeadActivityError(
          error instanceof Error ? error.message : "Could not load lead activity.",
        );
        setSelectedLeadActivityStatus("error");
      });

    return () => requestController.abort();
  }, [activityRefreshKey, isPreviewMode, selectedLeadId, token]);

  function getFollowUpInputValue(lead: Lead) {
    return getLeadFollowUpInputValue(lead, followUpDrafts, today);
  }

  function setFollowUpInputValue(leadId: string, value: string) {
    setFollowUpDrafts((current) => ({ ...current, [leadId]: value }));
  }

  function clearSelectedLead() {
    if (
      !selectedLeadId ||
      !pendingLeadIds.has(selectedLeadId) ||
      unknownFollowUpLeadIds.has(selectedLeadId)
    ) {
      selectedLeadIdRef.current = null;
      setSelectedLeadId(null);
      setSelectedLeadActivities([]);
      setSelectedLeadActivityError(null);
      setSelectedLeadActivityStatus("idle");
    }
  }

  function openAddLeadModal() {
    if (!canManageLeads) return;
    if (!addLeadOutcomeUnknown) setAddLeadError(null);
    setAddLeadProgramId(null);
    setShowAddLead(true);
  }

  function closeAddLeadModal() {
    if (isAddingLead) return;
    setShowAddLead(false);
    setAddLeadOutcomeUnknown(false);
    setAddLeadProgramId(null);
  }

  function selectLead(leadId: string) {
    setLeadActionError(null);
    selectedLeadIdRef.current = leadId;
    setSelectedLeadId(leadId);
    setSelectedLeadActivities([]);
    if (isPreviewMode) {
      setSelectedLeadActivityError(null);
      setSelectedLeadActivityStatus("ready");
    } else if (!token) {
      setSelectedLeadActivityError(
        "Activity history is unavailable until the current session is ready.",
      );
      setSelectedLeadActivityStatus("error");
    } else {
      setSelectedLeadActivityError(null);
      setSelectedLeadActivityStatus("loading");
    }
  }

  function retrySelectedLeadActivities() {
    if (!selectedLeadId || isPreviewMode || !token) return;
    setSelectedLeadActivities([]);
    setSelectedLeadActivityError(null);
    setSelectedLeadActivityStatus("loading");
    setActivityRefreshKey((current) => current + 1);
  }

  function beginOptimisticLeadUpdate(lead: Lead, updates: Partial<Lead>) {
    const optimisticLead = buildOptimisticLeadUpdate(lead, updates);

    setOptimisticLeads((current) => ({
      ...current,
      [lead.id]: optimisticLead,
    }));
  }

  async function handleConvertLead(lead: Lead) {
    if (!canManageLeads || !canConvertLeads) return;

    const owner = claimLead(lead.id);
    if (!owner) return;
    beginOptimisticLeadUpdate(lead, {
      stage: "enrolled",
      follow_up_date: null,
    });

    try {
      const { studentId } = await convertLeadToStudent(lead.id);
      if (!ownsLead(lead.id, owner)) return;
      closeCompletedLead(lead.id, studentId);
    } catch (error) {
      if (!ownsLead(lead.id, owner)) return;
      console.error("Failed to convert lead", error);
      setLeadActionError(
        error instanceof Error ? error.message : "Could not convert this lead into a student.",
      );
    } finally {
      finishLead(lead.id, owner);
    }
  }

  async function handleAddLead(data: Partial<Lead>) {
    if (!canManageLeads || addLeadOutcomeUnknown) return;
    setAddLeadError(null);
    setActionMessage(null);
    setIsAddingLead(true);

    try {
      await addLead(data);
      setShowAddLead(false);
      setAddLeadProgramId(null);
      setActionMessage("Lead added to the pipeline.");
    } catch (error) {
      console.error("Failed to add lead", error);
      if (error instanceof CommandOutcomeUnknown) setAddLeadOutcomeUnknown(true);
      setAddLeadError(error instanceof Error ? error.message : "Could not add this lead.");
    } finally {
      setIsAddingLead(false);
    }
  }

  async function handleLeadUpdate(
    lead: Lead,
    updates: Partial<Lead>,
    options?: { closeAfterSuccess?: boolean },
  ) {
    if (!canManageLeads) return;
    const owner = claimLead(lead.id);
    if (!owner) return;
    beginOptimisticLeadUpdate(lead, updates);

    try {
      await updateLead(lead.id, updates);
      if (!ownsLead(lead.id, owner)) return;
      setActionMessage(buildLeadUpdateSuccessMessage(lead, updates));
      if (options?.closeAfterSuccess) closeCompletedLead(lead.id);
    } catch (error) {
      if (!ownsLead(lead.id, owner)) return;
      console.error("Failed to update lead", error);
      setLeadActionError(
        error instanceof Error ? error.message : "Could not save lead changes. Please try again.",
      );
    } finally {
      finishLead(lead.id, owner);
    }
  }

  async function handleStageSelection(lead: Lead, nextStage: LeadStage) {
    if (!canManageLeads) return;
    if (nextStage === "enrolled" && !canConvertLeads) return;

    if (nextStage === "enrolled") {
      await handleConvertLead(lead);
      return;
    }

    await handleLeadUpdate(lead, {
      stage: nextStage,
      lost_reason: nextStage === "closed_lost" ? (lead.lost_reason ?? "other") : lead.lost_reason,
    });
  }

  async function handleKeyboardMoveLead(lead: Lead, direction: -1 | 1) {
    if (!canManageLeads) return;
    const currentIndex = PIPELINE_STAGES.findIndex((stage) => stage.id === lead.stage);
    if (currentIndex === -1) {
      return;
    }

    const nextStage = PIPELINE_STAGES[currentIndex + direction]?.id;
    if (!nextStage || nextStage === lead.stage) {
      return;
    }

    await handleStageSelection(lead, nextStage);
  }

  async function handleRescheduleLead(lead: Lead) {
    if (!canManageLeads) return;
    const nextDate = getFollowUpInputValue(lead);
    if (!nextDate) {
      setLeadActionError("Choose a follow-up date before rescheduling.");
      return;
    }

    await handleLeadUpdate(lead, { follow_up_date: nextDate });
  }

  async function runFollowUp(lead: Lead, command: LeadFollowUpCommand, retry = false) {
    if (command.next_stage === "enrolled" && !canConvertLeads) return;
    const owner = claimLead(lead.id, command, retry);
    if (!owner) return;
    beginOptimisticLeadUpdate(lead, {
      stage: command.next_stage ?? lead.stage,
      follow_up_date: null,
    });
    try {
      const result = await followUpLead(lead.id, command);
      if (!ownsLead(lead.id, owner)) return;
      if (command.next_stage === "enrolled")
        closeCompletedLead(lead.id, result.converted_student_id);
      setActionMessage(
        command.next_stage
          ? `${fullName(lead)} moved to ${getStageLabel(command.next_stage)}.`
          : `${fullName(lead)} marked contacted.`,
      );
      if (selectedLeadIdRef.current === lead.id) setActivityRefreshKey((current) => current + 1);
    } catch (error) {
      if (!ownsLead(lead.id, owner)) return;
      if (retry || error instanceof CommandOutcomeUnknown) {
        owner.unknown = true;
        setUnknownFollowUpLeadIds((current) => new Set(current).add(lead.id));
      }
      setLeadActionError(
        error instanceof Error ? error.message : "Could not complete that follow-up action.",
      );
    } finally {
      finishLead(lead.id, owner);
    }
  }

  async function handleMarkContacted(lead: Lead, advanceStage: boolean) {
    if (!canManageLeads) return;
    await runFollowUp(lead, {
      operation_id: crypto.randomUUID(),
      next_stage: advanceStage ? getNextStage(lead.stage) : null,
    });
  }

  async function handleRetryFollowUp(lead: Lead) {
    const owner = ownersRef.current.get(lead.id);
    if (owner?.scope !== scope || !owner.unknown || !owner.followUp) return;
    await runFollowUp(lead, owner.followUp, true);
  }

  function handleMarkLost(lead: Lead, lostReason: LostReason) {
    if (!canManageLeads) return;
    return handleLeadUpdate(
      lead,
      { stage: "closed_lost", lost_reason: lostReason },
      { closeAfterSuccess: true },
    );
  }

  function handleAssignedStaff(lead: Lead, assignedStaffId: string | null) {
    if (!canManageLeads) return;
    return handleLeadUpdate(lead, { assigned_staff_id: assignedStaffId });
  }

  return {
    actionMessage,
    addLeadProgramId,
    addLeadError,
    canConvertLeads,
    canManageLeads,
    clearSelectedLead,
    closeAddLeadModal,
    dismissActionMessage: () => setActionMessage(null),
    dismissAddLeadError: () => setAddLeadError(null),
    dismissLeadActionError: () => setLeadActionError(null),
    getFollowUpInputValue,
    handleAddLead,
    handleAssignedStaff,
    handleConvertLead,
    handleMarkContacted,
    handleRetryFollowUp,
    handleMarkLost,
    handleKeyboardMoveLead,
    handleRescheduleLead,
    handleStageSelection,
    isAddingLead,
    addLeadOutcomeUnknown,
    leadActionError,
    model,
    openAddLeadModal,
    pendingLeadIds,
    unknownFollowUpLeadIds,
    retrySelectedLeadActivities,
    selectedLeadActivities,
    selectedLeadActivityError,
    selectedLeadActivityStatus,
    selectLead,
    setAddLeadProgramId,
    setFollowUpInputValue,
    setShowLost,
    showAddLead,
    showLost,
  };
}

export type LeadsPageController = ReturnType<typeof useLeadsPageController>;

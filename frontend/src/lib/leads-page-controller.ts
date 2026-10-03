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
import type {
  LeadFollowUpCommand,
  LeadFollowUpRecovery,
  LeadOperation,
  LeadOperations,
} from "@/lib/lead-operation-reservations";
import type { LeadFollowUpOptions, LeadFollowUpResult } from "@/lib/store-lead-actions";
import type { Lead, LeadActivity, LeadStage, LostReason, Program, StaffRoleName } from "@/types";

type LeadActivityStatus = "idle" | "loading" | "ready" | "error";

type LeadStoreActions = {
  addLead: (data: Partial<Lead>) => Promise<void>;
  convertLeadToStudent: (leadId: string) => Promise<{ lead: Lead; studentId: string | null }>;
  followUpLead: (
    leadId: string,
    command: LeadFollowUpCommand,
    options?: LeadFollowUpOptions,
  ) => Promise<LeadFollowUpResult>;
  leadOperations: LeadOperations;
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
  leadOperations,
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
  // Null while unmounted. Row reservations live in the provider; this page scope
  // only owns its own notices, selection, optimistic rows and navigation.
  const scopeRef = useRef<string | null>(scope);
  const selectedLeadIdRef = useRef(selectedLeadId);
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
  // scope and cannot publish into the replacement scope.
  if (renderedScope !== scope) {
    setRenderedScope(scope);
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

  // Reservations are checked against the current identity on every render, so a
  // fenced owner never disables or offers a retry in a replacement scope.
  const pendingLeadIds = new Set<string>();
  const followUpRecoveries = new Map<string, LeadFollowUpRecovery>();
  if (renderedScope === scope) {
    for (const [leadId, view] of leadOperations.views) {
      if (!view.isCurrent()) continue;
      pendingLeadIds.add(leadId);
      if (view.recovery && view.followUp) followUpRecoveries.set(leadId, view.recovery);
    }
  }

  function claimLead(leadId: string, followUp?: LeadFollowUpCommand) {
    if (!canManageLeads || !identityReady || scopeRef.current !== scope) return null;
    const operation = leadOperations.reserve(leadId, followUp);
    if (!operation) return null;
    setLeadActionError(null);
    setActionMessage(null);
    return operation;
  }

  // Page publications need both this mounted page scope and the row reservation.
  function showsOutcome(operation: LeadOperation, operationScope: string) {
    return (
      scopeRef.current === operationScope && leadOperations.current(operation.leadId) === operation
    );
  }

  function finishOptimisticLead(operation: LeadOperation, operationScope: string) {
    const owner = leadOperations.current(operation.leadId);
    if (scopeRef.current !== operationScope || (owner && owner !== operation)) return;
    setOptimisticLeads((current) => removeOptimisticLeadUpdate(current, operation.leadId));
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
      followUpRecoveries.has(selectedLeadId)
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

    const operation = claimLead(lead.id);
    if (!operation) return;
    const operationScope = scope;
    beginOptimisticLeadUpdate(lead, {
      stage: "enrolled",
      follow_up_date: null,
    });

    try {
      const { studentId } = await convertLeadToStudent(lead.id);
      if (showsOutcome(operation, operationScope)) closeCompletedLead(lead.id, studentId);
    } catch (error) {
      console.error("Failed to convert lead", error);
      if (showsOutcome(operation, operationScope))
        setLeadActionError(
          error instanceof Error ? error.message : "Could not convert this lead into a student.",
        );
    } finally {
      finishOptimisticLead(operation, operationScope);
      leadOperations.release(operation);
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
    const operation = claimLead(lead.id);
    if (!operation) return;
    const operationScope = scope;
    beginOptimisticLeadUpdate(lead, updates);

    try {
      await updateLead(lead.id, updates);
      if (showsOutcome(operation, operationScope)) {
        setActionMessage(buildLeadUpdateSuccessMessage(lead, updates));
        if (options?.closeAfterSuccess) closeCompletedLead(lead.id);
      }
    } catch (error) {
      console.error("Failed to update lead", error);
      if (showsOutcome(operation, operationScope))
        setLeadActionError(
          error instanceof Error ? error.message : "Could not save lead changes. Please try again.",
        );
    } finally {
      finishOptimisticLead(operation, operationScope);
      leadOperations.release(operation);
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

  async function runFollowUp(lead: Lead, operation: LeadOperation, command: LeadFollowUpCommand) {
    const operationScope = scope;
    const retry = operation.previousRecovery !== null;
    if (!retry)
      beginOptimisticLeadUpdate(lead, {
        stage: command.next_stage ?? lead.stage,
        follow_up_date: null,
      });
    try {
      const result = await followUpLead(lead.id, command, { replay: retry });
      if (result.reconciliation === "stale") return;
      if (result.reconciliation === "required") {
        // The command is confirmed, but the current row is not known yet.
        if (showsOutcome(operation, operationScope)) {
          setActionMessage(`${fullName(lead)} follow-up saved.`);
          setLeadActionError(result.reconciliationError);
        }
        leadOperations.hold(operation, "confirmed");
        return;
      }
      if (showsOutcome(operation, operationScope)) {
        if (!result.currentLead) {
          closeCompletedLead(lead.id);
          setActionMessage("Follow-up confirmed. This lead is no longer available.");
        } else {
          if (command.next_stage === "enrolled" && result.currentLead.stage === "enrolled")
            closeCompletedLead(lead.id, result.currentLead.converted_student_id);
          setActionMessage(
            retry
              ? `${fullName(lead)} follow-up confirmed.`
              : command.next_stage
                ? `${fullName(lead)} moved to ${getStageLabel(command.next_stage)}.`
                : `${fullName(lead)} marked contacted.`,
          );
          if (selectedLeadIdRef.current === lead.id)
            setActivityRefreshKey((current) => current + 1);
        }
      }
      leadOperations.release(operation);
    } catch (error) {
      console.error("Failed to complete lead follow-up", error);
      // An unknown outcome or any retry failure cannot prove the command was not
      // applied. Keep the reservation and its exact command for another retry.
      const keepsCommand = retry || error instanceof CommandOutcomeUnknown;
      if (showsOutcome(operation, operationScope))
        setLeadActionError(
          operation.previousRecovery === "confirmed"
            ? "The follow-up is saved, but current details could not be refreshed. Try again."
            : error instanceof Error
              ? error.message
              : "Could not complete that follow-up action.",
        );
      if (keepsCommand)
        leadOperations.hold(
          operation,
          operation.previousRecovery === "confirmed" ? "confirmed" : "unknown",
        );
      else leadOperations.release(operation);
    } finally {
      finishOptimisticLead(operation, operationScope);
    }
  }

  async function handleMarkContacted(lead: Lead, advanceStage: boolean) {
    if (!canManageLeads) return;
    const nextStage = advanceStage ? getNextStage(lead.stage) : null;
    if (nextStage === "enrolled" && !canConvertLeads) return;
    const command: LeadFollowUpCommand = {
      operation_id: crypto.randomUUID(),
      next_stage: nextStage,
    };
    const operation = claimLead(lead.id, command);
    if (!operation) return;
    await runFollowUp(lead, operation, command);
  }

  async function handleRetryFollowUp(lead: Lead) {
    if (!canManageLeads || !identityReady || scopeRef.current !== scope) return;
    const saved = leadOperations.current(lead.id)?.followUp;
    if (saved?.next_stage === "enrolled" && !canConvertLeads) return;
    const operation = leadOperations.resumeFollowUp(lead.id);
    if (!operation?.followUp) return;
    setLeadActionError(null);
    setActionMessage(null);
    await runFollowUp(lead, operation, operation.followUp);
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
    followUpRecoveries,
    recoveringLeadIds: new Set(followUpRecoveries.keys()),
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

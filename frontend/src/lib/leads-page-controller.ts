"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, CommandOutcomeUnknown } from "@/lib/api";
import { hasStaffPermission } from "@/lib/staff-permissions";
import { useRetainedState } from "@/lib/retained-state";
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
import type { LeadCreateView } from "@/lib/lead-create-operation";
import type { LeadFollowUpOptions, LeadFollowUpResult } from "@/lib/store-lead-actions";
import type { Lead, LeadActivity, LeadStage, LostReason, Program, StaffRoleName } from "@/types";

type LeadActivityStatus = "idle" | "loading" | "refreshing" | "ready" | "error";

type LeadStoreActions = {
  addLead: (data: Partial<Lead>) => Promise<void>;
  leadCreate: LeadCreateView;
  checkLeadCreateResult: () => Promise<void>;
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
  trialRecoveryLeadIds?: ReadonlySet<string>;
};

export function useLeadsPageController({
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
  programs,
  today,
  token,
  trialRecoveryLeadIds,
  updateLead,
}: LeadsPageControllerOptions) {
  const router = useRouter();
  const canConvertLeads = hasStaffPermission(currentRole, "convert_leads");
  const canManageLeads = hasStaffPermission(currentRole, "manage_leads");
  const [showAddLead, setShowAddLead] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [showLost, setShowLost] = useState(false);
  const modalGenerationRef = useRef(0);
  const addEditGenerationRef = useRef(0);
  const submittedFormRef = useRef<{ scope: string; modal: number; edit: number } | null>(null);
  const addFlightRef = useRef(false);
  const currentCreate = leadCreate.isCurrent() ? leadCreate : null;
  const isAddingLead = currentCreate?.status === "submitting";
  const isCheckingLead = currentCreate?.status === "checking";
  const addLeadLocked = !currentCreate || currentCreate.locked;
  const leadCreateMessage = currentCreate
    ? currentCreate.message
    : !isPreviewMode && canManageLeads && identityReady
      ? "Your studio access needs to be checked. Reload this page before adding a lead."
      : null;
  const canCheckLeadCreate = Boolean(
    currentCreate?.locked &&
    ["unknown", "confirmed_needs_refresh", "storage_blocked", "rejected"].includes(
      currentCreate.status,
    ),
  );
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
  const [selectedLeadActivities, setSelectedLeadActivities] = useRetainedState<
    LeadActivity[] | null
  >(identityReady && selectedLeadId ? `leads:activity:${scope}:${selectedLeadId}` : null, null);
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
    setSelectedLeadActivityError(null);
    setSelectedLeadActivityStatus("idle");
    setSelectedLeadId(null);
    setLeadActionError(null);
    setActionMessage(null);
    setShowAddLead(false);
    setAddLeadProgramId(null);
    setAddLeadError(null);
  }
  useLayoutEffect(() => {
    modalGenerationRef.current += 1;
    addFlightRef.current = false;
    submittedFormRef.current = null;
  }, [scope]);
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
    if (!identityReady || !selectedLeadId || isPreviewMode || !token) return;

    const requestController = new AbortController();
    void api
      .get<LeadActivity[]>(`/leads/${selectedLeadId}/activities`, token, {
        signal: requestController.signal,
      })
      .then((activities) => {
        if (
          requestController.signal.aborted ||
          scopeRef.current !== scope ||
          selectedLeadIdRef.current !== selectedLeadId
        )
          return;
        setSelectedLeadActivities(activities);
        setSelectedLeadActivityStatus("ready");
      })
      .catch((error: unknown) => {
        if (
          requestController.signal.aborted ||
          scopeRef.current !== scope ||
          selectedLeadIdRef.current !== selectedLeadId
        )
          return;
        setSelectedLeadActivityError(
          error instanceof Error ? error.message : "Could not load lead activity.",
        );
        setSelectedLeadActivityStatus("error");
      });

    return () => requestController.abort();
  }, [
    activityRefreshKey,
    identityReady,
    isPreviewMode,
    scope,
    selectedLeadId,
    token,
    setSelectedLeadActivities,
  ]);

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
      followUpRecoveries.has(selectedLeadId) ||
      trialRecoveryLeadIds?.has(selectedLeadId)
    ) {
      selectedLeadIdRef.current = null;
      setSelectedLeadId(null);
      setSelectedLeadActivityError(null);
      setSelectedLeadActivityStatus("idle");
    }
  }

  function openAddLeadModal() {
    if (!canManageLeads) return;
    setAddLeadError(null);
    modalGenerationRef.current += 1;
    setAddLeadProgramId(null);
    setShowAddLead(true);
  }

  function closeAddLeadModal() {
    if (isAddingLead) return;
    setShowAddLead(false);
    modalGenerationRef.current += 1;
    setAddLeadProgramId(null);
  }

  function selectLead(leadId: string) {
    if (selectedLeadId === leadId) setActivityRefreshKey((current) => current + 1);
    setLeadActionError(null);
    selectedLeadIdRef.current = leadId;
    setSelectedLeadId(leadId);
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

  function handleAddLeadFormEdit() {
    if (scopeRef.current === scope) addEditGenerationRef.current += 1;
  }
  function changeAddLeadProgramId(id: string | null) {
    handleAddLeadFormEdit();
    setAddLeadProgramId(id);
  }

  async function runAddLeadAction(action: () => Promise<void>, submitting = false) {
    if (
      !canManageLeads ||
      !identityReady ||
      !leadCreate.isCurrent() ||
      scopeRef.current !== scope ||
      addFlightRef.current
    )
      return;
    const generation = modalGenerationRef.current;
    const operationScope = scope;
    if (submitting) {
      submittedFormRef.current = { scope, modal: generation, edit: addEditGenerationRef.current };
    }
    const originatingForm = submittedFormRef.current;
    // A storage-only retry may restore dispatch without confirming any create.
    const mayCloseForm =
      submitting || ["unknown", "confirmed_needs_refresh"].includes(leadCreate.status);
    const ownsUnchangedForm = () =>
      Boolean(
        originatingForm &&
        originatingForm === submittedFormRef.current &&
        originatingForm.scope === operationScope &&
        originatingForm.modal === modalGenerationRef.current &&
        originatingForm.edit === addEditGenerationRef.current,
      );
    const current = () =>
      scopeRef.current === operationScope &&
      modalGenerationRef.current === generation &&
      leadCreate.isCurrent();
    addFlightRef.current = true;
    setAddLeadError(null);
    setActionMessage(null);
    try {
      await action();
      if (current() && mayCloseForm && ownsUnchangedForm()) {
        submittedFormRef.current = null;
        setShowAddLead(false);
        setAddLeadProgramId(null);
        if (isPreviewMode) setActionMessage("Lead added to the pipeline.");
      }
    } catch {
      // Live status and recovery copy come from the retained owner, including
      // unavailable current rows. Do not turn a failed read into a failed write.
      if (current() && isPreviewMode) setAddLeadError("Could not add this lead.");
    } finally {
      if (scopeRef.current === operationScope) addFlightRef.current = false;
    }
  }
  async function handleAddLead(data: Partial<Lead>) {
    if (addLeadLocked) return;
    await runAddLeadAction(() => addLead(data), true);
  }
  async function handleCheckLeadCreateResult() {
    if (!canCheckLeadCreate) return;
    await runAddLeadAction(checkLeadCreateResult);
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
    handleAddLeadFormEdit,
    handleAssignedStaff,
    handleConvertLead,
    handleMarkContacted,
    handleRetryFollowUp,
    handleMarkLost,
    handleKeyboardMoveLead,
    handleRescheduleLead,
    handleStageSelection,
    isAddingLead,
    addLeadLocked,
    leadCreateMessage,
    canCheckLeadCreate,
    isCheckingLead,
    handleCheckLeadCreateResult,
    leadActionError,
    model,
    openAddLeadModal,
    pendingLeadIds,
    followUpRecoveries,
    recoveringLeadIds: new Set([...followUpRecoveries.keys(), ...(trialRecoveryLeadIds ?? [])]),
    retrySelectedLeadActivities,
    selectedLeadActivities: selectedLeadActivities ?? [],
    selectedLeadActivityError,
    selectedLeadActivityStatus:
      selectedLeadActivityStatus === "loading" && selectedLeadActivities !== null
        ? ("refreshing" as LeadActivityStatus)
        : selectedLeadActivityStatus,
    selectLead,
    setAddLeadProgramId: changeAddLeadProgramId,
    setFollowUpInputValue,
    setShowLost,
    showAddLead,
    showLost,
  };
}

export type LeadsPageController = ReturnType<typeof useLeadsPageController>;

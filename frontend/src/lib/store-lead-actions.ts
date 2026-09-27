import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";

import { api, ApiError } from "@/lib/api";
import {
  applyLeadUpdate,
  buildPreviewLead,
  buildPreviewLeadConversion,
} from "@/lib/lead-store-model";
import { refreshLiveLeadDataset } from "@/lib/store-lead-refresh-model";
import { localId } from "@/lib/store-storage";
import type { BeginLiveAuthRequest, StoreRef } from "@/lib/store-action-types";
import type { BeltLadder, BeltRank, Lead, LeadStage, Program, Student } from "@/types";

import type { ResourceScope } from "@/lib/store-resource-scope";
import { canCommitLiveMutation, withCurrentLiveAuthRead } from "@/lib/store-action-types";

export interface LeadFollowUpCommand {
  operation_id: string;
  next_stage: LeadStage | null;
}

export type LeadFollowUpResult =
  | { lead: Lead; currentLead: Lead | null; reconciliation: "ready" }
  | { lead: Lead; reconciliation: "required"; reconciliationError: string }
  | { lead: Lead; reconciliation: "stale" };

export interface LeadFollowUpOptions {
  replay?: boolean;
}

interface UseStoreLeadActionsOptions {
  leadMutationScopeRef: StoreRef<ResourceScope>;
  businessDateRef: StoreRef<string>;
  beginLeadMutation: () => () => void;
  beginLiveAuthRequest: BeginLiveAuthRequest;
  beltLaddersRef: StoreRef<BeltLadder[]>;
  beltRanksRef: StoreRef<BeltRank[]>;
  isPreviewMode: boolean;
  leadsRef: StoreRef<Lead[]>;
  onStudentMutation: () => void;
  persistLeads: (next: Lead[]) => void;
  persistStudents: (next: Student[]) => void;
  programsRef: StoreRef<Program[]>;
  refreshStudents: () => Promise<Student[]>;
  setLeads: Dispatch<SetStateAction<Lead[]>>;
  setLeadsLoaded: Dispatch<SetStateAction<boolean>>;
  setLeadsLoadError: Dispatch<SetStateAction<string | null>>;
  studentsRef: StoreRef<Student[]>;
}

export function useStoreLeadActions({
  beginLeadMutation,
  businessDateRef,
  leadMutationScopeRef,
  beginLiveAuthRequest,
  beltLaddersRef,
  beltRanksRef,
  isPreviewMode,
  leadsRef,
  onStudentMutation,
  persistLeads,
  persistStudents,
  programsRef,
  refreshStudents,
  setLeads,
  setLeadsLoaded,
  setLeadsLoadError,
  studentsRef,
}: UseStoreLeadActionsOptions) {
  // This provider outlives page controllers. Fence each row's publications so an
  // old controller's held read cannot replace a newer owner's confirmed write.
  const leadPublicationsRef = useRef(new Map<string, symbol>());
  const publishLead = useCallback(
    (leadId: string, lead: Lead | null) => {
      const publication = Symbol();
      leadPublicationsRef.current.set(leadId, publication);
      setLeads((current) => {
        if (leadPublicationsRef.current.get(leadId) !== publication) return current;
        return lead
          ? current.map((item) => (item.id === leadId ? lead : item))
          : current.filter((item) => item.id !== leadId);
      });
    },
    [setLeads],
  );

  const addLead = useCallback(
    async (data: Partial<Lead>) => {
      if (isPreviewMode) {
        const newLead = buildPreviewLead(data, { idFactory: localId });
        persistLeads([newLead, ...leadsRef.current]);
        return;
      }

      const liveRequest = beginLiveAuthRequest();
      const finishMutation = beginLeadMutation();
      try {
        const result = await api.post<Lead>("/leads", data, liveRequest.token);
        if (!canCommitLiveMutation(liveRequest)) {
          return;
        }
        setLeads((current) => [result, ...current]);
      } finally {
        finishMutation();
      }
    },
    [beginLeadMutation, beginLiveAuthRequest, isPreviewMode, leadsRef, persistLeads, setLeads],
  );

  const updateLead = useCallback(
    async (id: string, data: Partial<Lead>) => {
      if (isPreviewMode) {
        persistLeads(applyLeadUpdate(leadsRef.current, id, data));
        return;
      }

      const liveRequest = beginLiveAuthRequest();
      const finishMutation = beginLeadMutation();
      try {
        const result = await api.patch<Lead>(`/leads/${id}`, data, liveRequest.token);
        if (!canCommitLiveMutation(liveRequest)) {
          return;
        }
        publishLead(id, result);
      } finally {
        finishMutation();
      }
    },
    [beginLeadMutation, beginLiveAuthRequest, isPreviewMode, leadsRef, persistLeads, publishLead],
  );

  const deleteLead = useCallback(
    async (id: string) => {
      if (isPreviewMode) {
        persistLeads(leadsRef.current.filter((lead) => lead.id !== id));
        return;
      }

      const liveRequest = beginLiveAuthRequest();
      const finishMutation = beginLeadMutation();
      try {
        await api.delete(`/leads/${id}`, liveRequest.token);
        if (!canCommitLiveMutation(liveRequest)) {
          return;
        }
        publishLead(id, null);
      } finally {
        finishMutation();
      }
    },
    [beginLeadMutation, beginLiveAuthRequest, isPreviewMode, leadsRef, persistLeads, publishLead],
  );

  const refreshLeads = useCallback(async (): Promise<Lead[]> => {
    if (isPreviewMode) {
      return leadsRef.current;
    }

    return refreshLiveLeadDataset({
      beginLiveAuthRequest,
      scopeRef: leadMutationScopeRef,
      fetchLeads: (requestToken) => api.get<Lead[]>("/leads", requestToken),
      setLeads,
      setLeadsLoaded,
      setLeadsLoadError,
    });
  }, [
    beginLiveAuthRequest,
    leadMutationScopeRef,
    isPreviewMode,
    leadsRef,
    setLeads,
    setLeadsLoaded,
    setLeadsLoadError,
  ]);

  const convertLeadToStudent = useCallback(
    async (leadId: string) => {
      const lead = leadsRef.current.find((item) => item.id === leadId);
      if (!lead) {
        throw new Error("Lead not found");
      }

      if (lead.converted_student_id) {
        throw new Error("This lead has already been converted.");
      }

      if (isPreviewMode) {
        const conversion = buildPreviewLeadConversion(lead, programsRef.current, {
          beltLadders: beltLaddersRef.current,
          beltRanks: beltRanksRef.current,
          idFactory: localId,
          businessDate: businessDateRef.current,
        });

        persistStudents([conversion.student, ...studentsRef.current]);
        persistLeads(leadsRef.current.map((item) => (item.id === leadId ? conversion.lead : item)));
        onStudentMutation();

        return {
          lead: conversion.lead,
          studentId: conversion.studentId,
        };
      }

      const liveRequest = beginLiveAuthRequest();
      const finishMutation = beginLeadMutation();
      try {
        const membershipStartDate = businessDateRef.current;
        const result = await api.post<Lead>(
          `/leads/${leadId}/convert`,
          {
            status: "active",
            membership_start_date: membershipStartDate,
            program_id: lead.program_id || undefined,
          },
          liveRequest.token,
        );
        if (!canCommitLiveMutation(liveRequest)) {
          return {
            lead: result,
            studentId: result.converted_student_id ?? null,
          };
        }

        publishLead(leadId, result);
        try {
          await refreshStudents();
        } catch (error) {
          console.error("Failed to refresh students after lead conversion", error);
        }
        onStudentMutation();

        return {
          lead: result,
          studentId: result.converted_student_id ?? null,
        };
      } finally {
        finishMutation();
      }
    },
    [
      beginLeadMutation,
      businessDateRef,
      beginLiveAuthRequest,
      beltLaddersRef,
      beltRanksRef,
      isPreviewMode,
      leadsRef,
      onStudentMutation,
      persistLeads,
      persistStudents,
      programsRef,
      refreshStudents,
      publishLead,
      studentsRef,
    ],
  );

  const followUpLead = useCallback(
    async (
      leadId: string,
      command: LeadFollowUpCommand,
      options?: LeadFollowUpOptions,
    ): Promise<LeadFollowUpResult> => {
      if (isPreviewMode) {
        if (command.next_stage === "enrolled") {
          const { lead } = await convertLeadToStudent(leadId);
          return { lead, currentLead: lead, reconciliation: "ready" };
        }
        const lead = leadsRef.current.find((item) => item.id === leadId);
        if (!lead) throw new Error("Lead not found");
        const result = { ...lead, stage: command.next_stage ?? lead.stage, follow_up_date: null };
        persistLeads(leadsRef.current.map((item) => (item.id === leadId ? result : item)));
        return { lead: result, currentLead: result, reconciliation: "ready" };
      }

      const liveRequest = beginLiveAuthRequest();
      const mutationScope = leadMutationScopeRef.current;
      const finishMutation = beginLeadMutation();
      const ownsMutation = () =>
        canCommitLiveMutation(liveRequest) && leadMutationScopeRef.current === mutationScope;
      try {
        const result = await api.post<Lead>(
          `/leads/${leadId}/follow-up`,
          command,
          liveRequest.token,
        );
        if (!ownsMutation()) return { lead: result, reconciliation: "stale" };
        const refreshConvertedStudents = async () => {
          if (!ownsMutation()) return;
          try {
            await refreshStudents();
          } catch (error) {
            console.error("Failed to refresh students after lead follow-up", error);
          }
          if (ownsMutation()) onStudentMutation();
        };
        if (options?.replay) {
          if (command.next_stage === "enrolled") void refreshConvertedStudents();
          // A receipt is historical. Read this row after confirmation while the
          // mutation fence keeps list snapshots out. This GET does not wait for
          // unrelated lead mutations, and a read failure is not a failed write.
          try {
            const observed = await withCurrentLiveAuthRead(
              beginLiveAuthRequest,
              async (request) => {
                const publication = leadPublicationsRef.current.get(leadId);
                let currentLead: Lead | null;
                try {
                  currentLead = await api.get<Lead>(`/leads/${leadId}`, request.token);
                } catch (error) {
                  if (!(error instanceof ApiError) || error.status !== 404) throw error;
                  currentLead = null;
                }
                return { currentLead, request, publication };
              },
              () => undefined,
            );
            if (!ownsMutation()) return { lead: result, reconciliation: "stale" };
            if (!observed.request.isCurrent()) {
              return {
                lead: result,
                reconciliation: "required",
                reconciliationError:
                  "The session changed while loading current lead details. Refresh them to continue.",
              };
            }
            if (leadPublicationsRef.current.get(leadId) !== observed.publication) {
              return {
                lead: result,
                reconciliation: "required",
                reconciliationError:
                  "This lead changed while its details were loading. Refresh them to continue.",
              };
            }
            const { currentLead } = observed;
            publishLead(leadId, currentLead);
            return { lead: result, currentLead, reconciliation: "ready" };
          } catch {
            if (!ownsMutation()) return { lead: result, reconciliation: "stale" };
            return {
              lead: result,
              reconciliation: "required",
              reconciliationError:
                "Could not load current lead details. Refresh them before making another change.",
            };
          }
        }
        publishLead(leadId, result);
        if (command.next_stage === "enrolled") await refreshConvertedStudents();
        return { lead: result, currentLead: result, reconciliation: "ready" };
      } finally {
        finishMutation();
      }
    },
    [
      beginLeadMutation,
      beginLiveAuthRequest,
      convertLeadToStudent,
      isPreviewMode,
      leadMutationScopeRef,
      leadsRef,
      onStudentMutation,
      persistLeads,
      refreshStudents,
      publishLead,
    ],
  );

  return {
    addLead,
    convertLeadToStudent,
    deleteLead,
    followUpLead,
    refreshLeads,
    updateLead,
  };
}

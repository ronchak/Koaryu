import { useCallback, type Dispatch, type SetStateAction } from "react";

import { api } from "@/lib/api";
import {
  applyLeadUpdate,
  buildPreviewLead,
  buildPreviewLeadConversion,
} from "@/lib/lead-store-model";
import { localId } from "@/lib/store-storage";
import type { BeginLiveAuthRequest, StoreRef } from "@/lib/store-action-types";
import type { Lead, Program, Student } from "@/types";

interface UseStoreLeadActionsOptions {
  beginLiveAuthRequest: BeginLiveAuthRequest;
  isPreviewMode: boolean;
  leadsRef: StoreRef<Lead[]>;
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
  beginLiveAuthRequest,
  isPreviewMode,
  leadsRef,
  persistLeads,
  persistStudents,
  programsRef,
  refreshStudents,
  setLeads,
  setLeadsLoaded,
  setLeadsLoadError,
  studentsRef,
}: UseStoreLeadActionsOptions) {
  const addLead = useCallback(async (data: Partial<Lead>) => {
    if (isPreviewMode) {
      const newLead = buildPreviewLead(data, { idFactory: localId });
      persistLeads([newLead, ...leadsRef.current]);
      return;
    }

    const liveRequest = beginLiveAuthRequest();
    const result = await api.post<Lead>("/leads", data, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return;
    }
    setLeads((current) => [result, ...current]);
  }, [beginLiveAuthRequest, isPreviewMode, leadsRef, persistLeads, setLeads]);

  const updateLead = useCallback(async (id: string, data: Partial<Lead>) => {
    if (isPreviewMode) {
      persistLeads(applyLeadUpdate(leadsRef.current, id, data));
      return;
    }

    const liveRequest = beginLiveAuthRequest();
    const result = await api.patch<Lead>(`/leads/${id}`, data, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return;
    }
    setLeads((current) => current.map((lead) => lead.id === id ? result : lead));
  }, [beginLiveAuthRequest, isPreviewMode, leadsRef, persistLeads, setLeads]);

  const deleteLead = useCallback(async (id: string) => {
    if (isPreviewMode) {
      persistLeads(leadsRef.current.filter((lead) => lead.id !== id));
      return;
    }

    const liveRequest = beginLiveAuthRequest();
    await api.delete(`/leads/${id}`, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return;
    }
    setLeads((current) => current.filter((lead) => lead.id !== id));
  }, [beginLiveAuthRequest, isPreviewMode, leadsRef, persistLeads, setLeads]);

  const refreshLeads = useCallback(async (): Promise<Lead[]> => {
    if (isPreviewMode) {
      return leadsRef.current;
    }

    const request = beginLiveAuthRequest();
    setLeadsLoadError(null);
    setLeadsLoaded(false);
    try {
      const result = await api.get<Lead[]>("/leads", request.token);
      if (!request.isCurrent()) {
        return result;
      }
      setLeads(result);
      setLeadsLoaded(true);
      return result;
    } catch (error) {
      if (request.isCurrent()) {
        setLeadsLoadError(error instanceof Error ? error.message : "Leads could not be loaded.");
        setLeadsLoaded(false);
      }
      throw error;
    }
  }, [
    beginLiveAuthRequest,
    isPreviewMode,
    leadsRef,
    setLeads,
    setLeadsLoaded,
    setLeadsLoadError,
  ]);

  const convertLeadToStudent = useCallback(async (leadId: string) => {
    const lead = leadsRef.current.find((item) => item.id === leadId);
    if (!lead) {
      throw new Error("Lead not found");
    }

    if (lead.converted_student_id) {
      throw new Error("This lead has already been converted.");
    }

    if (isPreviewMode) {
      const conversion = buildPreviewLeadConversion(lead, programsRef.current, {
        idFactory: localId,
      });

      persistStudents([conversion.student, ...studentsRef.current]);
      persistLeads(leadsRef.current.map((item) => (item.id === leadId ? conversion.lead : item)));

      return {
        lead: conversion.lead,
        studentId: conversion.studentId,
      };
    }

    const liveRequest = beginLiveAuthRequest();
    const membershipStartDate = new Date().toISOString().split("T")[0];
    const result = await api.post<Lead>(
      `/leads/${leadId}/convert`,
      {
        status: "active",
        membership_start_date: membershipStartDate,
        program_id: lead.program_id || undefined,
      },
      liveRequest.token
    );
    if (!liveRequest.isCurrent()) {
      return {
        lead: result,
        studentId: result.converted_student_id ?? null,
      };
    }

    setLeads((current) => current.map((item) => (item.id === leadId ? result : item)));
    try {
      await refreshStudents();
    } catch (error) {
      console.error("Failed to refresh students after lead conversion", error);
    }

    return {
      lead: result,
      studentId: result.converted_student_id ?? null,
    };
  }, [
    beginLiveAuthRequest,
    isPreviewMode,
    leadsRef,
    persistLeads,
    persistStudents,
    programsRef,
    refreshStudents,
    setLeads,
    studentsRef,
  ]);

  return {
    addLead,
    convertLeadToStudent,
    deleteLead,
    refreshLeads,
    updateLead,
  };
}

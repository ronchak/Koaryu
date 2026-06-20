import { useCallback, type Dispatch, type SetStateAction } from "react";

import { api } from "@/lib/api";
import {
  MOCK_ATTENDANCE,
  MOCK_BELT_LADDER,
  MOCK_CLASS_TEMPLATES,
  MOCK_ELIGIBILITY,
  MOCK_LEADS,
  MOCK_SESSIONS,
  MOCK_STUDENTS,
} from "@/lib/mock-data";
import { DEMO_STUDIO_NAME, MOCK_BELT_LADDERS, MOCK_PROGRAMS, MOCK_STAFF_MEMBERS } from "@/lib/preview-studio-data";
import type { AuthUserProfile } from "@/lib/store-bootstrap-model";
import type { BeginLiveAuthRequest, StoreRef } from "@/lib/store-action-types";
import { KEYS, clearPreviewStorage, save } from "@/lib/store-storage";
import {
  buildPreviewDemoResetResponse,
  buildPreviewStudioDataClearResponse,
  type DemoResetResponse,
  type StudioDataClearResponse,
} from "@/lib/studio-store-model";
import type { AttendanceRecord, BeltRank, ClassSession, Lead, Program, StaffMember, Student } from "@/types";

const DESTRUCTIVE_ACTION_HEADER = "X-Koaryu-Destructive-Action";
const DEMO_RESET_DESTRUCTIVE_ACTION = "demo-reset";
const CLEAR_STUDIO_DATA_DESTRUCTIVE_ACTION = "clear-studio-data";

interface SupabaseProfileClient {
  auth: {
    updateUser: (attributes: { data: { full_name: string } }) => Promise<{
      error: { message?: string | null } | null;
    }>;
  };
}

interface UseStoreStudioActionsOptions {
  activeUserId: string | null;
  applyClearedStudioData: (studioNameValue?: string) => void;
  applyDemoResetResponse: (data: DemoResetResponse) => void;
  attendanceRef: StoreRef<AttendanceRecord[]>;
  beginLiveAuthRequest: BeginLiveAuthRequest;
  beltRanksRef: StoreRef<BeltRank[]>;
  isPreviewMode: boolean;
  leadsRef: StoreRef<Lead[]>;
  persistPrograms: (next: Program[]) => void;
  sessionsRef: StoreRef<ClassSession[]>;
  setCurrentUser: Dispatch<SetStateAction<AuthUserProfile | null>>;
  setStaffLoadError: Dispatch<SetStateAction<string | null>>;
  setStaffLoaded: Dispatch<SetStateAction<boolean>>;
  setStaffMembers: Dispatch<SetStateAction<StaffMember[]>>;
  setStudioNameState: Dispatch<SetStateAction<string>>;
  studentsRef: StoreRef<Student[]>;
  studioName: string;
  supabase: SupabaseProfileClient;
}

export function useStoreStudioActions({
  activeUserId,
  applyClearedStudioData,
  applyDemoResetResponse,
  attendanceRef,
  beginLiveAuthRequest,
  beltRanksRef,
  isPreviewMode,
  leadsRef,
  persistPrograms,
  sessionsRef,
  setCurrentUser,
  setStaffLoadError,
  setStaffLoaded,
  setStaffMembers,
  setStudioNameState,
  studentsRef,
  studioName,
  supabase,
}: UseStoreStudioActionsOptions) {
  const setStudioName = useCallback(async (name: string) => {
    if (isPreviewMode) {
      setStudioNameState(name);
      save(KEYS.studioName, name);
      return;
    }

    const liveRequest = beginLiveAuthRequest();
    await api.patch("/studios/current", { name }, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return;
    }
    setStudioNameState(name);
  }, [beginLiveAuthRequest, isPreviewMode, setStudioNameState]);

  const updateUserName = useCallback(async (name: string) => {
    const nextName = name.trim();
    if (!nextName) {
      throw new Error("Display name is required.");
    }

    if (isPreviewMode) {
      setCurrentUser((current) => current ? { ...current, full_name: nextName } : current);
      return;
    }

    const liveRequest = beginLiveAuthRequest();

    const { error } = await supabase.auth.updateUser({
      data: { full_name: nextName },
    });

    if (error) {
      throw new Error(error.message || "Failed to update profile.");
    }
    if (!liveRequest.isCurrent()) {
      return;
    }

    setCurrentUser((current) => current ? { ...current, full_name: nextName } : current);
    setStaffMembers((current) =>
      current.map((member) =>
        activeUserId && member.user_id === activeUserId
          ? { ...member, full_name: nextName, updated_at: new Date().toISOString() }
          : member
      )
    );
  }, [activeUserId, beginLiveAuthRequest, isPreviewMode, setCurrentUser, setStaffMembers, supabase]);

  const resetDemoData = useCallback(async (): Promise<DemoResetResponse> => {
    if (isPreviewMode) {
      clearPreviewStorage();
      const previewResponse = buildPreviewDemoResetResponse({
        studioName: DEMO_STUDIO_NAME,
        programs: MOCK_PROGRAMS,
        students: MOCK_STUDENTS,
        leads: MOCK_LEADS,
        beltLadders: MOCK_BELT_LADDERS,
        primaryBeltLadder: MOCK_BELT_LADDER,
        eligibility: MOCK_ELIGIBILITY,
        templates: MOCK_CLASS_TEMPLATES,
        sessions: MOCK_SESSIONS,
        attendance: MOCK_ATTENDANCE,
      });

      save(KEYS.studioName, previewResponse.studio_name);
      save(KEYS.students, previewResponse.students);
      save(KEYS.programs, MOCK_PROGRAMS);
      save(KEYS.beltLadders, MOCK_BELT_LADDERS);
      save(KEYS.leads, previewResponse.leads);
      save(KEYS.beltRanks, MOCK_BELT_LADDER.ranks);
      save(KEYS.sessions, previewResponse.sessions);
      save(KEYS.templates, previewResponse.templates);
      save(KEYS.attendance, previewResponse.attendance);
      save(KEYS.subRankTerm, MOCK_BELT_LADDER.sub_rank_term || "Stripe");
      save(KEYS.ladderName, MOCK_BELT_LADDER.name);
      setStaffMembers(MOCK_STAFF_MEMBERS);
      setStaffLoaded(true);
      setStaffLoadError(null);
      persistPrograms(MOCK_PROGRAMS);

      applyDemoResetResponse(previewResponse);
      return previewResponse;
    }

    const liveRequest = beginLiveAuthRequest();

    const response = await api.post<DemoResetResponse>(
      "/demo/reset",
      {},
      liveRequest.token,
      {
        headers: {
          [DESTRUCTIVE_ACTION_HEADER]: DEMO_RESET_DESTRUCTIVE_ACTION,
        },
        timeoutMs: 60000,
        timeoutMessage: "Demo reset is taking longer than expected. Please try again in a moment.",
      }
    );
    if (!liveRequest.isCurrent()) {
      return response;
    }
    applyDemoResetResponse(response);
    return response;
  }, [
    applyDemoResetResponse,
    beginLiveAuthRequest,
    isPreviewMode,
    persistPrograms,
    setStaffLoadError,
    setStaffLoaded,
    setStaffMembers,
  ]);

  const clearStudioData = useCallback(async (): Promise<StudioDataClearResponse> => {
    if (isPreviewMode) {
      clearPreviewStorage();
      const response = buildPreviewStudioDataClearResponse({
        studioName,
        students: studentsRef.current,
        leads: leadsRef.current,
        beltRanks: beltRanksRef.current,
        sessions: sessionsRef.current,
        attendance: attendanceRef.current,
      });
      applyClearedStudioData(response.studio_name);
      return response;
    }

    const liveRequest = beginLiveAuthRequest();

    const response = await api.delete<StudioDataClearResponse>("/demo/data", liveRequest.token, {
      headers: {
        [DESTRUCTIVE_ACTION_HEADER]: CLEAR_STUDIO_DATA_DESTRUCTIVE_ACTION,
      },
      timeoutMs: 60000,
      timeoutMessage: "Studio data clear is taking longer than expected. Please try again in a moment.",
    });
    if (!liveRequest.isCurrent()) {
      return response;
    }
    applyClearedStudioData(response.studio_name);
    return response;
  }, [
    applyClearedStudioData,
    attendanceRef,
    beginLiveAuthRequest,
    beltRanksRef,
    isPreviewMode,
    leadsRef,
    sessionsRef,
    studentsRef,
    studioName,
  ]);

  return {
    clearStudioData,
    resetDemoData,
    setStudioName,
    updateUserName,
  };
}

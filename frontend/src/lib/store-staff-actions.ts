import { useCallback, type Dispatch, type SetStateAction } from "react";
import { api } from "@/lib/api";
import {
  applyStaffRoleUpdate,
  buildPreviewStaffInvite,
  sortStaffMembers,
  upsertStaffMember,
} from "@/lib/staff-store-model";
import type { BeginLiveAuthRequest } from "@/lib/store-action-types";
import type { StaffInviteCreate, StaffMember, StaffRoleName } from "@/types";

interface UseStoreStaffActionsOptions {
  activeUserId: string | null;
  beginLiveAuthRequest: BeginLiveAuthRequest;
  isPreviewMode: boolean;
  setStaffLoadError: Dispatch<SetStateAction<string | null>>;
  setStaffLoaded: Dispatch<SetStateAction<boolean>>;
  setStaffMembers: Dispatch<SetStateAction<StaffMember[]>>;
  staffMembers: StaffMember[];
}

export function useStoreStaffActions({
  activeUserId,
  beginLiveAuthRequest,
  isPreviewMode,
  setStaffLoadError,
  setStaffLoaded,
  setStaffMembers,
  staffMembers,
}: UseStoreStaffActionsOptions) {
  const refreshStaff = useCallback(async (): Promise<StaffMember[]> => {
    if (isPreviewMode) {
      const sorted = sortStaffMembers(staffMembers, activeUserId);
      setStaffMembers(sorted);
      setStaffLoaded(true);
      setStaffLoadError(null);
      return sorted;
    }

    const request = beginLiveAuthRequest();

    try {
      const result = await api.get<StaffMember[]>("/staff", request.token);
      const sorted = sortStaffMembers(result, activeUserId);
      if (!request.isCurrent()) {
        return sorted;
      }
      setStaffMembers(sorted);
      setStaffLoaded(true);
      setStaffLoadError(null);
      return sorted;
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "";
      const message =
        rawMessage && rawMessage !== "Internal Server Error"
          ? rawMessage
          : "Staff could not be loaded. Please try again.";
      if (request.isCurrent()) {
        setStaffLoaded(true);
        setStaffLoadError(message);
      }
      throw error;
    }
  }, [activeUserId, beginLiveAuthRequest, isPreviewMode, setStaffLoadError, setStaffLoaded, setStaffMembers, staffMembers]);

  const inviteStaff = useCallback(async (data: StaffInviteCreate): Promise<StaffMember> => {
    if (isPreviewMode) {
      const previewMember = buildPreviewStaffInvite(data, activeUserId);
      setStaffMembers((current) =>
        sortStaffMembers([...current, previewMember], activeUserId)
      );
      setStaffLoaded(true);
      setStaffLoadError(null);
      return previewMember;
    }

    const liveRequest = beginLiveAuthRequest();

    const result = await api.post<StaffMember>("/staff/invitations", data, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return result;
    }
    setStaffMembers((current) =>
      upsertStaffMember(current, result, activeUserId)
    );
    setStaffLoaded(true);
    setStaffLoadError(null);
    return result;
  }, [activeUserId, beginLiveAuthRequest, isPreviewMode, setStaffLoadError, setStaffLoaded, setStaffMembers]);

  const updateStaffRole = useCallback(async (
    id: string,
    role: StaffRoleName
  ): Promise<StaffMember> => {
    if (isPreviewMode) {
      const nowIso = new Date().toISOString();
      const previewUpdate = applyStaffRoleUpdate(staffMembers, id, role, activeUserId, nowIso);
      if (!previewUpdate.updated) throw new Error("Staff member not found.");
      setStaffMembers((current) =>
        applyStaffRoleUpdate(current, id, role, activeUserId, nowIso).members
      );
      return previewUpdate.updated;
    }

    const liveRequest = beginLiveAuthRequest();

    const result = await api.patch<StaffMember>(`/staff/${id}`, { role }, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return result;
    }
    setStaffMembers((current) =>
      sortStaffMembers(current.map((member) => (member.id === id ? result : member)), activeUserId)
    );
    return result;
  }, [activeUserId, beginLiveAuthRequest, isPreviewMode, setStaffMembers, staffMembers]);

  const removeStaff = useCallback(async (id: string): Promise<void> => {
    if (isPreviewMode) {
      setStaffMembers((current) => current.filter((member) => member.id !== id));
      return;
    }

    const liveRequest = beginLiveAuthRequest();

    await api.delete(`/staff/${id}`, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return;
    }
    setStaffMembers((current) => current.filter((member) => member.id !== id));
  }, [beginLiveAuthRequest, isPreviewMode, setStaffMembers]);

  return {
    inviteStaff,
    refreshStaff,
    removeStaff,
    updateStaffRole,
  };
}

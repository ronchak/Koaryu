import { useCallback, type Dispatch, type SetStateAction } from "react";
import { api } from "@/lib/api";
import {
  applyStaffArchive,
  applyStaffLegalNameUpdate,
  applyStaffRoleUpdate,
  applyStaffUnarchive,
  buildPreviewStaffDeletionResponse,
  buildPreviewStaffInvite,
  buildStaffDeletionRequest,
  buildStaffListPath,
  getPendingInviteRevokeError,
  getStaffLifecyclePreviewError,
  mergeStaffLegalNameResponse,
  normalizeStaffInvite,
  sortStaffMembers,
  upsertStaffMember,
} from "@/lib/staff-store-model";
import type { BeginLiveAuthRequest } from "@/lib/store-action-types";
import type {
  StaffInviteCreate,
  StaffDeletionRequestResponse,
  StaffLegalNameResponse,
  StaffLegalNameUpdate,
  StaffMember,
  StaffRoleName,
} from "@/types";

interface UseStoreStaffActionsOptions {
  activeUserEmail: string;
  activeUserId: string | null;
  beginLiveAuthRequest: BeginLiveAuthRequest;
  isPreviewMode: boolean;
  setStaffLoadError: Dispatch<SetStateAction<string | null>>;
  setStaffLoaded: Dispatch<SetStateAction<boolean>>;
  setStaffMembers: Dispatch<SetStateAction<StaffMember[]>>;
  staffMembers: StaffMember[];
}

export function useStoreStaffActions({
  activeUserEmail,
  activeUserId,
  beginLiveAuthRequest,
  isPreviewMode,
  setStaffLoadError,
  setStaffLoaded,
  setStaffMembers,
  staffMembers,
}: UseStoreStaffActionsOptions) {
  const refreshStaff = useCallback(async (includeArchived = false): Promise<StaffMember[]> => {
    if (isPreviewMode) {
      const sorted = sortStaffMembers(staffMembers, activeUserId);
      setStaffMembers(sorted);
      setStaffLoaded(true);
      setStaffLoadError(null);
      return sorted;
    }

    const request = beginLiveAuthRequest();

    try {
      const result = await api.get<StaffMember[]>(buildStaffListPath(includeArchived), request.token);
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
    const payload = normalizeStaffInvite(data);

    if (isPreviewMode) {
      const previewMember = buildPreviewStaffInvite(payload, activeUserId);
      setStaffMembers((current) =>
        sortStaffMembers([...current, previewMember], activeUserId)
      );
      setStaffLoaded(true);
      setStaffLoadError(null);
      return previewMember;
    }

    const liveRequest = beginLiveAuthRequest();

    const result = await api.post<StaffMember>("/staff/invitations", payload, liveRequest.token);
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

  const updateStaffLegalName = useCallback(async (
    userId: string,
    firstName: string,
    lastName: string
  ): Promise<StaffLegalNameResponse> => {
    if (!userId) {
      throw new Error("Staff member identity is required.");
    }

    const payload: StaffLegalNameUpdate = {
      legal_first_name: firstName,
      legal_last_name: lastName,
    };

    if (isPreviewMode) {
      const previewUpdate = applyStaffLegalNameUpdate(staffMembers, userId, firstName, lastName);
      if (!previewUpdate.updated) {
        throw new Error("Staff member not found.");
      }

      setStaffMembers((current) =>
        applyStaffLegalNameUpdate(current, userId, firstName, lastName).members
      );
      return {
        user_id: userId,
        legal_first_name: firstName,
        legal_last_name: lastName,
      };
    }

    const liveRequest = beginLiveAuthRequest();
    const response = await api.patch<StaffLegalNameResponse>(
      `/staff/${userId}/legal-name`,
      payload,
      liveRequest.token
    );
    if (!liveRequest.isCurrent()) {
      return response;
    }

    setStaffMembers((current) => mergeStaffLegalNameResponse(current, response).members);
    return response;
  }, [beginLiveAuthRequest, isPreviewMode, setStaffMembers, staffMembers]);

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

  const archiveStaff = useCallback(async (id: string): Promise<StaffMember> => {
    const previewError = getStaffLifecyclePreviewError(staffMembers, id, "archive", {
      currentUserId: activeUserId,
    });
    if (isPreviewMode) {
      if (previewError) {
        throw new Error(previewError);
      }
      const nowIso = new Date().toISOString();
      const previewUpdate = applyStaffArchive(staffMembers, id, activeUserId, nowIso);
      if (!previewUpdate.updated) {
        throw new Error("Staff member not found.");
      }
      setStaffMembers((current) => applyStaffArchive(current, id, activeUserId, nowIso).members);
      return previewUpdate.updated;
    }

    const liveRequest = beginLiveAuthRequest();
    const result = await api.post<StaffMember>(`/staff/${id}/archive`, {}, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return result;
    }
    setStaffMembers((current) => upsertStaffMember(current, result, activeUserId));
    return result;
  }, [activeUserId, beginLiveAuthRequest, isPreviewMode, setStaffMembers, staffMembers]);

  const unarchiveStaff = useCallback(async (id: string): Promise<StaffMember> => {
    const previewError = getStaffLifecyclePreviewError(staffMembers, id, "unarchive", {
      currentUserId: activeUserId,
    });
    if (isPreviewMode) {
      if (previewError) {
        throw new Error(previewError);
      }
      const nowIso = new Date().toISOString();
      const previewUpdate = applyStaffUnarchive(staffMembers, id, activeUserId, nowIso);
      if (!previewUpdate.updated) {
        throw new Error("Staff member not found.");
      }
      setStaffMembers((current) => applyStaffUnarchive(current, id, activeUserId, nowIso).members);
      return previewUpdate.updated;
    }

    const liveRequest = beginLiveAuthRequest();
    const result = await api.post<StaffMember>(`/staff/${id}/unarchive`, {}, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return result;
    }
    setStaffMembers((current) => upsertStaffMember(current, result, activeUserId));
    return result;
  }, [activeUserId, beginLiveAuthRequest, isPreviewMode, setStaffMembers, staffMembers]);

  const scheduleStaffDeletion = useCallback(async (
    id: string,
    confirmationName: string,
    reason?: string
  ): Promise<StaffDeletionRequestResponse> => {
    const payload = buildStaffDeletionRequest(confirmationName, reason);
    const previewError = getStaffLifecyclePreviewError(staffMembers, id, "scheduleDeletion", {
      currentUserId: activeUserId,
    });
    const target = staffMembers.find((member) => member.id === id);
    if (isPreviewMode) {
      if (previewError || !target) {
        throw new Error(previewError || "Staff member not found.");
      }
      return buildPreviewStaffDeletionResponse(target, payload.reason, activeUserEmail);
    }

    const liveRequest = beginLiveAuthRequest();
    const result = await api.post<StaffDeletionRequestResponse>(
      `/staff/${id}/deletion-request`,
      payload,
      liveRequest.token
    );
    return result;
  }, [activeUserEmail, activeUserId, beginLiveAuthRequest, isPreviewMode, staffMembers]);

  const removeStaff = useCallback(async (id: string): Promise<void> => {
    const revokeError = getPendingInviteRevokeError(staffMembers, id);
    if (revokeError) {
      throw new Error(revokeError);
    }
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
  }, [beginLiveAuthRequest, isPreviewMode, setStaffMembers, staffMembers]);

  return {
    archiveStaff,
    inviteStaff,
    refreshStaff,
    removeStaff,
    scheduleStaffDeletion,
    unarchiveStaff,
    updateStaffLegalName,
    updateStaffRole,
  };
}

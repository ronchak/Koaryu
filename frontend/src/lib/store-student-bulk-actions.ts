import { useCallback } from "react";

import { api } from "@/lib/api";
import {
  applyAddedTagsToStudents,
  applyStatusToStudents,
  normalizeStudentIds,
  normalizeTags,
} from "@/lib/student-store-model";
import type { BeginLiveAuthRequest, StoreRef } from "@/lib/store-action-types";
import type {
  BulkStudentStatusUpdateRequest,
  BulkStudentStatusUpdateResponse,
  BulkStudentTagUpdateRequest,
  BulkStudentTagUpdateResponse,
  Student,
  StudentStatus,
} from "@/types";

type CommitStudents = (
  next: Student[] | ((current: Student[]) => Student[]),
  options?: { mayBePartial?: boolean }
) => void;

interface UseStoreStudentBulkActionsOptions {
  beginLiveAuthRequest: BeginLiveAuthRequest;
  commitStudents: CommitStudents;
  isPreviewMode: boolean;
  persistStudents: (next: Student[]) => void;
  refreshStudents: () => Promise<Student[]>;
  studentsMayBePartial: boolean;
  studentsRef: StoreRef<Student[]>;
}

export function useStoreStudentBulkActions({
  beginLiveAuthRequest,
  commitStudents,
  isPreviewMode,
  persistStudents,
  refreshStudents,
  studentsMayBePartial,
  studentsRef,
}: UseStoreStudentBulkActionsOptions) {
  const bulkAddTagsToStudents = useCallback(async (
    studentIds: string[],
    tags: string[],
    options?: { refreshMode?: "full" | "local" }
  ): Promise<BulkStudentTagUpdateResponse> => {
    const normalizedStudentIds = normalizeStudentIds(studentIds);
    const normalizedTags = normalizeTags(tags);
    const shouldRefreshFullRoster = options?.refreshMode !== "local";

    if (normalizedStudentIds.length === 0) {
      throw new Error("Select at least one student.");
    }

    if (normalizedTags.length === 0) {
      throw new Error("Enter at least one tag.");
    }

    const payload: BulkStudentTagUpdateRequest = {
      student_ids: normalizedStudentIds,
      tags_to_add: normalizedTags,
      tags_to_remove: [],
    };

    if (isPreviewMode) {
      const selectedIdSet = new Set(normalizedStudentIds);
      const nextStudents = applyAddedTagsToStudents(
        studentsRef.current,
        normalizedStudentIds,
        normalizedTags
      );
      persistStudents(nextStudents);

      return {
        updated: studentsRef.current.filter((student) => selectedIdSet.has(student.id)).length,
      };
    }

    const liveRequest = beginLiveAuthRequest();

    let response: BulkStudentTagUpdateResponse;
    try {
      response = await api.post<BulkStudentTagUpdateResponse>(
        "/students/bulk/tags",
        payload,
        liveRequest.token
      );
    } catch (error) {
      if (liveRequest.isCurrent() && shouldRefreshFullRoster) {
        try {
          await refreshStudents();
        } catch (refreshError) {
          console.error("Failed to refresh students after bulk tag update error", refreshError);
        }
      }
      throw error;
    }
    if (!liveRequest.isCurrent()) {
      return response;
    }

    if (shouldRefreshFullRoster) {
      try {
        await refreshStudents();
      } catch (error) {
        console.error("Failed to refresh students after bulk tag update", error);
        if (liveRequest.isCurrent()) {
          commitStudents((current) => applyAddedTagsToStudents(current, normalizedStudentIds, normalizedTags), {
            mayBePartial: studentsMayBePartial,
          });
        }
      }
    } else {
      commitStudents((current) => applyAddedTagsToStudents(current, normalizedStudentIds, normalizedTags), {
        mayBePartial: studentsMayBePartial,
      });
    }

    return response;
  }, [
    beginLiveAuthRequest,
    commitStudents,
    isPreviewMode,
    persistStudents,
    refreshStudents,
    studentsMayBePartial,
    studentsRef,
  ]);

  const bulkUpdateStudentStatus = useCallback(async (
    studentIds: string[],
    status: StudentStatus,
    options?: { refreshMode?: "full" | "local" }
  ): Promise<BulkStudentStatusUpdateResponse> => {
    const normalizedStudentIds = normalizeStudentIds(studentIds);
    const shouldRefreshFullRoster = options?.refreshMode !== "local";

    if (normalizedStudentIds.length === 0) {
      throw new Error("Select at least one student.");
    }

    const payload: BulkStudentStatusUpdateRequest = {
      student_ids: normalizedStudentIds,
      status,
    };

    if (isPreviewMode) {
      const selectedIdSet = new Set(normalizedStudentIds);
      persistStudents(applyStatusToStudents(studentsRef.current, normalizedStudentIds, status));

      return {
        updated: studentsRef.current.filter((student) => selectedIdSet.has(student.id)).length,
      };
    }

    const liveRequest = beginLiveAuthRequest();

    let response: BulkStudentStatusUpdateResponse;
    try {
      response = await api.post<BulkStudentStatusUpdateResponse>(
        "/students/bulk/status",
        payload,
        liveRequest.token
      );
    } catch (error) {
      if (liveRequest.isCurrent() && shouldRefreshFullRoster) {
        try {
          await refreshStudents();
        } catch (refreshError) {
          console.error("Failed to refresh students after bulk status update error", refreshError);
        }
      }
      throw error;
    }
    if (!liveRequest.isCurrent()) {
      return response;
    }

    if (shouldRefreshFullRoster) {
      try {
        await refreshStudents();
      } catch (error) {
        console.error("Failed to refresh students after bulk status update", error);
        if (liveRequest.isCurrent()) {
          commitStudents((current) => applyStatusToStudents(current, normalizedStudentIds, status), {
            mayBePartial: studentsMayBePartial,
          });
        }
      }
    } else {
      commitStudents((current) => applyStatusToStudents(current, normalizedStudentIds, status), {
        mayBePartial: studentsMayBePartial,
      });
    }

    return response;
  }, [
    beginLiveAuthRequest,
    commitStudents,
    isPreviewMode,
    persistStudents,
    refreshStudents,
    studentsMayBePartial,
    studentsRef,
  ]);

  return {
    bulkAddTagsToStudents,
    bulkUpdateStudentStatus,
  };
}

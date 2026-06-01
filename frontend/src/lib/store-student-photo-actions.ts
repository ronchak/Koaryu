import { useCallback } from "react";

import { api } from "@/lib/api";
import type { BeginLiveAuthRequest, StoreRef } from "@/lib/store-action-types";
import type { Student } from "@/types";

type CommitStudents = (
  next: Student[] | ((current: Student[]) => Student[]),
  options?: { mayBePartial?: boolean }
) => void;

interface UseStoreStudentPhotoActionsOptions {
  beginLiveAuthRequest: BeginLiveAuthRequest;
  commitStudents: CommitStudents;
  isPreviewMode: boolean;
  previewStudentPhotoUrlsRef: StoreRef<Record<string, string>>;
  studentsMayBePartial: boolean;
  studentsRef: StoreRef<Student[]>;
}

export function useStoreStudentPhotoActions({
  beginLiveAuthRequest,
  commitStudents,
  isPreviewMode,
  previewStudentPhotoUrlsRef,
  studentsMayBePartial,
  studentsRef,
}: UseStoreStudentPhotoActionsOptions) {
  const uploadStudentPhoto = useCallback(async (
    studentId: string,
    file: File
  ): Promise<Student> => {
    if (isPreviewMode) {
      const student = studentsRef.current.find((item) => item.id === studentId);
      if (!student) {
        throw new Error("Student not found");
      }

      const existingUrl = previewStudentPhotoUrlsRef.current[studentId];
      if (existingUrl) {
        URL.revokeObjectURL(existingUrl);
      }

      const now = new Date().toISOString();
      const photoUrl = URL.createObjectURL(file);
      previewStudentPhotoUrlsRef.current[studentId] = photoUrl;
      const updated: Student = {
        ...student,
        photo_path: `preview/students/${studentId}/${file.name}`,
        photo_url: photoUrl,
        photo_updated_at: now,
        updated_at: now,
      };

      commitStudents((current) =>
        current.map((item) => item.id === studentId ? updated : item)
      );
      return updated;
    }

    const liveRequest = beginLiveAuthRequest();
    const body = new FormData();
    body.append("file", file);

    const updated = await api.postForm<Student>(
      `/students/${studentId}/photo`,
      body,
      liveRequest.token
    );
    if (!liveRequest.isCurrent()) {
      return updated;
    }
    commitStudents(
      (current) =>
        current.some((item) => item.id === studentId)
          ? current.map((item) => item.id === studentId ? updated : item)
          : [updated, ...current],
      { mayBePartial: studentsMayBePartial }
    );
    return updated;
  }, [
    beginLiveAuthRequest,
    commitStudents,
    isPreviewMode,
    previewStudentPhotoUrlsRef,
    studentsMayBePartial,
    studentsRef,
  ]);

  const deleteStudentPhoto = useCallback(async (studentId: string): Promise<Student> => {
    if (isPreviewMode) {
      const student = studentsRef.current.find((item) => item.id === studentId);
      if (!student) {
        throw new Error("Student not found");
      }

      const existingUrl = previewStudentPhotoUrlsRef.current[studentId];
      if (existingUrl) {
        URL.revokeObjectURL(existingUrl);
        delete previewStudentPhotoUrlsRef.current[studentId];
      }

      const updated: Student = {
        ...student,
        photo_path: null,
        photo_url: null,
        photo_updated_at: null,
        updated_at: new Date().toISOString(),
      };

      commitStudents((current) =>
        current.map((item) => item.id === studentId ? updated : item)
      );
      return updated;
    }

    const liveRequest = beginLiveAuthRequest();
    const updated = await api.delete<Student>(`/students/${studentId}/photo`, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return updated;
    }
    commitStudents(
      (current) =>
        current.some((item) => item.id === studentId)
          ? current.map((item) => item.id === studentId ? updated : item)
          : [updated, ...current],
      { mayBePartial: studentsMayBePartial }
    );
    return updated;
  }, [
    beginLiveAuthRequest,
    commitStudents,
    isPreviewMode,
    previewStudentPhotoUrlsRef,
    studentsMayBePartial,
    studentsRef,
  ]);

  return {
    deleteStudentPhoto,
    uploadStudentPhoto,
  };
}

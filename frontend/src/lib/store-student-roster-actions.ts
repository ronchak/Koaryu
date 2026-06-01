import { useCallback } from "react";

import { api } from "@/lib/api";
import { markPerformance, measurePerformance, startStudentPagePerformanceSpan } from "@/lib/performance";
import {
  buildPreviewStudentListPage,
  type StudentListQuery,
} from "@/lib/student-list-page";
import { buildPreviewStudent } from "@/lib/student-store-model";
import type { BeginLiveAuthRequest, StoreRef } from "@/lib/store-action-types";
import { localId } from "@/lib/store-storage";
import {
  fetchAllStudents,
  fetchStudentPage,
} from "@/lib/store-student-pages";
import type {
  Program,
  Student,
  StudentCreate,
  StudentListResponse,
  StudentUpdate,
} from "@/types";

type CommitStudents = (
  next: Student[] | ((current: Student[]) => Student[]),
  options?: { mayBePartial?: boolean }
) => void;

interface UseStoreStudentRosterActionsOptions {
  beginLiveAuthRequest: BeginLiveAuthRequest;
  commitStudents: CommitStudents;
  isPreviewMode: boolean;
  persistStudents: (next: Student[]) => void;
  previewStudentPhotoUrlsRef: StoreRef<Record<string, string>>;
  programsRef: StoreRef<Program[]>;
  setStudentsLoadError: (message: string | null) => void;
  studentsMayBePartial: boolean;
  studentsRef: StoreRef<Student[]>;
  token: string | null;
}

export function useStoreStudentRosterActions({
  beginLiveAuthRequest,
  commitStudents,
  isPreviewMode,
  persistStudents,
  previewStudentPhotoUrlsRef,
  programsRef,
  setStudentsLoadError,
  studentsMayBePartial,
  studentsRef,
  token,
}: UseStoreStudentRosterActionsOptions) {
  const addStudent = useCallback(async (data: StudentCreate): Promise<Student> => {
    if (isPreviewMode) {
      const newStudent = buildPreviewStudent(data, programsRef.current, {
        idFactory: localId,
      });
      persistStudents([newStudent, ...studentsRef.current]);
      return newStudent;
    }

    const liveRequest = beginLiveAuthRequest();
    const result = await api.post<Student>("/students", data, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return result;
    }
    commitStudents((current) => [result, ...current], { mayBePartial: studentsMayBePartial });
    return result;
  }, [
    beginLiveAuthRequest,
    commitStudents,
    isPreviewMode,
    persistStudents,
    programsRef,
    studentsMayBePartial,
    studentsRef,
  ]);

  const updateStudent = useCallback(async (id: string, data: StudentUpdate): Promise<Student> => {
    if (isPreviewMode) {
      let updatedStudent: Student | null = null;
      const next = studentsRef.current.map((student) => {
        if (student.id !== id) {
          return student;
        }
        updatedStudent = {
            ...student,
            ...data,
            legal_first_name: data.legal_first_name ?? student.legal_first_name,
            legal_last_name: data.legal_last_name ?? student.legal_last_name,
            status: data.status ?? student.status,
            tags: data.tags ?? student.tags,
            updated_at: new Date().toISOString(),
          };
        return updatedStudent;
      });
      persistStudents(next);
      if (!updatedStudent) {
        throw new Error("Student not found.");
      }
      return updatedStudent;
    }

    const liveRequest = beginLiveAuthRequest();
    const result = await api.patch<Student>(`/students/${id}`, data, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return result;
    }
    commitStudents(
      (current) => current.map((student) => student.id === id ? result : student),
      { mayBePartial: studentsMayBePartial }
    );
    return result;
  }, [
    beginLiveAuthRequest,
    commitStudents,
    isPreviewMode,
    persistStudents,
    studentsMayBePartial,
    studentsRef,
  ]);

  const deleteStudents = useCallback(async (ids: string[]) => {
    if (isPreviewMode) {
      const idSet = new Set(ids);
      ids.forEach((studentId) => {
        const photoUrl = previewStudentPhotoUrlsRef.current[studentId];
        if (photoUrl) {
          URL.revokeObjectURL(photoUrl);
          delete previewStudentPhotoUrlsRef.current[studentId];
        }
      });
      const next = studentsRef.current.filter((student) => !idSet.has(student.id));
      persistStudents(next);
      return;
    }

    const liveRequest = beginLiveAuthRequest();
    for (const id of ids) {
      await api.delete(`/students/${id}`, liveRequest.token);
    }
    if (!liveRequest.isCurrent()) {
      return;
    }
    const idSet = new Set(ids);
    commitStudents(
      (current) => current.filter((student) => !idSet.has(student.id)),
      { mayBePartial: studentsMayBePartial }
    );
  }, [
    beginLiveAuthRequest,
    commitStudents,
    isPreviewMode,
    persistStudents,
    previewStudentPhotoUrlsRef,
    studentsMayBePartial,
    studentsRef,
  ]);

  const refreshStudents = useCallback(async (): Promise<Student[]> => {
    if (isPreviewMode) {
      return studentsRef.current;
    }

    const request = beginLiveAuthRequest();

    try {
      markPerformance("students.refresh_started");
      const nextStudents = await fetchAllStudents(request.token, { timeoutMs: 30000 });
      markPerformance("students.refresh_finished");
      measurePerformance(
        "students.refresh_duration",
        "students.refresh_started",
        "students.refresh_finished"
      );
      if (!request.isCurrent()) {
        return nextStudents;
      }
      commitStudents(nextStudents);
      return nextStudents;
    } catch (error) {
      if (request.isCurrent()) {
        setStudentsLoadError(
          error instanceof Error ? error.message : "Failed to load students."
        );
      }
      throw error;
    }
  }, [beginLiveAuthRequest, commitStudents, isPreviewMode, setStudentsLoadError, studentsRef]);

  const listStudentsPage = useCallback(async (
    query: StudentListQuery = {},
    options?: { signal?: AbortSignal; timeoutMs?: number | null }
  ): Promise<StudentListResponse> => {
    if (isPreviewMode) {
      return buildPreviewStudentListPage(studentsRef.current, query);
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const pageSpan = startStudentPagePerformanceSpan(query);

    try {
      const result = await fetchStudentPage(token, query, {
        timeoutMs: 12000,
        ...options,
      });
      pageSpan.finish({ total: result.total });
      return result;
    } catch (error) {
      pageSpan.finish({ error: true });
      throw error;
    }
  }, [isPreviewMode, studentsRef, token]);

  return {
    addStudent,
    deleteStudents,
    listStudentsPage,
    refreshStudents,
    updateStudent,
  };
}

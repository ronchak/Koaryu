"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toLocalDateKey } from "@/lib/date";
import {
  buildStudentDetailModel,
  validateStudentPhotoFile,
} from "@/lib/student-detail-page-model";
import type {
  BeltsStoreContextValue,
  ConfigStoreContextValue,
  ProgramsStoreContextValue,
  StudentsStoreContextValue,
} from "@/lib/store-contexts";
import { hasStaffPermission } from "@/lib/staff-permissions";
import type { BeltLadder, Promotion, Student, StudentUpdate } from "@/types";

const EMPTY_PROMOTION_HISTORY: Promotion[] = [];

type StudentDetailPageControllerOptions = {
  beltStore: Pick<
    BeltsStoreContextValue,
    "beltLadders" | "loadPromotionHistory" | "promotionHistoryByStudent"
  >;
  config: Pick<ConfigStoreContextValue, "currentRole" | "isPreviewMode" | "token">;
  programsStore: Pick<ProgramsStoreContextValue, "programs">;
  studentsStore: Pick<
    StudentsStoreContextValue,
    | "deleteStudentPhoto"
    | "deleteStudents"
    | "students"
    | "studentsLoaded"
    | "updateStudent"
    | "uploadStudentPhoto"
  >;
};

export function useStudentDetailPageController({
  beltStore,
  config,
  programsStore,
  studentsStore,
}: StudentDetailPageControllerOptions) {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const { isPreviewMode, token } = config;
  const canManageRoster = hasStaffPermission(config.currentRole, "manage_roster_bulk");
  const canManageStudentLifecycle = hasStaffPermission(
    config.currentRole,
    "manage_student_lifecycle"
  );
  const {
    deleteStudentPhoto,
    deleteStudents,
    students,
    studentsLoaded,
    updateStudent,
    uploadStudentPhoto,
  } = studentsStore;
  const { programs } = programsStore;
  const {
    beltLadders: storeBeltLadders,
    loadPromotionHistory: loadPromotionHistoryForStudent,
    promotionHistoryByStudent,
  } = beltStore;

  const [showEdit, setShowEdit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hydratedStudent, setHydratedStudent] = useState<Student | null>(null);
  const [isLoadingStudent, setIsLoadingStudent] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fallbackBeltLadders, setFallbackBeltLadders] = useState<BeltLadder[]>([]);
  const [promotionHistoryState, setPromotionHistoryState] = useState<{
    studentId: string;
    items: Promotion[];
  } | null>(null);
  const [isLoadingFallbackBeltLadders, setIsLoadingFallbackBeltLadders] = useState(false);
  const [isLoadingPromotionHistory, setIsLoadingPromotionHistory] = useState(false);
  const [beltLoadError, setBeltLoadError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [isPhotoSaving, setIsPhotoSaving] = useState(false);

  const listStudent = useMemo(
    () => students.find((student) => student.id === id),
    [id, students]
  );
  const cachedPromotionHistory = promotionHistoryByStudent[id];

  useEffect(() => {
    return () => {
      if (photoPreviewUrl) {
        URL.revokeObjectURL(photoPreviewUrl);
      }
    };
  }, [photoPreviewUrl]);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    async function loadStudent() {
      if (isPreviewMode || !token) {
        if (mounted) {
          setHydratedStudent(null);
          setLoadError(null);
          setIsLoadingStudent(false);
        }
        return;
      }

      if (listStudent) {
        if (mounted) {
          setHydratedStudent(null);
          setLoadError(null);
          setIsLoadingStudent(false);
        }
        return;
      }

      if (!studentsLoaded) {
        if (mounted) {
          setHydratedStudent(null);
          setLoadError(null);
          setIsLoadingStudent(false);
        }
        return;
      }

      setIsLoadingStudent(true);
      setLoadError(null);

      try {
        const result = await api.get<Student>(`/students/${id}`, token, {
          signal: controller.signal,
        });
        if (mounted) {
          setHydratedStudent(result);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        if (mounted) {
          setLoadError(error instanceof Error ? error.message : "Failed to load student");
        }
      } finally {
        if (mounted) {
          setIsLoadingStudent(false);
        }
      }
    }

    void loadStudent();

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [id, isPreviewMode, listStudent, studentsLoaded, token]);

  useEffect(() => {
    let mounted = true;

    async function loadFallbackBeltLadders() {
      if (isPreviewMode || !token || storeBeltLadders.length > 0) {
        if (mounted) {
          setIsLoadingFallbackBeltLadders(false);
        }
        return;
      }

      setIsLoadingFallbackBeltLadders(true);
      setBeltLoadError(null);

      try {
        const laddersResult = await api.get<BeltLadder[]>("/belts/ladders", token);
        if (!mounted) return;
        setFallbackBeltLadders(laddersResult);
      } catch (error) {
        if (mounted) {
          setBeltLoadError(
            error instanceof Error ? error.message : "Failed to load belt ladder"
          );
        }
      } finally {
        if (mounted) {
          setIsLoadingFallbackBeltLadders(false);
        }
      }
    }

    void loadFallbackBeltLadders();

    return () => {
      mounted = false;
    };
  }, [isPreviewMode, storeBeltLadders.length, token]);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    async function loadStudentPromotionHistory() {
      const cachedHistory = cachedPromotionHistory;
      setPromotionHistoryState({ studentId: id, items: cachedHistory ?? [] });

      if (isPreviewMode || !token) {
        if (mounted) {
          setBeltLoadError(null);
          setIsLoadingPromotionHistory(false);
        }
        return;
      }

      setIsLoadingPromotionHistory(!cachedHistory);
      setBeltLoadError(null);

      try {
        const promotionsResult = await loadPromotionHistoryForStudent(id, {
          signal: controller.signal,
        });

        if (mounted) {
          setPromotionHistoryState({ studentId: id, items: promotionsResult });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (mounted) {
          setBeltLoadError(
            error instanceof Error ? error.message : "Failed to load belt history"
          );
        }
      } finally {
        if (mounted) {
          setIsLoadingPromotionHistory(false);
        }
      }
    }

    void loadStudentPromotionHistory();

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [cachedPromotionHistory, id, isPreviewMode, loadPromotionHistoryForStudent, token]);

  const student = hydratedStudent?.id === id ? hydratedStudent : listStudent;
  const promotionHistory = promotionHistoryState?.studentId === id
    ? promotionHistoryState.items
    : EMPTY_PROMOTION_HISTORY;
  const beltLadders = storeBeltLadders.length > 0 ? storeBeltLadders : fallbackBeltLadders;
  const isLoadingBeltData = isLoadingPromotionHistory || (
    beltLadders.length === 0 && isLoadingFallbackBeltLadders
  );
  const detail = useMemo(
    () =>
      student
        ? buildStudentDetailModel({
            beltLadders,
            promotionHistory,
            student,
            today: toLocalDateKey(),
          })
        : null,
    [beltLadders, promotionHistory, student]
  );

  async function handleEdit(data: StudentUpdate) {
    if (!student) return;
    setIsSaving(true);
    setActionMessage(null);
    try {
      const updated = await updateStudent(id, data);
      setHydratedStudent(updated);
      setShowEdit(false);
      setActionMessage("Student profile updated.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeleteStudent() {
    if (!canManageRoster) return;

    setIsDeleting(true);
    setDeleteError(null);

    try {
      await deleteStudents([id]);
      router.push("/students");
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Failed to archive student.");
      setIsDeleting(false);
    }
  }

  async function handlePhotoSelected(file: File): Promise<boolean> {
    const validationError = validateStudentPhotoFile(file);
    if (validationError) {
      setPhotoError(validationError);
      return false;
    }

    const nextPreviewUrl = URL.createObjectURL(file);
    setPhotoPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return nextPreviewUrl;
    });
    setPhotoError(null);
    setActionMessage(null);
    setIsPhotoSaving(true);

    try {
      const updated = await uploadStudentPhoto(id, file);
      setHydratedStudent(updated);
      setActionMessage("Student photo updated.");
      setPhotoPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    } catch (error) {
      setPhotoError(error instanceof Error ? error.message : "Failed to update student photo.");
    } finally {
      setIsPhotoSaving(false);
    }

    return true;
  }

  async function handleDeletePhoto() {
    if (!canManageRoster) return;

    setPhotoError(null);
    setActionMessage(null);
    setIsPhotoSaving(true);

    try {
      const updated = await deleteStudentPhoto(id);
      setHydratedStudent(updated);
      setActionMessage("Student photo removed.");
      setPhotoPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    } catch (error) {
      setPhotoError(error instanceof Error ? error.message : "Failed to remove student photo.");
    } finally {
      setIsPhotoSaving(false);
    }
  }

  return {
    contentProps: {
      actionMessage,
      beltLoadError,
      canManageRoster,
      canManageStudentLifecycle,
      deleteError,
      detail,
      isDeleting,
      isLoadingBeltData,
      isLoadingStudent: !student && (!studentsLoaded || isLoadingStudent),
      isPhotoSaving,
      isSaving,
      loadError,
      photoError,
      photoPreviewUrl,
      programs,
      promotionHistory,
      showDeleteConfirm,
      showEdit,
      student,
      onBackToStudents: () => router.push("/students"),
      onCancelDelete: () => {
        setShowDeleteConfirm(false);
        setDeleteError(null);
      },
      onCloseEdit: () => setShowEdit(false),
      onDeletePhoto: handleDeletePhoto,
      onDeleteStudent: handleDeleteStudent,
      onDismissActionMessage: () => setActionMessage(null),
      onEdit: handleEdit,
      onPhotoSelected: handlePhotoSelected,
      onShowDeleteConfirm: () => setShowDeleteConfirm(true),
      onShowEdit: () => setShowEdit(true),
    },
  };
}

export type StudentDetailPageController = ReturnType<typeof useStudentDetailPageController>;

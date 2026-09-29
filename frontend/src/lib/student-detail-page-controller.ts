"use client";
import { useResumeRefresh } from "@/lib/use-resume-refresh";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { safeStudentsReturn } from "@/lib/student-roster-location";
import { withCurrentMinorStatus } from "./student-age";
import { api } from "@/lib/api";
import { buildStudentDetailModel, validateStudentPhotoFile } from "@/lib/student-detail-page-model";
import type {
  BeltsStoreContextValue,
  ConfigStoreContextValue,
  ProgramsStoreContextValue,
  StudentsStoreContextValue,
  StudioStoreContextValue,
} from "@/lib/store-contexts";
import { hasStaffPermission } from "@/lib/staff-permissions";
import { STUDENT_COMMAND_BUSY_MESSAGE } from "@/lib/store";
import type { BeltLadder, Promotion, Student, StudentUpdate } from "@/types";

const EMPTY_PROMOTION_HISTORY: Promotion[] = [];

type StudentCommandKind = "archive" | "photo" | "profile";

type StudentDetailPageControllerOptions = {
  beltStore: Pick<
    BeltsStoreContextValue,
    "beltLadders" | "loadPromotionHistory" | "promotionHistoryByStudent"
  >;
  studioStore: Pick<StudioStoreContextValue, "identityGeneration">;
  config: Pick<ConfigStoreContextValue, "businessDate" | "currentRole" | "isPreviewMode" | "token">;
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
  studioStore,
  programsStore,
  studentsStore,
}: StudentDetailPageControllerOptions) {
  const params = useParams();
  const router = useRouter();
  const returnTo = safeStudentsReturn(useSearchParams().get("returnTo"));
  const id = params.id as string;
  const { isPreviewMode, token } = config;
  const canManageRoster = hasStaffPermission(config.currentRole, "manage_roster_bulk");
  const canManageStudentLifecycle = hasStaffPermission(
    config.currentRole,
    "manage_student_lifecycle",
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

  const scope = `${studioStore.identityGeneration}:${id}`;
  const [editScope, setEditScope] = useState<string | null>(null);
  const showEdit = editScope === scope;
  const currentScope = useRef<string | null>(scope);
  useEffect(() => {
    currentScope.current = scope;
    return () => {
      if (currentScope.current === scope) currentScope.current = null;
    };
  }, [scope]);
  const detailRevision = useRef(0);
  const [hydration, setHydration] = useState<{ scope: string; student: Student } | null>(null);
  const hydratedStudent = hydration?.scope === scope ? hydration.student : null;
  const setHydratedStudent = (student: Student) => {
    if (currentScope.current === scope) setHydration({ scope, student });
  };
  const [retryNonce, setRetryNonce] = useState(0);
  const historyRetryNonceRef = useRef(0);
  useResumeRefresh(() => setRetryNonce((value) => value + 1));
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
  const [deleteConfirmScope, setDeleteConfirmScope] = useState<string | null>(null);
  const showDeleteConfirm = deleteConfirmScope === scope;
  const [deleteErrorState, setDeleteErrorState] = useState<{
    scope: string;
    message: string;
  } | null>(null);
  const deleteError = deleteErrorState?.scope === scope ? deleteErrorState.message : null;
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<{ scope: string; url: string } | null>(null);
  const photoPreviewUrl = photoPreview?.scope === scope ? photoPreview.url : null;
  const [photoError, setPhotoError] = useState<string | null>(null);
  // One profile, photo or archive command owns this student until its store
  // write and detail hydration settle. The ref refuses a same-tick repeat that
  // the pending state has not rendered yet. Every completion is fenced to the
  // scope that started it, so a replaced identity or student cannot change the
  // current page's notices, pending flags, preview or route.
  const commandOwnersRef = useRef(new Map<string, symbol>());
  const [pendingCommands, setPendingCommands] = useState<ReadonlyMap<string, StudentCommandKind>>(
    () => new Map(),
  );
  const [archivedScope, setArchivedScope] = useState<string | null>(null);
  const pendingCommand = pendingCommands.get(scope);
  const isStudentCommandPending = pendingCommand !== undefined;
  const isSaving = pendingCommand === "profile";
  const isPhotoSaving = pendingCommand === "photo";
  const isDeleting = pendingCommand === "archive" || archivedScope === scope;
  const beginStudentCommand = (kind: StudentCommandKind) => {
    if (commandOwnersRef.current.has(scope)) return null;
    const ownerScope = scope;
    const owner = Symbol(kind);
    commandOwnersRef.current.set(ownerScope, owner);
    setPendingCommands((current) => new Map(current).set(ownerScope, kind));
    return {
      isCurrent: () => currentScope.current === ownerScope,
      scope: ownerScope,
      release: () => {
        if (commandOwnersRef.current.get(ownerScope) !== owner) return;
        commandOwnersRef.current.delete(ownerScope);
        setPendingCommands((current) => {
          const next = new Map(current);
          next.delete(ownerScope);
          return next;
        });
      },
    };
  };
  // The effect below revokes a preview URL once no state refers to it, so a
  // command only clears the preview it created.
  const clearOwnedPhotoPreview = (url: string) =>
    setPhotoPreview((current) => (current?.url === url ? null : current));

  const listStudent = useMemo(() => students.find((student) => student.id === id), [id, students]);
  const cachedPromotionHistory = promotionHistoryByStudent[id];

  const ownedPhotoPreviewUrl = photoPreview?.url ?? null;
  useEffect(() => {
    return () => {
      if (ownedPhotoPreviewUrl) {
        URL.revokeObjectURL(ownedPhotoPreviewUrl);
      }
    };
  }, [ownedPhotoPreviewUrl]);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    async function loadStudent() {
      if (isPreviewMode || !token) return;
      const revision = detailRevision.current;
      setIsLoadingStudent(true);
      setLoadError(null);

      try {
        const result = await api.get<Student>(`/students/${id}`, token, {
          signal: controller.signal,
        });
        if (mounted && currentScope.current === scope && detailRevision.current === revision) {
          setHydration({ scope, student: result });
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
  }, [id, isPreviewMode, retryNonce, scope, token]);

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
          setBeltLoadError(error instanceof Error ? error.message : "Failed to load belt ladder");
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
        const force = historyRetryNonceRef.current !== retryNonce;
        historyRetryNonceRef.current = retryNonce;
        const promotionsResult = await loadPromotionHistoryForStudent(id, {
          signal: controller.signal,
          force,
        });

        if (mounted) {
          setPromotionHistoryState({ studentId: id, items: promotionsResult });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (mounted) {
          setBeltLoadError(error instanceof Error ? error.message : "Failed to load belt history");
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
  }, [
    cachedPromotionHistory,
    id,
    isPreviewMode,
    loadPromotionHistoryForStudent,
    retryNonce,
    token,
  ]);

  const sourceStudent = hydratedStudent ?? listStudent;
  const student = useMemo(
    () => (sourceStudent ? withCurrentMinorStatus(sourceStudent, config.businessDate) : undefined),
    [config.businessDate, sourceStudent],
  );
  const detailReady = isPreviewMode ? Boolean(student) : Boolean(hydratedStudent);
  const promotionHistory =
    promotionHistoryState?.studentId === id ? promotionHistoryState.items : EMPTY_PROMOTION_HISTORY;
  const beltLadders = storeBeltLadders.length > 0 ? storeBeltLadders : fallbackBeltLadders;
  const isLoadingBeltData =
    isLoadingPromotionHistory || (beltLadders.length === 0 && isLoadingFallbackBeltLadders);
  const detail = useMemo(
    () =>
      student
        ? buildStudentDetailModel({
            beltLadders,
            promotionHistory,
            student,
            today: config.businessDate,
          })
        : null,
    [beltLadders, config.businessDate, promotionHistory, student],
  );

  async function handleEdit(data: StudentUpdate) {
    if (!student || !detailReady) return;
    const command = beginStudentCommand("profile");
    if (!command) throw new Error(STUDENT_COMMAND_BUSY_MESSAGE);
    detailRevision.current += 1;
    setActionMessage(null);
    try {
      const updated = await updateStudent(id, data);
      if (command.isCurrent()) {
        setHydratedStudent(updated);
        setEditScope(null);
        setActionMessage("Student profile updated.");
      }
    } finally {
      command.release();
    }
  }

  async function handleDeleteStudent() {
    if (!canManageRoster || !detailReady) return;
    const command = beginStudentCommand("archive");
    if (!command) return;

    setDeleteErrorState(null);

    try {
      await deleteStudents([id]);
      if (command.isCurrent()) {
        setArchivedScope(command.scope);
        router.push(returnTo);
      }
    } catch (error) {
      if (command.isCurrent()) {
        setDeleteErrorState({
          scope: command.scope,
          message: error instanceof Error ? error.message : "Failed to archive student.",
        });
      }
    } finally {
      command.release();
    }
  }

  async function handlePhotoSelected(file: File): Promise<boolean> {
    if (!canManageRoster || !detailReady) return false;
    const command = beginStudentCommand("photo");
    if (!command) return false;
    const validationError = validateStudentPhotoFile(file);
    if (validationError) {
      setPhotoError(validationError);
      command.release();
      return false;
    }

    detailRevision.current += 1;
    const previewUrl = URL.createObjectURL(file);
    setPhotoPreview({ scope: command.scope, url: previewUrl });
    setPhotoError(null);
    setActionMessage(null);

    try {
      const updated = await uploadStudentPhoto(id, file);
      if (command.isCurrent()) {
        setHydratedStudent(updated);
        setActionMessage("Student photo updated.");
      }
    } catch (error) {
      if (command.isCurrent()) {
        setPhotoError(error instanceof Error ? error.message : "Failed to update student photo.");
      }
    } finally {
      // The stored photo stays authoritative; a settled or rejected upload's
      // preview is no longer shown.
      clearOwnedPhotoPreview(previewUrl);
      command.release();
    }

    return true;
  }

  async function handleDeletePhoto() {
    if (!canManageRoster || !detailReady) return;
    const command = beginStudentCommand("photo");
    if (!command) return;
    detailRevision.current += 1;

    setPhotoError(null);
    setActionMessage(null);

    try {
      const updated = await deleteStudentPhoto(id);
      if (command.isCurrent()) {
        setHydratedStudent(updated);
        setActionMessage("Student photo removed.");
        setPhotoPreview((current) => (current?.scope === command.scope ? null : current));
      }
    } catch (error) {
      if (command.isCurrent()) {
        setPhotoError(error instanceof Error ? error.message : "Failed to remove student photo.");
      }
    } finally {
      command.release();
    }
  }

  return {
    contentProps: {
      actionMessage,
      beltLoadError,
      businessDate: config.businessDate,
      canManageRoster,
      canManageStudentLifecycle,
      deleteError,
      detail,
      detailReady,
      isDeleting,
      isLoadingBeltData,
      isLoadingStudent:
        !student && !loadError && (!studentsLoaded || isLoadingStudent || !detailReady),
      isPhotoSaving,
      isSaving,
      isStudentCommandPending,
      loadError,
      photoError,
      photoPreviewUrl,
      programs,
      promotionHistory,
      showDeleteConfirm,
      showEdit,
      student,
      onBackToStudents: () => router.push(returnTo),
      onCancelDelete: () => {
        setDeleteConfirmScope(null);
        setDeleteErrorState(null);
      },
      onCloseEdit: () => {
        if (!isSaving) setEditScope(null);
      },
      onRetryDetail: () => setRetryNonce((value) => value + 1),
      onDeletePhoto: handleDeletePhoto,
      onDeleteStudent: handleDeleteStudent,
      onDismissActionMessage: () => setActionMessage(null),
      onEdit: handleEdit,
      onPhotoSelected: handlePhotoSelected,
      onShowDeleteConfirm: () => {
        if (detailReady && !isStudentCommandPending) setDeleteConfirmScope(scope);
      },
      onShowEdit: () => {
        if (detailReady && !isStudentCommandPending) setEditScope(scope);
      },
    },
  };
}

export type StudentDetailPageController = ReturnType<typeof useStudentDetailPageController>;

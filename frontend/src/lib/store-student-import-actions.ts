import { useCallback, type Dispatch, type SetStateAction } from "react";

import { api } from "@/lib/api";
import { withCsvImportRefreshWarning } from "@/lib/csv-import";
import { buildPreviewStudentImportResult } from "@/lib/student-import-store-model";
import type { BeginLiveAuthRequest, StoreRef } from "@/lib/store-action-types";
import { localId } from "@/lib/store-storage";
import { fetchAllStudents } from "@/lib/store-student-pages";
import type {
  BeltLadder,
  BeltRank,
  CsvImportOptions,
  CsvImportRequest,
  CsvImportResult,
  Program,
  Student,
} from "@/types";

type CommitStudents = (
  next: Student[] | ((current: Student[]) => Student[]),
  options?: { mayBePartial?: boolean }
) => void;

interface UseStoreStudentImportActionsOptions {
  beginLiveAuthRequest: BeginLiveAuthRequest;
  beltLaddersRef: StoreRef<BeltLadder[]>;
  beltRanksRef: StoreRef<BeltRank[]>;
  commitStudents: CommitStudents;
  isPreviewMode: boolean;
  persistStudents: (next: Student[]) => void;
  programsRef: StoreRef<Program[]>;
  refreshBeltsRef: StoreRef<((preferredLadderId?: string | null) => Promise<void>) | null>;
  refreshPrograms: (options?: { includeArchived?: boolean }) => Promise<Program[]>;
  setStudentsLoadError: Dispatch<SetStateAction<string | null>>;
  studentsRef: StoreRef<Student[]>;
}

export function useStoreStudentImportActions({
  beginLiveAuthRequest,
  beltLaddersRef,
  beltRanksRef,
  commitStudents,
  isPreviewMode,
  persistStudents,
  programsRef,
  refreshBeltsRef,
  refreshPrograms,
  setStudentsLoadError,
  studentsRef,
}: UseStoreStudentImportActionsOptions) {
  const importStudents = useCallback(async (
    file: File,
    rows: Record<string, string>[],
    mapping: Record<string, string>,
    options: CsvImportOptions,
    request?: { importKey?: string }
  ): Promise<CsvImportResult> => {
    if (isPreviewMode) {
      const execution = buildPreviewStudentImportResult({
        rows,
        mapping,
        options,
        programs: programsRef.current,
        beltLadders: beltLaddersRef.current,
        fallbackRanks: beltRanksRef.current,
        existingStudents: studentsRef.current,
        idFactory: localId,
      });
      if (execution.importedStudents.length > 0) {
        persistStudents(execution.students);
      }
      return execution.result;
    }

    const liveRequest = beginLiveAuthRequest();
    const importKey = request?.importKey?.trim();
    const formData = new FormData();
    const requestPayload: CsvImportRequest = {
      mapping,
      options,
      ...(importKey ? { idempotency_key: importKey } : {}),
    };

    formData.append("file", file);
    formData.append("payload", JSON.stringify(requestPayload));
    if (importKey) {
      formData.append("idempotency_key", importKey);
    }

    const result = await api.postForm<CsvImportResult>(
      "/students/import/execute",
      formData,
      liveRequest.token,
      {
        timeoutMs: null,
        headers: importKey ? {
          "Idempotency-Key": importKey,
          "X-Import-Key": importKey,
        } : undefined,
        networkErrorMessage:
          "The connection dropped before Koaryu could confirm the import finished. Wait a moment, then retry with this same file and options so Koaryu can avoid duplicate students.",
      }
    );
    if (!liveRequest.isCurrent()) {
      return result;
    }

    const shouldRefreshBelts =
      result.imported_count > 0 ||
      result.reused_result ||
      result.created_programs.length > 0 ||
      result.created_ladders.length > 0 ||
      result.created_belts.length > 0;

    const refreshWarnings: string[] = [];

    const programsRefresh = await Promise.allSettled([
      refreshPrograms({ includeArchived: true }),
    ]);
    if (programsRefresh[0].status === "rejected") {
      const message = programsRefresh[0].reason instanceof Error
        ? programsRefresh[0].reason.message
        : "Failed to refresh programs after import.";
      refreshWarnings.push(`Import data was saved, but Koaryu could not refresh the Programs list afterward. ${message}`);
    }

    const studentsRefresh = await Promise.allSettled([
      fetchAllStudents(liveRequest.token, { timeoutMs: 30000 }).then((refreshedStudents) => {
        if (liveRequest.isCurrent()) {
          commitStudents(refreshedStudents);
        }
      }),
    ]);
    if (studentsRefresh[0].status === "rejected") {
      const message = studentsRefresh[0].reason instanceof Error
        ? studentsRefresh[0].reason.message
        : "Failed to refresh students after import.";
      if (liveRequest.isCurrent()) {
        setStudentsLoadError(message);
      }
      refreshWarnings.push(`Import data was saved, but Koaryu could not refresh the Students list afterward. ${message}`);
    }

    if (shouldRefreshBelts) {
      const beltsRefresh = await Promise.allSettled([
        refreshBeltsRef.current?.() ?? Promise.resolve(),
      ]);
      if (beltsRefresh[0].status === "rejected") {
        const message = beltsRefresh[0].reason instanceof Error
          ? beltsRefresh[0].reason.message
          : "Failed to refresh belt data after import.";
        refreshWarnings.push(`Import data was saved, but Koaryu could not refresh Belt Tracker afterward. ${message}`);
      }
    }

    if (refreshWarnings.length > 0) {
      return refreshWarnings.reduce(
        (nextResult, warning) => withCsvImportRefreshWarning(nextResult, warning),
        result
      );
    }

    return result;
  }, [
    beginLiveAuthRequest,
    beltLaddersRef,
    beltRanksRef,
    commitStudents,
    isPreviewMode,
    persistStudents,
    programsRef,
    refreshBeltsRef,
    refreshPrograms,
    setStudentsLoadError,
    studentsRef,
  ]);

  return {
    importStudents,
  };
}

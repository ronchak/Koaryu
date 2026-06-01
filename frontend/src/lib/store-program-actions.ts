import { useCallback, type Dispatch, type SetStateAction } from "react";

import { api } from "@/lib/api";
import {
  applyPreviewProgramArchiveState,
  applyPreviewProgramUpdate,
  applyProgramNameToLadders,
  buildPreviewProgram,
  buildPreviewProgramLadder,
  upsertProgram,
} from "@/lib/program-store-model";
import type { BeginLiveAuthRequest, StoreRef } from "@/lib/store-action-types";
import { KEYS, load, localId } from "@/lib/store-storage";
import { MOCK_PROGRAMS } from "@/lib/preview-studio-data";
import type { BeltLadder, Program, ProgramCreate, ProgramUpdate } from "@/types";

interface UseStoreProgramActionsOptions {
  applyLadderSelection: (
    ladders: BeltLadder[],
    preferredLadderId?: string | null
  ) => BeltLadder | null | undefined;
  beginLiveAuthRequest: BeginLiveAuthRequest;
  beltLaddersRef: StoreRef<BeltLadder[]>;
  currentLadderIdRef: StoreRef<string | null>;
  isPreviewMode: boolean;
  persistPrograms: (next: Program[]) => void;
  programsRef: StoreRef<Program[]>;
  refreshBeltsRef: StoreRef<((preferredLadderId?: string | null) => Promise<void>) | null>;
  setProgramsLoadError: Dispatch<SetStateAction<string | null>>;
}

export function useStoreProgramActions({
  applyLadderSelection,
  beginLiveAuthRequest,
  beltLaddersRef,
  currentLadderIdRef,
  isPreviewMode,
  persistPrograms,
  programsRef,
  refreshBeltsRef,
  setProgramsLoadError,
}: UseStoreProgramActionsOptions) {
  const refreshPrograms = useCallback(async (
    options?: { includeArchived?: boolean }
  ): Promise<Program[]> => {
    if (isPreviewMode) {
      const stored = load(KEYS.programs, MOCK_PROGRAMS);
      persistPrograms(stored);
      return stored;
    }

    const request = beginLiveAuthRequest();
    setProgramsLoadError(null);

    try {
      const result = await api.get<Program[]>(
        `/programs?include_archived=${options?.includeArchived ? "true" : "false"}`,
        request.token
      );
      if (!request.isCurrent()) {
        return result;
      }
      persistPrograms(result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load programs.";
      if (request.isCurrent()) {
        setProgramsLoadError(message);
      }
      throw error;
    }
  }, [beginLiveAuthRequest, isPreviewMode, persistPrograms, setProgramsLoadError]);

  const createProgram = useCallback(async (data: ProgramCreate): Promise<Program> => {
    if (isPreviewMode) {
      const now = new Date();
      const created = buildPreviewProgram(data, programsRef.current, {
        idFactory: localId,
        now,
      });
      const ladder = buildPreviewProgramLadder(created, {
        idFactory: localId,
        now,
      });
      persistPrograms([...programsRef.current, created]);
      applyLadderSelection([...beltLaddersRef.current, ladder], currentLadderIdRef.current || ladder.id);
      return created;
    }

    const liveRequest = beginLiveAuthRequest();
    const created = await api.post<Program>("/programs", data, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return created;
    }
    persistPrograms(upsertProgram(programsRef.current, created));
    await (refreshBeltsRef.current?.(currentLadderIdRef.current).catch(() => undefined) ?? Promise.resolve());
    return created;
  }, [
    applyLadderSelection,
    beginLiveAuthRequest,
    beltLaddersRef,
    currentLadderIdRef,
    isPreviewMode,
    persistPrograms,
    programsRef,
    refreshBeltsRef,
  ]);

  const updateProgram = useCallback(async (id: string, data: ProgramUpdate): Promise<Program> => {
    if (isPreviewMode) {
      const nowIso = new Date().toISOString();
      const update = applyPreviewProgramUpdate(programsRef.current, id, data, nowIso);
      persistPrograms(update.programs);
      if (data.name) {
        const nextLadders = applyProgramNameToLadders(beltLaddersRef.current, id, data.name, nowIso);
        applyLadderSelection(nextLadders, currentLadderIdRef.current);
      }
      return update.updated!;
    }

    const liveRequest = beginLiveAuthRequest();
    const updated = await api.patch<Program>(`/programs/${id}`, data, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return updated;
    }
    persistPrograms(programsRef.current.map((program) => program.id === id ? updated : program));
    await (refreshBeltsRef.current?.(currentLadderIdRef.current).catch(() => undefined) ?? Promise.resolve());
    return updated;
  }, [
    applyLadderSelection,
    beginLiveAuthRequest,
    beltLaddersRef,
    currentLadderIdRef,
    isPreviewMode,
    persistPrograms,
    programsRef,
    refreshBeltsRef,
  ]);

  const archiveProgram = useCallback(async (id: string): Promise<Program> => {
    if (isPreviewMode) {
      const update = applyPreviewProgramArchiveState(programsRef.current, id, true);
      persistPrograms(update.programs);
      return update.updated!;
    }

    const liveRequest = beginLiveAuthRequest();
    const archived = await api.post<Program>(`/programs/${id}/archive`, {}, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return archived;
    }
    persistPrograms(programsRef.current.map((program) => program.id === id ? archived : program));
    return archived;
  }, [beginLiveAuthRequest, isPreviewMode, persistPrograms, programsRef]);

  const restoreProgram = useCallback(async (id: string): Promise<Program> => {
    if (isPreviewMode) {
      const update = applyPreviewProgramArchiveState(programsRef.current, id, false);
      persistPrograms(update.programs);
      return update.updated!;
    }

    const liveRequest = beginLiveAuthRequest();
    const restored = await api.post<Program>(`/programs/${id}/restore`, {}, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return restored;
    }
    persistPrograms(programsRef.current.map((program) => program.id === id ? restored : program));
    return restored;
  }, [beginLiveAuthRequest, isPreviewMode, persistPrograms, programsRef]);

  return {
    archiveProgram,
    createProgram,
    refreshPrograms,
    restoreProgram,
    updateProgram,
  };
}

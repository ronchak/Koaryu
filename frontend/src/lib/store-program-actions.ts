import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";

import { api } from "@/lib/api";
import {
  applyPreviewProgramArchiveState,
  applyPreviewProgramUpdate,
  applyProgramNameToLadders,
  buildPreviewProgram,
  buildPreviewProgramLadder,
  upsertProgram,
} from "@/lib/program-store-model";
import {
  canCommitLiveMutation,
  type BeginLiveAuthRequest,
  type StoreRef,
} from "@/lib/store-action-types";
import { beginResourceMutation, type ResourceScope } from "@/lib/store-resource-scope";
import { KEYS, load, localId } from "@/lib/store-storage";
import { MOCK_PROGRAMS } from "@/lib/preview-studio-data";
import type { BeltLadder, Program, ProgramCreate, ProgramUpdate } from "@/types";

interface UseStoreProgramActionsOptions {
  applyLadderSelection: (
    ladders: BeltLadder[],
    preferredLadderId?: string | null,
  ) => BeltLadder | null | undefined;
  beginLiveAuthRequest: BeginLiveAuthRequest;
  beltLaddersRef: StoreRef<BeltLadder[]>;
  currentLadderIdRef: StoreRef<string | null>;
  isPreviewMode: boolean;
  persistPrograms: (next: Program[]) => void;
  programsRef: StoreRef<Program[]>;
  programScopeRef: StoreRef<ResourceScope>;
  programsLoadedRef: StoreRef<boolean>;
  refreshBeltsRef: StoreRef<((preferredLadderId?: string | null) => Promise<void>) | null>;
  setProgramsUsageLoaded: Dispatch<SetStateAction<boolean>>;
  setProgramsUsageLoadError: Dispatch<SetStateAction<string | null>>;
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
  programScopeRef,
  programsLoadedRef,
  refreshBeltsRef,
  setProgramsUsageLoaded,
  setProgramsUsageLoadError,
  setProgramsLoadError,
}: UseStoreProgramActionsOptions) {
  const usageRequestsRef = useRef(
    new Map<string, { identity: object; promise: Promise<Program[]>; isCurrent: () => boolean }>(),
  );
  const refreshPrograms = useCallback(
    async (options?: { includeArchived?: boolean; force?: boolean }): Promise<Program[]> => {
      if (isPreviewMode) {
        const stored = load(KEYS.programs, MOCK_PROGRAMS);
        persistPrograms(stored);
        setProgramsUsageLoaded(true);
        setProgramsUsageLoadError(null);
        return stored;
      }

      const owner = beginLiveAuthRequest();
      const scope = programScopeRef.current;
      const key = `${owner.token}:${options?.includeArchived === true}`;
      const retainedRequest = usageRequestsRef.current.get(key);
      if (!options?.force && retainedRequest?.isCurrent()) return retainedRequest.promise;
      const sequence = ++scope.sequence;
      const ownsRead = () =>
        programScopeRef.current === scope &&
        scope.sequence === sequence &&
        canCommitLiveMutation(owner);
      let revision = scope.revision;
      setProgramsUsageLoadError(null);
      if (!programsLoadedRef.current) setProgramsLoadError(null);

      const identity = {};
      const pending = (async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (!ownsRead()) return [];
          if (scope.pending) await scope.settled;
          if (!ownsRead()) return [];
          const request = beginLiveAuthRequest();
          revision = scope.revision;
          try {
            const result = await api.get<Program[]>(
              `/programs?include_archived=${options?.includeArchived ? "true" : "false"}`,
              request.token,
            );
            if (!ownsRead()) return result;
            if (request.canRetryAfterTokenChange?.()) continue;
            if (!request.isCurrent()) return result;
            if (revision !== scope.revision || scope.pending) continue;
            persistPrograms(result);
            setProgramsUsageLoaded(true);
            setProgramsUsageLoadError(null);
            return result;
          } catch (error) {
            if (ownsRead() && request.canRetryAfterTokenChange?.()) continue;
            if (ownsRead() && request.isCurrent()) {
              if (revision !== scope.revision || scope.pending) continue;
              const message =
                error instanceof Error ? error.message : "Programs could not be loaded.";
              setProgramsUsageLoadError(message);
              if (!programsLoadedRef.current) setProgramsLoadError(message);
            }
            throw error;
          }
        }
        const error = new Error(
          "Programs changed while loading. Refresh to see the latest records.",
        );
        if (ownsRead()) {
          setProgramsUsageLoadError(error.message);
          if (!programsLoadedRef.current) setProgramsLoadError(error.message);
        }
        throw error;
      })().finally(() => {
        if (usageRequestsRef.current.get(key)?.identity === identity)
          usageRequestsRef.current.delete(key);
      });
      usageRequestsRef.current.set(key, {
        identity,
        promise: pending,
        isCurrent: () => ownsRead() && owner.isCurrent() && revision === scope.revision,
      });
      return pending;
    },
    [
      beginLiveAuthRequest,
      isPreviewMode,
      persistPrograms,
      programScopeRef,
      programsLoadedRef,
      setProgramsLoadError,
      setProgramsUsageLoaded,
      setProgramsUsageLoadError,
    ],
  );

  // All four commands share one commit boundary. A belt refresh happens after
  // program settlement, so unrelated read latency cannot hold program waiters.
  const commitLiveProgram = useCallback(
    async (
      send: (token: string) => Promise<Program>,
      merge: (current: Program[], result: Program) => Program[],
      reconcileBelts = false,
    ): Promise<Program> => {
      const request = beginLiveAuthRequest();
      const scope = programScopeRef.current;
      const finish = beginResourceMutation(scope);
      const canCommit = () => programScopeRef.current === scope && canCommitLiveMutation(request);
      let result: Program;
      let committed = false;
      try {
        result = await send(request.token);
        if (canCommit()) {
          persistPrograms(merge(programsRef.current, result));
          committed = true;
        }
      } finally {
        finish();
      }
      if (committed && reconcileBelts && canCommit()) {
        await (refreshBeltsRef.current?.(currentLadderIdRef.current).catch(() => undefined) ??
          Promise.resolve());
      }
      return result;
    },
    [
      beginLiveAuthRequest,
      programScopeRef,
      persistPrograms,
      programsRef,
      refreshBeltsRef,
      currentLadderIdRef,
    ],
  );

  const createProgram = useCallback(
    async (data: ProgramCreate): Promise<Program> => {
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
        applyLadderSelection(
          [...beltLaddersRef.current, ladder],
          currentLadderIdRef.current || ladder.id,
        );
        return created;
      }

      return commitLiveProgram(
        (token) => api.post<Program>("/programs", data, token),
        (current, created) => upsertProgram(current, created),
        true,
      );
    },
    [
      applyLadderSelection,
      commitLiveProgram,
      beltLaddersRef,
      currentLadderIdRef,
      isPreviewMode,
      persistPrograms,
      programsRef,
    ],
  );

  const updateProgram = useCallback(
    async (id: string, data: ProgramUpdate): Promise<Program> => {
      if (isPreviewMode) {
        const nowIso = new Date().toISOString();
        const update = applyPreviewProgramUpdate(programsRef.current, id, data, nowIso);
        persistPrograms(update.programs);
        if (data.name) {
          const nextLadders = applyProgramNameToLadders(
            beltLaddersRef.current,
            id,
            data.name,
            nowIso,
          );
          applyLadderSelection(nextLadders, currentLadderIdRef.current);
        }
        return update.updated!;
      }

      return commitLiveProgram(
        (token) => api.patch<Program>(`/programs/${id}`, data, token),
        (current, updated) => current.map((program) => (program.id === id ? updated : program)),
        true,
      );
    },
    [
      applyLadderSelection,
      commitLiveProgram,
      beltLaddersRef,
      currentLadderIdRef,
      isPreviewMode,
      persistPrograms,
      programsRef,
    ],
  );

  const archiveProgram = useCallback(
    async (id: string): Promise<Program> => {
      if (isPreviewMode) {
        const update = applyPreviewProgramArchiveState(programsRef.current, id, true);
        persistPrograms(update.programs);
        return update.updated!;
      }

      return commitLiveProgram(
        (token) => api.post<Program>(`/programs/${id}/archive`, {}, token),
        (current, updated) => current.map((program) => (program.id === id ? updated : program)),
      );
    },
    [commitLiveProgram, isPreviewMode, persistPrograms, programsRef],
  );

  const restoreProgram = useCallback(
    async (id: string): Promise<Program> => {
      if (isPreviewMode) {
        const update = applyPreviewProgramArchiveState(programsRef.current, id, false);
        persistPrograms(update.programs);
        return update.updated!;
      }

      return commitLiveProgram(
        (token) => api.post<Program>(`/programs/${id}/restore`, {}, token),
        (current, updated) => current.map((program) => (program.id === id ? updated : program)),
      );
    },
    [commitLiveProgram, isPreviewMode, persistPrograms, programsRef],
  );

  return {
    archiveProgram,
    createProgram,
    refreshPrograms,
    restoreProgram,
    updateProgram,
  };
}

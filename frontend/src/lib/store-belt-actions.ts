"use client";

import { useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import {
  clearPendingBeltLadderSync,
  isTerminalBeltLadderSyncError,
  loadPendingBeltLadderSync,
  persistPendingBeltLadderSync,
  type PendingBeltLadderSync,
} from "@/lib/belt-ladder-sync-operation";
import {
  buildBeltLadderSyncPayload,
  buildPreviewBeltLadderFromRanks,
  buildPreviewPromotion,
  repairPreviewStudentRanksForLadder,
  selectBeltLadder,
  updatePreviewLadderSubRankTerm,
  upsertBeltLadder,
} from "@/lib/belt-store-model";
import {
  buildPromotionHistoryWithPrependedItem,
  buildPromotionHistoryWithPrependedItemIfCached,
  loadPromotionHistoryWithCache,
  type PromotionHistoryCache,
  type PromotionHistoryRequests,
} from "@/lib/store-promotion-history";
import {
  clearPendingRankTransition,
  isTerminalRankTransitionError,
  loadPendingRankTransition,
  persistPendingRankTransition,
  rankTransitionFingerprint,
  type PendingRankTransition,
  type RankTransitionKind,
} from "@/lib/rank-transition-operation";
import { KEYS, localId, save } from "@/lib/store-storage";
import { MOCK_BELT_LADDER } from "@/lib/mock-data";
import type { BeginLiveAuthRequest, StoreRef } from "@/lib/store-action-types";
import type {
  BeltLadder,
  BeltRank,
  DemoteStudent,
  EligibilityEntry,
  PromoteStudent,
  Promotion,
  Student,
} from "@/types";

interface UseStoreBeltActionsArgs {
  applyLadderSelection: (ladders: BeltLadder[], preferredLadderId?: string | null) => BeltLadder | null;
  beginLiveAuthRequest: BeginLiveAuthRequest;
  beltLaddersRef: StoreRef<BeltLadder[]>;
  beltRanksRef: StoreRef<BeltRank[]>;
  commitPromotionHistoryCache: (studentId: string, items: Promotion[]) => void;
  currentLadderIdRef: StoreRef<string | null>;
  isPreviewMode: boolean;
  ladderName: string;
  loadEligibilityForLadder: (ladderId?: string | null, options?: { force?: boolean }) => Promise<EligibilityEntry[]>;
  persistBeltRanks: (next: BeltRank[]) => void;
  persistStudents: (next: Student[]) => void;
  promotionHistoryCacheRef: StoreRef<PromotionHistoryCache>;
  promotionHistoryGenerationRef: StoreRef<number>;
  promotionHistoryRequestsRef: StoreRef<PromotionHistoryRequests>;
  refreshBeltsRef: StoreRef<((preferredLadderId?: string | null) => Promise<void>) | null>;
  refreshStudents: () => Promise<unknown>;
  setEligibilityLoadError: (error: string | null) => void;
  setEligibilityPendingLadderId: (ladderId: string | null) => void;
  setLadderNameState: (name: string) => void;
  setSubRankTermState: (term: string) => void;
  studentsRef: StoreRef<Student[]>;
  subRankTerm: string;
}

export function useStoreBeltActions({
  applyLadderSelection,
  beginLiveAuthRequest,
  beltLaddersRef,
  beltRanksRef,
  commitPromotionHistoryCache,
  currentLadderIdRef,
  isPreviewMode,
  ladderName,
  loadEligibilityForLadder,
  persistBeltRanks,
  persistStudents,
  promotionHistoryCacheRef,
  promotionHistoryGenerationRef,
  promotionHistoryRequestsRef,
  refreshBeltsRef,
  refreshStudents,
  setEligibilityLoadError,
  setEligibilityPendingLadderId,
  setLadderNameState,
  setSubRankTermState,
  studentsRef,
  subRankTerm,
}: UseStoreBeltActionsArgs) {
  const pendingLadderSyncsRef = useRef(new Map<string, PendingBeltLadderSync>());
  const pendingRankTransitionsRef = useRef(new Map<string, PendingRankTransition>());

  const pendingRankTransition = useCallback((
    kind: RankTransitionKind,
    data: PromoteStudent | DemoteStudent,
  ) => {
    const key = `${kind}:${data.student_id}`;
    const fingerprint = rankTransitionFingerprint(data);
    const existing = pendingRankTransitionsRef.current.get(key)
      ?? loadPendingRankTransition(kind, data.student_id);
    if (existing?.fingerprint === fingerprint) {
      pendingRankTransitionsRef.current.set(key, existing);
      return existing;
    }
    const pending = { fingerprint, operationId: crypto.randomUUID() };
    pendingRankTransitionsRef.current.set(key, pending);
    persistPendingRankTransition(kind, data.student_id, pending);
    return pending;
  }, []);

  const clearRankTransition = useCallback((
    kind: RankTransitionKind,
    studentId: string,
  ) => {
    pendingRankTransitionsRef.current.delete(`${kind}:${studentId}`);
    clearPendingRankTransition(kind, studentId);
  }, []);

  const refreshBelts = useCallback(async (
    preferredLadderId?: string | null,
    options?: { requireEligibility?: boolean }
  ) => {
    if (isPreviewMode) {
      return;
    }

    const request = beginLiveAuthRequest();
    const beltLaddersRes = await api.get<BeltLadder[]>("/belts/ladders", request.token);
    if (!request.isCurrent()) {
      return;
    }

    const selectedLadder = applyLadderSelection(
      beltLaddersRes,
      preferredLadderId ?? currentLadderIdRef.current
    );
    const eligibilityRefresh = loadEligibilityForLadder(selectedLadder?.id ?? null, { force: true });
    if (options?.requireEligibility) {
      await eligibilityRefresh;
    } else {
      await eligibilityRefresh.catch(() => undefined);
    }
  }, [applyLadderSelection, beginLiveAuthRequest, currentLadderIdRef, isPreviewMode, loadEligibilityForLadder]);

  useEffect(() => {
    refreshBeltsRef.current = refreshBelts;
  }, [refreshBelts, refreshBeltsRef]);

  const setCurrentLadder = useCallback(async (ladderId: string) => {
    if (isPreviewMode) {
      const selectedLadder = applyLadderSelection(beltLaddersRef.current, ladderId);
      setEligibilityPendingLadderId(null);
      setEligibilityLoadError(null);
      await loadEligibilityForLadder(selectedLadder?.id ?? null, { force: true });
      return;
    }

    const selectedLadder = applyLadderSelection(beltLaddersRef.current, ladderId);
    if (!selectedLadder) {
      await (refreshBeltsRef.current?.(ladderId) ?? Promise.resolve());
      return;
    }

    await loadEligibilityForLadder(selectedLadder.id);
  }, [
    applyLadderSelection,
    beltLaddersRef,
    isPreviewMode,
    loadEligibilityForLadder,
    refreshBeltsRef,
    setEligibilityLoadError,
    setEligibilityPendingLadderId,
  ]);

  const ensureCurrentLadder = useCallback(async (termOverride?: string) => {
    if (isPreviewMode) {
      const selectedPreviewLadder = selectBeltLadder(
        beltLaddersRef.current,
        currentLadderIdRef.current
      );
      return {
        id: selectedPreviewLadder?.id || "mock-ladder",
        sub_rank_term: termOverride || selectedPreviewLadder?.sub_rank_term || subRankTerm,
      };
    }

    const liveRequest = beginLiveAuthRequest();

    if (currentLadderIdRef.current) {
      return {
        id: currentLadderIdRef.current,
        sub_rank_term: termOverride || subRankTerm,
      };
    }

    const existingLadders = await api.get<BeltLadder[]>("/belts/ladders", liveRequest.token);
    if (!liveRequest.isCurrent()) {
      throw new Error("Not authenticated");
    }
    const existingSelectedLadder = applyLadderSelection(existingLadders);

    if (existingSelectedLadder) {
      return {
        id: existingSelectedLadder.id,
        sub_rank_term: existingSelectedLadder.sub_rank_term || "Stripe",
      };
    }

    throw new Error("Create a program in Settings before configuring ranks.");
  }, [applyLadderSelection, beginLiveAuthRequest, beltLaddersRef, currentLadderIdRef, isPreviewMode, subRankTerm]);

  const setBeltRanks = useCallback(async (ranks: BeltRank[], options?: { subRankTerm?: string }) => {
    if (isPreviewMode) {
      const previousRanks = beltRanksRef.current;
      const nextPreviewLadder = buildPreviewBeltLadderFromRanks(
        beltLaddersRef.current,
        ranks,
        {
          preferredLadderId: currentLadderIdRef.current,
          fallbackLadder: MOCK_BELT_LADDER,
          ladderName,
          subRankTerm,
          requestedSubRankTerm: options?.subRankTerm,
        }
      );
      const nextLadders = upsertBeltLadder(beltLaddersRef.current, nextPreviewLadder);
      const repairedStudents = repairPreviewStudentRanksForLadder(
        studentsRef.current,
        nextPreviewLadder,
        previousRanks,
        ranks,
      );
      persistStudents(repairedStudents);
      beltRanksRef.current = ranks;
      beltLaddersRef.current = nextLadders;
      persistBeltRanks(ranks);
      applyLadderSelection(nextLadders, nextPreviewLadder.id);
      await loadEligibilityForLadder(nextPreviewLadder.id, { force: true });
      return;
    }

    const liveRequest = beginLiveAuthRequest();
    const desiredSubRankTerm = options?.subRankTerm?.trim() || undefined;
    const ladder = await ensureCurrentLadder(desiredSubRankTerm);
    if (!liveRequest.isCurrent()) {
      return;
    }
    const studioId = beltLaddersRef.current.find(
      (candidate) => candidate.id === ladder.id
    )?.studio_id;
    if (!studioId) {
      throw new Error("The selected belt ladder is not attached to the active studio.");
    }
    const nextSubRankTerm = desiredSubRankTerm || ladder.sub_rank_term || "Stripe";
    const syncPayload = buildBeltLadderSyncPayload(ranks, nextSubRankTerm);
    const fingerprint = JSON.stringify(syncPayload);

    let syncedLadder: BeltLadder | undefined;
    const pendingSync = pendingLadderSyncsRef.current.get(ladder.id)
      ?? loadPendingBeltLadderSync(studioId, ladder.id);
    if (pendingSync) {
      pendingLadderSyncsRef.current.set(ladder.id, pendingSync);
      let resolvedPendingSync: BeltLadder;
      try {
        resolvedPendingSync = await api.post<BeltLadder>(
          `/belts/ladders/${ladder.id}/sync`,
          pendingSync.request,
          liveRequest.token
        );
      } catch (error) {
        if (isTerminalBeltLadderSyncError(error)) {
          pendingLadderSyncsRef.current.delete(ladder.id);
          clearPendingBeltLadderSync(studioId, ladder.id);
        }
        throw error;
      }
      pendingLadderSyncsRef.current.delete(ladder.id);
      clearPendingBeltLadderSync(studioId, ladder.id);
      if (pendingSync.fingerprint === fingerprint) {
        syncedLadder = resolvedPendingSync;
      }
    }

    if (!syncedLadder) {
      const request = {
        ...syncPayload,
        operation_id: crypto.randomUUID(),
      };
      pendingLadderSyncsRef.current.set(ladder.id, { fingerprint, request });
      persistPendingBeltLadderSync(studioId, ladder.id, { fingerprint, request });
      try {
        syncedLadder = await api.post<BeltLadder>(
          `/belts/ladders/${ladder.id}/sync`,
          request,
          liveRequest.token
        );
      } catch (firstError) {
        if (isTerminalBeltLadderSyncError(firstError)) {
          pendingLadderSyncsRef.current.delete(ladder.id);
          clearPendingBeltLadderSync(studioId, ladder.id);
          throw firstError;
        }
        try {
          // The database operation ID serializes this retry behind an original
          // request that may still be committing.  A later user retry resolves
          // the same pending operation before it can submit a new payload.
          syncedLadder = await api.post<BeltLadder>(
            `/belts/ladders/${ladder.id}/sync`,
            request,
            liveRequest.token
          );
        } catch (retryError) {
          if (isTerminalBeltLadderSyncError(retryError)) {
            pendingLadderSyncsRef.current.delete(ladder.id);
            clearPendingBeltLadderSync(studioId, ladder.id);
            throw retryError;
          }
          throw firstError;
        }
      }
      pendingLadderSyncsRef.current.delete(ladder.id);
      clearPendingBeltLadderSync(studioId, ladder.id);
    }
    if (!liveRequest.isCurrent()) {
      return;
    }
    const nextLadders = upsertBeltLadder(beltLaddersRef.current, syncedLadder);
    applyLadderSelection(nextLadders, syncedLadder.id);

    const reconciliation = await Promise.allSettled([
      refreshStudents(),
      loadEligibilityForLadder(syncedLadder.id, { force: true }),
    ]);
    if (reconciliation.some((result) => result.status === "rejected")) {
      throw Object.assign(
        new Error("Program ranks were saved, but refreshed data could not be loaded."),
        { committed: true },
      );
    }
  }, [
    applyLadderSelection,
    beginLiveAuthRequest,
    beltLaddersRef,
    beltRanksRef,
    currentLadderIdRef,
    ensureCurrentLadder,
    isPreviewMode,
    ladderName,
    loadEligibilityForLadder,
    persistBeltRanks,
    persistStudents,
    refreshStudents,
    studentsRef,
    subRankTerm,
  ]);

  const setLadderName = useCallback((name: string) => {
    setLadderNameState(name);
    if (isPreviewMode) save(KEYS.ladderName, name);
  }, [isPreviewMode, setLadderNameState]);

  const setSubRankTerm = useCallback(async (term: string) => {
    const nextTerm = term.trim() || "Stripe";

    if (isPreviewMode) {
      const previewUpdate = updatePreviewLadderSubRankTerm(
        beltLaddersRef.current,
        currentLadderIdRef.current,
        nextTerm
      );
      setSubRankTermState(nextTerm);
      if (previewUpdate.selectedLadder && previewUpdate.ladders) {
        applyLadderSelection(previewUpdate.ladders, previewUpdate.selectedLadder.id);
      }
      save(KEYS.subRankTerm, nextTerm);
      return;
    }

    const liveRequest = beginLiveAuthRequest();
    const ladder = await ensureCurrentLadder(nextTerm);
    if (!liveRequest.isCurrent()) {
      return;
    }
    if (ladder.sub_rank_term !== nextTerm) {
      await api.patch(
        `/belts/ladders/${ladder.id}`,
        { sub_rank_term: nextTerm },
        liveRequest.token
      );
    }
    if (!liveRequest.isCurrent()) {
      return;
    }
    await refreshBelts(ladder.id);
  }, [
    applyLadderSelection,
    beginLiveAuthRequest,
    beltLaddersRef,
    currentLadderIdRef,
    ensureCurrentLadder,
    isPreviewMode,
    refreshBelts,
    setSubRankTermState,
  ]);

  const loadPromotionHistory = useCallback(async (
    studentId: string,
    options?: { force?: boolean; signal?: AbortSignal }
  ): Promise<Promotion[]> => {
    return loadPromotionHistoryWithCache({
      studentId,
      force: options?.force,
      isPreviewMode,
      cache: promotionHistoryCacheRef.current,
      requests: promotionHistoryRequestsRef.current,
      generation: promotionHistoryGenerationRef.current,
      isGenerationCurrent: (generation) => generation === promotionHistoryGenerationRef.current,
      beginLiveAuthRequest,
      fetchPromotionHistory: (requestedStudentId, authToken) => api.get<Promotion[]>(
        `/belts/promotions?student_id=${encodeURIComponent(requestedStudentId)}&include_names=true`,
        authToken,
        {
          timeoutMs: 6000,
          timeoutMessage: "Promotion history took too long to load. Please try again.",
        }
      ),
      commitCache: commitPromotionHistoryCache,
    });
  }, [
    beginLiveAuthRequest,
    commitPromotionHistoryCache,
    isPreviewMode,
    promotionHistoryCacheRef,
    promotionHistoryGenerationRef,
    promotionHistoryRequestsRef,
  ]);

  const commitPromotionHistoryItem = useCallback((studentId: string, item: Promotion) => {
    commitPromotionHistoryCache(
      studentId,
      buildPromotionHistoryWithPrependedItem(
        promotionHistoryCacheRef.current,
        studentId,
        item
      )
    );
  }, [commitPromotionHistoryCache, promotionHistoryCacheRef]);

  const commitLivePromotionHistoryItem = useCallback((studentId: string, item: Promotion) => {
    const history = buildPromotionHistoryWithPrependedItemIfCached(
      promotionHistoryCacheRef.current,
      studentId,
      item
    );
    if (history) {
      commitPromotionHistoryCache(studentId, history);
    }
  }, [commitPromotionHistoryCache, promotionHistoryCacheRef]);

  const promoteStudent = useCallback(async (data: PromoteStudent) => {
    if (isPreviewMode) {
      const previewPromotion = buildPreviewPromotion(studentsRef.current, beltRanksRef.current, {
        studentId: data.student_id,
        toRankId: data.to_rank_id,
        studentProgramMembershipId: data.student_program_membership_id,
        programId: data.program_id,
        notes: data.notes ?? undefined,
        idFactory: localId,
      });
      persistStudents(previewPromotion.students);
      commitPromotionHistoryItem(data.student_id, previewPromotion.promotion);
      await loadEligibilityForLadder(currentLadderIdRef.current, { force: true });

      return previewPromotion.promotion;
    }

    // Invalidate any GET that started before this write. Its promise may still
    // resolve for its caller, but identity checks prevent it from overwriting
    // the committed promotion in the shared cache.
    delete promotionHistoryRequestsRef.current[data.student_id];
    const pending = pendingRankTransition("promotion", data);
    const requestData = { ...data, operation_id: pending.operationId };
    const liveRequest = beginLiveAuthRequest();
    let result: Promotion;
    try {
      result = await api.post<Promotion>(
        "/belts/promote",
        requestData,
        liveRequest.token
      );
    } catch (error) {
      if (isTerminalRankTransitionError(error)) {
        clearRankTransition("promotion", data.student_id);
        throw error;
      }
      delete promotionHistoryRequestsRef.current[data.student_id];
      const history = await loadPromotionHistory(data.student_id, { force: true })
        .catch(() => null);
      const recovered = history?.find(
        (item) => item.operation_id === pending.operationId
      );
      if (!recovered) throw error;
      clearRankTransition("promotion", data.student_id);
      result = recovered;
    }
    clearRankTransition("promotion", data.student_id);
    if (!liveRequest.isCurrent()) {
      return result;
    }

    commitLivePromotionHistoryItem(data.student_id, result);

    const reconciliation = await Promise.allSettled([
      refreshStudents(),
      refreshBelts(currentLadderIdRef.current, { requireEligibility: true }),
    ]);
    if (reconciliation.some((item) => item.status === "rejected")) {
      throw Object.assign(
        new Error("Promotion was recorded, but refreshed data could not be loaded."),
        { committed: true },
      );
    }
    return result;
  }, [
    beginLiveAuthRequest,
    beltRanksRef,
    clearRankTransition,
    commitPromotionHistoryItem,
    commitLivePromotionHistoryItem,
    currentLadderIdRef,
    isPreviewMode,
    loadEligibilityForLadder,
    loadPromotionHistory,
    pendingRankTransition,
    persistStudents,
    promotionHistoryRequestsRef,
    refreshBelts,
    refreshStudents,
    studentsRef,
  ]);

  const demoteStudent = useCallback(async (data: DemoteStudent) => {
    if (isPreviewMode) {
      const previewDemotion = buildPreviewPromotion(studentsRef.current, beltRanksRef.current, {
        studentId: data.student_id,
        toRankId: data.to_rank_id,
        studentProgramMembershipId: data.student_program_membership_id,
        programId: data.program_id,
        notes: data.reason,
        idFactory: localId,
      });
      persistStudents(previewDemotion.students);
      commitPromotionHistoryItem(data.student_id, previewDemotion.promotion);
      await loadEligibilityForLadder(currentLadderIdRef.current, { force: true });

      return previewDemotion.promotion;
    }

    delete promotionHistoryRequestsRef.current[data.student_id];
    const pending = pendingRankTransition("demotion", data);
    const requestData = { ...data, operation_id: pending.operationId };
    const liveRequest = beginLiveAuthRequest();
    let result: Promotion;
    try {
      result = await api.post<Promotion>(
        "/belts/demote",
        requestData,
        liveRequest.token
      );
    } catch (error) {
      if (isTerminalRankTransitionError(error)) {
        clearRankTransition("demotion", data.student_id);
        throw error;
      }
      delete promotionHistoryRequestsRef.current[data.student_id];
      const history = await loadPromotionHistory(data.student_id, { force: true })
        .catch(() => null);
      const recovered = history?.find(
        (item) => item.operation_id === pending.operationId
      );
      if (!recovered) throw error;
      clearRankTransition("demotion", data.student_id);
      result = recovered;
    }
    clearRankTransition("demotion", data.student_id);
    if (!liveRequest.isCurrent()) {
      return result;
    }

    commitLivePromotionHistoryItem(data.student_id, result);

    const reconciliation = await Promise.allSettled([
      refreshStudents(),
      refreshBelts(currentLadderIdRef.current, { requireEligibility: true }),
    ]);
    if (reconciliation.some((item) => item.status === "rejected")) {
      throw Object.assign(
        new Error("Demotion was recorded, but refreshed data could not be loaded."),
        { committed: true },
      );
    }
    return result;
  }, [
    beginLiveAuthRequest,
    beltRanksRef,
    clearRankTransition,
    commitPromotionHistoryItem,
    commitLivePromotionHistoryItem,
    currentLadderIdRef,
    isPreviewMode,
    loadEligibilityForLadder,
    loadPromotionHistory,
    pendingRankTransition,
    persistStudents,
    promotionHistoryRequestsRef,
    refreshBelts,
    refreshStudents,
    studentsRef,
  ]);

  return {
    demoteStudent,
    loadPromotionHistory,
    promoteStudent,
    refreshBelts,
    setBeltRanks,
    setCurrentLadder,
    setLadderName,
    setSubRankTerm,
  };
}

"use client";

import { useCallback, useEffect } from "react";
import { api } from "@/lib/api";
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
  const refreshBelts = useCallback(async (preferredLadderId?: string | null) => {
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
    await loadEligibilityForLadder(selectedLadder?.id ?? null, { force: true }).catch(() => undefined);
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
    const nextSubRankTerm = desiredSubRankTerm || ladder.sub_rank_term || "Stripe";
    const syncPayload = buildBeltLadderSyncPayload(ranks, nextSubRankTerm);

    const syncedLadder = await api.post<BeltLadder>(
      `/belts/ladders/${ladder.id}/sync`,
      syncPayload,
      liveRequest.token
    );
    if (!liveRequest.isCurrent()) {
      return;
    }
    const nextLadders = upsertBeltLadder(beltLaddersRef.current, syncedLadder);
    applyLadderSelection(nextLadders, syncedLadder.id);

    await Promise.all([
      refreshStudents(),
      loadEligibilityForLadder(syncedLadder.id, { force: true }),
    ]);
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
        `/belts/promotions?student_id=${encodeURIComponent(requestedStudentId)}&include_names=false`,
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

    const liveRequest = beginLiveAuthRequest();
    const result = await api.post<Promotion>(
      "/belts/promote",
      data,
      liveRequest.token
    );
    if (!liveRequest.isCurrent()) {
      return result;
    }

    commitLivePromotionHistoryItem(data.student_id, result);

    await Promise.all([refreshStudents(), refreshBelts(currentLadderIdRef.current)]);
    return result;
  }, [
    beginLiveAuthRequest,
    beltRanksRef,
    commitPromotionHistoryItem,
    commitLivePromotionHistoryItem,
    currentLadderIdRef,
    isPreviewMode,
    loadEligibilityForLadder,
    persistStudents,
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

    const liveRequest = beginLiveAuthRequest();
    const result = await api.post<Promotion>(
      "/belts/demote",
      data,
      liveRequest.token
    );
    if (!liveRequest.isCurrent()) {
      return result;
    }

    delete promotionHistoryRequestsRef.current[data.student_id];
    commitLivePromotionHistoryItem(data.student_id, result);

    await Promise.allSettled([refreshStudents(), refreshBelts(currentLadderIdRef.current)]);
    return result;
  }, [
    beginLiveAuthRequest,
    beltRanksRef,
    commitPromotionHistoryItem,
    commitLivePromotionHistoryItem,
    currentLadderIdRef,
    isPreviewMode,
    loadEligibilityForLadder,
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

import type { Promotion } from "@/types";

export const PROMOTION_HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;

export interface PromotionHistoryCacheEntry {
  items: Promotion[];
  fetchedAt: number;
}

export type PromotionHistoryCache = Record<string, PromotionHistoryCacheEntry>;
export type PromotionHistoryRequests = Record<string, Promise<Promotion[]>>;

export function isPromotionHistoryCacheEntryFresh(
  entry: PromotionHistoryCacheEntry | undefined,
  now = Date.now(),
  ttlMs = PROMOTION_HISTORY_CACHE_TTL_MS
): boolean {
  return Boolean(entry && now - entry.fetchedAt < ttlMs);
}

export function setPromotionHistoryCacheItems(
  cache: PromotionHistoryCache,
  studentId: string,
  items: Promotion[],
  fetchedAt = Date.now()
): PromotionHistoryCache {
  return {
    ...cache,
    [studentId]: {
      items,
      fetchedAt,
    },
  };
}

export function getPromotionHistoryCacheItems(
  cache: PromotionHistoryCache,
  studentId: string
): Promotion[] {
  return cache[studentId]?.items ?? [];
}

export function prependPromotionHistoryItem(
  items: Promotion[],
  promotion: Promotion
): Promotion[] {
  return [promotion, ...items.filter((item) => item.id !== promotion.id)];
}

export function buildPromotionHistoryWithPrependedItem(
  cache: PromotionHistoryCache,
  studentId: string,
  promotion: Promotion
): Promotion[] {
  return prependPromotionHistoryItem(
    getPromotionHistoryCacheItems(cache, studentId),
    promotion
  );
}

export function buildPromotionHistoryWithPrependedItemIfCached(
  cache: PromotionHistoryCache,
  studentId: string,
  promotion: Promotion
): Promotion[] | null {
  const cached = cache[studentId];
  return cached ? prependPromotionHistoryItem(cached.items, promotion) : null;
}

export function toPromotionHistoryByStudent(
  cache: PromotionHistoryCache
): Record<string, Promotion[]> {
  return Object.fromEntries(
    Object.entries(cache).map(([studentId, entry]) => [studentId, entry.items])
  );
}

type PromotionHistoryLoadPlan =
  | { kind: "cached"; items: Promotion[] }
  | { kind: "inFlight"; request: Promise<Promotion[]> }
  | { kind: "preview"; items: Promotion[] }
  | { kind: "live" };

export function resolvePromotionHistoryLoadPlan({
  cache,
  requests,
  studentId,
  force = false,
  isPreviewMode,
  now = Date.now(),
  ttlMs = PROMOTION_HISTORY_CACHE_TTL_MS,
}: {
  cache: PromotionHistoryCache;
  requests: PromotionHistoryRequests;
  studentId: string;
  force?: boolean;
  isPreviewMode: boolean;
  now?: number;
  ttlMs?: number;
}): PromotionHistoryLoadPlan {
  const cached = cache[studentId];

  if (!force && isPromotionHistoryCacheEntryFresh(cached, now, ttlMs)) {
    return { kind: "cached", items: cached?.items ?? [] };
  }

  const inFlightRequest = requests[studentId];
  if (inFlightRequest && !force) {
    return { kind: "inFlight", request: inFlightRequest };
  }

  if (isPreviewMode) {
    return { kind: "preview", items: cached?.items ?? [] };
  }

  return { kind: "live" };
}

export async function loadPromotionHistoryWithCache({
  studentId,
  force,
  isPreviewMode,
  cache,
  requests,
  generation,
  isGenerationCurrent,
  beginLiveAuthRequest,
  fetchPromotionHistory,
  commitCache,
}: {
  studentId: string;
  force?: boolean;
  isPreviewMode: boolean;
  cache: PromotionHistoryCache;
  requests: PromotionHistoryRequests;
  generation: number;
  isGenerationCurrent: (generation: number) => boolean;
  beginLiveAuthRequest: () => { token: string; isCurrent: () => boolean };
  fetchPromotionHistory: (studentId: string, token: string) => Promise<Promotion[]>;
  commitCache: (studentId: string, items: Promotion[]) => void;
}): Promise<Promotion[]> {
  const loadPlan = resolvePromotionHistoryLoadPlan({
    cache,
    requests,
    studentId,
    force,
    isPreviewMode,
  });

  if (loadPlan.kind === "cached" || loadPlan.kind === "preview") {
    return loadPlan.items;
  }

  if (loadPlan.kind === "inFlight") {
    return loadPlan.request;
  }

  const liveRequest = beginLiveAuthRequest();
  const request = fetchPromotionHistory(studentId, liveRequest.token)
    .then((result) => {
      if (
        requests[studentId] === request
        && isGenerationCurrent(generation)
        && liveRequest.isCurrent()
      ) {
        commitCache(studentId, result);
      }
      return result;
    })
    .finally(() => {
      if (requests[studentId] === request) {
        delete requests[studentId];
      }
    });

  requests[studentId] = request;
  return request;
}

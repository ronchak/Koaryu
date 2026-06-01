import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getPromotionHistoryCacheItems,
  loadPromotionHistoryWithCache,
  prependPromotionHistoryItem,
  resolvePromotionHistoryLoadPlan,
  setPromotionHistoryCacheItems,
  toPromotionHistoryByStudent,
} from "../src/lib/store-promotion-history.ts";

function promotion(id, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    student_id: "student-1",
    from_rank_id: "white",
    to_rank_id: "blue",
    promoted_by: "user-1",
    promoted_at: "2026-05-24T12:00:00.000Z",
    ...overrides,
  };
}

describe("store promotion history model", () => {
  it("stores, projects, and prepends cache items without duplicates", () => {
    const first = promotion("promotion-1");
    const updatedFirst = promotion("promotion-1", { notes: "Updated" });
    const second = promotion("promotion-2");

    const cache = setPromotionHistoryCacheItems(
      {},
      "student-1",
      [first],
      Date.parse("2026-05-24T12:00:00.000Z")
    );

    assert.deepEqual(getPromotionHistoryCacheItems(cache, "student-1"), [first]);
    assert.deepEqual(getPromotionHistoryCacheItems(cache, "missing"), []);
    assert.deepEqual(
      prependPromotionHistoryItem([first, second], updatedFirst).map((item) => [item.id, item.notes]),
      [
        ["promotion-1", "Updated"],
        ["promotion-2", undefined],
      ]
    );
    assert.deepEqual(toPromotionHistoryByStudent(cache), { "student-1": [first] });
  });

  it("resolves cache, in-flight, preview, and live load plans", async () => {
    const cachedPromotion = promotion("promotion-1");
    const cachedAt = Date.parse("2026-05-24T12:00:00.000Z");
    const freshNow = cachedAt + 60_000;
    const staleNow = cachedAt + 600_000;
    const cache = setPromotionHistoryCacheItems({}, "student-1", [cachedPromotion], cachedAt);
    const inFlight = Promise.resolve([promotion("promotion-2")]);

    assert.deepEqual(
      resolvePromotionHistoryLoadPlan({
        cache,
        requests: {},
        studentId: "student-1",
        isPreviewMode: false,
        now: freshNow,
      }),
      { kind: "cached", items: [cachedPromotion] }
    );

    const inFlightPlan = resolvePromotionHistoryLoadPlan({
      cache,
      requests: { "student-1": inFlight },
      studentId: "student-1",
      isPreviewMode: false,
      now: staleNow,
    });
    assert.equal(inFlightPlan.kind, "inFlight");
    assert.deepEqual(await inFlightPlan.request, await inFlight);

    assert.deepEqual(
      resolvePromotionHistoryLoadPlan({
        cache,
        requests: { "student-1": inFlight },
        studentId: "student-1",
        force: true,
        isPreviewMode: true,
        now: freshNow,
      }),
      { kind: "preview", items: [cachedPromotion] }
    );

    assert.deepEqual(
      resolvePromotionHistoryLoadPlan({
        cache: {},
        requests: {},
        studentId: "student-1",
        isPreviewMode: false,
        now: staleNow,
      }),
      { kind: "live" }
    );
  });

  it("loads live promotion history once and commits only current generations", async () => {
    const fetched = [promotion("promotion-3")];
    const requests = {};
    const committed = [];
    let fetchCount = 0;

    const loadPromise = loadPromotionHistoryWithCache({
      studentId: "student-1",
      isPreviewMode: false,
      cache: {},
      requests,
      generation: 2,
      isGenerationCurrent: (generation) => generation === 2,
      beginLiveAuthRequest: () => ({ token: "token-1", isCurrent: () => true }),
      fetchPromotionHistory: async (studentId, token) => {
        fetchCount += 1;
        assert.equal(studentId, "student-1");
        assert.equal(token, "token-1");
        return fetched;
      },
      commitCache: (studentId, items) => committed.push([studentId, items]),
    });

    assert.ok(requests["student-1"] instanceof Promise);
    assert.deepEqual(await loadPromise, fetched);
    assert.equal(fetchCount, 1);
    assert.deepEqual(committed, [["student-1", fetched]]);
    assert.equal(requests["student-1"], undefined);

    await loadPromotionHistoryWithCache({
      studentId: "student-1",
      isPreviewMode: false,
      cache: {},
      requests: {},
      generation: 3,
      isGenerationCurrent: () => false,
      beginLiveAuthRequest: () => ({ token: "token-2", isCurrent: () => true }),
      fetchPromotionHistory: async () => fetched,
      commitCache: (studentId, items) => committed.push([studentId, items]),
    });

    assert.deepEqual(committed, [["student-1", fetched]]);
  });
});

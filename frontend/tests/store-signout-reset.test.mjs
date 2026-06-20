import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isLiveAuthRequestCurrent } from "../src/lib/store-bootstrap-model.ts";
import {
  applyLiveStudioDataResetRefs,
  buildSignedOutStudioResetState,
  buildSubscriptionRequiredStudioResetState,
  nextLiveStudioDataResetGeneration,
  SUBSCRIPTION_REQUIRED_MESSAGE,
} from "../src/lib/store-reset-model.ts";

describe("store auth reset model", () => {
  it("clears every live studio cache for a signed-out session", () => {
    const reset = buildSignedOutStudioResetState();

    assert.equal(reset.subscriptionRequired, false);
    assert.equal(reset.studioName, "");
    assert.equal(reset.staffLoaded, false);
    assert.equal(reset.staffLoadError, null);
    assert.equal(reset.programsLoaded, false);
    assert.equal(reset.programsLoadError, null);
    assert.equal(reset.dashboardSummary, null);
    assert.equal(reset.dashboardSummaryLoaded, true);
    assert.equal(reset.studentsLoaded, true);
    assert.equal(reset.studentsLoadError, null);
    assert.equal(reset.studentsLastLoadedAt, null);
    assert.equal(reset.studentsMayBePartial, false);
    assert.equal(reset.currentLadderId, null);
    assert.equal(reset.ladderName, "");
    assert.equal(reset.subRankTerm, "Stripe");
    assert.equal(reset.eligibilityLadderId, null);
    assert.equal(reset.eligibilityPendingLadderId, null);
    assert.equal(reset.eligibilityLoadError, null);
    assert.deepEqual(reset.eligibilityCache, {});
    assert.deepEqual(reset.promotionHistoryCache, {});

    for (const key of [
      "staffMembers",
      "programs",
      "students",
      "leads",
      "beltLadders",
      "beltRanks",
      "sessions",
      "templates",
      "attendance",
      "eligibility",
    ]) {
      assert.deepEqual(reset[key], [], `${key} is cleared`);
    }
  });

  it("synchronously clears mutable live cache refs during reset", () => {
    const reset = buildSignedOutStudioResetState();
    const refs = {
      staffMembers: { current: [{ id: "staff-1" }] },
      programs: { current: [{ id: "program-1" }] },
      students: { current: [{ id: "student-1" }] },
      leads: { current: [{ id: "lead-1" }] },
      beltLadders: { current: [{ id: "ladder-1" }] },
      beltRanks: { current: [{ id: "rank-1" }] },
      sessions: { current: [{ id: "session-1" }] },
      templates: { current: [{ id: "template-1" }] },
      attendance: { current: [{ id: "attendance-1" }] },
      eligibility: { current: [{ student_id: "student-1" }] },
      eligibilityCache: { current: { "ladder-1": [{ student_id: "student-1" }] } },
      promotionHistoryCache: {
        current: {
          "student-1": {
            fetchedAt: 123,
            items: [{ id: "promotion-1" }],
          },
        },
      },
      promotionHistoryRequests: {
        current: {
          "student-1": Promise.resolve([{ id: "promotion-1" }]),
        },
      },
    };

    applyLiveStudioDataResetRefs(refs, reset);

    for (const key of [
      "staffMembers",
      "programs",
      "students",
      "leads",
      "beltLadders",
      "beltRanks",
      "sessions",
      "templates",
      "attendance",
      "eligibility",
    ]) {
      assert.equal(refs[key].current, reset[key], `${key} ref points at reset state`);
      assert.deepEqual(refs[key].current, [], `${key} ref is cleared`);
    }

    assert.equal(refs.eligibilityCache.current, reset.eligibilityCache);
    assert.deepEqual(refs.eligibilityCache.current, {});
    assert.equal(refs.promotionHistoryCache.current, reset.promotionHistoryCache);
    assert.deepEqual(refs.promotionHistoryCache.current, {});
    assert.deepEqual(refs.promotionHistoryRequests.current, {});
  });

  it("clears cached studio data while preserving subscription-required errors", () => {
    const reset = buildSubscriptionRequiredStudioResetState();

    assert.equal(reset.subscriptionRequired, true);
    assert.equal(reset.staffLoaded, true);
    assert.equal(reset.programsLoaded, true);
    assert.equal(reset.studentsLoaded, true);
    assert.equal(reset.staffLoadError, SUBSCRIPTION_REQUIRED_MESSAGE);
    assert.equal(reset.programsLoadError, SUBSCRIPTION_REQUIRED_MESSAGE);
    assert.equal(reset.studentsLoadError, SUBSCRIPTION_REQUIRED_MESSAGE);
    assert.equal(reset.studentsLastLoadedAt, null);
    assert.equal(reset.studentsMayBePartial, false);
    assert.deepEqual(reset.eligibilityCache, {});
    assert.deepEqual(reset.promotionHistoryCache, {});

    for (const key of [
      "staffMembers",
      "programs",
      "students",
      "leads",
      "beltLadders",
      "beltRanks",
      "sessions",
      "templates",
      "attendance",
      "eligibility",
    ]) {
      assert.deepEqual(reset[key], [], `${key} is cleared`);
    }
  });

  it("invalidates stale live commits when token or generation changes", () => {
    const request = {
      requestToken: "token-a",
      requestGeneration: 3,
    };

    assert.equal(isLiveAuthRequestCurrent({
      ...request,
      currentToken: "token-a",
      currentGeneration: 3,
    }), true);
    assert.equal(isLiveAuthRequestCurrent({
      ...request,
      currentToken: "token-b",
      currentGeneration: 3,
    }), false);
    assert.equal(isLiveAuthRequestCurrent({
      ...request,
      currentToken: "token-a",
      currentGeneration: 4,
    }), false);
    assert.equal(isLiveAuthRequestCurrent({
      ...request,
      currentToken: null,
      currentGeneration: 4,
    }), false);
  });

  it("keeps subscription-required resets tokenful but stale-commit safe", () => {
    const requestToken = "active-token";
    const requestGeneration = 7;
    const subscriptionRequiredGeneration = nextLiveStudioDataResetGeneration(requestGeneration);
    const reset = buildSubscriptionRequiredStudioResetState();

    assert.equal(reset.subscriptionRequired, true);
    assert.equal(isLiveAuthRequestCurrent({
      requestToken,
      requestGeneration,
      currentToken: requestToken,
      currentGeneration: subscriptionRequiredGeneration,
    }), false);
    assert.equal(isLiveAuthRequestCurrent({
      requestToken,
      requestGeneration: subscriptionRequiredGeneration,
      currentToken: requestToken,
      currentGeneration: subscriptionRequiredGeneration,
    }), true);
  });
});

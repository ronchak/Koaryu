import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { landingPageContent } from "../src/lib/landing-page-content.ts";
import {
  FAQ_HASHES,
  FAQ_WHEEL_LOCK_MS,
  INITIAL_WHEEL_GESTURE_STATE,
  JOURNEY_HASH_ALIASES,
  LINE_DELTA_SCALE,
  NEW_GESTURE_GAP_MS,
  TOUCH_THRESHOLD_PX,
  WHEEL_LOCK_MS,
  WHEEL_THRESHOLD,
  canScrollablePanelMove,
  decideJourneyKey,
  decideTouchChapter,
  nextFaqTopicIndex,
  normalizeWheelDelta,
  reduceWheelGesture,
  resolveJourneyHash,
  sceneTransitionDuration,
  shouldHandleJourneyKeyboardFocus,
} from "../src/components/marketing/journey/interaction-model.ts";

describe("Journey hash model", () => {
  it("resolves every canonical chapter and preserves all exact chapter stops", () => {
    landingPageContent.chapters.forEach((chapter, chapterIndex) => {
      assert.deepEqual(resolveJourneyHash(`#${chapter.id}`), {
        chapterId: chapter.id,
        chapterIndex,
        faqGroup: null,
        canonicalHash: chapter.id,
        wasAlias: false,
      });
    });
    assert.equal(resolveJourneyHash(""), null);
    assert.equal(resolveJourneyHash("#not-a-journey-stop"), null);
  });

  it("normalizes all 12 legacy aliases and all six FAQ topic hashes", () => {
    assert.equal(Object.keys(JOURNEY_HASH_ALIASES).length, 12);
    for (const [alias, chapterId] of Object.entries(JOURNEY_HASH_ALIASES)) {
      const resolved = resolveJourneyHash(`#${alias}`);
      assert.equal(resolved?.chapterId, chapterId);
      assert.equal(resolved?.canonicalHash, chapterId);
      assert.equal(resolved?.wasAlias, true);
    }

    assert.deepEqual(FAQ_HASHES, [
      "faq-fit",
      "faq-switching",
      "faq-daily",
      "faq-pricing",
      "faq-data",
      "faq-roadmap",
    ]);
    FAQ_HASHES.forEach((hash, faqGroup) => {
      const resolved = resolveJourneyHash(hash);
      assert.equal(resolved?.chapterId, "faq");
      assert.equal(resolved?.faqGroup, faqGroup);
      assert.equal(resolved?.canonicalHash, hash);
      assert.equal(resolved?.wasAlias, false);
    });
  });
});

describe("Journey wheel and nested-scroll model", () => {
  it("uses the exact normalization and gesture constants", () => {
    assert.equal(WHEEL_THRESHOLD, 14);
    assert.equal(WHEEL_LOCK_MS, 260);
    assert.equal(FAQ_WHEEL_LOCK_MS, 220);
    assert.equal(NEW_GESTURE_GAP_MS, 115);
    assert.equal(LINE_DELTA_SCALE, 18);
    assert.equal(TOUCH_THRESHOLD_PX, 40);
    assert.equal(normalizeWheelDelta(2, 0, 844), 2);
    assert.equal(normalizeWheelDelta(2, 1, 844), 36);
    assert.equal(normalizeWheelDelta(2, 2, 844), 1688);
    assert.equal(normalizeWheelDelta(Number.NaN, 0, 844), 0);
  });

  it("accumulates one gesture, advances one chapter, and consumes its inertial tail", () => {
    const first = reduceWheelGesture(INITIAL_WHEEL_GESTURE_STATE, {
      delta: 6,
      now: 10,
      faqCanScroll: false,
    });
    assert.equal(first.action, "none");
    assert.equal(first.state.total, 6);
    assert.equal(first.preventDefault, true);

    const commit = reduceWheelGesture(first.state, {
      delta: 8,
      now: 18,
      faqCanScroll: false,
    });
    assert.equal(commit.action, "advance");
    assert.equal(commit.direction, 1);
    assert.equal(commit.state.lockUntil, 18 + WHEEL_LOCK_MS);

    const tail = reduceWheelGesture(commit.state, {
      delta: 90,
      now: 45,
      faqCanScroll: false,
    });
    assert.equal(tail.action, "none");
    assert.equal(tail.direction, 0);

    const newGesture = reduceWheelGesture(tail.state, {
      delta: -14,
      now: 45 + NEW_GESTURE_GAP_MS + 1,
      faqCanScroll: false,
    });
    assert.equal(newGesture.action, "advance");
    assert.equal(newGesture.direction, -1);
  });

  it("requires the post-lock magnitude floor when events have not separated", () => {
    const active = {
      total: 0,
      active: true,
      lastAt: 100,
      lastMagnitude: 20,
      lockUntil: 200,
    };
    const tail = reduceWheelGesture(active, {
      delta: 34,
      now: 205,
      faqCanScroll: false,
    });
    assert.equal(tail.action, "none");
    const deliberate = reduceWheelGesture(active, {
      delta: 36,
      now: 205,
      faqCanScroll: false,
    });
    assert.equal(deliberate.action, "advance");
    assert.equal(deliberate.direction, 1);
  });

  it("lets a FAQ panel consume input until its directional boundary", () => {
    const middle = { scrollTop: 100, scrollHeight: 500, clientHeight: 200 };
    assert.equal(canScrollablePanelMove(middle, 1), true);
    assert.equal(canScrollablePanelMove(middle, -1), true);
    assert.equal(
      canScrollablePanelMove(
        { scrollTop: 300, scrollHeight: 500, clientHeight: 200 },
        1
      ),
      false
    );
    assert.equal(
      canScrollablePanelMove(
        { scrollTop: 0, scrollHeight: 500, clientHeight: 200 },
        -1
      ),
      false
    );

    const consumed = reduceWheelGesture(INITIAL_WHEEL_GESTURE_STATE, {
      delta: 18,
      now: 80,
      faqCanScroll: true,
    });
    assert.equal(consumed.action, "faq-scroll");
    assert.equal(consumed.preventDefault, false);
    assert.equal(consumed.state.lockUntil, 80 + FAQ_WHEEL_LOCK_MS);
    const escapeTail = reduceWheelGesture(consumed.state, {
      delta: 18,
      now: 95,
      faqCanScroll: false,
    });
    assert.equal(escapeTail.action, "none");
    assert.equal(escapeTail.preventDefault, true);
  });
});

describe("Journey keyboard, touch, and motion decisions", () => {
  const scrollablePanel = {
    scrollTop: 80,
    scrollHeight: 500,
    clientHeight: 200,
  };

  it("gives interactive targets and nested FAQ scrolling priority", () => {
    assert.deepEqual(
      decideJourneyKey({
        key: "ArrowDown",
        shiftKey: false,
        interactiveTarget: true,
        panel: scrollablePanel,
      }),
      { action: "none" }
    );
    assert.deepEqual(
      decideJourneyKey({
        key: "PageDown",
        shiftKey: false,
        interactiveTarget: false,
        panel: scrollablePanel,
      }),
      { action: "panel-scroll", direction: 1, amount: "page" }
    );
    assert.deepEqual(
      decideJourneyKey({
        key: "Home",
        shiftKey: false,
        interactiveTarget: false,
        panel: scrollablePanel,
      }),
      {
        action: "panel-scroll",
        direction: -1,
        amount: "edge",
        edge: "first",
      }
    );
  });

  it("handles fresh body focus, contains Journey focus, and rejects outside focus", () => {
    assert.equal(
      shouldHandleJourneyKeyboardFocus({
        hasActiveElement: true,
        activeIsBody: true,
        activeIsDocumentElement: false,
        rootContainsActive: false,
      }),
      true,
      "fresh-load body focus must keep global chapter keys live"
    );
    assert.equal(
      shouldHandleJourneyKeyboardFocus({
        hasActiveElement: true,
        activeIsBody: false,
        activeIsDocumentElement: false,
        rootContainsActive: true,
      }),
      true
    );
    assert.equal(
      shouldHandleJourneyKeyboardFocus({
        hasActiveElement: true,
        activeIsBody: false,
        activeIsDocumentElement: false,
        rootContainsActive: false,
      }),
      false,
      "focus outside Journey must retain its own keyboard behavior"
    );
  });

  it("moves FAQ topic focus and state with wrapping vertical arrows", () => {
    assert.equal(nextFaqTopicIndex(0, "ArrowDown", FAQ_HASHES.length), 1);
    assert.equal(nextFaqTopicIndex(5, "ArrowDown", FAQ_HASHES.length), 0);
    assert.equal(nextFaqTopicIndex(0, "ArrowUp", FAQ_HASHES.length), 5);
    assert.equal(nextFaqTopicIndex(2, "Enter", FAQ_HASHES.length), null);
  });

  it("maps global keyboard controls and lets FAQ boundaries escape", () => {
    assert.deepEqual(
      decideJourneyKey({
        key: " ",
        shiftKey: true,
        interactiveTarget: false,
        panel: null,
      }),
      { action: "chapter", direction: -1 }
    );
    assert.deepEqual(
      decideJourneyKey({
        key: "End",
        shiftKey: false,
        interactiveTarget: false,
        panel: null,
      }),
      { action: "chapter-edge", edge: "last" }
    );
    assert.deepEqual(
      decideJourneyKey({
        key: "ArrowDown",
        shiftKey: false,
        interactiveTarget: false,
        panel: { scrollTop: 300, scrollHeight: 500, clientHeight: 200 },
      }),
      { action: "chapter", direction: 1 }
    );
  });

  it("requires a 40px swipe and defers to a moving or scrollable FAQ", () => {
    assert.equal(
      decideTouchChapter({
        startY: 200,
        endY: 161,
        panelMoved: false,
        panelCanScroll: false,
      }),
      0
    );
    assert.equal(
      decideTouchChapter({
        startY: 200,
        endY: 160,
        panelMoved: false,
        panelCanScroll: false,
      }),
      1
    );
    assert.equal(
      decideTouchChapter({
        startY: 160,
        endY: 210,
        panelMoved: false,
        panelCanScroll: false,
      }),
      -1
    );
    assert.equal(
      decideTouchChapter({
        startY: 200,
        endY: 100,
        panelMoved: true,
        panelCanScroll: false,
      }),
      0
    );
    assert.equal(
      decideTouchChapter({
        startY: 200,
        endY: 100,
        panelMoved: false,
        panelCanScroll: true,
      }),
      0
    );
  });

  it("selects the exact scene durations including both portal directions", () => {
    assert.equal(sceneTransitionDuration(0.025, 0.1), 940);
    assert.equal(sceneTransitionDuration(0.288, 0.52), 1260);
    assert.equal(sceneTransitionDuration(0.52, 0.288), 1260);
    assert.equal(sceneTransitionDuration(0.52, 0.64), 1100);
    assert.equal(sceneTransitionDuration(1, 1), 1100);
  });
});

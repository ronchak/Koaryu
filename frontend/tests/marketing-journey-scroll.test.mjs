import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { landingPageContent } from "../src/lib/landing-page-content.ts";
import {
  LANDING_HASH_ALIASES,
  TRANSITION_END,
  TRANSITION_START,
  driftForScroll,
  keyframesForLayout,
  progressForScroll,
  resolveLegacyHash,
  stillFrame,
} from "../src/components/marketing/journey/scroll-model.ts";

const anchors = [
  { scrollY: 0, scene: 0 },
  { scrollY: 800, scene: 0.1 },
  { scrollY: 1600, scene: 0.3 },
];

describe("Journey scroll model", () => {
  it("interpolates scene progress between chapter anchors and clamps at both ends", () => {
    assert.equal(progressForScroll(-40, anchors), 0);
    assert.equal(progressForScroll(0, anchors), 0);
    assert.equal(progressForScroll(400, anchors), 0.05);
    assert.equal(progressForScroll(800, anchors), 0.1);
    assert.ok(Math.abs(progressForScroll(1200, anchors) - 0.2) < 1e-9);
    assert.equal(progressForScroll(9000, anchors), 0.3);
    assert.equal(progressForScroll(100, []), 0);
  });

  it("lets the last of several chapters sharing the page bottom own the final frame", () => {
    const bottom = [
      { scrollY: 0, scene: 0 },
      { scrollY: 500, scene: 0.86 },
      { scrollY: 500, scene: 1 },
    ];
    assert.equal(progressForScroll(500, bottom), 1);
    assert.equal(progressForScroll(250, bottom), 0.43);
  });

  it("shows only chapter still frames for reduced motion", () => {
    const scenes = [0, 0.1, 0.3, 0.5];
    assert.equal(stillFrame(0.04, scenes), 0);
    assert.equal(stillFrame(0.06, scenes), 0.1);
    assert.equal(stillFrame(0.21, scenes), 0.3);
    assert.equal(stillFrame(0.9, scenes), 0.5);
  });

  it("holds each chapter while it is read and plays each beat across the gap after it", () => {
    const keyframes = keyframesForLayout(
      [
        { scene: 0, gapStart: 1000, gapEnd: 1500 },
        { scene: 0.1, gapStart: 2500, gapEnd: 3800 },
        { scene: 0.3, gapStart: 4800, gapEnd: 4800 },
      ],
      1000,
      9000,
    );
    assert.equal(TRANSITION_START, 0.6);
    assert.equal(TRANSITION_END, 0.4);
    assert.deepEqual(keyframes, [
      { scrollY: 0, scene: 0 },
      { scrollY: 400, scene: 0 },
      { scrollY: 1100, scene: 0.1 },
      { scrollY: 1900, scene: 0.1 },
      { scrollY: 3400, scene: 0.3 },
    ]);
    // Reading the first two chapters moves nothing.
    assert.equal(progressForScroll(200, keyframes), 0);
    assert.equal(progressForScroll(1500, keyframes), 0.1);
    // Halfway through a gap, the story is halfway through its beat.
    assert.ok(Math.abs(progressForScroll(750, keyframes) - 0.05) < 1e-9);
    // A longer interlude gives its beat more scroll.
    assert.ok(3400 - 1900 > 1100 - 400);
    assert.equal(progressForScroll(8000, keyframes), 0.3);
  });

  it("drifts held frames continuously and eases the drift out during each beat", () => {
    const keyframes = [
      { scrollY: 0, scene: 0 },
      { scrollY: 400, scene: 0 },
      { scrollY: 1100, scene: 0.1 },
      { scrollY: 1900, scene: 0.1 },
    ];
    assert.equal(driftForScroll(0, keyframes, 3000), 0);
    assert.equal(driftForScroll(200, keyframes, 3000), 0.5);
    assert.equal(driftForScroll(400, keyframes, 3000), 1);
    assert.ok(Math.abs(driftForScroll(750, keyframes, 3000) - 0.5) < 1e-9);
    assert.equal(driftForScroll(1100, keyframes, 3000), 0);
    assert.equal(driftForScroll(1500, keyframes, 3000), 0.5);
    assert.ok(Math.abs(driftForScroll(2450, keyframes, 3000) - 0.5) < 1e-9);
    assert.equal(driftForScroll(100, [], 3000), 0);
  });

  it("clamps keyframes to the scrollable range without ever decreasing", () => {
    const keyframes = keyframesForLayout(
      [
        { scene: 0, gapStart: 300, gapEnd: 500 },
        { scene: 0.5, gapStart: 900, gapEnd: 1200 },
        { scene: 1, gapStart: 1600, gapEnd: 1600 },
      ],
      1000,
      600,
    );
    const positions = keyframes.map(({ scrollY }) => scrollY);
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
    );
    assert.ok(positions.every((position) => position >= 0 && position <= 600));
    assert.equal(progressForScroll(600, keyframes), 1);
    assert.deepEqual(keyframesForLayout([], 1000, 600), []);
  });

  it("orders chapter scenes so scrolling down always moves the story forward", () => {
    const interludes = landingPageContent.chapters.map((chapter) =>
      "interludeAfter" in chapter ? chapter.interludeAfter : null,
    );
    // Every beat gets open space; the long cloud-to-floor sequence gets the most.
    assert.deepEqual(interludes, [50, 60, 70, 80, 130, 100, null]);
    const scenes = landingPageContent.chapters.map(({ scene }) => scene);
    assert.deepEqual(
      scenes,
      [...scenes].sort((a, b) => a - b),
    );
    assert.equal(scenes[0], 0);
    assert.equal(scenes.at(-1), 1);
  });
});

describe("Legacy landing hashes", () => {
  it("leaves current chapters, FAQ groups, and empty hashes alone", () => {
    for (const { id } of landingPageContent.chapters)
      assert.equal(resolveLegacyHash(`#${id}`), null);
    for (const id of ["faq-fit", "faq-daily", "faq-pricing", "faq-limits"]) {
      assert.equal(resolveLegacyHash(`#${id}`), null);
    }
    assert.equal(resolveLegacyHash(""), null);
    assert.equal(resolveLegacyHash("#"), null);
    assert.equal(resolveLegacyHash("#not-a-section"), null);
  });

  it("sends every retired chapter, topic, and alias to a section that exists", () => {
    const targets = new Set([
      ...landingPageContent.chapters.map(({ id }) => id),
      "faq-fit",
      "faq-daily",
      "faq-pricing",
      "faq-limits",
    ]);
    for (const retired of [
      "studio-view",
      "use-cases",
      "signals-gather",
      "explore",
      "class-ready",
      "about",
      "stillness",
      "faq-switching",
      "faq-data",
      "faq-roadmap",
    ]) {
      assert.ok(retired in LANDING_HASH_ALIASES, `${retired} has no alias`);
    }
    for (const [from, to] of Object.entries(LANDING_HASH_ALIASES)) {
      assert.ok(targets.has(to), `${from} points at missing ${to}`);
      assert.equal(resolveLegacyHash(`#${from}`), to);
    }
  });
});

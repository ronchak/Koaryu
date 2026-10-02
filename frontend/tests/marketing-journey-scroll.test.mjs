import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { landingPageContent } from "../src/lib/landing-page-content.ts";
import {
  LANDING_HASH_ALIASES,
  TRANSITION_END,
  TRANSITION_START,
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

  it("holds each chapter while it is read and moves only while the gap crosses the screen", () => {
    const keyframes = keyframesForLayout(
      [
        { scene: 0, gapCenter: 1300 },
        { scene: 0.1, gapCenter: 2900 },
        { scene: 0.3, gapCenter: Number.POSITIVE_INFINITY },
      ],
      1000,
      5000,
    );
    assert.equal(TRANSITION_START, 0.85);
    assert.equal(TRANSITION_END, 0.15);
    assert.deepEqual(keyframes, [
      { scrollY: 0, scene: 0 },
      { scrollY: 450, scene: 0 },
      { scrollY: 1150, scene: 0.1 },
      { scrollY: 2050, scene: 0.1 },
      { scrollY: 2750, scene: 0.3 },
    ]);
    // Reading the first two chapters moves nothing.
    assert.equal(progressForScroll(200, keyframes), 0);
    assert.equal(progressForScroll(1600, keyframes), 0.1);
    // Halfway through a gap, the story is halfway through its beat.
    assert.ok(Math.abs(progressForScroll(800, keyframes) - 0.05) < 1e-9);
    assert.equal(progressForScroll(4000, keyframes), 0.3);
  });

  it("clamps keyframes to the scrollable range without ever decreasing", () => {
    const keyframes = keyframesForLayout(
      [
        { scene: 0, gapCenter: 300 },
        { scene: 0.5, gapCenter: 900 },
        { scene: 1, gapCenter: Number.POSITIVE_INFINITY },
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
    const withInterludes = landingPageContent.chapters
      .filter((chapter) => "interludeAfter" in chapter && chapter.interludeAfter)
      .map(({ id }) => id);
    assert.deepEqual(withInterludes, ["welcome", "the-problem", "product", "features"]);
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

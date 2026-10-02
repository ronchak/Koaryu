import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { landingPageContent } from "../src/lib/landing-page-content.ts";
import {
  LANDING_HASH_ALIASES,
  anchorsForLayout,
  nearestAnchorScene,
  progressForScroll,
  resolveLegacyHash,
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

  it("snaps to the nearest chapter's still frame for reduced motion", () => {
    assert.equal(nearestAnchorScene(350, anchors), 0);
    assert.equal(nearestAnchorScene(450, anchors), 0.1);
    assert.equal(nearestAnchorScene(5000, anchors), 0.3);
  });

  it("centers chapters, clamps to the scrollable range, and keeps anchors increasing", () => {
    const result = anchorsForLayout(
      [
        { top: 0, height: 900, scene: 0 },
        { top: 900, height: 900, scene: 0.1 },
        { top: 1800, height: 1400, scene: 0.86 },
        { top: 3200, height: 600, scene: 1 },
      ],
      900,
      2900,
    );
    assert.deepEqual(result, [
      { scrollY: 0, scene: 0 },
      { scrollY: 900, scene: 0.1 },
      { scrollY: 2050, scene: 0.86 },
      { scrollY: 2900, scene: 1 },
    ]);
  });

  it("orders chapter scenes so scrolling down always moves the story forward", () => {
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

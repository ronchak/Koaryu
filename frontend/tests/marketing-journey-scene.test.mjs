import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { landingPageContent } from "../src/lib/landing-page-content.ts";
import {
  CLOUD_GEOMETRY,
  JOURNEY_SCENE_STOPS,
  PLANK_GEOMETRY,
  SCENE_HEIGHT,
  SCENE_OVERSCAN,
  SCENE_PHASES,
  SCENE_WIDTH,
  clamp,
  createCloudGeometry,
  createPlankGeometry,
  easeIn,
  easeInOut,
  easeOut,
  frameForDimensions,
  phaseProgress,
  sceneProgressModel,
} from "../src/components/marketing/journey/scene-model.ts";

const sceneSource = readFileSync(
  new URL(
    "../src/components/marketing/journey/journey-scene.tsx",
    import.meta.url
  ),
  "utf8"
);
const sceneCss = readFileSync(
  new URL(
    "../src/components/marketing/journey/journey-scene.module.css",
    import.meta.url
  ),
  "utf8"
);
const modelSource = readFileSync(
  new URL(
    "../src/components/marketing/journey/scene-model.ts",
    import.meta.url
  ),
  "utf8"
);

describe("Journey scene model", () => {
  it("clamps hostile progress and preserves the approved easing curves", () => {
    assert.equal(clamp(-1), 0);
    assert.equal(clamp(2), 1);
    assert.equal(clamp(Number.NaN), 0);
    assert.equal(clamp(Number.NEGATIVE_INFINITY), 0);
    assert.equal(clamp(Number.POSITIVE_INFINITY), 1);
    assert.equal(easeIn(0.5), 0.125);
    assert.equal(easeOut(0.5), 0.875);
    assert.equal(easeInOut(0.25), 0.125);
    assert.equal(easeInOut(0.5), 0.5);
    assert.equal(easeInOut(0.75), 0.875);

    const before = sceneProgressModel(-10);
    const after = sceneProgressModel(10);
    assert.equal(before.progress, 0);
    assert.equal(after.progress, 1);
    assert.equal(before.phase.mountains, 0);
    assert.equal(after.phase.students, 1);
  });

  it("keeps every exact scene window and boundary", () => {
    assert.deepEqual(SCENE_PHASES, {
      mountains: [0, 0.1],
      drop: [0.1, 0.212],
      settle: [0.212, 0.288],
      portal: [0.288, 0.52],
      door: [0.404, 0.52],
      through: [0.516, 0.64],
      sky: [0.6, 0.7],
      clouds: [0.66, 0.802],
      morph: [0.802, 0.892],
      floor: [0.892, 0.952],
      students: [0.952, 1],
    });

    for (const [phase, [start, end]] of Object.entries(SCENE_PHASES)) {
      assert.equal(phaseProgress(start - 0.001, phase), 0, `${phase} before`);
      assert.equal(phaseProgress(start, phase), 0, `${phase} start`);
      assert.ok(
        Math.abs(phaseProgress((start + end) / 2, phase) - 0.5) < 1e-12,
        `${phase} midpoint`
      );
      assert.equal(phaseProgress(end, phase), 1, `${phase} end`);
      assert.equal(phaseProgress(end + 0.001, phase), 1, `${phase} after`);
    }

    const dropMidpoint = sceneProgressModel((0.1 + 0.212) / 2);
    assert.equal(dropMidpoint.curtainOpen, 0.5);
    assert.equal(dropMidpoint.dojoArrival, 0.875);
    const doorwayMidpoint = sceneProgressModel((0.516 + 0.64) / 2);
    assert.ok(Math.abs(doorwayMidpoint.doorwayPush - 0.125) < 1e-12);
  });

  it("derives every exact chapter stop from canonical landing content", () => {
    const expected = {
      welcome: 0.025,
      "the-problem": 0.1,
      "studio-view": 0.235,
      product: 0.288,
      features: 0.52,
      "use-cases": 0.64,
      "signals-gather": 0.802,
      explore: 0.892,
      "class-ready": 0.952,
      pricing: 1,
      about: 1,
      faq: 1,
      stillness: 1,
      begin: 1,
    };
    assert.deepEqual(JOURNEY_SCENE_STOPS, expected);
    assert.deepEqual(
      JOURNEY_SCENE_STOPS,
      Object.fromEntries(
        landingPageContent.chapters.map(({ id, scene }) => [id, scene])
      )
    );
    assert.equal(
      Object.values(JOURNEY_SCENE_STOPS).filter((stop) => stop === 1).length,
      5
    );
  });

  it("generates stable bounded cloud and weave geometry once at module scope", () => {
    assert.deepEqual(createCloudGeometry(), createCloudGeometry());
    assert.notDeepEqual(createCloudGeometry(), createCloudGeometry(1208));
    assert.equal(CLOUD_GEOMETRY.length, 42);
    assert.equal(Object.isFrozen(CLOUD_GEOMETRY), true);
    assert.deepEqual(
      CLOUD_GEOMETRY.map(({ tier }) => tier),
      [...CLOUD_GEOMETRY.map(({ tier }) => tier)].sort((a, b) => a - b)
    );
    for (const cloud of CLOUD_GEOMETRY) {
      assert.ok(cloud.x >= -180 && cloud.x <= SCENE_WIDTH + 180);
      assert.ok(cloud.y >= -110 && cloud.y <= SCENE_HEIGHT + 130);
      assert.ok(cloud.scale >= 0.72 * 0.8 && cloud.scale <= 1.7 * 1.3);
      assert.ok(cloud.arrival >= 0 && cloud.arrival <= 0.6);
      assert.ok(cloud.tone >= 0 && cloud.tone <= 4);
      assert.match(cloud.path, /^M.*Z$/);
    }

    assert.deepEqual(createPlankGeometry(), createPlankGeometry());
    assert.notDeepEqual(createPlankGeometry(), createPlankGeometry(88042));
    assert.equal(PLANK_GEOMETRY.length, 16 * 16);
    assert.equal(Object.isFrozen(PLANK_GEOMETRY), true);
    for (const plank of PLANK_GEOMETRY) {
      assert.equal(plank.uv.length, 8);
      assert.equal(plank.flat.length, 8);
      assert.equal(plank.cloud.length, 8);
      assert.ok(plank.normalizedDepth >= 0 && plank.normalizedDepth <= 1);
      assert.ok(plank.tone >= 0 && plank.tone <= 4);
      for (const point of [...plank.uv, ...plank.flat, ...plank.cloud]) {
        assert.equal(Number.isFinite(point.x), true);
        assert.equal(Number.isFinite(point.y), true);
      }
    }
    assert.match(sceneSource, /import \{[\s\S]*CLOUD_GEOMETRY[\s\S]*PLANK_GEOMETRY[\s\S]*\} from "\.\/scene-model"/);
    assert.doesNotMatch(sceneSource, /createCloudGeometry\(|createPlankGeometry\(/);
  });

  it("uses a 1600 by 1000 frame that expands vertically and narrows students in portrait", () => {
    assert.equal(SCENE_WIDTH, 1600);
    assert.equal(SCENE_HEIGHT, 1000);
    assert.deepEqual(SCENE_OVERSCAN, {
      x: -520,
      y: -740,
      width: 2640,
      height: 2480,
    });

    assert.deepEqual(frameForDimensions(1600, 1000), {
      viewBox: "0 0 1600 1000",
      visibleHalfWidth: 800,
      studentSpread: 1,
      variant: "landscape",
    });
    const portrait = frameForDimensions(390, 844);
    assert.equal(portrait.viewBox, "0 -500 1600 2000");
    assert.equal(portrait.variant, "portrait");
    assert.ok(portrait.studentSpread >= 0.34 && portrait.studentSpread < 1);
    assert.equal(frameForDimensions(0, 0).viewBox, "0 0 1600 1000");
    assert.match(sceneSource, /preserveAspectRatio="xMidYMid slice"/);
  });
});

describe("Journey scene SVG contract", () => {
  it("is decorative, pointer-inert, locally styled, and instance-safe", () => {
    assert.match(sceneSource, /aria-hidden="true"/);
    assert.match(sceneSource, /focusable="false"/);
    assert.match(sceneSource, /makeIds\(useId\(\)\)/);
    assert.match(sceneSource, /reactId\.replace\(\/\[\^a-zA-Z0-9_-\]\//);
    assert.match(sceneCss, /\.scene\s*\{[\s\S]*position:\s*absolute;[\s\S]*pointer-events:\s*none;/);
    assert.doesNotMatch(
      `${modelSource}\n${sceneSource}`,
      /\b(?:window|document|navigator)\s*\.|\b(?:matchMedia|requestAnimationFrame)\s*\(/
    );
    assert.doesNotMatch(
      `${modelSource}\n${sceneSource}\n${sceneCss}`,
      /from\s+["']https?:|\bsrc=["']https?:|unpkg|<script|@font-face|url\(["']?https?:/i
    );
    assert.doesNotMatch(`${sceneSource}\n${sceneCss}`, /var\(--(?:bg|surface|border|text-|accent)/);
  });

  it("contains the exact static pulp, fine-grain, crumple, and washi recipes", () => {
    for (const contract of [
      'baseFrequency="0.018 0.035" numOctaves="2" seed="17"',
      'type="saturate" values="0"',
      'type="linear" slope="0.72"',
      'baseFrequency="0.68" numOctaves="2" seed="7"',
      'type="linear" slope="0.58"',
      'filterUnits="userSpaceOnUse" x="0" y="0" width="360" height="360"',
      'colorInterpolationFilters="sRGB"',
      'baseFrequency="0.0111" numOctaves="4" seed="9"',
      'surfaceScale="1.9" diffuseConstant="1.05"',
      'azimuth="235" elevation="58"',
      '0.2067 0.2067 0.2067 0 0.0273',
      'baseFrequency="0.026 0.44" numOctaves="2" seed="29"',
      'type="linear" slope="0.76"',
      'width="220" height="220" patternUnits="userSpaceOnUse"',
      'fill="#8B7B60"',
      'opacity="0.24"',
    ]) {
      assert.ok(sceneSource.includes(contract), `missing SVG contract: ${contract}`);
    }
    assert.match(sceneSource, /filter={`url\(#\$\{ids\.pulp\}\)`} opacity="0\.07"/);
    assert.match(sceneSource, /filter={`url\(#\$\{ids\.fine\}\)`} opacity="0\.05"/);
    assert.match(sceneSource, /CRUMPLE_OPACITY = 0\.45/);
  });

  it("keeps every connected transformation layer in one local scene", () => {
    for (const layer of [
      "mountains",
      "curtain",
      "dojo",
      "sky",
      "clouds",
      "weave-floor",
      "room",
      "students",
    ]) {
      assert.match(sceneSource, new RegExp(`data-scene-layer="${layer}"`));
    }
    for (const color of [
      "#EFE2C0",
      "#56431F",
      "#E6E2DA",
      "#C1AA76",
      "#F6E9CD",
      "#F4E7CC",
      "#E1C99E",
      "#E2CAA2",
      "#DED7CF",
      "#F3F0E9",
    ]) {
      assert.ok(sceneSource.includes(color), `missing scene palette color ${color}`);
    }
  });
});

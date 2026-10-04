import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { landingPageContent } from "../src/lib/landing-page-content.ts";
import {
  FILM_ANCHORS,
  FILM_KEYFRAMES,
  FILM_LENGTH,
  FILM_SEGMENTS,
  TITLE_CUES,
  cueSpan,
  cueState,
  filmPosition,
  handoffAt,
  sceneAt,
  segmentRange,
} from "../src/components/marketing/journey/film-model.ts";
import {
  LANDING_HASH_ALIASES,
  LANDING_TARGETS,
  resolveLegacyHash,
} from "../src/components/marketing/landing/legacy-hash.ts";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const controllerSource = source("../src/components/marketing/landing/landing-controller.tsx");
const titlesSource = source("../src/components/marketing/landing/film-titles.tsx");
const sectionsSource = source("../src/components/marketing/landing/page-sections.tsx");
const filmCss = source("../src/components/marketing/landing/film.module.css");
const pageCss = source("../src/components/marketing/landing/page.module.css");

describe("Film timeline", () => {
  it("plays the whole story in order, from the hills to the seated class", () => {
    assert.deepEqual(
      FILM_SEGMENTS.map((segment) => segment.name),
      [
        "hills",
        "dive",
        "curtain",
        "dojo",
        "dojo-hold",
        "door",
        "doorway-hold",
        "through",
        "sky",
        "clouds",
        "weave",
        "mat-hold",
        "room",
        "class",
        "class-hold",
        "handoff",
      ],
    );
    for (let index = 1; index < FILM_KEYFRAMES.length; index += 1) {
      assert.ok(FILM_KEYFRAMES[index].at > FILM_KEYFRAMES[index - 1].at);
      assert.ok(FILM_KEYFRAMES[index].scene >= FILM_KEYFRAMES[index - 1].scene);
    }
    assert.equal(sceneAt(0), 0);
    assert.equal(sceneAt(FILM_LENGTH), 1);
    assert.equal(sceneAt(-3), 0);
    assert.equal(sceneAt(FILM_LENGTH + 3), 1);
    // Every composed frame of the scene is held for a moment.
    for (const scene of [0, 0.1, 0.288, 0.52, 0.66, 0.892, 1]) {
      assert.ok(
        FILM_SEGMENTS.some((segment, index) => {
          const previous = index ? FILM_SEGMENTS[index - 1].scene : 0;
          return segment.scene === scene && previous === scene;
        }),
        `held frame ${scene}`,
      );
    }
  });

  it("is six to eight screens long and gives the second half of the story the most scroll", () => {
    assert.ok(FILM_LENGTH >= 5 && FILM_LENGTH <= 8, String(FILM_LENGTH));
    const [doorStart] = segmentRange("door");
    const [, classEnd] = segmentRange("class");
    const [diveStart] = segmentRange("dive");
    assert.ok(classEnd - doorStart > (doorStart - diveStart) * 2);
    // No hold drags: each is under half a screen.
    for (const segment of FILM_SEGMENTS) {
      const index = FILM_SEGMENTS.indexOf(segment);
      const held = index > 0 && FILM_SEGMENTS[index - 1].scene === segment.scene;
      if (held && segment.name !== "handoff") assert.ok(segment.length <= 0.5, segment.name);
    }
  });

  it("interpolates scene progress between keyframes", () => {
    const keyframes = [
      { at: 0, scene: 0 },
      { at: 1, scene: 0 },
      { at: 2, scene: 0.5 },
    ];
    assert.equal(sceneAt(0.5, keyframes), 0);
    assert.equal(sceneAt(1.5, keyframes), 0.25);
    assert.equal(sceneAt(9, keyframes), 0.5);
    assert.equal(sceneAt(1, []), 0);
  });

  it("maps scroll to film position in screen heights and clamps at both ends", () => {
    assert.equal(filmPosition(0, 0, 900), 0);
    assert.equal(filmPosition(450, 0, 900), 0.5);
    assert.equal(filmPosition(-100, 0, 900), 0);
    assert.equal(filmPosition(1e7, 0, 900), FILM_LENGTH);
    assert.equal(filmPosition(500, 0, 0), 0);
  });
});

describe("Film titles", () => {
  it("fades each title in and out within its own stretch of the film", () => {
    const cue = { enter: [1, 2], exit: [3, 4] };
    assert.deepEqual(cueState(cue, 0.5), { opacity: 0, shift: 1 });
    assert.deepEqual(cueState(cue, 1.5), { opacity: 0.5, shift: 0.5 });
    assert.deepEqual(cueState(cue, 2.5), { opacity: 1, shift: 0 });
    assert.deepEqual(cueState(cue, 3.5), { opacity: 0.5, shift: -0.5 });
    assert.deepEqual(cueState(cue, 5), { opacity: 0, shift: -1 });
    assert.deepEqual(cueSpan(cue), [1, 4]);
    assert.deepEqual(cueSpan({ enter: null, exit: null }), [0, FILM_LENGTH]);
  });

  it("shows the curtain title on the closed curtain and the path title in the open sky", () => {
    const at = (id) => FILM_ANCHORS[id];
    assert.equal(sceneAt(at("the-problem")), 0.1);
    assert.equal(cueState(TITLE_CUES["the-problem"], at("the-problem")).opacity, 1);
    assert.ok(Math.abs(sceneAt(at("the-path")) - 0.66) < 0.02);
    assert.equal(cueState(TITLE_CUES["the-path"], at("the-path")).opacity, 1);
    // The hero has gone before the curtain title arrives; titles never overlap.
    const ids = ["welcome", "the-problem", "the-path", "studio"];
    for (let index = 1; index < ids.length; index += 1) {
      assert.ok(cueSpan(TITLE_CUES[ids[index - 1]])[1] <= cueSpan(TITLE_CUES[ids[index]])[0]);
    }
    // Nothing covers the weave: no title between the sky and the class.
    const [weaveStart, weaveEnd] = segmentRange("weave");
    for (const id of ids) {
      const [from, to] = cueSpan(TITLE_CUES[id]);
      assert.ok(to <= weaveStart || from >= weaveEnd, id);
    }
  });

  it("settles the closing frame into a framed picture over the last stretch", () => {
    const [start, end] = segmentRange("handoff");
    assert.equal(handoffAt(start - 0.1), 0);
    assert.equal(handoffAt(start), 0);
    assert.ok(Math.abs(handoffAt((start + end) / 2) - 0.5) < 1e-9);
    assert.equal(handoffAt(end), 1);
    assert.equal(end, FILM_LENGTH);
    assert.equal(FILM_ANCHORS.studio, FILM_LENGTH);
    assert.equal(cueState(TITLE_CUES.studio, end).opacity, 1);
    assert.equal(cueState(TITLE_CUES["studio-detail"], end).opacity, 1);
    assert.equal(cueState(TITLE_CUES["studio-detail"], start).opacity, 0);
  });
});

describe("Landing links", () => {
  it("knows every section and keeps retired hashes landing somewhere sensible", () => {
    for (const id of ["welcome", "the-problem", "the-path", "studio", "product", "features"]) {
      assert.ok(LANDING_TARGETS.has(id), id);
    }
    for (const id of ["pricing", "faq", "begin", "faq-fit", "faq-limits"]) {
      assert.ok(LANDING_TARGETS.has(id), id);
    }
    for (const target of Object.values(LANDING_HASH_ALIASES)) {
      assert.ok(LANDING_TARGETS.has(target), target);
    }
    assert.equal(resolveLegacyHash("#studio-view"), "product");
    assert.equal(resolveLegacyHash("#explore"), "features");
    assert.equal(resolveLegacyHash("#about"), "faq");
    assert.equal(resolveLegacyHash("#faq-roadmap"), "faq-limits");
    assert.equal(resolveLegacyHash("#pricing"), null);
    assert.equal(resolveLegacyHash("#nothing-here"), null);
    assert.equal(resolveLegacyHash(""), null);
  });
});

describe("Landing composition", () => {
  it("scrolls natively, observing scroll passively and never intercepting input", () => {
    assert.match(controllerSource, /addEventListener\("scroll", schedule, \{ passive: true \}\)/);
    assert.doesNotMatch(controllerSource, /preventDefault\(|addEventListener\("(?:wheel|touch)/);
    assert.doesNotMatch(controllerSource, /useState\([^)]*progress/i);
    assert.match(controllerSource, /requestAnimationFrame\(tick\)/);
    assert.match(controllerSource, /sceneRef\.current\?\.setProgress/);
  });

  it("pins the film with sticky positioning and keeps the art decorative", () => {
    assert.match(filmCss, /\.stage\s*\{[^}]*position:\s*sticky;[^}]*pointer-events:\s*none;/);
    assert.match(filmCss, /\.film\[data-mode="live"\]\s*\{[^}]*--film-length/);
    assert.match(controllerSource, /className=\{styles\.stage\} aria-hidden="true"/);
    assert.match(controllerSource, /<main id="main-content"/);
  });

  it("falls back to composed stills without the film, and for reduced motion", () => {
    assert.match(controllerSource, /data-mode="still"/);
    assert.match(controllerSource, /matchMedia\(MOTION_QUERY\)/);
    assert.match(controllerSource, /"\(prefers-reduced-motion: reduce\)"/);
    for (const still of ["doorway", "sky", "mat", "class"]) {
      for (const shape of ["wide", "tall"]) {
        const file = new URL(`../public/marketing/scenes/${still}-${shape}.webp`, import.meta.url);
        assert.ok(existsSync(file), `${still}-${shape}`);
      }
    }
    assert.match(titlesSource, /className=\{styles\.still\} aria-hidden="true"/);
    assert.match(filmCss, /\.film\[data-mode="live"\] \.still/);
  });

  it("has one h1, labelled sample art, and a skip link", () => {
    assert.equal(titlesSource.match(/<h1/g)?.length, 1);
    assert.doesNotMatch(sectionsSource, /<h1/);
    assert.match(titlesSource, /handoff\.caption/);
    assert.match(sectionsSource, /product\.caption/);
    assert.match(controllerSource, /href="#main-content"/);
    assert.equal(landingPageContent.handoff.caption, "Illustration with sample students.");
  });

  it("gates scroll-driven motion on support and motion preference, with visible focus", () => {
    assert.match(
      pageCss,
      /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*@supports \(animation-timeline: view\(\)\)/,
    );
    assert.match(filmCss, /@supports \(animation-timeline: scroll\(\)\)/);
    assert.match(pageCss, /outline:\s*2px solid currentColor/);
    assert.match(pageCss, /\.footer a\s*\{[^}]*min-height:\s*44px/);
    assert.match(pageCss, /\.faqItem summary\s*\{[^}]*min-height:\s*56px/);
    assert.match(filmCss, /\.masthead:focus-within\s*\{[^}]*transform:\s*none/);
  });

  it("uses only scoped marketing materials and no external runtime", () => {
    const complete = `${controllerSource}\n${titlesSource}\n${sectionsSource}\n${filmCss}\n${pageCss}`;
    assert.doesNotMatch(
      complete,
      /var\(--(?:bg|surface|border|text-[\w-]+|accent)\)|\b(?:bg-bg|bg-surface|text-text-primary|border-border|text-accent)\b/,
    );
    assert.doesNotMatch(
      complete,
      /from\s+["']https?:|\bsrc=["']https?:|unpkg|<script|@font-face|url\(["']?https?:/i,
    );
  });
});

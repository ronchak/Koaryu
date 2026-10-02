import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { landingPageContent } from "../src/lib/landing-page-content.ts";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const chapterSource = source("../src/components/marketing/journey/journey-chapters.tsx");
const controllerSource = source("../src/components/marketing/journey/journey-controller.tsx");
const journeyCss = source("../src/components/marketing/journey/journey.module.css");

describe("Journey server composition", () => {
  it("maps the seven chapters once into semantic initial HTML", () => {
    assert.deepEqual(
      landingPageContent.chapters.map(({ id }) => id),
      ["welcome", "the-problem", "product", "features", "pricing", "faq", "begin"],
    );
    assert.match(chapterSource, /landingPageContent\.chapters\.map/);
    assert.match(chapterSource, /<section[\s\S]*id=\{chapter\.id\}/);
    assert.match(chapterSource, /data-scene=\{chapter\.scene\}/);
    assert.match(chapterSource, /<main id="main-content"/);
    for (const element of ["<h1", "<h2", "<h3", "<ul", "<dl", "<nav", "<details", "<summary"]) {
      assert.ok(chapterSource.includes(element), element);
    }
    assert.doesNotMatch(chapterSource, /const\s+(?:FEATURE|FAQ|PRICE|ABOUT)_/);
  });

  it("leaves open interludes for the story's turning points", () => {
    assert.match(chapterSource, /data-journey-interlude=""\s+aria-hidden="true"/);
    assert.match(chapterSource, /"--interlude": chapter\.interludeAfter/);
    assert.match(
      journeyCss,
      /\.interlude\s*\{[^}]*height:\s*calc\(var\(--interlude, 60\) \* 1svh\)/,
    );
  });

  it("shows the real product with its sample-data caption", () => {
    const product = landingPageContent.chapters.find((chapter) => chapter.kind === "product");
    assert.ok(product);
    assert.match(product.image.src, /^\/marketing\/product\/.+\.webp$/);
    assert.match(product.image.caption, /sample studio data/);
    assert.match(product.image.mobile.src, /^\/marketing\/product\/.+-mobile\.webp$/);
    assert.match(chapterSource, /<source[\s\S]*media="\(min-width: 821px\)"/);
    assert.match(chapterSource, /alt: image\.alt/);
  });
});

describe("Journey scrolling and accessibility", () => {
  it("scrolls natively without intercepting wheel, touch, or keyboard input", () => {
    // Input listeners may only observe: every one is passive and nothing prevents defaults.
    const inputListeners = [
      ...controllerSource.matchAll(
        /addEventListener\("(?:wheel|touchstart|touchmove|touchend|keydown)",[^)]*\)/g,
      ),
    ].map(([listener]) => listener);
    assert.ok(inputListeners.length > 0);
    for (const listener of inputListeners) assert.match(listener, /\{ passive: true \}/);
    assert.doesNotMatch(controllerSource, /preventDefault\(/);
    assert.match(controllerSource, /addEventListener\("scroll", schedule, \{ passive: true \}\)/);
    assert.doesNotMatch(journeyCss, /overflow:\s*hidden;[\s\S]{0,40}height:\s*100dvh/);
  });

  it("keeps chapters in ordinary flow with a fixed, decorative scene behind them", () => {
    const chapter = journeyCss.match(/\n\.chapter\s*\{(?<body>[\s\S]*?)\n\}/);
    assert.ok(chapter?.groups?.body);
    assert.match(chapter.groups.body, /position:\s*relative/);
    assert.doesNotMatch(chapter.groups.body, /opacity:\s*0|visibility:\s*hidden|pointer-events/);
    assert.match(
      journeyCss,
      /\.sceneLayer\s*\{[\s\S]*position:\s*fixed;[\s\S]*pointer-events:\s*none;/,
    );
    assert.match(controllerSource, /className=\{styles\.sceneLayer\} aria-hidden="true"/);
  });

  it("settles gently onto chapters without trapping long ones", () => {
    assert.match(journeyCss, /scroll-snap-type:\s*y proximity/);
    assert.doesNotMatch(journeyCss, /scroll-snap-type:\s*y mandatory/);
    assert.match(journeyCss, /\n\.chapter\s*\{[^}]*scroll-snap-align:\s*start;/);
  });

  it("gives dark chapters their own ground before the scene is enhanced", () => {
    assert.match(
      journeyCss,
      /\.journey:not\(\[data-enhanced="true"\]\) \.chapter\[data-ink="light"\]\s*\{[^}]*background/,
    );
  });

  it("reveals cards on the compositor only where supported and motion is welcome", () => {
    assert.match(
      journeyCss,
      /@supports \(animation-timeline: view\(\)\)\s*\{\s*@media \(prefers-reduced-motion: no-preference\)/,
    );
  });

  it("keeps the phone masthead reachable", () => {
    assert.match(journeyCss, /\.journey\[data-masthead-hidden="true"\] \.masthead/);
    assert.match(journeyCss, /\.masthead:focus-within\s*\{[^}]*transform:\s*none/);
    assert.match(controllerSource, /details\[open\]/);
  });

  it("offers a skip link, visible focus, and reduced-motion still frames", () => {
    assert.match(controllerSource, /href="#main-content"/);
    assert.match(journeyCss, /outline:\s*2px solid currentColor/);
    assert.match(journeyCss, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(controllerSource, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
    assert.match(controllerSource, /stillFrame\(/);
    assert.match(journeyCss, /\.footer a\s*\{[^}]*min-height:\s*44px/);
    assert.match(journeyCss, /\.faqItem summary\s*\{[^}]*min-height:\s*52px/);
  });

  it("uses only scoped marketing materials and no external runtime", () => {
    const completeSource = `${chapterSource}\n${controllerSource}\n${journeyCss}`;
    assert.doesNotMatch(
      completeSource,
      /var\(--(?:bg|surface|border|text-[\w-]+|accent)|\b(?:bg-bg|bg-surface|text-text-primary|text-text-secondary|border-border|text-accent)\b/,
    );
    assert.doesNotMatch(
      completeSource,
      /from\s+["']https?:|\bsrc=["']https?:|unpkg|<script|@font-face|url\(["']?https?:/i,
    );
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { landingPageContent } from "../src/lib/landing-page-content.ts";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const chapterSource = source("../src/components/marketing/journey/journey-chapters.tsx");
const controllerSource = source("../src/components/marketing/journey/journey-controller.tsx");
const loomSource = source("../src/components/marketing/journey/weave-loom.tsx");
const journeyCss = source("../src/components/marketing/journey/journey.module.css");
const pageSource = source("../src/components/marketing/landing/page-sections.tsx");
const pageCss = source("../src/components/marketing/landing/page.module.css");
const landingSource = source("../src/components/marketing/landing-page.tsx");

describe("Landing composition", () => {
  it("renders every story chapter once as a semantic, server-rendered stop", () => {
    assert.match(chapterSource, /story\.map\(\(chapter, index\)/);
    assert.match(chapterSource, /data-stop=\{chapter\.id\}/);
    assert.match(chapterSource, /data-scene=\{chapter\.scene\}/);
    assert.match(chapterSource, /data-panel=""/);
    assert.match(chapterSource, /data-stop="handoff"/);
    assert.match(landingSource, /<main id="main-content"/);
    for (const element of ["<h1", "<h2", "<h3", "<ol", "<dl", "<nav", "<figure"]) {
      assert.ok(chapterSource.includes(element), element);
    }
    for (const element of ["<details", "<summary", "<footer", "<dl"]) {
      assert.ok(pageSource.includes(element), element);
    }
    // One h1 on the page: the hero.
    assert.equal(`${chapterSource}${pageSource}`.match(/<h1/g)?.length, 1);
  });

  it("gives each chapter one screen, with open scroll between for the beats", () => {
    assert.match(journeyCss, /\.chapter\s*\{[^}]*height:\s*100svh/);
    assert.match(
      journeyCss,
      /\.interlude\s*\{[^}]*height:\s*calc\(var\(--interlude, 70\) \* 1svh\)/,
    );
    assert.match(chapterSource, /className=\{styles\.interlude\}\s+aria-hidden="true"/);
  });

  it("lets a chapter taller than the screen scroll inside itself", () => {
    assert.match(
      journeyCss,
      /\.panel\s*\{[^}]*overflow:\s*hidden auto;[^}]*overscroll-behavior:\s*contain/,
    );
    assert.match(journeyCss, /view-timeline:\s*--day block/);
    assert.match(journeyCss, /animation-timeline:\s*--day/);
    const features = landingPageContent.story.find((chapter) => chapter.kind === "features");
    assert.equal(features.moments.length, 7);
    // The day starts by bringing the roster over, and every moment has a time of day.
    assert.equal(features.moments[0].time, "7:00 AM");
    assert.equal(features.moments[0].title, "Bring your roster over");
    assert.equal(features.moments.at(-1).time, "8:00 PM");
    assert.ok(features.moments.every(({ time }) => /^\d{1,2}:\d{2} [AP]M$/.test(time)));
  });

  it("shows the real product on desktop and phone with its sample-data caption", () => {
    const product = landingPageContent.story.find((chapter) => chapter.kind === "product");
    assert.match(product.image.src, /^\/marketing\/product\/.+\.webp$/);
    assert.match(product.image.caption, /sample studio data/);
    assert.match(product.image.mobile.alt, /phone layout/);
    assert.match(chapterSource, /alt=\{image\.alt\}/);
    assert.match(chapterSource, /alt=\{image\.mobile\.alt\}/);
  });

  it("weaves the threads as a decorative layer driven by scene progress", () => {
    assert.match(controllerSource, /<WeaveLoom/);
    assert.match(loomSource, /aria-hidden="true"/);
    assert.match(loomSource, /setProgress\(progress: number\)/);
    // Attribute writes only; no React state per frame.
    assert.doesNotMatch(loomSource, /useState/);
    assert.match(
      journeyCss,
      /:global\(html\[data-scene="night"\]\) \.journey\s*\{[^}]*--loom-warp-0/,
    );
  });

  it("hands the class off into a framed picture before the page begins", () => {
    assert.match(chapterSource, /data-picture-slot=""/);
    assert.match(chapterSource, /data-pinned=""/);
    assert.match(controllerSource, /handoffGeometry\(/);
    assert.match(controllerSource, /layer\.style\.clipPath/);
    assert.match(journeyCss, /\.pictureRing\s*\{/);
    // Without scripts the class is an ordinary framed still.
    assert.match(journeyCss, /\.journey:not\(\[data-enhanced="true"\]\) \.pictureStill/);
  });
});

describe("Landing paging and accessibility", () => {
  it("pages the story through the document scroll, never a fixed viewport", () => {
    assert.match(controllerSource, /addEventListener\("wheel", onWheel, \{ passive: false \}\)/);
    assert.match(
      controllerSource,
      /addEventListener\("touchmove", onTouchMove, \{ passive: false \}\)/,
    );
    assert.match(controllerSource, /addEventListener\("scroll", onScroll, \{ passive: true \}\)/);
    assert.match(
      controllerSource,
      /window\.scrollTo\(\{ top: y, left: 0, behavior: "instant" \}\)/,
    );
    assert.match(controllerSource, /reduceWheelGesture\(/);
    assert.match(controllerSource, /decideTouchChapter\(/);
    assert.match(controllerSource, /decideJourneyKey\(/);
    assert.doesNotMatch(journeyCss, /overflow:\s*hidden;[\s\S]{0,40}height:\s*100dvh/);
  });

  it("scrolls the page natively after the hand-off", () => {
    // Below the hand-off the wheel is only clamped at the frame's edge.
    assert.match(controllerSource, /inPage\(y\)/);
    assert.match(controllerSource, /holdWheelGesture\(/);
    assert.doesNotMatch(pageCss, /scroll-snap/);
  });

  it("keeps the story a real document: hash links, history and old links work", () => {
    assert.match(controllerSource, /addEventListener\("hashchange", onHashChange\)/);
    assert.match(controllerSource, /window\.history\.pushState/);
    assert.match(controllerSource, /resolveLegacyHash\(/);
  });

  it("keeps a fixed, decorative scene behind the chapters", () => {
    assert.match(
      journeyCss,
      /\.sceneLayer\s*\{[\s\S]*position:\s*fixed;[\s\S]*pointer-events:\s*none;/,
    );
    assert.match(controllerSource, /className=\{styles\.sceneLayer\} aria-hidden="true"/);
    assert.match(
      journeyCss,
      /\.journey:not\(\[data-enhanced="true"\]\) \.chapter\[data-ink="light"\]\s*\{[^}]*background/,
    );
  });

  it("names chapters in a rail and announces each arrival", () => {
    assert.match(controllerSource, /aria-label="Story chapters"/);
    assert.match(controllerSource, /aria-current=\{index === active \? "step" : undefined\}/);
    assert.match(controllerSource, /aria-live="polite"/);
  });

  it("reveals on the compositor only where supported and motion is welcome", () => {
    for (const css of [journeyCss, pageCss]) {
      assert.match(
        css,
        /@supports \(animation-timeline: view\(\)\)\s*\{\s*@media \(prefers-reduced-motion: no-preference\)/,
      );
      assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    }
    assert.match(controllerSource, /"\(prefers-reduced-motion: reduce\)"/);
    assert.match(controllerSource, /stillFrame\(/);
  });

  it("offers a skip link, visible focus and comfortable targets", () => {
    assert.match(controllerSource, /href="#main-content"/);
    assert.match(journeyCss, /outline:\s*2px solid currentColor/);
    assert.match(pageCss, /\.footer a\s*\{[^}]*min-height:\s*44px/);
    assert.match(pageCss, /\.faqItem summary\s*\{[^}]*min-height:\s*56px/);
  });

  it("styles every surface for the night scene through the shared tokens", () => {
    assert.match(journeyCss, /var\(--scene-masthead-light\)/);
    assert.match(journeyCss, /var\(--scene-masthead-dark\)/);
    assert.match(journeyCss, /var\(--scene-belt-black\)/);
    assert.match(pageCss, /:global\(html\[data-scene="night"\]\) \.page\s*\{/);
    assert.match(pageCss, /:global\(html\[data-scene="night"\]\) \.close\s*\{/);
  });

  it("uses only scoped marketing materials and no external runtime", () => {
    const completeSource = `${chapterSource}\n${controllerSource}\n${journeyCss}\n${pageSource}\n${pageCss}`;
    assert.doesNotMatch(
      completeSource,
      /var\(--(?:bg|surface|border|text-[\w-]+|accent)\)|\b(?:bg-bg|bg-surface|text-text-primary|text-text-secondary|border-border|text-accent)\b/,
    );
    assert.doesNotMatch(
      completeSource,
      /from\s+["']https?:|\bsrc=["']https?:|unpkg|<script|@font-face|url\(["']?https?:/i,
    );
  });
});

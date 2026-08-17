import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { landingPageContent } from "../src/lib/landing-page-content.ts";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const landingSource = source("../src/components/marketing/landing-page.tsx");
const chapterSource = source(
  "../src/components/marketing/journey/journey-chapters.tsx"
);
const controllerSource = source(
  "../src/components/marketing/journey/journey-controller.tsx"
);
const journeyCss = source(
  "../src/components/marketing/journey/journey.module.css"
);
const appPageSource = source("../src/app/page.tsx");

describe("Journey server composition", () => {
  it("keeps the route and landing composition server-owned with warmup intact", () => {
    assert.doesNotMatch(appPageSource, /["']use client["']/);
    assert.doesNotMatch(landingSource, /["']use client["']/);
    assert.match(appPageSource, /export const metadata: Metadata/);
    assert.match(appPageSource, /canonical: "https:\/\/koaryu\.app\/"/);
    assert.match(appPageSource, /export default LandingPage/);
    assert.match(landingSource, /<BackendWarmup\s*\/>/);
    assert.match(landingSource, /<MarketingRoot layout="document">/);
    assert.match(landingSource, /<JourneyController>/);
    assert.match(landingSource, /<JourneyChapters\s*\/>/);
  });

  it("maps the canonical 14 chapters once into semantic initial HTML", () => {
    assert.equal(landingPageContent.chapters.length, 14);
    assert.deepEqual(
      landingPageContent.chapters.map(({ id }) => id),
      [
        "welcome",
        "the-problem",
        "studio-view",
        "product",
        "features",
        "use-cases",
        "signals-gather",
        "explore",
        "class-ready",
        "pricing",
        "about",
        "faq",
        "stillness",
        "begin",
      ]
    );
    assert.match(chapterSource, /landingPageContent\.chapters\.map/);
    assert.match(chapterSource, /<section[\s\S]*id=\{chapter\.id\}/);
    assert.match(chapterSource, /data-journey-chapter=""/);
    assert.match(chapterSource, /<h1/);
    assert.match(chapterSource, /<h2/);
    assert.match(chapterSource, /<ul/);
    assert.match(chapterSource, /<dl/);
    assert.match(chapterSource, /<nav/);
    assert.doesNotMatch(chapterSource, /const\s+(?:FEATURE|FAQ|PRICE|ABOUT)_/);
  });

  it("renders every canonical content family and all FAQ answers by reference", () => {
    for (const reference of [
      "chapter.headline.map",
      "chapter.question",
      "chapter.aside",
      "chapter.proofLabel",
      "chapter.proof",
      "chapter.rows.map",
      "chapter.routes.map",
      "chapter.displayPrice",
      "chapter.period",
      "chapter.facts.map",
      "chapter.principles.map",
      "chapter.groups.map",
      "group.items.map",
      "item.answer",
      "chapter.footerLinks.map",
      "chapter.copyright",
    ]) {
      assert.ok(chapterSource.includes(reference), `missing ${reference}`);
    }
    assert.match(chapterSource, /import Link from "next\/link"/);
    assert.match(chapterSource, /href === "\/signup" \|\| href === "\/login"/);
    assert.match(chapterSource, /prefetch=\{actionPrefetch\(href\)\}/);
  });
});

describe("Journey progressive enhancement and accessibility", () => {
  it("keeps initial chapters in ordinary flow and gates all cinematic staging", () => {
    const defaultChapter = journeyCss.match(/\.chapter\s*\{(?<body>[\s\S]*?)\n\}/);
    assert.ok(defaultChapter?.groups?.body);
    assert.match(defaultChapter.groups.body, /position:\s*relative/);
    assert.doesNotMatch(
      defaultChapter.groups.body,
      /position:\s*(?:fixed|absolute)|opacity:\s*0|visibility:\s*hidden|pointer-events:\s*none/
    );

    const enhancedRoot = journeyCss.match(
      /\.journey\[data-enhanced="true"\]\s*\{(?<body>[\s\S]*?)\n\}/
    );
    assert.ok(enhancedRoot?.groups?.body);
    assert.match(enhancedRoot.groups.body, /height:\s*100dvh/);
    assert.match(enhancedRoot.groups.body, /overflow:\s*hidden/);
    assert.match(
      journeyCss,
      /\.journey\[data-enhanced="true"\] \.chapter\s*\{[\s\S]*position:\s*absolute;[\s\S]*visibility:\s*hidden;/
    );
    assert.match(
      journeyCss,
      /\.journey\[data-enhanced="true"\] \.chapter\[aria-hidden="false"\]/
    );
    assert.doesNotMatch(chapterSource, /\binert(?:=|\s)/);
  });

  it("activates inert, live, focus, hit-area, FAQ, and reduced-motion contracts", () => {
    assert.match(controllerSource, /chapter\.inert = !active/);
    assert.match(controllerSource, /chapter\.setAttribute\("aria-hidden"/);
    assert.match(controllerSource, /aria-live="polite"/);
    assert.match(controllerSource, /aria-current=\{index === pageIndex \? "step"/);
    assert.match(chapterSource, /aria-expanded="true"/);
    assert.match(chapterSource, /aria-controls=\{answerId\}/);
    assert.match(journeyCss, /\.pager button\s*\{[\s\S]*width:\s*44px;[\s\S]*height:\s*44px;/);
    assert.match(journeyCss, /\.rail button\s*\{[\s\S]*width:\s*44px;[\s\S]*height:\s*24px;/);
    assert.match(journeyCss, /outline:\s*2px solid currentColor/);
    assert.match(journeyCss, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(journeyCss, /animation-delay:\s*0ms !important/);
    assert.match(journeyCss, /transition-delay:\s*0ms !important/);
    assert.match(controllerSource, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
    assert.match(controllerSource, /reducedMotionRef\.current/);
    assert.match(controllerSource, /topic\.tabIndex = active \? 0 : -1/);
    assert.match(controllerSource, /nextFaqTopicIndex\(/);
    assert.match(controllerSource, /\.querySelector<HTMLElement>\(`\[data-faq-topic=/);
    assert.match(
      journeyCss,
      /\.faqIndex a\s*\{[^}]*min-width:\s*24px;[^}]*min-height:\s*44px;/s
    );
    assert.match(
      journeyCss,
      /@media \(max-width: 560px\)[\s\S]*\.journey\[data-enhanced="true"\] \.chapter\s*\{[\s\S]*padding-inline:\s*20px 48px;/
    );
    assert.match(
      journeyCss,
      /\.rail button\s*\{[\s\S]*width:\s*44px;[\s\S]*height:\s*24px;/
    );
  });

  it("keeps controller browser access guarded and history replacement canonical", () => {
    assert.match(controllerSource, /^"use client";/);
    assert.match(controllerSource, /if \(typeof window === "undefined"/);
    assert.match(controllerSource, /typeof Element === "undefined"/);
    assert.match(controllerSource, /typeof Node === "undefined"/);
    assert.match(controllerSource, /activeElement === document\.body/);
    assert.match(controllerSource, /shouldHandleJourneyKeyboardFocus/);
    assert.match(controllerSource, /window\.history\.replaceState/);
    assert.doesNotMatch(controllerSource, /pushState/);
    assert.match(controllerSource, /event\.metaKey/);
    assert.match(controllerSource, /event\.ctrlKey/);
    assert.match(controllerSource, /event\.shiftKey/);
    assert.match(controllerSource, /event\.altKey/);
    assert.match(
      controllerSource,
      /rangeProgress\(sceneProgress, 0\.48, 0\.52\)/,
      "continuous chrome must reach dark ink at the feature stop"
    );
  });

  it("compacts the mobile feature ledger without hiding its descriptions", () => {
    for (const contract of [
      /\.ledgerPlane\s*\{[\s\S]*padding:\s*18px 20px;/,
      /\.ledgerPlane \.planeHeading\s*\{[\s\S]*font-size:\s*clamp\(30px, 9vw, 40px\)/,
      /\.ledgerPlane \.supportingLede\s*\{[\s\S]*margin-top:\s*11px;[\s\S]*font-size:\s*13px/,
      /\.ledgerPlane \.ledgerList\s*\{[\s\S]*margin-top:\s*13px/,
      /\.ledgerPlane \.ledgerRow\s*\{[\s\S]*gap:\s*4px;[\s\S]*padding-block:\s*9px/,
      /\.ledgerPlane \.ledgerRow p\s*\{[\s\S]*font-size:\s*12px;[\s\S]*line-height:\s*1\.42/,
      /\.ledgerPlane \.planeLink\s*\{[\s\S]*margin-top:\s*6px/,
    ]) {
      assert.match(journeyCss, contract);
    }
    assert.match(
      journeyCss,
      /@media \(max-width: 820px\) and \(max-height: 700px\)[\s\S]*\.ledgerRow p[\s\S]*display:\s*none/,
      "description hiding must remain confined to the canonical short-height tier"
    );
    assert.match(
      journeyCss,
      /@media \(max-width: 820px\) and \(max-height: 700px\)[\s\S]*chapter\[data-chapter-id="features"\][\s\S]*padding-top:\s*max\(72px, env\(safe-area-inset-top\)\)[\s\S]*\.ledgerPlane \.ledgerRow\s*\{[\s\S]*padding-block:\s*0/,
      "short mobile must compact the feature plane without shrinking its 44px title links"
    );
    assert.match(
      journeyCss,
      /@media \(max-width: 820px\) and \(max-height: 700px\)[\s\S]*\.faqShell\s*\{[\s\S]*height:\s*calc\(100dvh - 148px\)[\s\S]*\.faqPanel\s*\{[\s\S]*flex:\s*1 1 auto;[\s\S]*min-height:\s*0;/,
      "short mobile must reserve a bounded scroll region above the pager"
    );
  });

  it("uses only scoped marketing materials and no external runtime", () => {
    const completeSource = `${landingSource}\n${chapterSource}\n${controllerSource}\n${journeyCss}`;
    assert.doesNotMatch(
      completeSource,
      /var\(--(?:bg|surface|border|text-[\w-]+|accent)|\b(?:bg-bg|bg-surface|text-text-primary|text-text-secondary|border-border|text-accent)\b/
    );
    assert.doesNotMatch(
      completeSource,
      /from\s+["']https?:|\bsrc=["']https?:|unpkg|<script|@font-face|url\(["']?https?:/i
    );
    assert.match(
      journeyCss,
      /chapter\[data-chapter-id="stillness"\]::before/
    );
    assert.equal(
      journeyCss.match(/radial-gradient\(/g)?.length,
      1,
      "closing stillness is the only full-frame wash"
    );
  });
});

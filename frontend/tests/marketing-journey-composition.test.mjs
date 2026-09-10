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
describe("Journey server composition", () => {
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

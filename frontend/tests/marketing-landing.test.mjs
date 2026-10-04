import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

import { landingPageContent } from "../src/lib/landing-page-content.ts";
import {
  LANDING_HASH_ALIASES,
  LANDING_TARGETS,
  resolveLegacyHash,
} from "../src/components/marketing/landing/legacy-hash.ts";
import {
  STUDIO_FINISHED,
  STUDIO_MARKS,
  STUDIO_READY,
  studioStep,
} from "../src/components/marketing/landing/studio-model.ts";

const landingDir = new URL("../src/components/marketing/landing/", import.meta.url);
const css = readFileSync(new URL("landing.module.css", landingDir), "utf8");
const sources = Object.fromEntries(
  readdirSync(landingDir)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => [name, readFileSync(new URL(name, landingDir), "utf8")]),
);
const allSource = Object.values(sources).join("\n");

describe("Landing class demo", () => {
  it("marks each student in turn after the doors open, then shows the result", () => {
    assert.equal(STUDIO_MARKS.length, landingPageContent.studio.students.length);
    assert.deepEqual(
      [...STUDIO_MARKS],
      [...STUDIO_MARKS].sort((a, b) => a - b),
    );
    assert.ok(STUDIO_MARKS[0] > 0.25, "the shoji doors finish opening before the first mark");
    assert.ok(STUDIO_READY > STUDIO_MARKS.at(-1));
    assert.equal(studioStep(0), 0);
    assert.equal(studioStep(STUDIO_MARKS[0]), 1);
    assert.equal(studioStep(STUDIO_MARKS.at(-1)), STUDIO_MARKS.length);
    assert.equal(studioStep(1), STUDIO_FINISHED);
    let previous = 0;
    for (let step = 0; step <= 100; step += 1) {
      const value = studioStep(step / 100);
      assert.ok(value >= previous, "steps never go backwards while scrolling down");
      previous = value;
    }
  });

  it("renders the finished class for server HTML and visitors without script", () => {
    assert.match(sources["studio.tsx"], /useState\(STUDIO_FINISHED\)/);
  });
});

describe("Landing links", () => {
  it("leaves current sections and FAQ topics alone", () => {
    for (const target of LANDING_TARGETS) assert.equal(resolveLegacyHash(`#${target}`), null);
    assert.equal(resolveLegacyHash(""), null);
    assert.equal(resolveLegacyHash("#not-a-section"), null);
  });

  it("sends every retired chapter and topic to a section that exists", () => {
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
      assert.ok(LANDING_TARGETS.has(to), `${from} points at missing ${to}`);
      assert.equal(resolveLegacyHash(`#${from}`), to);
    }
  });
});

describe("Landing motion and accessibility", () => {
  it("only animates on scroll where supported and where motion is welcome", () => {
    const motion = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    assert.ok(motion > 0);
    const timelines = [...css.matchAll(/animation-timeline:/g)].map((match) => match.index);
    assert.ok(timelines.length >= 10);
    assert.ok(
      timelines.every((index) => index > motion),
      "every scroll animation is gated",
    );
    assert.match(css, /@supports \(animation-timeline: view\(\)\)/);
  });

  it("never intercepts scrolling or input", () => {
    assert.doesNotMatch(allSource, /addEventListener\("(?:wheel|touchstart|touchmove|keydown)"/);
    assert.doesNotMatch(allSource, /preventDefault\(/);
    assert.match(
      sources["studio.tsx"],
      /addEventListener\("scroll", schedule, \{ passive: true \}\)/,
    );
  });

  it("keeps decorative art out of the accessibility tree and labels the real product", () => {
    assert.match(sources["hero.tsx"], /className=\{styles\.heroArt\} aria-hidden="true"/);
    assert.match(
      sources["problem.tsx"],
      /className=\{styles\.hillCrest\}[\s\S]*?aria-hidden="true"/,
    );
    assert.match(sources["studio.tsx"], /className=\{styles\.studioCurtain\} aria-hidden="true"/);
    assert.match(sources["studio.tsx"], /data-side="left" aria-hidden="true"/);
    assert.match(sources["product.tsx"], /alt=\{product\.image\.alt\}/);
    assert.match(css, /outline: 2px solid currentColor/);
  });

  it("ships every scene still it references, wide and tall where phones need a different crop", () => {
    const publicDir = new URL("../public/", import.meta.url);
    const referenced = [...allSource.matchAll(/"\/marketing\/scenes\/([\w-]+\.webp)"/g)].map(
      (match) => match[1],
    );
    assert.ok(referenced.length >= 6);
    for (const file of referenced) {
      assert.ok(existsSync(new URL(`marketing/scenes/${file}`, publicDir)), file);
    }
    for (const scene of ["doorway", "class"]) {
      assert.ok(
        referenced.includes(`${scene}-wide.webp`) && referenced.includes(`${scene}-tall.webp`),
      );
    }
  });

  it("uses only scoped marketing materials and no external runtime", () => {
    assert.doesNotMatch(
      `${allSource}\n${css}`,
      /from\s+["']https?:|\bsrc=["']https?:|unpkg|<script|@font-face|url\(["']?https?:/i,
    );
  });
});

describe("Landing identity", () => {
  const pageSource = readFileSync(
    new URL("../src/components/marketing/landing-page.tsx", import.meta.url),
    "utf8",
  );

  it("sets type in production's system display stack, without a web serif or italic accents", () => {
    assert.doesNotMatch(`${pageSource}\n${allSource}`, /next\/font|Instrument|<em>/);
    assert.doesNotMatch(css, /font-family|font-style:\s*italic|serif/);
    const weights = [...css.matchAll(/font-weight:\s*(\d+)/g)].map((match) => Number(match[1]));
    assert.ok(weights.filter((weight) => weight >= 700).length >= 8, "display type is heavy");
  });

  it("keeps production's palette: deep brown and wood, no red seal or sticky notes", () => {
    assert.match(css, /--deep: var\(--koaryu-deep-brown\)/);
    assert.match(css, /--beam-light: var\(--koaryu-beam-light\)/);
    assert.doesNotMatch(css, /#b3432b|--seal|\.seal\b|\.scrap/);
    assert.doesNotMatch(allSource, /styles\.seal|scrap/i);
  });

  it("dives into the hill: the masthead darkens over the brown, and the brown lifts into the dojo beam", () => {
    assert.match(
      pageSource,
      /<div className=\{styles\.inside\}>\s*<Problem \/>\s*<Studio \/>\s*<\/div>/,
    );
    assert.match(css, /timeline-scope: --inside/);
    assert.match(css, /animation-timeline: scroll\(root\), --inside/);
    assert.match(
      css,
      /\.studioCurtain \{[^}]*transform: translateY\(calc\(-100% \+ var\(--lintel\)\)\)/s,
    );
  });
});

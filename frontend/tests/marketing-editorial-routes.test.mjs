import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  exploreSections,
  getMarketingPageByRef,
} from "../src/lib/marketing-pages.ts";

const exploreSource = readFileSync(
  new URL("../src/app/explore/page.tsx", import.meta.url),
  "utf8"
);
const aboutSource = readFileSync(
  new URL("../src/app/about/page.tsx", import.meta.url),
  "utf8"
);
const publicPagesSource = readFileSync(
  new URL("../src/components/marketing/public-pages.tsx", import.meta.url),
  "utf8"
);
const css = readFileSync(
  new URL("../src/components/marketing/public-pages.module.css", import.meta.url),
  "utf8"
);

const routeSources = `${exploreSource}\n${aboutSource}`;
const routeCss = css.slice(css.indexOf(".exploreHero {"), css.lastIndexOf(".footer {"));
const normalizeWhitespace = (value) => value.replace(/\s+/g, " ");

describe("Explore and About editorial routes", () => {
  it("preserves exact metadata, canonical URLs, and page structured data", () => {
    for (const [source, expectations] of [
      [
        exploreSource,
        {
          title: "Explore Koaryu | Martial Arts Studio Software Guide",
          description:
            "A quiet guide to Koaryu's feature pages, studio workflows, and fit for independent martial arts schools.",
          openGraphDescription:
            "Find the Koaryu product page, use case, or studio path that matches what you are trying to understand.",
          url: "https://koaryu.app/explore",
          type: "CollectionPage",
          name: "Explore Koaryu",
          structuredDescription:
            "A guide to Koaryu feature pages, use cases, and studio-fit pages.",
        },
      ],
      [
        aboutSource,
        {
          title: "About Koaryu | Martial Arts Studio Software",
          description:
            "Koaryu is a flat-rate operating system for independent martial arts studios, built around students, ranks, attendance, leads, billing, and retention.",
          openGraphDescription:
            "The product philosophy behind Koaryu and its focus on independent martial arts schools.",
          url: "https://koaryu.app/about",
          type: "AboutPage",
          name: "About Koaryu",
          structuredDescription:
            "Koaryu is a martial arts studio operating system for independent schools.",
        },
      ],
    ]) {
      const normalizedSource = normalizeWhitespace(source);

      assert.ok(normalizedSource.includes(`title: "${expectations.title}"`));
      assert.ok(normalizedSource.includes(`description: "${expectations.description}"`));
      assert.ok(normalizedSource.includes(`alternates: { canonical: "${expectations.url}" }`));
      assert.ok(normalizedSource.includes(`url: "${expectations.url}"`));
      assert.ok(normalizedSource.includes(expectations.openGraphDescription));
      assert.ok(normalizedSource.includes(`"@type": "${expectations.type}"`));
      assert.ok(normalizedSource.includes(`name: "${expectations.name}"`));
      assert.ok(normalizedSource.includes(expectations.structuredDescription));
      assert.match(source, /isPartOf:\s*\{\s*"@type": "WebSite",\s*name: APP_NAME,\s*url: "https:\/\/koaryu\.app\/"/s);
      assert.match(source, /<BreadcrumbJsonLd\s+items=\{\[/);
    }
  });

  it("keeps one route-owned Explore heading and one shared About hero heading", () => {
    assert.equal(exploreSource.match(/<h1\b/g)?.length, 1);
    assert.equal(aboutSource.match(/<h1\b/g)?.length ?? 0, 0);
    assert.equal(aboutSource.match(/<MarketingHero\b/g)?.length, 1);
    assert.equal(publicPagesSource.match(/<h1\b/g)?.length, 1);
  });

  it("renders every Explore intent, route, and resolved included page from its source", () => {
    const paths = exploreSections.flatMap((section) => section.paths);
    const pageRefs = paths.flatMap((path) => path.pages);
    const resolvedPages = pageRefs.map(getMarketingPageByRef);

    assert.equal(exploreSections.length, 3);
    assert.equal(paths.length, 4);
    assert.equal(pageRefs.length, 10);
    assert.ok(resolvedPages.every(Boolean));
    assert.match(exploreSource, /exploreSections\.map\(\(section, sectionIndex\)/);
    assert.match(exploreSource, /section\.paths\.map\(\(path\)/);
    assert.match(exploreSource, /path\.pages\.flatMap\(\(pageRef\)/);
    assert.match(exploreSource, /getMarketingPageByRef\(pageRef\)/);
    assert.match(exploreSource, /includedPages\.map\(\(page\)/);
    assert.match(exploreSource, /\{page\.eyebrow\}/);
    assert.match(exploreSource, /\{page\.title\}/);
    assert.match(exploreSource, /<Link href=\{path\.href\}/);
    assert.match(exploreSource, /\{path\.eyebrow\}/);
    assert.match(exploreSource, /\{path\.title\}/);
    assert.match(exploreSource, /\{path\.description\}/);
    assert.match(exploreSource, /\{path\.action\}/);
    assert.doesNotMatch(exploreSource, /\.slice\(0,\s*4\)/);
  });

  it("preserves About principles, positioning, caveats, and both route actions", () => {
    const normalizedAbout = normalizeWhitespace(aboutSource);

    for (const copy of [
      "Built for independent schools",
      "Koaryu is focused on owner-operated and small-team martial arts studios, not enterprise gym chains.",
      "Studio data should stay understandable",
      "Student, guardian, attendance, rank, lead, and supported billing records stay visible and scoped to the school; new billing exports are currently unavailable.",
      "Daily action beats dashboard theater",
      "The product should answer what needs attention today: follow-ups, classes, promotions, retention, and tuition issues.",
      "Koaryu is intentionally narrower than generic gym software.",
      "The product is built around the rhythm of a martial arts school: the student who misses class, the trial family waiting for a call, the instructor reviewing promotions, and the owner who needs to know whether the school is healthy before the evening rush.",
      "Koaryu supports one studio per user with explicit Admin, Front Desk, and Instructor boundaries. It centers the roster, ranks, schedule, attendance, leads, and honest visibility into existing billing records. Provider-backed billing changes and live Stripe activation are currently unavailable.",
    ]) {
      assert.ok(normalizedAbout.includes(copy), `missing About copy: ${copy}`);
    }

    assert.match(aboutSource, /<MarketingActionLink href="\/features">\s*Explore features/);
    assert.match(aboutSource, /<MarketingActionLink href="\/use-cases" variant="secondary">\s*See use cases/);
    assert.match(aboutSource, /steps=\{detailNextSteps\}/);
    assert.match(exploreSource, /steps=\{detailNextSteps\}/);
  });

  it("uses server-rendered route maps and paper statements without legacy UI seams", () => {
    assert.doesNotMatch(
      routeSources,
      /["']use client["']|ScrollReveal|lucide-react|@\/components\/ui\/|\bButton\b|ProductScene|iconMap|use(?:State|Effect|Ref)\s*\(|\b(?:window|document|navigator)\s*\.|onWheel|onTouch|preventDefault|\.slice\(0,\s*4\)/
    );
    assert.doesNotMatch(
      routeSources,
      /(?:bg-bg|bg-surface|text-text|border-border|text-accent)|var\(--(?:bg|surface|border|text-[\w-]+|accent)\b/
    );
    assert.doesNotMatch(routeSources, /card|badge|pill|rounded|shadow|translate-y/i);
    assert.doesNotMatch(
      routeCss,
      /gradient|backdrop|glass|#[fF]{6}|#[0]{6}|position:\s*fixed|height:\s*100dvh|overflow:\s*hidden/i
    );
    assert.match(routeCss, /\.aboutScope\s*\{[^}]*color:\s*var\(--koaryu-ink-light\);[^}]*background:\s*var\(--koaryu-deep-brown\)/s);
    assert.match(routeCss, /\.exploreRouteLink\s*\{[^}]*min-height:\s*132px/s);
    assert.match(routeCss, /\.exploreRouteLink:hover \.exploreRouteAction > span\s*\{[^}]*translateX\(3px\)/s);

    const includedTitleRule = routeCss.match(
      /\.exploreIncludedList > span > span:last-child\s*\{([^}]*)\}/
    )?.[1];
    const includedTitleOpacity = Number(
      includedTitleRule?.match(/opacity:\s*([\d.]+)/)?.[1]
    );

    assert.ok(Number.isFinite(includedTitleOpacity));
    assert.ok(includedTitleOpacity >= 0.72);
  });

  it("keeps the feature ledger calm and gives use cases a separate workflow rail", () => {
    const indexSection = css.match(/\.indexSection\s*\{[\s\S]*?\n\}/)?.[0] ?? "";

    assert.match(indexSection, /grid-template-columns:\s*minmax\(230px, 0\.55fr\) minmax\(0, 1\.45fr\)/);
    assert.doesNotMatch(css, /\.indexSection::before/);
    assert.match(css, /\.featureIndex \.indexHeading\s*\{[^}]*max-width:\s*34ch/s);
    assert.match(css, /\.useCaseIndex\s*\{[^}]*grid-template-columns:\s*1fr/s);
    assert.match(css, /\.useCaseIndex \.ledger li::before\s*\{[^}]*position:\s*absolute[^}]*background:\s*var\(--koaryu-rule-soft\)/s);
    assert.match(css, /\.useCaseIndex \.ledger li::after\s*\{[^}]*border-radius:\s*50%/s);
  });
});

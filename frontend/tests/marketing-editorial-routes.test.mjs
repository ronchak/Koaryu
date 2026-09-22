import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { featurePages, studioTypePages, useCasePages } from "../src/lib/marketing-pages.ts";

const readSource = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const exploreSource = readSource("app/explore/page.tsx");
const aboutSource = readSource("app/about/page.tsx");
const familySource = readSource("components/marketing/discovery-pages.tsx");
const normalizeWhitespace = (value) => value.replace(/\s+/g, " ");

describe("Explore, About, and family-school guides", () => {
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
      assert.match(
        source,
        /isPartOf:\s*\{\s*"@type": "WebSite",\s*name: APP_NAME,\s*url: "https:\/\/koaryu\.app\/"/s,
      );
      assert.match(source, /<BreadcrumbJsonLd\s+items=\{\[/);
    }
  });

  it("gives Explore a direct path to every feature, workflow, and school guide", () => {
    assert.match(exploreSource, /featurePages\.map/);
    assert.match(exploreSource, /href=\{page\.href\}/);
    for (const page of [...useCasePages, ...studioTypePages]) {
      assert.ok(exploreSource.includes(page.href), `missing direct route ${page.href}`);
    }
    assert.equal(featurePages.length, 4);
    assert.match(exploreSource, /href="\/about"/);
    assert.match(exploreSource, /href="\/features"/);
    assert.match(exploreSource, /href="\/use-cases"/);
  });

  it("states real product limits where owners evaluate fit", () => {
    for (const source of [aboutSource, familySource]) {
      const text = normalizeWhitespace(source);
      assert.match(text, /one studio per user/i);
      assert.match(text, /separate activation for the exact studio/);
      assert.match(text, /not generally available/);
      assert.match(text, /billing exports are currently unavailable/i);
      assert.match(text, /Instructors do not have access to billing data/);
    }
    assert.match(aboutSource, /formatPublicPlatformPrice\(\)/);
    assert.doesNotMatch(aboutSource, /\$27|2700|["']27["']/);
  });

  it("separates family responsibilities and labels illustrative records", () => {
    for (const role of ["The student", "The guardian", "The payer", "The program"]) {
      assert.ok(familySource.includes(role));
    }
    assert.match(familySource, /illustrative family, not live student data/);
    assert.match(familySource, /It does not move money/);
    assert.match(familySource, /Readiness is a review signal/);
    assert.match(familySource, /relatedPages\.map/);
  });

  it("keeps information pages server-rendered without scroll interception or heavyweight scenes", () => {
    for (const source of [exploreSource, aboutSource, familySource]) {
      assert.doesNotMatch(
        source,
        /["']use client["']|onWheel|onTouch|preventDefault|use(?:State|Effect|Ref)\s*\(|ProductScene|JourneyScene/,
      );
    }
    assert.equal(exploreSource.match(/<h1\b/g)?.length, 1);
    assert.equal(aboutSource.match(/<h1\b/g)?.length, 1);
    assert.equal(familySource.match(/<h1\b/g)?.length, 1);
  });
});

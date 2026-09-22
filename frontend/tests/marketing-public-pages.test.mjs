import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const readSource = (path) =>
  readFileSync(new URL(`../src/components/marketing/${path}`, import.meta.url), "utf8");
const source = readSource("public-pages.tsx");
const navigation = readSource("public-navigation.tsx");
const css = readSource("public-pages.module.css");

describe("public document shell", () => {
  it("preserves the shared API for public and legal routes", () => {
    for (const name of [
      "MarketingHeader",
      "MarketingFooter",
      "PublicPageShell",
      "PageStructuredData",
      "BreadcrumbJsonLd",
      "MarketingHero",
      "MarketingNextSteps",
      "MarketingIndexPage",
      "MarketingDetailPage",
    ]) {
      assert.match(source, new RegExp(`export function ${name}\\b`));
    }
    assert.match(source, /export \{ detailNextSteps, indexNextSteps \}/);
    assert.match(source, /export type \{ MarketingNextStep \}/);
    assert.match(source, /<MarketingRoot layout="document"/);
    assert.match(source, /<main id="main-content"/);
    assert.match(source, /href="#main-content"/);
  });

  it("keeps public links semantic and authentication links unprefetched", () => {
    assert.match(source, /aria-label="Primary navigation"/);
    assert.match(navigation, /aria-label="Mobile navigation"/);
    assert.match(source, /aria-label="Footer navigation"/);
    assert.equal(source.match(/publicNavLinks\.map/g)?.length, 2);
    assert.match(source, /publicFooterLinks\.map/);
    assert.equal(source.match(/href="\/login"\s+prefetch=\{false\}/g)?.length, 2);
  });

  it("uses native disclosure with scoped dismissal and listener cleanup", () => {
    assert.match(navigation, /<details\b/);
    assert.match(navigation, /<summary aria-label="Navigation menu">/);
    for (const event of ["pointerdown", "keydown"]) {
      assert.ok(navigation.includes(`addEventListener("${event}"`));
      assert.ok(navigation.includes(`removeEventListener("${event}"`));
    }
    assert.match(navigation, /event\.key !== "Escape"/);
    assert.match(navigation, /querySelector\("summary"\)\?\.focus/);
    assert.doesNotMatch(navigation, /preventDefault|onWheel|onTouch|requestAnimationFrame/);
    assert.doesNotMatch(source, /["']use client["']/);
  });

  it("keeps normal document flow with a lightweight texture and transparent chrome", () => {
    assert.doesNotMatch(css, /position:\s*fixed|height:\s*100dvh|overflow:\s*hidden/);
    assert.match(css, /\.shell\[data-koaryu-marketing\]::after\s*\{[^}]*paper\.webp/s);
    assert.match(css, /\.header\s*\{[^}]*background:\s*transparent/s);
    assert.match(css, /\.footer\s*\{[^}]*background:\s*transparent/s);
    assert.match(css, /\.shell a:focus-visible\s*\{[^}]*outline:\s*2px solid currentColor/s);
    assert.match(css, /prefers-reduced-motion/);
  });
});

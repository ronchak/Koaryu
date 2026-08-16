import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(
  new URL("../src/components/marketing/public-pages.tsx", import.meta.url),
  "utf8"
);
const css = readFileSync(
  new URL("../src/components/marketing/public-pages.module.css", import.meta.url),
  "utf8"
);

describe("conventional marketing page composition", () => {
  it("preserves the compatibility-sensitive public API", () => {
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
    assert.match(source, /sceneLabel\?: string/);
    assert.match(source, /sceneFocus\?: string/);
  });

  it("uses one server-rendered marketing document shell and semantic navigation", () => {
    assert.match(source, /<MarketingRoot layout="document"/);
    assert.match(source, /<main className=\{styles\.main\}>/);
    assert.match(source, /aria-label="Primary navigation"/);
    assert.match(source, /aria-label="Account navigation"/);
    assert.match(source, /aria-label="Footer navigation"/);
    assert.match(source, /publicNavLinks\.map/);
    assert.match(source, /publicFooterLinks\.map/);
    assert.match(source, /href="\/login" prefetch=\{false\}/);
    assert.match(source, /href="\/signup" prefetch=\{false\}/);
    assert.doesNotMatch(
      source,
      /["']use client["']|\b(?:window|document|navigator)\s*\.|requestAnimationFrame|use(?:State|Effect|Ref)\s*\(/
    );
  });

  it("renders one hero heading and complete ledger, proof, detail, and related semantics", () => {
    assert.equal(source.match(/<h1\b/g)?.length, 1);
    assert.match(source, /<ul className=\{styles\.ledger\}>/);
    assert.doesNotMatch(source, /<ol className=\{styles\.ledger\}>/);
    assert.match(source, /\{page\.eyebrow\}/);
    assert.match(source, /\{page\.title\}/);
    assert.match(source, /\{page\.description\}/);
    assert.match(source, /<dl>/);
    assert.match(source, /page\.proof\.map/);
    assert.match(source, /page\.sections\.map/);
    assert.match(source, /section\.bullets\.map/);
    assert.match(source, /relatedPages\.map/);
    assert.doesNotMatch(source, /padStart\(|String\(index \+ 1\)/);
  });

  it("retires the old product scene, icon-card, reveal, and product-control seam", () => {
    assert.doesNotMatch(
      source,
      /ProductScene|product-scene|iconMap|LucideIcon|lucide-react|ScrollReveal|LogoLink|MobileNav|\bButton\b|@\/components\/ui\//
    );
    assert.doesNotMatch(
      `${source}\n${css}`,
      /(?:bg-bg|bg-surface|text-text|border-border|text-accent)|var\(--(?:bg|surface|border|text-[\w-]+|accent)\b/
    );
    assert.doesNotMatch(css, /gradient|backdrop|glass|#[fF]{6}|#[0]{6}|animation\s*:/);
  });

  it("keeps normal document flow, visible focus, target sizing, and canonical breakpoints", () => {
    assert.doesNotMatch(source, /onWheel|onTouch|onKeyDown|preventDefault/);
    assert.doesNotMatch(css, /position:\s*fixed|height:\s*100dvh|overflow:\s*hidden/);
    assert.match(
      css,
      /\.shell a:focus-visible\s*\{[^}]*outline:\s*2px solid currentColor;[^}]*outline-offset:\s*4px/s
    );
    assert.match(css, /\.routeLink\s*\{[^}]*min-height:\s*106px/s);
    assert.match(css, /\.brand\s*\{[^}]*min-height:\s*44px/s);
    for (const breakpoint of ["1000px", "820px", "560px"]) {
      assert.match(css, new RegExp(`@media \\(max-width: ${breakpoint}\\)`));
    }
  });

  it("layers long-document content and the paper header above the scoped fibre veil", () => {
    assert.match(
      css,
      /\.header,\s*\n\.main,\s*\n\.footer\s*\{[^}]*z-index:\s*21/s
    );
    assert.match(css, /\.header\s*\{[^}]*position:\s*sticky;[^}]*z-index:\s*30/s);
    assert.match(css, /overflow-x:\s*clip/);
  });
});

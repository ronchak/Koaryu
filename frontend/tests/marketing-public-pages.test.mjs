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
const headerSource = source.slice(
  source.indexOf("export function MarketingHeader"),
  source.indexOf("export function MarketingFooter")
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
    assert.match(source, /<details className=\{styles\.mobileNavigation\}>/);
    assert.match(source, /<summary aria-label="Navigation menu">/);
    assert.match(source, /aria-label="Mobile navigation"/);
    assert.match(source, /aria-label="Footer navigation"/);
    assert.equal(source.match(/publicNavLinks\.map/g)?.length, 2);
    assert.match(source, /publicFooterLinks\.map/);
    assert.equal(source.match(/href="\/login"/g)?.length, 2);
    assert.equal(
      source.match(/href="\/login"\s+prefetch=\{false\}/g)?.length,
      2
    );
    assert.doesNotMatch(headerSource, /\/signup|Start setup|MarketingActionLink/);
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
    assert.doesNotMatch(css, /gradient|backdrop|glass|#[fF]{6}|#[0]{6}/);
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
    assert.match(
      css,
      /\.headerInner\s*\{[^}]*grid-template-columns:[^;]*;[^}]*min-height:\s*76px/s
    );
    assert.match(
      css,
      /\.mobileNavigation > summary\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;[^}]*border-radius:\s*50%/s
    );
    assert.match(css, /\.mobileMenu\s*\{[^}]*background:\s*var\(--koaryu-sheet\)/s);
    assert.match(css, /\.mobileNavigation\[open\] \.mobileMenuIcon/s);
    assert.match(css, /\.mobileNavigation\s*\{[^}]*display:\s*none/s);
    for (const breakpoint of ["1000px", "820px", "560px"]) {
      assert.match(css, new RegExp(`@media \\(max-width: ${breakpoint}\\)`));
    }
  });

  it("keeps the opaque header in normal document flow above the fibre veil", () => {
    assert.match(css, /\.main,\s*\n\.footer\s*\{[^}]*z-index:\s*0/s);
    assert.match(
      css,
      /\.header\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*10;[^}]*background:\s*var\(--koaryu-paper\)/s
    );
    assert.doesNotMatch(css, /\.header\s*\{[^}]*(?:position:\s*(?:sticky|fixed)|top:\s*0)/s);
    assert.doesNotMatch(css, /\.(?:main|footer)[^{]*\{[^}]*z-index:\s*(?:2[0-9]|[3-9][0-9])/s);
    assert.match(css, /overflow-x:\s*clip/);
  });

  it("renders explicit index and detail family classes without a faux index plane", () => {
    assert.match(
      source,
      /basePath === "\/features" \? styles\.featureIndex : styles\.useCaseIndex/
    );
    assert.match(source, /pageHref\.startsWith\("\/features\/"\)[\s\S]*styles\.featureDetail/);
    assert.match(source, /pageHref\.startsWith\("\/use-cases\/"\)[\s\S]*styles\.useCaseDetail/);
    assert.match(source, /return styles\.studioTypeDetail/);
    assert.match(source, /className=\{`\$\{styles\.indexSection\} \$\{indexFamilyClass\}`\}/);
    assert.match(source, /className=\{`\$\{styles\.proofBand\} \$\{familyClass\}`\}/);
    assert.match(source, /className=\{`\$\{styles\.detailSection\} \$\{familyClass\}`\}/);
    assert.doesNotMatch(css, /\.indexSection::before/);
    assert.match(css, /\.featureIndex \.indexHeading\s*\{[^}]*max-width:\s*34ch/s);
    assert.match(css, /\.useCaseIndex\s*\{[^}]*grid-template-columns:\s*1fr/s);
    assert.match(css, /\.useCaseIndex \.ledger li::before\s*\{[^}]*background:\s*var\(--koaryu-rule-soft\)/s);
    assert.match(css, /\.featureDetail\.proofBand/s);
    assert.match(css, /\.useCaseDetail\.detailSection/s);
    assert.match(css, /\.studioTypeDetail\.detailSection/s);
  });

  it("uses a restrained ruled related band and semantic, reduced-motion-safe movement", () => {
    assert.match(
      css,
      /\.relatedSection\s*\{[^}]*position:\s*relative;[^}]*padding:\s*clamp\(56px, 5vw, 72px\) 0 clamp\(64px, 8vw, 96px\);[^}]*background:\s*transparent/s
    );
    assert.match(
      css,
      /\.relatedSection::before\s*\{[^}]*top:\s*0;[^}]*width:\s*100vw;[^}]*height:\s*1px;[^}]*background:\s*var\(--koaryu-rule\)/s
    );
    assert.match(
      css,
      /\.detailSection\s*\{[^}]*padding:\s*clamp\(72px, 9vw, 112px\) 0 clamp\(48px, 4vw, 64px\)/s
    );
    assert.match(css, /\.detailHeading\s*\{[^}]*position:\s*sticky;[^}]*top:\s*32px/s);
    assert.match(css, /\.relatedList\s*\{[^}]*display:\s*block/s);
    assert.match(css, /\.relatedLink\s*\{[^}]*min-height:\s*88px/s);
    assert.match(css, /@keyframes publicSettle/);
    assert.match(css, /@keyframes publicOpen/);
    assert.match(
      css,
      /\.heroSupport,\s*\n\.exploreHeroSupport,\s*\n\.ledger,\s*\n\.proofBand dl\s*\{[^}]*animation:\s*publicSettle 360ms/s
    );
    assert.match(css, /\.mobileNavigation\[open\] \.mobileMenu,\s*\n\.detailSection:target \.detailArticles\s*\{[^}]*animation:\s*publicOpen/s);
    assert.match(css, /\.ledgerLink:hover \.ledgerAction,[^}]*transform:\s*translateX\(3px\)/s);

    const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    assert.match(reducedMotion, /transition:\s*none !important/);
    assert.match(reducedMotion, /animation:\s*none !important/);
    assert.match(reducedMotion, /animation-delay:\s*0s !important/);
    assert.match(reducedMotion, /transform:\s*none !important/);
    assert.match(reducedMotion, /\.heroSupport,\s*\n\s*\.exploreHeroSupport/s);
  });
});

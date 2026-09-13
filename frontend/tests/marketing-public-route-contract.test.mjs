import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { PUBLIC_PLATFORM_PRICE, publicPlatformPriceAmount } from "../src/lib/constants.ts";
import {
  buildMarketingDetailMetadata,
  buildMarketingDetailStructuredData,
  generateMarketingDetailStaticParams,
} from "../src/lib/marketing-detail-route-model.ts";
import { featurePages, studioTypePages, useCasePages } from "../src/lib/marketing-pages.ts";
import { buildPublicSitemap } from "../src/lib/sitemap-model.ts";

const sourceUrl = (path) => new URL(`../src/${path}`, import.meta.url);
const readSource = (path) => readFileSync(sourceUrl(path), "utf8");

const staticRoutes = ["/features", "/use-cases", "/explore", "/about", "/privacy", "/terms"];

const detailRoutes = [...featurePages, ...useCasePages, ...studioTypePages];

describe("public marketing route contract", () => {
  it("accounts for exactly 16 non-root routes and every sitemap URL", () => {
    const routes = [...staticRoutes, ...detailRoutes.map((page) => page.href)];

    assert.equal(featurePages.length, 4);
    assert.equal(useCasePages.length, 5);
    assert.equal(studioTypePages.length, 1);
    assert.equal(routes.length, 16);
    assert.equal(new Set(routes).size, 16);

    const sitemapUrls = buildPublicSitemap({
      baseUrl: "https://koaryu.app",
      featurePages,
      publicContentLastModified: new Date("2026-05-23T00:00:00.000Z"),
      studioTypePages,
      useCasePages,
    })
      .map((entry) => entry.url)
      .filter((url) => url !== "https://koaryu.app/")
      .sort();

    assert.deepEqual(sitemapUrls, routes.map((route) => `https://koaryu.app${route}`).sort());
  });

  it("derives every detail metadata, structured URL, and static parameter from its record", () => {
    for (const page of detailRoutes) {
      const metadata = buildMarketingDetailMetadata(page);
      const structuredData = buildMarketingDetailStructuredData(page, "Koaryu");

      assert.equal(metadata.title, page.metaTitle);
      assert.equal(metadata.description, page.description);
      assert.equal(metadata.alternates?.canonical, `https://koaryu.app${page.href}`);
      assert.equal(metadata.openGraph?.url, `https://koaryu.app${page.href}`);
      assert.equal(structuredData.url, `https://koaryu.app${page.href}`);
    }

    for (const pages of [featurePages, useCasePages, studioTypePages]) {
      assert.deepEqual(
        generateMarketingDetailStaticParams(pages),
        pages.map((page) => ({ slug: page.slug })),
      );
    }
  });

  it("keeps route and detail structured data alongside complete detail content", () => {
    for (const routePath of [
      "app/features/page.tsx",
      "app/use-cases/page.tsx",
      "app/explore/page.tsx",
      "app/about/page.tsx",
    ]) {
      const source = readSource(routePath);
      assert.match(source, /<BreadcrumbJsonLd\b/);
      assert.match(source, /<PageStructuredData\b/);
    }

    const detailSource = readSource("lib/marketing-detail-route.tsx");
    const rendererSource = readSource("components/marketing/public-pages.tsx");
    assert.match(detailSource, /<BreadcrumbJsonLd\b/);
    assert.match(detailSource, /<PageStructuredData\b/);
    assert.match(rendererSource, /page\.sections\.map/);
    assert.match(rendererSource, /section\.bullets\.map/);
    assert.match(rendererSource, /\{section\.description\}/);
  });

  it("derives public price data and keeps tuition availability conditional", () => {
    const featuresSource = readSource("app/features/page.tsx");
    assert.match(featuresSource, /price:\s*publicPlatformPriceAmount\(\)/);
    assert.match(featuresSource, /priceCurrency:\s*PUBLIC_PLATFORM_PRICE\.currency/);
    assert.doesNotMatch(featuresSource, /\$27|2700|["']27["']/);
    assert.equal(publicPlatformPriceAmount(), "27");
    assert.equal(PUBLIC_PLATFORM_PRICE.currency, "USD");

    const billingPage = featurePages.find((page) => page.slug === "billing");
    assert.ok(billingPage);
    const billingCopy = JSON.stringify(billingPage);
    assert.match(billingCopy, /separate activation/i);
    assert.match(billingCopy, /not generally available/i);
  });
});

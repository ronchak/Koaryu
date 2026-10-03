import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMarketingDetailMetadata,
  buildMarketingDetailStructuredData,
  generateMarketingDetailStaticParams,
} from "../src/lib/marketing-detail-route-model.ts";
import {
  featurePages,
  useCasePages,
  getFeaturePage,
  getUseCasePage,
} from "../src/lib/marketing-pages.ts";
import { buildPublicSitemap } from "../src/lib/sitemap-model.ts";
import { formatPublicPlatformPrice } from "../src/lib/constants.ts";

const detailPages = [...featurePages, ...useCasePages];

describe("public marketing route contract", () => {
  it("indexes eleven distinct marketing pages, home, and the two legal pages", () => {
    const entries = buildPublicSitemap({
      baseUrl: "https://koaryu.app",
      featurePages,
      useCasePages,
      publicContentLastModified: new Date("2026-09-22T00:00:00.000Z"),
    });
    const expected = [
      "/",
      "/features",
      "/use-cases",
      "/privacy",
      "/terms",
      ...detailPages.map(({ href }) => href),
    ];
    assert.equal(detailPages.length, 9);
    assert.equal(entries.length, 14);
    assert.equal(new Set(entries.map(({ url }) => url)).size, entries.length);
    assert.deepEqual(
      entries.map(({ url }) => url).sort(),
      expected.map((path) => `https://koaryu.app${path}`).sort(),
    );
  });

  it("keeps each detail page’s search and social descriptions consistent with structured data", () => {
    for (const page of detailPages) {
      const metadata = buildMarketingDetailMetadata(page);
      const structured = buildMarketingDetailStructuredData(page, "Koaryu");
      assert.equal(metadata.title, page.metaTitle);
      assert.equal(metadata.description, page.description);
      assert.equal(metadata.openGraph.description, page.description);
      assert.equal(metadata.twitter.description, page.description);
      assert.equal(structured.description, page.description);
      assert.equal(metadata.alternates.canonical, `https://koaryu.app${page.href}`);
      assert.equal(metadata.openGraph.url, metadata.alternates.canonical);
      assert.equal(structured.url, metadata.alternates.canonical);
    }
    for (const pages of [featurePages, useCasePages]) {
      assert.deepEqual(
        generateMarketingDetailStaticParams(pages),
        pages.map(({ slug }) => ({ slug })),
      );
    }
  });

  it("does not resolve invented feature or workflow slugs", () => {
    for (const slug of ["unknown", "__proto__", "toString"]) {
      assert.equal(getFeaturePage(slug), undefined);
      assert.equal(getUseCasePage(slug), undefined);
    }
  });

  it("qualifies platform price and preserves the payment-record and collection boundaries", () => {
    const billing = getFeaturePage("billing");
    assert.equal(
      billing.proof.find(({ label }) => label === "Pricing").value,
      `${formatPublicPlatformPrice()} per month per studio`,
    );
    assert.match(billing.summary, /separate activation/);
    assert.match(billing.summary, /not generally available/);
    assert.match(billing.summary, /billing exports are unavailable/);
    assert.match(JSON.stringify(billing.sections), /does not settle a Stripe invoice/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMarketingDetailMetadata,
  buildMarketingDetailStructuredData,
  generateMarketingDetailStaticParams,
  publicMarketingUrl,
  relatedMarketingPages,
} from "../src/lib/marketing-detail-route-model.ts";
import { featurePages, getMarketingPageByRef } from "../src/lib/marketing-pages.ts";

describe("marketing detail route helper", () => {
  it("builds route params, metadata, related pages, and structured data from page records", () => {
    const page = featurePages[0];

    assert.deepEqual(generateMarketingDetailStaticParams(featurePages).at(0), { slug: page.slug });
    assert.equal(publicMarketingUrl(page.href), `https://koaryu.app${page.href}`);
    assert.equal(buildMarketingDetailMetadata(page).alternates.canonical, `https://koaryu.app${page.href}`);
    assert.equal(buildMarketingDetailStructuredData(page, "Koaryu").url, `https://koaryu.app${page.href}`);
    assert.deepEqual(
      relatedMarketingPages(page, getMarketingPageByRef).map((relatedPage) => relatedPage.slug),
      page.related.map((related) => related.slug)
    );
  });

});

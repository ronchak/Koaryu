import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { compileCommonJsModule } from "./helpers/store-browser-harness.mjs";
import { SOCIAL_PREVIEW_IMAGE } from "../src/lib/social-preview.ts";
import { buildMarketingDetailMetadata } from "../src/lib/marketing-detail-route-model.ts";
import { featurePages, useCasePages } from "../src/lib/marketing-pages.ts";

describe("social preview metadata", () => {
  it("renders a public PNG whose dimensions match the declared image", async () => {
    const url = new URL(SOCIAL_PREVIEW_IMAGE.url);
    assert.equal(url.origin, "https://koaryu.app");
    assert.equal(url.search, "");
    assert.equal(url.pathname, "/opengraph-image");
    const file = new URL("../src/app/opengraph-image.tsx", import.meta.url);
    const compiledModule = { exports: {} };
    const source = compileCommonJsModule(readFileSync(file, "utf8"), file.pathname);
    new Function("require", "module", "exports", source)(
      createRequire(import.meta.url),
      compiledModule,
      compiledModule.exports,
    );
    assert.equal(compiledModule.exports.dynamic, "force-static");
    assert.equal(compiledModule.exports.alt, SOCIAL_PREVIEW_IMAGE.alt);
    const response = compiledModule.exports.default();
    assert.equal(response.headers.get("content-type"), SOCIAL_PREVIEW_IMAGE.type);
    const png = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), SOCIAL_PREVIEW_IMAGE.width);
    assert.equal(png.readUInt32BE(20), SOCIAL_PREVIEW_IMAGE.height);
    assert.equal(SOCIAL_PREVIEW_IMAGE.type, "image/png");
    assert.equal(SOCIAL_PREVIEW_IMAGE.alt, "Koaryu — Martial Arts Studio OS");
    assert.ok(png.length < 5_000_000);
  });

  it("preserves the shared image when marketing details replace nested metadata", () => {
    for (const page of [...featurePages, ...useCasePages]) {
      const metadata = buildMarketingDetailMetadata(page);
      assert.deepEqual(metadata.openGraph.images, [SOCIAL_PREVIEW_IMAGE], page.href);
      assert.deepEqual(metadata.twitter.images, [SOCIAL_PREVIEW_IMAGE], page.href);
      assert.equal(metadata.twitter.card, "summary_large_image", page.href);
      assert.equal(metadata.openGraph.title, page.metaTitle, page.href);
      assert.equal(metadata.twitter.title, page.metaTitle, page.href);
    }
  });
});

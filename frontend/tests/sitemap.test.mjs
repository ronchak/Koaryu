import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPublicSitemap } from "../src/lib/sitemap-model.ts";

const featurePages = [{ slug: "billing" }];
const useCasePages = [{ slug: "retention" }];
const studioTypePages = [{ slug: "bjj" }];

function buildSitemap() {
  return buildPublicSitemap({
    baseUrl: "https://koaryu.app",
    featurePages,
    publicContentLastModified: new Date("2026-05-23T00:00:00.000Z"),
    studioTypePages,
    useCasePages,
  });
}

describe("sitemap freshness", () => {
  it("returns a stable public content timestamp for every route", () => {
    const first = buildSitemap();
    const second = buildSitemap();

    assert.deepEqual(
      first.map((entry) => entry.lastModified?.toISOString()),
      second.map((entry) => entry.lastModified?.toISOString())
    );
    assert.equal(
      first.every((entry) => entry.lastModified?.toISOString() === "2026-05-23T00:00:00.000Z"),
      true
    );
  });

  it("includes public marketing routes with expected sitemap priorities", () => {
    const entriesByUrl = new Map(buildSitemap().map((entry) => [entry.url, entry]));

    assert.equal(entriesByUrl.get("https://koaryu.app/")?.priority, 1);
    assert.equal(entriesByUrl.get("https://koaryu.app/explore")?.priority, 0.8);
    assert.equal(entriesByUrl.get("https://koaryu.app/features")?.priority, 0.8);
    assert.equal(entriesByUrl.get("https://koaryu.app/about")?.changeFrequency, "monthly");
    assert.equal(entriesByUrl.has("https://koaryu.app/features/billing"), true);
    assert.equal(entriesByUrl.has("https://koaryu.app/use-cases/retention"), true);
    assert.equal(entriesByUrl.has("https://koaryu.app/studio-types/bjj"), true);
  });
});

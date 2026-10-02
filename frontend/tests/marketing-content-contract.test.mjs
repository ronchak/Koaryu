import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  PUBLIC_PLATFORM_PRICE,
  formatPublicPlatformPrice,
  publicPlatformPriceAmount,
} from "../src/lib/constants.ts";
import { landingPageContent } from "../src/lib/landing-page-content.ts";
import { featurePages } from "../src/lib/marketing-pages.ts";

const frontendRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function chapter(id) {
  const value = landingPageContent.chapters.find((item) => item.id === id);
  assert.ok(value, `missing ${id} chapter`);
  return value;
}

function assertPlainJsonValue(value, path = "landingPageContent") {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return;
  }

  assert.notEqual(typeof value, "function", `${path} contains a function`);
  assert.notEqual(typeof value, "symbol", `${path} contains a symbol`);

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainJsonValue(item, `${path}[${index}]`));
    return;
  }

  assert.equal(Object.getPrototypeOf(value), Object.prototype, `${path} is not a plain object`);
  for (const [key, item] of Object.entries(value)) {
    assertPlainJsonValue(item, `${path}.${key}`);
  }
}

describe("marketing content contract", () => {
  it("keeps the Journey in exact chapter order with plain JSON-safe values", () => {
    assert.deepEqual(
      landingPageContent.chapters.map(({ id, scene, kind }) => [id, scene, kind]),
      [
        ["welcome", 0, "hero"],
        ["the-problem", 0.1, "problem"],
        ["product", 0.3, "product"],
        ["features", 0.5, "features"],
        ["pricing", 0.72, "pricing"],
        ["faq", 0.86, "faq"],
        ["begin", 1, "final"],
      ],
    );
    assert.deepEqual(JSON.parse(JSON.stringify(landingPageContent)), landingPageContent);
    assertPlainJsonValue(landingPageContent);
  });

  it("preserves direct destinations and states current product limits once, plainly", () => {
    assert.deepEqual(
      chapter("features").rows.map((row) => row.detail.href),
      [
        "/features/student-management",
        "/features/belt-tracking",
        "/features/attendance",
        "/use-cases/trial-to-enrollment",
        "/use-cases/spreadsheets-to-studio-crm",
        "/features/billing",
      ],
    );
    assert.deepEqual(
      chapter("features").links.map((link) => link.href),
      ["/features", "/use-cases"],
    );
    assert.equal(chapter("pricing").setupAction.href, "/signup");
    assert.deepEqual(
      chapter("faq").groups.map((group) => [group.id, group.items.length]),
      [
        ["faq-fit", 3],
        ["faq-daily", 3],
        ["faq-pricing", 2],
        ["faq-limits", 2],
      ],
    );
    assert.deepEqual(
      chapter("begin").footerLinks.map((link) => link.href),
      ["/features", "/use-cases", "/terms", "/privacy"],
    );

    const serialized = JSON.stringify(landingPageContent);
    assert.match(serialized, /Student CSV import maps names, contacts, programs and current belts/);
    assert.match(serialized, /does not deduplicate existing students/);
    assert.match(serialized, /class-count, time-at-rank and instructor-approval requirements/);
    assert.match(serialized, /requires separate activation and is not generally available/);
    assert.match(serialized, /0\.5% per successful charge, plus Stripe fees/);
    assert.match(serialized, /cannot access billing/);
    assert.match(serialized, /no multi-location dashboard/);
    assert.match(serialized, /doesn't send automated email or SMS reminders/);
    assert.match(serialized, /new billing exports are unavailable/);
    assert.match(serialized, /shown with sample studio data/);
    assert.doesNotMatch(serialized, /already sorted|Koaryu’s now|web-first|Very convenient/);

    // Limits live in the FAQ; the selling chapters say what Koaryu does.
    const limitsCopy = /not generally available|requires separate activation/;
    for (const id of ["welcome", "product", "features", "pricing", "begin"]) {
      assert.doesNotMatch(JSON.stringify(chapter(id)), limitsCopy, id);
    }
    assert.equal(serialized.match(/not generally available/g)?.length, 1);
  });

  it("derives every authoritative public price representation from one fact", () => {
    assert.deepEqual(PUBLIC_PLATFORM_PRICE, {
      monthlyCents: 2700,
      currency: "USD",
      billingPeriod: "month",
      scope: "studio",
    });
    assert.equal(publicPlatformPriceAmount(), "27");
    assert.equal(formatPublicPlatformPrice(), "$27");
    assert.equal(chapter("pricing").amount, publicPlatformPriceAmount());
    assert.equal(chapter("pricing").displayPrice, formatPublicPlatformPrice());
    assert.match(chapter("welcome").lede, /\$27 per studio per month/);
    assert.equal(chapter("begin").lede, "$27 per studio, per month.");

    const constantsPath = join(frontendRoot, "src/lib/constants.ts");
    const constantsSource = readFileSync(constantsPath, "utf8");
    assert.equal(constantsSource.match(/\b2700\b/g)?.length, 1);

    const authoritativeSources = [
      "src/lib/landing-page-content.ts",
      "src/lib/marketing-pages.ts",
    ].map((path) => readFileSync(join(frontendRoot, path), "utf8"));
    const hardcodedPrice = /\$27|\b2700\b|(["'])27\1/;
    authoritativeSources.forEach((source) => assert.doesNotMatch(source, hardcodedPrice));

    const billingPage = featurePages.find((page) => page.slug === "billing");
    assert.ok(billingPage);
    assert.equal(
      billingPage.proof.find((item) => item.label === "Pricing")?.value,
      `${formatPublicPlatformPrice()} per month per studio`,
    );
  });

  it("keeps the canonical source server-safe and free of component values", () => {
    const source = readFileSync(join(frontendRoot, "src/lib/landing-page-content.ts"), "utf8");
    assert.doesNotMatch(source, /lucide-react|from ["']react["']/);
    assert.doesNotMatch(source, /\b(?:window|document|navigator)\b/);
    assert.doesNotMatch(source, /export\s+const\s+metadata\b/);
    assert.doesNotMatch(source, /new\s+(?:Date|Map|Set)\b|\bSymbol\s*\(/);
  });

  it("retires the old landing composition after the complete Journey takes ownership", () => {
    const landingSource = readFileSync(
      join(frontendRoot, "src/components/marketing/landing-page.tsx"),
      "utf8",
    );
    assert.match(landingSource, /<JourneyController>/);
    assert.match(landingSource, /<JourneyChapters\s*\/>/);
    assert.doesNotMatch(landingSource, /landing-page-legacy-content/);
    assert.equal(existsSync(join(frontendRoot, "src/lib/landing-page-legacy-content.ts")), false);
    assert.equal(existsSync(join(frontendRoot, "src/app/page.module.css")), false);
  });
});

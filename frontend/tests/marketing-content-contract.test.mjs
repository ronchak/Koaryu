import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  PUBLIC_PLATFORM_PRICE,
  formatPublicPlatformPrice,
  publicPlatformPriceAmount,
} from "../src/lib/constants.ts";
import { landingPageContent } from "../src/lib/landing-page-content.ts";
import * as legacyContent from "../src/lib/landing-page-legacy-content.ts";
import { featurePages } from "../src/lib/marketing-pages.ts";

const frontendRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

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
  it("keeps the complete Journey in exact chapter order with plain JSON-safe values", () => {
    const expectedStops = [
      ["welcome", 0.025, "hero"],
      ["the-problem", 0.1, "problem"],
      ["studio-view", 0.235, "morning"],
      ["product", 0.288, "product-intro"],
      ["features", 0.52, "features"],
      ["use-cases", 0.64, "use-cases"],
      ["signals-gather", 0.802, "transition"],
      ["explore", 0.892, "explore"],
      ["class-ready", 0.952, "transition"],
      ["pricing", 1, "pricing"],
      ["about", 1, "about"],
      ["faq", 1, "faq"],
      ["stillness", 1, "transition"],
      ["begin", 1, "final"],
    ];

    assert.deepEqual(
      landingPageContent.chapters.map(({ id, scene, kind }) => [id, scene, kind]),
      expectedStops
    );
    assert.deepEqual(JSON.parse(JSON.stringify(landingPageContent)), landingPageContent);
    assertPlainJsonValue(landingPageContent);
  });

  it("preserves approved rows, routes, FAQ counts, actions, and caveat language", () => {
    assert.deepEqual(
      chapter("features").rows.map((row) => row.detail.href),
      [
        "/features/student-management",
        "/features/belt-tracking",
        "/features/attendance",
        "/features/billing",
      ]
    );
    assert.deepEqual(
      chapter("features").rows.map((row) => row.title),
      chapter("features").rows.map((row) => row.detail.eyebrow)
    );
    assert.deepEqual(
      chapter("use-cases").rows.map((row) => row.detail.href),
      [
        "/use-cases/spreadsheets-to-studio-crm",
        "/use-cases/student-retention",
        "/use-cases/trial-to-enrollment",
        "/use-cases/tuition-cleanup",
        "/use-cases/belt-test-readiness",
      ]
    );
    assert.deepEqual(
      chapter("explore").routes.map((route) => route.href),
      ["/features", "/use-cases", "/studio-types/family-martial-arts-schools"]
    );
    assert.equal(chapter("features").rows.length, 4);
    assert.equal(chapter("use-cases").rows.length, 5);
    assert.equal(chapter("explore").routes.length, 3);
    assert.equal(chapter("pricing").facts.length, 3);
    assert.equal(chapter("pricing").setupAction.href, "/signup");
    assert.equal(chapter("about").principles.length, 3);
    assert.equal(chapter("about").link.href, "/about");
    assert.deepEqual(chapter("faq").groups.map((group) => group.items.length), [4, 4, 5, 5, 4, 4]);
    assert.deepEqual(
      chapter("begin").footerLinks.map((link) => link.href),
      ["/explore", "/features", "/use-cases", "/about", "/terms", "/privacy"]
    );

    const serialized = JSON.stringify(landingPageContent);
    assert.match(serialized, /CSV import is planned/);
    assert.match(serialized, /configurable belt ladders planned/);
    assert.match(serialized, /web-first/);
    assert.match(serialized, /Maybe\. SMS brings cost/);
    assert.match(serialized, /before activating payments/);
    assert.match(serialized, /fees separately/);
    assert.match(serialized, /Very convenient! Right up until class starts/);
    assert.match(serialized, /Six students haven't trained in 14 days/);
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
    assert.match(chapter("welcome").lede, /\$27 a month for the whole studio/);
    assert.equal(chapter("begin").lede, "$27 per studio, per month.");

    const constantsPath = join(frontendRoot, "src/lib/constants.ts");
    const constantsSource = readFileSync(constantsPath, "utf8");
    assert.equal(constantsSource.match(/\b2700\b/g)?.length, 1);

    const authoritativeSources = [
      "src/lib/landing-page-content.ts",
      "src/lib/marketing-pages.ts",
      "src/lib/marketing-public-content.ts",
    ].map((path) => readFileSync(join(frontendRoot, path), "utf8"));
    const hardcodedPrice = /\$27|\b2700\b|(["'])27\1/;
    authoritativeSources.forEach((source) => assert.doesNotMatch(source, hardcodedPrice));

    const billingPage = featurePages.find((page) => page.slug === "billing");
    assert.ok(billingPage);
    assert.equal(billingPage.proof.find((item) => item.label === "Pricing")?.value, formatPublicPlatformPrice());
  });

  it("keeps the canonical source server-safe and free of component values", () => {
    const source = readFileSync(join(frontendRoot, "src/lib/landing-page-content.ts"), "utf8");
    assert.doesNotMatch(source, /lucide-react|from ["']react["']/);
    assert.doesNotMatch(source, /\b(?:window|document|navigator)\b/);
    assert.doesNotMatch(source, /export\s+const\s+metadata\b/);
    assert.doesNotMatch(source, /new\s+(?:Date|Map|Set)\b|\bSymbol\s*\(/);
  });

  it("keeps the old landing composition unchanged except for its compatibility import", () => {
    const landingSource = readFileSync(
      join(frontendRoot, "src/components/marketing/landing-page.tsx"),
      "utf8"
    );
    const legacyImport = "@/lib/landing-page-legacy-content";
    const canonicalImport = "@/lib/landing-page-content";
    assert.equal(landingSource.match(new RegExp(legacyImport, "g"))?.length, 1);
    assert.doesNotMatch(landingSource, /from ["']@\/lib\/landing-page-content["']/);
    assert.equal(
      sha256(landingSource.replace(legacyImport, canonicalImport)),
      "607fe4aed130e565eb7b39776261acb796143c148d5bc73125fb44fd5b1e306c"
    );

    const legacySource = readFileSync(
      join(frontendRoot, "src/lib/landing-page-legacy-content.ts"),
      "utf8"
    );
    const compatibilityComment =
      "// Temporary compatibility for the old landing composition. Delete this module with that composition in WS-2.";
    assert.equal(legacySource.startsWith(`${compatibilityComment}\n`), true);
    assert.equal(
      sha256(legacySource.slice(compatibilityComment.length + 1)),
      "af769bb0fa76bc89c0d0c92a2d0f4fc4c5a7292fd1bb2658a78aebca4483bacf"
    );

    assert.deepEqual(Object.keys(legacyContent).sort(), [
      "assuranceItems",
      "faqGroups",
      "features",
      "previewActions",
      "previewMetrics",
      "previewProgramBuckets",
      "pricingItems",
      "privacyItems",
      "promises",
      "workflows",
    ]);
  });

  it("preserves the provider-write availability boundary", () => {
    const source = readFileSync(join(frontendRoot, "src/lib/marketing-pages.ts"), "utf8");
    assert.match(source, /live outbound provider changes remain disabled/);
    assert.match(source, /Plan, payer, autopay, invoice-lifecycle, refund, and Connect changes are currently unavailable/);
    assert.match(source, /without presenting unsupported provider changes as complete/);
  });
});

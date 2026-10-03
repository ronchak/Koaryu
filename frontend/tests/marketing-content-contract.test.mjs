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
  it("tells the story beat by beat with plain JSON-safe values", () => {
    const content = landingPageContent;
    assert.deepEqual(
      [
        content.hero.id,
        content.problem.id,
        content.studio.id,
        content.product.id,
        content.day.id,
        content.pricing.id,
        content.faq.id,
        content.finale.id,
      ],
      ["welcome", "the-problem", "studio", "product", "features", "pricing", "faq", "begin"],
    );
    assert.equal(content.problem.scraps.length, 6);
    assert.deepEqual(content.studio.doors, ["Step", "inside."]);
    assert.deepEqual(JSON.parse(JSON.stringify(content)), content);
    assertPlainJsonValue(content);
  });

  it("keeps the class demo honest: one student finishes their requirement, and it is labeled", () => {
    const { studio } = landingPageContent;
    assert.equal(studio.students.length, 5);
    for (const student of studio.students) {
      assert.ok(student.attended < student.required, `${student.name} starts below requirement`);
    }
    const finishers = studio.students.filter(
      (student) => student.attended + 1 === student.required,
    );
    assert.deepEqual(
      finishers.map((student) => student.name),
      [studio.ready.student],
    );
    assert.match(studio.caption, /sample students/);
  });

  it("preserves direct destinations and states current product limits once, plainly", () => {
    const { day, pricing, faq, finale } = landingPageContent;
    assert.deepEqual(
      day.moments.map((moment) => moment.detail.href),
      [
        "/use-cases/student-retention",
        "/use-cases/trial-to-enrollment",
        "/features/student-management",
        "/features/attendance",
        "/features/belt-tracking",
        "/features/billing",
        "/use-cases/spreadsheets-to-studio-crm",
      ],
    );
    assert.deepEqual(
      day.links.map((link) => link.href),
      ["/features", "/use-cases"],
    );
    assert.equal(pricing.setupAction.href, "/signup");
    assert.equal(pricing.paymentsLink.href, "#faq-pricing");
    assert.deepEqual(
      faq.groups.map((group) => [group.id, group.items.length]),
      [
        ["faq-fit", 3],
        ["faq-daily", 3],
        ["faq-pricing", 2],
        ["faq-limits", 2],
      ],
    );
    assert.deepEqual(
      finale.footerLinks.map((link) => link.href),
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

    // Limits live in the FAQ; everything else says what Koaryu does.
    const limitsCopy = /not generally available|requires separate activation/;
    const { faq: _faq, ...selling } = landingPageContent;
    assert.doesNotMatch(JSON.stringify(selling), limitsCopy);
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
    assert.equal(landingPageContent.pricing.amount, publicPlatformPriceAmount());
    assert.equal(landingPageContent.pricing.displayPrice, formatPublicPlatformPrice());
    assert.match(landingPageContent.hero.lede, /\$27 per studio per month/);
    assert.equal(landingPageContent.finale.lede, "$27 per studio, per month.");

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

  it("composes the landing from its own sections, not the retired journey controller", () => {
    const landingSource = readFileSync(
      join(frontendRoot, "src/components/marketing/landing-page.tsx"),
      "utf8",
    );
    for (const section of [
      "Hero",
      "Problem",
      "Studio",
      "Product",
      "Day",
      "Breather",
      "Pricing",
      "MatBand",
      "Faq",
      "Finale",
    ]) {
      assert.match(landingSource, new RegExp(`<${section}\\s*/>`), section);
    }
    assert.doesNotMatch(landingSource, /JourneyController|JourneyChapters/);
    assert.equal(
      existsSync(join(frontendRoot, "src/components/marketing/journey/journey-controller.tsx")),
      false,
    );
    assert.equal(existsSync(join(frontendRoot, "src/lib/landing-page-legacy-content.ts")), false);
  });
});

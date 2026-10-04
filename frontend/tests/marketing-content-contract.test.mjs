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
  it("tells the page as a film and then a page, with plain JSON-safe values", () => {
    const { hero, titles, handoff, product, day, pricing, faq, finale } = landingPageContent;
    assert.deepEqual(
      [hero.id, ...titles.map((title) => title.id), handoff.id],
      ["welcome", "the-problem", "the-path", "studio"],
    );
    assert.deepEqual(
      [product.id, day.id, pricing.id, faq.id, finale.id],
      ["product", "features", "pricing", "faq", "begin"],
    );
    assert.deepEqual(hero.headline, ["Run the school.", "Teach the art."]);
    assert.equal(titles[0].title, "Your studio is not a spreadsheet.");
    // Film titles are one short line each.
    for (const { title } of [...titles, handoff]) assert.ok(title.split(" ").length <= 9, title);
    assert.deepEqual(JSON.parse(JSON.stringify(landingPageContent)), landingPageContent);
    assertPlainJsonValue(landingPageContent);
  });

  it("preserves direct destinations and states current product limits once, plainly", () => {
    const { hero, handoff, day, pricing, faq, finale, product } = landingPageContent;
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
    assert.equal(hero.actions[0].href, "/signup");
    assert.equal(hero.actions[0].label, "Create an account");
    assert.equal(handoff.action.href, "/signup");
    assert.equal(pricing.setupAction.href, "/signup");
    assert.equal(finale.action.href, "/signup");
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
    assert.match(serialized, /Instructors never see billing/);
    assert.match(serialized, /no multi-location dashboard/);
    assert.match(serialized, /doesn't send automated email or SMS reminders/);
    assert.match(serialized, /new billing exports are unavailable/);
    assert.equal(product.caption, "Belt tracker, shown with sample studio data.");
    assert.equal(handoff.caption, "Illustration with sample students.");
    assert.match(product.lede, /decision to promote stays with you/);
    assert.doesNotMatch(serialized, /already sorted|Koaryu’s now|web-first|Very convenient/);

    // Limits live in the FAQ; everything else says what Koaryu does.
    const limitsCopy = /not generally available|requires separate activation/;
    for (const [key, value] of Object.entries(landingPageContent)) {
      if (key !== "faq") assert.doesNotMatch(JSON.stringify(value), limitsCopy, key);
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
    const { hero, pricing, finale } = landingPageContent;
    assert.equal(pricing.amount, publicPlatformPriceAmount());
    assert.equal(pricing.displayPrice, formatPublicPlatformPrice());
    assert.match(pricing.note, /No per-student tiers/);
    assert.match(hero.lede, /\$27 per studio per month/);
    assert.equal(finale.lede, "$27 per studio, per month.");

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

  it("composes the landing page as a film followed by the page", () => {
    const landingSource = readFileSync(
      join(frontendRoot, "src/components/marketing/landing-page.tsx"),
      "utf8",
    );
    assert.match(landingSource, /<LandingController titles=\{<FilmTitles \/>\}>/);
    for (const section of ["<Product />", "<Day />", "<Pricing />", "<Faq />", "<Finale />"]) {
      assert.ok(landingSource.includes(section), section);
    }
    assert.doesNotMatch(landingSource, /landing-page-legacy-content|Instrument_Serif/);
    assert.equal(existsSync(join(frontendRoot, "src/lib/landing-page-legacy-content.ts")), false);
    assert.equal(existsSync(join(frontendRoot, "src/app/page.module.css")), false);
    assert.equal(
      existsSync(join(frontendRoot, "src/components/marketing/journey/journey-controller.tsx")),
      false,
    );
  });
});

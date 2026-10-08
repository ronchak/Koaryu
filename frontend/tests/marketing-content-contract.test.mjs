import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import sharp from "sharp";
import {
  PUBLIC_PLATFORM_PRICE,
  formatPublicPlatformPrice,
  publicPlatformPriceAmount,
} from "../src/lib/constants.ts";
import { landingPageContent } from "../src/lib/landing-page-content.ts";
import { featurePages } from "../src/lib/marketing-pages.ts";

const frontendRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function chapter(id) {
  const value = landingPageContent.story.find((item) => item.id === id);
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
  it("keeps the paged story in exact chapter order with plain JSON-safe values", () => {
    assert.deepEqual(
      landingPageContent.story.map(({ id, scene, kind }) => [id, scene, kind]),
      [
        ["welcome", 0, "hero"],
        ["product", 0.288, "product"],
        ["features", 0.52, "features"],
        ["the-weave", 0.685, "weave"],
        ["studio", 1, "studio"],
      ],
    );
    assert.deepEqual(
      ["pricing", "tryIt", "faq", "close"].map((key) => landingPageContent[key].id),
      ["pricing", "try", "faq", "begin"],
    );
    assert.deepEqual(JSON.parse(JSON.stringify(landingPageContent)), landingPageContent);
    assertPlainJsonValue(landingPageContent);
  });

  it("rests the one-record line on the clouds and points people to the hands-on demo", () => {
    assert.ok(!("threads" in chapter("the-weave")));
    assert.equal(chapter("the-weave").title, "Your studio is not a spreadsheet.");
    assert.deepEqual(
      chapter("welcome").actions.map((action) => [action.label, action.href]),
      [
        ["Start free trial", "/signup"],
        ["Try the demo", "/try"],
      ],
    );
    // The offer is the product's: one 30-day trial per studio, then the public price.
    assert.equal(chapter("welcome").note, "30 days free, then $27 a month per studio.");
    assert.equal(landingPageContent.close.lede, chapter("welcome").note);
    assert.match(landingPageContent.pricing.trial, /^Free for 30 days/);
    // Every moment of the day shows the real screen that handles it.
    for (const moment of chapter("features").moments) {
      assert.match(moment.shot.src, /^\/marketing\/product\/day-[a-z]+\.webp$/);
      assert.ok(moment.shot.alt.length > 40);
    }
    assert.equal(landingPageContent.tryIt.action.href, "/try");
    assert.match(landingPageContent.tryIt.miniature.caption, /Sample students/);
    assert.match(chapter("studio").caption, /Illustration with sample students/);
  });

  // A crop that keeps a screen's rounded corners has the app's backdrop baked
  // in outside them; the print's frame must round at least that far.
  it("frames each day screen inside its own rounded corners", async () => {
    for (const { shot } of chapter("features").moments) {
      const file = join(frontendRoot, "public", shot.src);
      const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
      assert.deepEqual([info.width, info.height], [shot.width, shot.height], shot.src);
      const pixel = (x, y) => data.subarray((y * info.width + x) * info.channels).subarray(0, 3);
      const differs = (a, b) => a.some((value, index) => Math.abs(value - b[index]) > 10);
      let baked = 0;
      for (const [x0, y0, dx, dy] of [
        [0, 0, 1, 1],
        [info.width - 1, 0, -1, 1],
        [info.width - 1, info.height - 1, -1, -1],
        [0, info.height - 1, 1, -1],
      ]) {
        // How far the corner's colour runs along each edge before the screen's own edge.
        for (const [stepX, stepY] of [
          [dx, 0],
          [0, dy],
        ]) {
          const edge = pixel(x0 + stepX * 90, y0 + stepY * 90);
          let run = 0;
          while (run < 90 && differs(pixel(x0 + stepX * run, y0 + stepY * run), edge)) run += 1;
          baked = Math.max(baked, run);
        }
      }
      assert.ok(
        baked <= shot.corner,
        `${shot.src}: corners run ${baked}px, framed for ${shot.corner}px`,
      );
    }
  });

  it("preserves direct destinations and states current product limits once, plainly", () => {
    assert.deepEqual(
      chapter("features").moments.map((moment) => moment.detail.href),
      [
        "/use-cases/spreadsheets-to-studio-crm",
        "/use-cases/student-retention",
        "/use-cases/trial-to-enrollment",
        "/features/student-management",
        "/features/attendance",
        "/features/belt-tracking",
        "/features/billing",
      ],
    );
    assert.deepEqual(
      chapter("features").links.map((link) => link.href),
      ["/features", "/use-cases"],
    );
    assert.equal(landingPageContent.pricing.setupAction.href, "/signup");
    assert.deepEqual(
      landingPageContent.faq.groups.map((group) => [group.id, group.items.length]),
      [
        ["faq-fit", 3],
        ["faq-daily", 3],
        ["faq-pricing", 3],
        ["faq-limits", 2],
      ],
    );
    assert.deepEqual(
      landingPageContent.close.footerLinks.map((link) => link.href),
      ["/features", "/use-cases", "#pricing", "/try", "/login", "/terms", "/privacy"],
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
    for (const section of [
      ...landingPageContent.story,
      landingPageContent.pricing,
      landingPageContent.tryIt,
      landingPageContent.close,
    ]) {
      assert.doesNotMatch(JSON.stringify(section), limitsCopy, section.id);
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
    assert.equal(landingPageContent.pricing.amount, publicPlatformPriceAmount());
    assert.equal(landingPageContent.pricing.displayPrice, formatPublicPlatformPrice());
    // The price sits in the offer, under the hero's actions and in the close.
    assert.match(chapter("welcome").note, /\$27 a month per studio/);
    assert.equal(landingPageContent.close.lede, "30 days free, then $27 a month per studio.");
    // The roster sizes all show the one price; no tiers are stored anywhere.
    assert.deepEqual(landingPageContent.pricing.rosterSizes, [25, 80, 200]);

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

  it("composes the paged story and the product page under one controller", () => {
    const landingSource = readFileSync(
      join(frontendRoot, "src/components/marketing/landing-page.tsx"),
      "utf8",
    );
    assert.match(landingSource, /<SceneTimeScript\s*\/>/);
    assert.match(landingSource, /<JourneyController>/);
    assert.match(landingSource, /<JourneyStory\s*\/>/);
    assert.match(landingSource, /<LandingPageSections\s*\/>/);
    assert.doesNotMatch(landingSource, /landing-page-legacy-content/);
    assert.equal(existsSync(join(frontendRoot, "src/lib/landing-page-legacy-content.ts")), false);
    assert.equal(existsSync(join(frontendRoot, "src/app/page.module.css")), false);
  });
});

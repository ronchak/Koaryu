import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  PUBLIC_PLATFORM_PRICE,
  publicPlatformPriceAmount,
} from "../src/lib/constants.ts";
import {
  buildMarketingDetailMetadata,
  buildMarketingDetailStructuredData,
  generateMarketingDetailStaticParams,
} from "../src/lib/marketing-detail-route-model.ts";
import {
  featurePages,
  studioTypePages,
  useCasePages,
} from "../src/lib/marketing-pages.ts";
import { publicFooterLinks, publicNavLinks } from "../src/lib/public-navigation.ts";
import { buildPublicSitemap } from "../src/lib/sitemap-model.ts";

const sourceUrl = (path) => new URL(`../src/${path}`, import.meta.url);
const readSource = (path) => readFileSync(sourceUrl(path), "utf8");
const normalizeWhitespace = (value) => value.replace(/\s+/g, " ");

const staticRoutes = [
  {
    path: "/features",
    sourcePath: "app/features/page.tsx",
    title: "Martial Arts Studio Software Features | Koaryu",
    description:
      "Explore Koaryu features for martial arts student management, belt tracking, attendance, leads, billing, and retention workflows.",
    openGraphDescription:
      "Feature pages for Koaryu's martial-arts-native studio operating system.",
  },
  {
    path: "/use-cases",
    sourcePath: "app/use-cases/page.tsx",
    title: "Martial Arts Studio Use Cases | Koaryu",
    description:
      "Practical Koaryu use cases for moving from spreadsheets, improving student retention, and running a calmer independent martial arts studio.",
    openGraphDescription:
      "Practical operating workflows for independent martial arts studios evaluating Koaryu.",
  },
  {
    path: "/explore",
    sourcePath: "app/explore/page.tsx",
    title: "Explore Koaryu | Martial Arts Studio Software Guide",
    description:
      "A quiet guide to Koaryu's feature pages, studio workflows, and fit for independent martial arts schools.",
    openGraphDescription:
      "Find the Koaryu product page, use case, or studio path that matches what you are trying to understand.",
  },
  {
    path: "/about",
    sourcePath: "app/about/page.tsx",
    title: "About Koaryu | Martial Arts Studio Software",
    description:
      "Koaryu is a flat-rate operating system for independent martial arts studios, built around students, ranks, attendance, leads, billing, and retention.",
    openGraphDescription:
      "The product philosophy behind Koaryu and its focus on independent martial arts schools.",
  },
  {
    path: "/privacy",
    sourcePath: "app/privacy/page.tsx",
    title: "Privacy Policy | Koaryu",
    description:
      "How Koaryu handles account, studio, student, and payment-adjacent data.",
    openGraphDescription:
      "How Koaryu handles account, studio, student, and payment-adjacent data.",
  },
  {
    path: "/terms",
    sourcePath: "app/terms/page.tsx",
    title: "Terms of Service | Koaryu",
    description: "Operating terms for Koaryu studio management and billing tools.",
    openGraphDescription: "Operating terms for Koaryu studio management and billing tools.",
  },
];

const detailRoutes = [
  ...featurePages,
  ...useCasePages,
  ...studioTypePages,
];

const legalContracts = [
  {
    path: "app/privacy/page.tsx",
    arrayName: "privacySections",
    navigationLabel: "Privacy policy sections",
    documentLabel: "Privacy policy",
    headings: [
      ["information-koaryu-handles", "Information Koaryu handles"],
      ["authentication-and-access", "Authentication and access"],
      ["payments", "Payments"],
      ["how-information-is-used", "How information is used"],
      ["exports-and-deletion", "Exports and deletion"],
      ["third-party-services", "Third-party services"],
      ["contact", "Contact"],
    ],
    paragraphs: [
      "Koaryu handles account information, studio settings, staff roles, students, guardians, leads, schedules, attendance, rank progress, reports, audit records, billing plans, payer records, invoices, payments, refunds, disputes, and related metadata needed to operate the product.",
      "Koaryu uses Supabase Auth for authentication and uses studio membership, role checks, backend authorization, and database policies to scope records to the correct studio. Users should protect their login credentials and studio admins should promptly remove staff who no longer need access.",
      "Stripe processes card and bank/payment method details. Koaryu stores Stripe IDs, invoice status, payment status, fee amounts, reconciliation state, and other payment metadata so studios can understand and repair billing activity without storing raw card numbers.",
      "Koaryu uses information to provide studio management features, enforce permissions, support billing workflows, troubleshoot errors, protect accounts, generate exports and reports, improve reliability, and respond to support requests.",
      "Studio admins can export many operational records from Reports. Admin-only cleanup tools can delete or replace working studio data after confirmation while preserving platform access records needed to keep Koaryu Core subscription access intact.",
      "Koaryu depends on service providers such as Supabase, Stripe, Render, and Vercel to authenticate users, store data, process payments, host the backend, and serve the frontend. Those providers may process information as needed to deliver their services.",
      "For privacy, access, export, or deletion questions, contact support@koaryu.app and include the relevant studio name and account email.",
      "Koaryu may update this privacy policy as the product, business details, data retention decisions, support process, and payment configuration evolve. Material changes should be reflected here before relying on the updated behavior in production.",
    ],
  },
  {
    path: "app/terms/page.tsx",
    arrayName: "termsSections",
    navigationLabel: "Terms of service sections",
    documentLabel: "Terms of service",
    headings: [
      ["agreement-to-these-terms", "Agreement to these terms"],
      ["accounts-and-studio-access", "Accounts and studio access"],
      ["koaryu-core-and-koaryu-payments", "Koaryu Core and Koaryu Payments"],
      ["studio-data", "Studio data"],
      ["availability-and-changes", "Availability and changes"],
      ["support", "Support"],
    ],
    paragraphs: [
      "By creating an account, accessing Koaryu, or using Koaryu to manage studio operations, you agree to use the service responsibly and only for lawful studio administration, communication, reporting, scheduling, and billing workflows.",
      "You are responsible for keeping account credentials secure, inviting only authorized staff, assigning appropriate staff roles, and promptly removing access for people who should no longer use the studio workspace. Actions taken inside a studio workspace may be recorded for operational, audit, billing, or support purposes.",
      "Koaryu Core is the studio subscription that provides access to the Koaryu software. Koaryu Payments lets an eligible connected studio charge students or payers through Stripe Connect.",
      "Studios are responsible for obtaining authorization before charging a payer or enabling autopay, keeping billing plans accurate, issuing refunds when appropriate, responding to disputes, and maintaining required Stripe Connect account information.",
      "Stripe may charge processing fees, enforce its own platform rules, request additional verification, delay payouts, or reject transactions. Koaryu stores payment metadata and Stripe object references, but Koaryu does not store raw card numbers.",
      "Studios are responsible for the accuracy, permissions, and lawful use of student, guardian, staff, schedule, attendance, rank, lead, report, and billing records entered into Koaryu. Admin-only demo reset and data-clearing tools are destructive and should be used only when replacement or deletion of working studio records is intended.",
      "Koaryu may change, improve, limit, suspend, or discontinue features as the product evolves. Service availability can be affected by maintenance, hosting providers, network conditions, browser behavior, Supabase, Stripe, or other third-party dependencies.",
      "For account, billing, or support questions, contact Koaryu at support@koaryu.app with the relevant studio name, user email, workflow, and any invoice or payment identifiers that appear in the product.",
      "Koaryu may update these terms as the product, pricing, support process, business details, and payment configuration evolve. Continued use of Koaryu after an update means the updated terms apply.",
    ],
  },
];

describe("public marketing route contract", () => {
  it("accounts for exactly 16 non-root routes and every sitemap URL", () => {
    const routes = [
      ...staticRoutes.map((route) => route.path),
      ...detailRoutes.map((page) => page.href),
    ];

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

    assert.deepEqual(
      sitemapUrls,
      routes.map((route) => `https://koaryu.app${route}`).sort()
    );
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
        pages.map((page) => ({ slug: page.slug }))
      );
    }
  });

  it("preserves all six static metadata, canonical, and Open Graph contracts", () => {
    for (const route of staticRoutes) {
      const source = normalizeWhitespace(readSource(route.sourcePath));
      const url = `https://koaryu.app${route.path}`;

      assert.ok(source.includes(`title: "${route.title}"`));
      assert.ok(source.includes(`description: "${route.description}"`));
      assert.ok(source.includes(`alternates: { canonical: "${url}" }`));
      assert.ok(source.includes(`url: "${url}"`));
      assert.ok(source.includes(`description: "${route.openGraphDescription}"`));
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

  it("keeps legal documents complete, navigable, semantic, and server rendered", () => {
    for (const contract of legalContracts) {
      const source = readSource(contract.path);
      const normalized = normalizeWhitespace(source);

      assert.match(source, new RegExp(`const ${contract.arrayName} = \\[`));
      assert.equal(source.match(/<h1\b/g)?.length, 1);
      assert.match(source, /<time[^>]+dateTime="2026-05-19"/);
      assert.ok(normalized.includes("Updated May 19, 2026"));
      assert.ok(source.includes(`aria-label="${contract.navigationLabel}"`));
      assert.ok(source.includes(`aria-label="${contract.documentLabel}"`));
      assert.match(source, /href=\{`#\$\{section\.id\}`\}/);
      assert.match(source, /id=\{section\.id\}/);
      assert.match(source, /<h2>\{section\.title\}<\/h2>/);

      for (const [id, heading] of contract.headings) {
        assert.ok(source.includes(`id: "${id}"`));
        assert.ok(source.includes(`title: "${heading}"`));
      }
      for (const paragraph of contract.paragraphs) {
        assert.ok(normalized.includes(paragraph), `missing legal text: ${paragraph}`);
      }

      assert.doesNotMatch(
        source,
        /["']use client["']|use(?:State|Effect|Ref)\s*\(|\b(?:window|document|navigator)\s*\.|onWheel|onTouch|preventDefault|AccountPageShell|AccountSection|AccountNotice/
      );
    }
  });

  it("derives public price data and preserves the provider-write caveat", () => {
    const featuresSource = readSource("app/features/page.tsx");
    assert.match(featuresSource, /price:\s*publicPlatformPriceAmount\(\)/);
    assert.match(featuresSource, /priceCurrency:\s*PUBLIC_PLATFORM_PRICE\.currency/);
    assert.doesNotMatch(featuresSource, /\$27|2700|["']27["']/);
    assert.equal(publicPlatformPriceAmount(), "27");
    assert.equal(PUBLIC_PLATFORM_PRICE.currency, "USD");

    const billingPage = featurePages.find((page) => page.slug === "billing");
    assert.ok(billingPage);
    assert.ok(
      billingPage.sections
        .flatMap((section) => section.bullets)
        .includes(
          "Plan, payer, autopay, invoice-lifecycle, refund, and Connect changes are currently unavailable"
        )
    );
    assert.deepEqual(
      billingPage.proof.find((item) => item.label === "Provider writes"),
      { label: "Provider writes", value: "Disabled", detail: "Currently unavailable" }
    );
  });

  it("preserves navigation and prefetch boundaries without inventing routes", () => {
    assert.deepEqual(publicNavLinks.map((link) => link.href), [
      "/features",
      "/use-cases",
      "/explore",
      "/#pricing",
      "/about",
    ]);
    assert.deepEqual(publicFooterLinks.map((link) => link.href), [
      "/explore",
      "/features",
      "/use-cases",
      "/about",
      "/terms",
      "/privacy",
    ]);
    assert.equal(
      [...publicNavLinks, ...publicFooterLinks].some((link) => link.href === "/pricing"),
      false
    );

    const shellSource = readSource("components/marketing/public-pages.tsx");
    assert.equal(shellSource.match(/href="\/login"\s+prefetch=\{false\}/g)?.length, 2);
    assert.match(shellSource, /prefetch=\{ctaHref === "\/signup" \? false : undefined\}/);
    assert.match(shellSource, /prefetch=\{step\.href === "\/signup" \? false : undefined\}/);
  });

  it("retires the legacy seam and keeps conventional public sources on paper tokens", () => {
    assert.equal(existsSync(sourceUrl("components/marketing/product-scene.tsx")), false);

    const sourcePaths = [
      ...staticRoutes.map((route) => route.sourcePath),
      "app/features/[slug]/page.tsx",
      "app/use-cases/[slug]/page.tsx",
      "app/studio-types/[slug]/page.tsx",
      "components/marketing/public-pages.tsx",
      "components/marketing/public-pages.module.css",
      "lib/marketing-detail-route.tsx",
      "lib/marketing-detail-route-configs.ts",
      "lib/marketing-detail-route-model.ts",
      "lib/marketing-pages.ts",
      "lib/public-navigation.ts",
      "lib/sitemap-model.ts",
    ];
    const publicSource = sourcePaths.map(readSource).join("\n");

    assert.doesNotMatch(
      publicSource,
      /ProductScene|product-scene|dotGrid|accentStripe|accent-glow|iconMap|ScrollReveal|AccountPageShell|LogoLink|MobileNav|@\/components\/ui\/|\bButton\b/
    );
    assert.doesNotMatch(
      publicSource,
      /(?:bg-bg|bg-surface|text-text|border-border|text-accent)|var\(--(?:bg|surface|border|text-[\w-]+|accent)\b/
    );
    assert.doesNotMatch(
      publicSource,
      /["']use client["']|\b(?:window|document|navigator)\s*\.|onWheel|onTouch|preventDefault/
    );
    assert.doesNotMatch(publicSource, /\$27|2700|["']27["']/);
  });

  it("keeps opaque legal reading surfaces, target sizes, breakpoints, and fibre order", () => {
    const css = readSource("components/marketing/public-pages.module.css");
    const legalStart = css.indexOf(".legalHero {");
    const legalCss = css.slice(legalStart, css.indexOf(".footer {", legalStart));

    assert.match(legalCss, /\.legalDocument\s*\{[^}]*max-width:\s*68ch/s);
    assert.match(legalCss, /\.legalBody p\s*\{[^}]*line-height:\s*1\.75;[^}]*opacity:\s*0\.78/s);
    assert.match(legalCss, /\.legalSectionNavigation a\s*\{[^}]*min-height:\s*44px/s);
    assert.match(legalCss, /\.legalSectionNavigation\s*\{[^}]*position:\s*sticky;[^}]*top:\s*32px/s);
    assert.match(legalCss, /\.legalSection\s*\{[^}]*scroll-margin-top:\s*32px/s);
    assert.match(legalCss, /\.legalNotice\s*\{[^}]*background:\s*var\(--koaryu-sheet\)/s);
    assert.doesNotMatch(legalCss, /gradient|backdrop|glass|position:\s*fixed|100dvh|overflow:\s*hidden|#[fF]{6}|#[0]{6}/i);
    for (const breakpoint of ["1000px", "820px", "560px"]) {
      assert.match(css, new RegExp(`@media \\(max-width: ${breakpoint}\\)`));
    }

    assert.match(css, /\.header\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*10/s);
    assert.doesNotMatch(css, /\.header\s*\{[^}]*position:\s*(?:sticky|fixed)/s);
    assert.match(css, /\.main,\s*\n\.footer\s*\{[^}]*z-index:\s*0/s);
    assert.doesNotMatch(css, /\.(?:main|footer)[^{]*\{[^}]*z-index:\s*(?:2[0-9]|[3-9][0-9])/s);
  });
});

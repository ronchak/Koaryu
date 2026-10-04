import { landingPageContent } from "../../../lib/landing-page-content.ts";

/** Every section, film moment and FAQ topic on the page that a link may target. */
export const LANDING_TARGETS: ReadonlySet<string> = new Set([
  landingPageContent.hero.id,
  ...landingPageContent.titles.map((title) => title.id),
  landingPageContent.handoff.id,
  landingPageContent.product.id,
  landingPageContent.day.id,
  landingPageContent.pricing.id,
  landingPageContent.faq.id,
  landingPageContent.finale.id,
  ...landingPageContent.faq.groups.map((group) => group.id),
]);

/**
 * Hashes from earlier versions of the landing page, mapped to the section that
 * now carries the same content, so shared links keep working.
 */
export const LANDING_HASH_ALIASES = Object.freeze({
  "studio-view": "product",
  "use-cases": "features",
  "signals-gather": "features",
  explore: "features",
  "class-ready": "studio",
  about: "faq",
  stillness: "begin",
  "faq-switching": "faq-fit",
  "faq-data": "faq-daily",
  "faq-roadmap": "faq-limits",
  "student-path": "the-path",
  "daily-flow": "features",
  "studio-signal": "features",
  "why-koaryu": "pricing",
  operations: "faq",
  privacy: "faq",
  "data-control": "faq",
  "doors-open": "the-path",
  workflow: "features",
  "patterns-form": "features",
  "floor-forms": "studio",
  "operations-trust": "faq",
} as const satisfies Readonly<Record<string, string>>);

/** Returns the current target for a retired hash, or null when no rewrite is needed. */
export function resolveLegacyHash(hash: string): string | null {
  const id = hash.replace(/^#/, "");
  if (!id || LANDING_TARGETS.has(id)) return null;
  return (LANDING_HASH_ALIASES as Readonly<Record<string, string>>)[id] ?? null;
}

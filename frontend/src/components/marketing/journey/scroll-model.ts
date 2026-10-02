import { landingPageContent } from "../../../lib/landing-page-content.ts";

/** A scroll position at which the scene shows a chapter's progress. */
export interface SceneAnchor {
  readonly scrollY: number;
  readonly scene: number;
}

const FAQ_GROUP_IDS: readonly string[] = landingPageContent.chapters.flatMap((chapter) =>
  chapter.kind === "faq" ? chapter.groups.map((group) => group.id) : [],
);

const LANDING_TARGETS: ReadonlySet<string> = new Set([
  ...landingPageContent.chapters.map(({ id }) => id),
  ...FAQ_GROUP_IDS,
]);

/**
 * Hashes from earlier versions of the landing page, mapped to the section that
 * now carries the same content. Shared links keep working.
 */
export const LANDING_HASH_ALIASES = Object.freeze({
  "studio-view": "product",
  "use-cases": "features",
  "signals-gather": "features",
  explore: "features",
  "class-ready": "features",
  about: "faq",
  stillness: "begin",
  "faq-switching": "faq-fit",
  "faq-data": "faq-daily",
  "faq-roadmap": "faq-limits",
  "student-path": "features",
  "daily-flow": "features",
  "studio-signal": "features",
  "why-koaryu": "pricing",
  operations: "faq",
  privacy: "faq",
  "data-control": "faq",
  "doors-open": "features",
  workflow: "features",
  "patterns-form": "features",
  "floor-forms": "features",
  "operations-trust": "faq",
} as const satisfies Readonly<Record<string, string>>);

/** Returns the current target for a retired hash, or null when no rewrite is needed. */
export function resolveLegacyHash(hash: string): string | null {
  const id = hash.replace(/^#/, "");
  if (!id || LANDING_TARGETS.has(id)) return null;
  return (LANDING_HASH_ALIASES as Readonly<Record<string, string>>)[id] ?? null;
}

/** Interpolates scene progress between the chapters on either side of the scroll position. */
export function progressForScroll(scrollY: number, anchors: readonly SceneAnchor[]): number {
  const first = anchors[0];
  if (!first) return 0;
  if (scrollY <= first.scrollY) return first.scene;
  for (let index = 1; index < anchors.length; index += 1) {
    const next = anchors[index]!;
    if (scrollY <= next.scrollY) {
      // Short closing chapters can share the bottom of the page; the last one wins.
      if (scrollY === next.scrollY) {
        let last = index;
        while (anchors[last + 1]?.scrollY === scrollY) last += 1;
        return anchors[last]!.scene;
      }
      const previous = anchors[index - 1]!;
      const span = next.scrollY - previous.scrollY;
      const fraction = span > 0 ? (scrollY - previous.scrollY) / span : 1;
      return previous.scene + (next.scene - previous.scene) * fraction;
    }
  }
  return anchors[anchors.length - 1]!.scene;
}

/** Reduced motion shows each chapter's still frame instead of scrubbing between them. */
export function nearestAnchorScene(scrollY: number, anchors: readonly SceneAnchor[]): number {
  let nearest = anchors[0];
  for (const anchor of anchors) {
    if (!nearest || Math.abs(anchor.scrollY - scrollY) < Math.abs(nearest.scrollY - scrollY)) {
      nearest = anchor;
    }
  }
  return nearest?.scene ?? 0;
}

/**
 * Each chapter's anchor is the scroll position that centers it in the viewport.
 * Anchors are clamped to the scrollable range and kept increasing.
 */
export function anchorsForLayout(
  chapters: readonly { readonly top: number; readonly height: number; readonly scene: number }[],
  viewportHeight: number,
  maxScroll: number,
): SceneAnchor[] {
  const anchors: SceneAnchor[] = [];
  for (const chapter of chapters) {
    const centered = chapter.top + chapter.height / 2 - viewportHeight / 2;
    const previous = anchors[anchors.length - 1]?.scrollY ?? -Infinity;
    const scrollY = Math.max(previous, Math.min(maxScroll, Math.max(0, centered)));
    anchors.push({ scrollY, scene: chapter.scene });
  }
  return anchors;
}

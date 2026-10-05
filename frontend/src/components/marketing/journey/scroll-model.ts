import { landingPageContent } from "../../../lib/landing-page-content.ts";

/** A scroll position and the scene progress shown there; the scene interpolates between them. */
export interface SceneKeyframe {
  readonly scrollY: number;
  readonly scene: number;
}

const FAQ_GROUP_IDS: readonly string[] = landingPageContent.faq.groups.map(({ id }) => id);

/** Every id on the landing page a link can land on. */
export const LANDING_TARGETS: ReadonlySet<string> = new Set([
  ...landingPageContent.story.map(({ id }) => id),
  landingPageContent.pricing.id,
  landingPageContent.tryIt.id,
  landingPageContent.faq.id,
  landingPageContent.close.id,
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
  "class-ready": "studio",
  about: "faq",
  stillness: "studio",
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
  "patterns-form": "the-weave",
  "floor-forms": "the-weave",
  "operations-trust": "faq",
} as const satisfies Readonly<Record<string, string>>);

/** Returns the current target for a retired hash, or null when no rewrite is needed. */
export function resolveLegacyHash(hash: string): string | null {
  const id = hash.replace(/^#/, "");
  if (!id || LANDING_TARGETS.has(id)) return null;
  return (LANDING_HASH_ALIASES as Readonly<Record<string, string>>)[id] ?? null;
}

/** Interpolates scene progress between the keyframes on either side of the scroll position. */
export function progressForScroll(scrollY: number, keyframes: readonly SceneKeyframe[]): number {
  const first = keyframes[0];
  if (!first) return 0;
  if (scrollY <= first.scrollY) return first.scene;
  for (let index = 1; index < keyframes.length; index += 1) {
    const next = keyframes[index]!;
    if (scrollY <= next.scrollY) {
      // Keyframes can share a position; the last one there wins.
      if (scrollY === next.scrollY) {
        let last = index;
        while (keyframes[last + 1]?.scrollY === scrollY) last += 1;
        return keyframes[last]!.scene;
      }
      const previous = keyframes[index - 1]!;
      const span = next.scrollY - previous.scrollY;
      const fraction = span > 0 ? (scrollY - previous.scrollY) / span : 1;
      return previous.scene + (next.scene - previous.scene) * fraction;
    }
  }
  return keyframes[keyframes.length - 1]!.scene;
}

export type MastheadTone = "light" | "dark";

/**
 * Scene progress over which the top edge of the artwork is dark: inside the
 * hill, then under the dojo ceiling. Wide frames leave the ceiling sooner than
 * tall ones, which keep more of it in view.
 */
export const DARK_TOP_START = 0.08;
export const DARK_TOP_END = Object.freeze({ wide: 0.385, tall: 0.575 });

/**
 * The masthead takes the tone of the artwork beneath it, so it reads as part of
 * the scene. `viewBoxHeight` runs from 1000 (wide screens) to 2000 (phones).
 */
export function mastheadTone(progress: number, viewBoxHeight: number): MastheadTone {
  const tallness = Math.min(1, Math.max(0, (viewBoxHeight - 1000) / 1000));
  const end = DARK_TOP_END.wide + (DARK_TOP_END.tall - DARK_TOP_END.wide) * tallness;
  return progress >= DARK_TOP_START && progress <= end ? "dark" : "light";
}

/** Reduced motion shows only chapter still frames, switching at each transition's midpoint. */
export function stillFrame(progress: number, scenes: readonly number[]): number {
  let nearest = scenes[0] ?? 0;
  for (const scene of scenes) {
    if (Math.abs(scene - progress) < Math.abs(nearest - progress)) nearest = scene;
  }
  return nearest;
}

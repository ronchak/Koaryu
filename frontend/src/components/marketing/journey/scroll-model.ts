import { landingPageContent } from "../../../lib/landing-page-content.ts";

/** A scroll position and the scene progress shown there; the scene interpolates between them. */
export interface SceneKeyframe {
  readonly scrollY: number;
  readonly scene: number;
}

/**
 * A transition plays while the gap between two chapters crosses the middle
 * of the screen: from when the gap's center is this far down the viewport...
 */
export const TRANSITION_START = 0.85;
/** ...until it is this far down. Outside these windows the scene holds still. */
export const TRANSITION_END = 0.15;

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

/** Interpolates scene progress between the keyframes on either side of the scroll position. */
export function progressForScroll(scrollY: number, keyframes: readonly SceneKeyframe[]): number {
  const first = keyframes[0];
  if (!first) return 0;
  if (scrollY <= first.scrollY) return first.scene;
  for (let index = 1; index < keyframes.length; index += 1) {
    const next = keyframes[index]!;
    if (scrollY <= next.scrollY) {
      // Short closing chapters can share the bottom of the page; the last one wins.
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

/** Reduced motion shows only chapter still frames, switching at each transition's midpoint. */
export function stillFrame(progress: number, scenes: readonly number[]): number {
  let nearest = scenes[0] ?? 0;
  for (const scene of scenes) {
    if (Math.abs(scene - progress) < Math.abs(nearest - progress)) nearest = scene;
  }
  return nearest;
}

export interface ChapterLayout {
  /** Scene progress held while the chapter is read. */
  readonly scene: number;
  /**
   * Document position of the center of the gap after this chapter: the middle
   * of its interlude, or the next chapter's top edge when there is none.
   */
  readonly gapCenter: number;
}

/**
 * Builds keyframes that hold each chapter's scene while it is read and move
 * the story only while the gap to the next chapter crosses the viewport.
 * Keyframes are clamped to the scrollable range and never decrease.
 */
export function keyframesForLayout(
  chapters: readonly ChapterLayout[],
  viewportHeight: number,
  maxScroll: number,
): SceneKeyframe[] {
  const keyframes: SceneKeyframe[] = [];
  const push = (scrollY: number, scene: number) => {
    const previous = keyframes[keyframes.length - 1]?.scrollY ?? 0;
    keyframes.push({
      scrollY: Math.max(previous, Math.min(maxScroll, Math.max(0, scrollY))),
      scene,
    });
  };
  const first = chapters[0];
  if (!first) return keyframes;
  push(0, first.scene);
  for (let index = 0; index < chapters.length - 1; index += 1) {
    const chapter = chapters[index]!;
    const next = chapters[index + 1]!;
    push(chapter.gapCenter - viewportHeight * TRANSITION_START, chapter.scene);
    push(chapter.gapCenter - viewportHeight * TRANSITION_END, next.scene);
  }
  return keyframes;
}

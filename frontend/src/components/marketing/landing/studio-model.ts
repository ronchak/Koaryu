/**
 * Where, through the studio's scroll, each student is marked present, and where
 * the class settles into its result. The shoji doors open before the first mark.
 */
export const STUDIO_MARKS = [0.34, 0.43, 0.52, 0.61, 0.7] as const;
export const STUDIO_READY = 0.78;
/** The step at which every student is marked and the result is shown. */
export const STUDIO_FINISHED = STUDIO_MARKS.length + 1;

/** How many beats of the class have happened at this point (0 to 1) in the section. */
export function studioStep(progress: number): number {
  const marked = STUDIO_MARKS.filter((mark) => progress >= mark).length;
  return marked + (progress >= STUDIO_READY ? 1 : 0);
}

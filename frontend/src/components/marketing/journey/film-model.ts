/**
 * Act one of the landing page is a film: the illustrated story pinned to the
 * screen and scrubbed by native scrolling. Positions are measured in screen
 * heights of scroll from the top of the film, so the pacing is the same on a
 * phone and a desktop. Everything here is pure, so it is tested directly.
 */

/** One stretch of the film: how long it lasts and the scene progress it ends on. */
export interface FilmSegment {
  readonly name: string;
  readonly length: number;
  readonly scene: number;
}

/**
 * The story beat by beat. Holds (the scene stays put) are short and carry a
 * title or a breath; the transitions get the scroll. The second half (door,
 * sky, weave, floor, room, class) is the heart of the film and gets the most.
 */
export const FILM_SEGMENTS: readonly FilmSegment[] = Object.freeze([
  { name: "hills", length: 0.3, scene: 0 },
  { name: "dive", length: 0.6, scene: 0.1 },
  { name: "curtain", length: 0.5, scene: 0.1 },
  { name: "dojo", length: 0.6, scene: 0.288 },
  { name: "dojo-hold", length: 0.1, scene: 0.288 },
  { name: "door", length: 0.72, scene: 0.52 },
  { name: "doorway-hold", length: 0.12, scene: 0.52 },
  { name: "through", length: 0.66, scene: 0.66 },
  { name: "sky", length: 0.36, scene: 0.66 },
  { name: "clouds", length: 0.56, scene: 0.802 },
  { name: "weave", length: 0.72, scene: 0.892 },
  { name: "mat-hold", length: 0.12, scene: 0.892 },
  { name: "room", length: 0.5, scene: 0.952 },
  { name: "class", length: 0.46, scene: 1 },
  { name: "class-hold", length: 0.3, scene: 1 },
  { name: "handoff", length: 0.72, scene: 1 },
]);

export interface FilmKeyframe {
  /** Screen heights of scroll from the start of the film. */
  readonly at: number;
  readonly scene: number;
}

function buildKeyframes(segments: readonly FilmSegment[]): FilmKeyframe[] {
  const keyframes: FilmKeyframe[] = [{ at: 0, scene: segments[0]?.scene ?? 0 }];
  let at = 0;
  for (const segment of segments) {
    at = round4(at + segment.length);
    keyframes.push({ at, scene: segment.scene });
  }
  return keyframes;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export const FILM_KEYFRAMES: readonly FilmKeyframe[] = Object.freeze(buildKeyframes(FILM_SEGMENTS));

/** Total scroll through the film, in screen heights. */
export const FILM_LENGTH = FILM_KEYFRAMES[FILM_KEYFRAMES.length - 1]!.at;

/** Where a named segment starts and ends. */
export function segmentRange(name: string): readonly [number, number] {
  let at = 0;
  for (const segment of FILM_SEGMENTS) {
    if (segment.name === name) return [at, round4(at + segment.length)];
    at = round4(at + segment.length);
  }
  throw new Error(`Unknown film segment: ${name}`);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : Number.isNaN(value) ? 0 : value;
}

function smooth(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

/** Scene progress (0 hills to 1 seated class) at a film position. */
export function sceneAt(at: number, keyframes: readonly FilmKeyframe[] = FILM_KEYFRAMES): number {
  const first = keyframes[0];
  if (!first) return 0;
  if (at <= first.at) return first.scene;
  for (let index = 1; index < keyframes.length; index += 1) {
    const next = keyframes[index]!;
    if (at <= next.at) {
      const previous = keyframes[index - 1]!;
      const span = next.at - previous.at;
      const fraction = span > 0 ? (at - previous.at) / span : 1;
      return previous.scene + (next.scene - previous.scene) * fraction;
    }
  }
  return keyframes[keyframes.length - 1]!.scene;
}

/**
 * A title card's timing: it fades and rises in across `enter`, and drifts up
 * and fades out across `exit`. A missing enter means it is on screen from the
 * start; a missing exit means it stays until the film releases it.
 */
export interface TitleCue {
  readonly enter: readonly [number, number] | null;
  readonly exit: readonly [number, number] | null;
}

const [, curtainEnd] = segmentRange("curtain");
const [skyStart, skyEnd] = segmentRange("sky");
const [classStart] = segmentRange("class");
const [handoffStart, handoffEnd] = segmentRange("handoff");

export const TITLE_CUES = Object.freeze({
  /** The hero copy drifts up and away as the camera starts its dive. */
  welcome: { enter: null, exit: [0.06, 0.46] },
  /** On the closed curtain. */
  "the-problem": { enter: [0.74, 0.96], exit: [curtainEnd - 0.12, curtainEnd + 0.04] },
  /** In the open sky, after flying through the door; gone before the clouds gather. */
  "the-path": { enter: [skyStart - 0.16, skyStart + 0.06], exit: [skyEnd - 0.08, skyEnd + 0.12] },
  /** On the wall above the class as it sits, staying into the page. */
  studio: { enter: [classStart + 0.1, classStart + 0.38], exit: null },
  /** The rest of the hand-off copy arrives as the picture settles. */
  "studio-detail": { enter: [handoffStart + 0.5, handoffEnd - 0.02], exit: null },
} as const satisfies Readonly<Record<string, TitleCue>>);

export type TitleCueId = keyof typeof TITLE_CUES;

/** The first and last film positions a cue is on screen; its pinned layer spans these. */
export function cueSpan(cue: TitleCue): readonly [number, number] {
  return [cue.enter ? cue.enter[0] : 0, cue.exit ? cue.exit[1] : FILM_LENGTH];
}

/** Opacity and vertical drift (-1 above, 0 in place, 1 below) of a title at a film position. */
export function cueState(cue: TitleCue, at: number): { opacity: number; shift: number } {
  if (cue.enter && at < cue.enter[1]) {
    const t = smooth((at - cue.enter[0]) / (cue.enter[1] - cue.enter[0]));
    return { opacity: t, shift: 1 - t };
  }
  if (cue.exit && at > cue.exit[0]) {
    const t = smooth((at - cue.exit[0]) / (cue.exit[1] - cue.exit[0]));
    return { opacity: 1 - t, shift: -t };
  }
  return { opacity: 1, shift: 0 };
}

/** How far the closing frame has settled into the page as a framed picture (0 to 1). */
export function handoffAt(at: number): number {
  const t = clamp01((at - handoffStart) / (handoffEnd - handoffStart));
  // Ease in and out so the picture starts softly and lands softly.
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Film position for a scroll offset, given where the film starts and the screen height. */
export function filmPosition(scrollY: number, filmTop: number, screen: number): number {
  if (!(screen > 0)) return 0;
  const at = (scrollY - filmTop) / screen;
  return at < 0 ? 0 : at > FILM_LENGTH ? FILM_LENGTH : at;
}

/** Where each linkable moment of the film is held, so a link lands on a composed frame. */
export const FILM_ANCHORS = Object.freeze({
  welcome: 0,
  "the-problem": round4(
    (TITLE_CUES["the-problem"].enter[1] + TITLE_CUES["the-problem"].exit[0]) / 2,
  ),
  "the-path": round4(skyStart + 0.06),
  studio: handoffEnd,
} as const satisfies Readonly<Record<string, number>>);

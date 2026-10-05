/**
 * The weave, in cut paper. The clouds flatten into streaks and lie down as the
 * studio's seven labelled strips (warp); kraft strips are threaded up through
 * them, over and under, until they are one mat. Then the mat lies down into
 * the room, the wall stands up behind it and the room's floor is laid over it,
 * far to near. Pure geometry and timing in scene coordinates (the same viewBox
 * as the journey scene), driven by scene progress so it plays when paged and
 * scrubs when scrolled. Unit tested.
 */

import {
  FLOOR_FAR,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  clamp,
  easeInOut,
  easeOut,
  frameForDimensions,
  mix,
  mulberry32,
  rangeProgress,
  round2,
  smoothPath,
  type ScenePoint,
} from "./scene-model.ts";

/** Scene progress at which each part of the loom plays. */
export const LOOM_PHASES = Object.freeze({
  /** The sky wash settles over the flattened clouds before the scene's own morph begins. */
  enter: Object.freeze([0.752, 0.792] as const),
  /** The strips slide in as cloud streaks, then lie down and straighten, one after another. */
  warp: Object.freeze([0.756, 0.83] as const),
  /** The backing card slides up behind the landed strips. */
  ground: Object.freeze([0.818, 0.836] as const),
  /** The names are printed on the strips once they have landed. */
  labels: Object.freeze([0.806, 0.846] as const),
  /** Kraft strips are threaded up through the warp, over and under. */
  weft: Object.freeze([0.83, 0.886] as const),
  /** The finished mat lies down into the room... */
  lie: Object.freeze([0.892, 0.926] as const),
  /** ...the wall stands up behind it... */
  wall: Object.freeze([0.9, 0.934] as const),
  /** ...and the floor is laid over the mat, from the far wall toward the camera. */
  floor: Object.freeze([0.93, 0.958] as const),
});

/** Where the room's floor meets its far wall once the room has risen (the scene's horizon is 330). */
export const ROOM_FLOOR_LINE = 330 + FLOOR_FAR;

export const WARP_TONES = 4;
export const WEFT_TONES = 4;

/** Points along a strip's long edges; between them the scissors run straight. */
const WARP_CUTS = 14;
const WEFT_CUTS = 9;

export interface LoomWarp {
  readonly y: number;
  readonly thickness: number;
  readonly tone: number;
  readonly label: string;
  readonly labelX: number;
  readonly labelWidth: number;
  /** Where the strip starts, high in the sky, before it lies down. */
  readonly lift: number;
  readonly phase: number;
  /** The side of the screen it is pulled in from. */
  readonly side: -1 | 1;
  /** Hand-cut wobble of the top and bottom edges, in scene units, at each cut point. */
  readonly cutTop: readonly number[];
  readonly cutBottom: readonly number[];
}

export interface LoomWeft {
  readonly x: number;
  readonly width: number;
  readonly tone: number;
  /** Fraction of the weft phase before this strip starts. */
  readonly delay: number;
  /** Rise of the slanted cut at its top end, from its left corner to its right. */
  readonly slant: number;
  readonly cutLeft: readonly number[];
  readonly cutRight: readonly number[];
}

export interface LoomLayout {
  readonly viewBox: string;
  readonly visible: { left: number; right: number; top: number; bottom: number };
  readonly portrait: boolean;
  readonly matTop: number;
  readonly matBottom: number;
  readonly fontSize: number;
  /** Offset of a strip's shadow on what lies beneath it. */
  readonly shadow: number;
  readonly warps: readonly LoomWarp[];
  readonly wefts: readonly LoomWeft[];
  /** over[warp][weft]: the warp strip passes over the weft at this crossing. */
  readonly over: readonly (readonly boolean[])[];
  /** The tops of the kraft strips, a little proud of the first warp. */
  readonly weftTop: number;
  /** How far a kraft strip travels to come up from below the screen. */
  readonly weftTravel: number;
  readonly weftPitch: number;
  /** The mat's top edge and the room's floor line, as fractions of the screen height. */
  readonly matTopFraction: number;
  readonly floorFraction: number;
}

const LABEL_SPOTS = Object.freeze({
  landscape: [0.1, 0.5, 0.24, 0.6, 0.06, 0.38, 0.16],
  portrait: [0.07, 0.34, 0.14, 0.4, 0.05, 0.26, 0.1],
});

/** Visible rectangle of the scene for a viewport, in scene coordinates. */
export function visibleSceneRect(width: number, height: number) {
  const frame = frameForDimensions(width, height);
  const [, top, , viewHeight] = frame.viewBox.split(" ").map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const aspect = width > 0 && height > 0 ? width / height : SCENE_WIDTH / SCENE_HEIGHT;
  const visibleHeight = Math.min(viewHeight, SCENE_WIDTH / aspect);
  const centerY = top + viewHeight / 2;
  return {
    frame,
    left: SCENE_WIDTH / 2 - frame.visibleHalfWidth,
    right: SCENE_WIDTH / 2 + frame.visibleHalfWidth,
    top: centerY - visibleHeight / 2,
    bottom: centerY + visibleHeight / 2,
  };
}

/** Small, seeded wobbles: the strips are cut by hand, never ruled. */
function cuts(random: () => number, count: number, amplitude: number): number[] {
  return Array.from({ length: count + 1 }, () => round2((random() * 2 - 1) * amplitude));
}

export function loomLayout(width: number, height: number, threads: readonly string[]): LoomLayout {
  const visible = visibleSceneRect(width, height);
  const visibleWidth = visible.right - visible.left;
  const visibleHeight = visible.bottom - visible.top;
  const portrait = visibleWidth < visibleHeight;
  const count = Math.max(1, threads.length);
  const matTop = visible.top + visibleHeight * (portrait ? 0.5 : 0.47);
  // The last strip runs off the bottom edge, so the mat reads as continuing.
  const pitch = (visible.bottom - matTop) / (count - 0.15);
  const thickness = pitch * 0.82;
  const fontSize = round2(Math.min(thickness * 0.38, portrait ? 46 : 28));
  const spots = portrait ? LABEL_SPOTS.portrait : LABEL_SPOTS.landscape;
  const wobble = thickness * 0.03;
  const random = mulberry32(4127);

  const warps: LoomWarp[] = threads.map((label, index) => {
    const labelWidth = round2(label.length * fontSize * 0.56 + fontSize * 1.6);
    const spot = spots[index % spots.length]!;
    const labelX = round2(
      Math.min(
        visible.right - labelWidth - visibleWidth * 0.08,
        visible.left + visibleWidth * spot,
      ),
    );
    return {
      y: round2(matTop + index * pitch + (pitch - thickness) / 2),
      thickness: round2(thickness),
      tone: (index * 3 + 1) % WARP_TONES,
      label,
      labelX,
      labelWidth,
      lift: round2(visibleHeight * (0.3 + 0.06 * ((index * 5) % 7))),
      phase: round2(index * 1.9 + 0.6),
      side: index % 2 === 0 ? -1 : 1,
      cutTop: cuts(random, WARP_CUTS, wobble),
      cutBottom: cuts(random, WARP_CUTS, wobble),
    };
  });

  const weftWidth = thickness * (portrait ? 0.86 : 0.96);
  const weftPitch = weftWidth + (pitch - thickness);
  const firstX = visible.left - weftPitch * 0.6;
  const weftCount = Math.ceil((visible.right + weftPitch - firstX) / weftPitch);
  const wefts: LoomWeft[] = Array.from({ length: weftCount }, (_, index) => {
    const jitter = (random() - 0.5) * 0.08;
    return {
      x: round2(firstX + index * weftPitch),
      width: round2(weftWidth),
      tone: (index * 7 + 2) % WEFT_TONES,
      delay: round2(clamp((index / Math.max(1, weftCount - 1)) * 0.6 + jitter, 0, 0.62)),
      slant: round2((random() * 2 - 1) * weftWidth * 0.12),
      cutLeft: cuts(random, WEFT_CUTS, wobble),
      cutRight: cuts(random, WEFT_CUTS, wobble),
    };
  });

  // Plain weave, except where a name is printed: there the strip floats over
  // the weft so the word stays whole.
  const over = warps.map((warp, row) =>
    wefts.map((weft, column) => {
      const pad = fontSize * 0.4;
      const underLabel =
        weft.x + weft.width > warp.labelX - pad && weft.x < warp.labelX + warp.labelWidth + pad;
      return underLabel || (row + column) % 2 === 0;
    }),
  );

  const weftTop = matTop - (pitch - thickness) * 0.5 - thickness * 0.3;
  const matBottom = visible.bottom + pitch;
  return {
    viewBox: visible.frame.viewBox,
    visible: {
      left: round2(visible.left),
      right: round2(visible.right),
      top: round2(visible.top),
      bottom: round2(visible.bottom),
    },
    portrait,
    matTop: round2(matTop),
    matBottom: round2(matBottom),
    fontSize,
    shadow: round2(Math.max(3, thickness * 0.07)),
    warps,
    wefts,
    over,
    weftTop: round2(weftTop),
    weftTravel: round2(visible.bottom - weftTop + weftWidth),
    weftPitch: round2(weftPitch),
    matTopFraction: round2((matTop - visible.top) / visibleHeight),
    floorFraction: round2((ROOM_FLOOR_LINE - visible.top) / visibleHeight),
  };
}

/**
 * Outline of a warp strip: a thin, wavy streak lifted like a cloud at 0, a
 * straight hand-cut strip at 1. The outline at 1 is exact, so crossings can
 * redraw the strip over a weft without a seam.
 */
export function warpPath(layout: LoomLayout, warp: LoomWarp, settle: number): string {
  const s = clamp(settle);
  const left = layout.visible.left - 80;
  const right = layout.visible.right + 80;
  const thickness = warp.thickness * mix(0.34, 1, s);
  const amplitude = warp.thickness * 0.5 * (1 - s);
  const baseY = warp.y - warp.lift * (1 - s);
  const top: ScenePoint[] = [];
  const bottom: ScenePoint[] = [];
  for (let index = 0; index <= WARP_CUTS; index += 1) {
    const x = mix(left, right, index / WARP_CUTS);
    const wave = Math.sin(x * 0.0046 + warp.phase) * amplitude;
    // A cloud streak is fuller in the middle and tapers at its ends.
    const swell = mix(Math.sin((index / WARP_CUTS) * Math.PI) * 0.7 + 0.3, 1, s);
    const inset = (thickness * (1 - swell)) / 2;
    top.push({ x, y: baseY + wave + inset + (warp.cutTop[index] ?? 0) * s });
    bottom.push({
      x,
      y: baseY + wave + thickness - inset + (warp.cutBottom[index] ?? 0) * s,
    });
  }
  return smoothPath([...top, ...bottom.reverse()], true, s >= 1 ? 0 : mix(0.9, 0, s));
}

/** Outline of a kraft strip at rest: hand-cut sides, a slanted cut across its top end. */
export function weftPath(layout: LoomLayout, weft: LoomWeft): string {
  const top = layout.weftTop;
  const bottom = layout.matBottom + 40;
  const left: ScenePoint[] = [];
  const right: ScenePoint[] = [];
  for (let index = 0; index <= WEFT_CUTS; index += 1) {
    const y = mix(top, bottom, index / WEFT_CUTS);
    const slant = index === 0 ? weft.slant / 2 : 0;
    left.push({ x: weft.x + (weft.cutLeft[index] ?? 0), y: y + slant });
    right.push({ x: weft.x + weft.width + (weft.cutRight[index] ?? 0), y: y - slant });
  }
  const points = [...left.reverse(), ...right];
  return `M${points.map(({ x, y }) => `${round2(x)} ${round2(y)}`).join("L")}Z`;
}

export interface LoomWarpFrame {
  /** Horizontal offset while the strip is pulled in from its side, in scene units. */
  readonly slide: number;
  readonly settle: number;
  /** Opacity of the cloud colour over the strip's own. */
  readonly cloud: number;
  /** Offset of the strip's shadow: long while it floats, short once it lies on the backing. */
  readonly shadow: number;
}

export interface LoomFrame {
  readonly visible: boolean;
  /** Opacity of the sky wash that hides the scene beneath. */
  readonly wash: number;
  /** How far the backing card has slid up behind the landed strips, 0 to 1. */
  readonly ground: number;
  /** 0 flat to the camera, 1 lying in the room. */
  readonly lie: number;
  /** The sky's lower edge, as a fraction of the screen height: the wall stands up beneath it. */
  readonly wallEdge: number;
  /** The leading edge of the laid floor, as a fraction of the screen height: the mat shows below it. */
  readonly floorEdge: number;
  /** Strength of the shadow the laid floor casts onto the mat. */
  readonly seam: number;
  readonly warps: readonly LoomWarpFrame[];
  readonly labels: readonly { opacity: number; shift: number }[];
  /** How far each kraft strip has been threaded, 0 to 1. */
  readonly wefts: readonly number[];
}

/** Everything that moves in the loom at a scene progress. */
export function loomFrame(progress: number, layout: LoomLayout): LoomFrame {
  const p = clamp(progress);
  const [enterStart, enterEnd] = LOOM_PHASES.enter;
  const visible = p > enterStart && p < LOOM_PHASES.floor[1];
  const warpPhase = rangeProgress(p, LOOM_PHASES.warp[0], LOOM_PHASES.warp[1]);
  const labelPhase = rangeProgress(p, LOOM_PHASES.labels[0], LOOM_PHASES.labels[1]);
  const weftPhase = rangeProgress(p, LOOM_PHASES.weft[0], LOOM_PHASES.weft[1]);
  const wall = easeInOut(rangeProgress(p, LOOM_PHASES.wall[0], LOOM_PHASES.wall[1]));
  const floor = rangeProgress(p, LOOM_PHASES.floor[0], LOOM_PHASES.floor[1]);
  const count = layout.warps.length;
  const width = layout.visible.right - layout.visible.left;
  const shadow = layout.shadow;

  const warps = layout.warps.map((warp, index): LoomWarpFrame => {
    const delay = (index / Math.max(1, count - 1)) * 0.4;
    const local = clamp((warpPhase - delay) / 0.6);
    const pulled = easeOut(clamp(local / 0.5));
    const settle = easeInOut(clamp((local - 0.18) / 0.82));
    return {
      slide: round2(warp.side * (1 - pulled) * (width + 160)),
      settle: round2(settle),
      cloud: round2(1 - easeInOut(clamp((settle - 0.3) / 0.6))),
      shadow: round2(mix(shadow * 3.4, shadow, settle)),
    };
  });
  return {
    visible,
    wash: round2(easeInOut(rangeProgress(p, enterStart, enterEnd))),
    ground: round2(easeOut(rangeProgress(p, LOOM_PHASES.ground[0], LOOM_PHASES.ground[1]))),
    lie: round2(easeInOut(rangeProgress(p, LOOM_PHASES.lie[0], LOOM_PHASES.lie[1]))),
    wallEdge: round2(mix(layout.floorFraction, -0.02, wall)),
    // The floor comes toward the camera, so its edge gathers speed as it nears.
    floorEdge: round2(mix(layout.floorFraction, 1.04, floor * floor * (1.7 - 0.7 * floor))),
    seam: round2(floor > 0 && floor < 1 ? 1 : 0),
    warps,
    labels: layout.warps.map((_, index) => {
      const delay = (index / Math.max(1, count - 1)) * 0.5;
      const local = easeOut(clamp((labelPhase - delay) / 0.5));
      return { opacity: round2(local), shift: round2((1 - local) * 10) };
    }),
    wefts: layout.wefts.map((weft) => round2(easeOut(clamp((weftPhase - weft.delay) / 0.38)))),
  };
}

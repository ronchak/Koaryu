/**
 * The weave: the clouds lie down as the studio's threads (warp), and wooden
 * weft shuttles through them over and under until they are one floor. Pure
 * geometry and timing in scene coordinates (the same viewBox as the journey
 * scene), driven by scene progress so it plays when paged and scrubs when
 * scrolled. Unit tested.
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
  rangeProgress,
  round2,
  smoothPath,
  type ScenePoint,
} from "./scene-model.ts";

/** Scene progress at which each part of the loom plays. */
export const LOOM_PHASES = Object.freeze({
  /** The wash of sky covers the gathered clouds before the scene's own morph begins. */
  enter: Object.freeze([0.758, 0.8] as const),
  /** The strands lie down and straighten, one after another. */
  warp: Object.freeze([0.762, 0.83] as const),
  labels: Object.freeze([0.8, 0.842] as const),
  /** Weft shuttles through, alternating down and up. */
  weft: Object.freeze([0.824, 0.886] as const),
  /** The finished floor lies down into the room while its walls rise... */
  lie: Object.freeze([0.892, 0.94] as const),
  room: Object.freeze([0.898, 0.93] as const),
  /** ...and gives way to the scene's own floor as the class arrives. */
  leave: Object.freeze([0.934, 0.954] as const),
});

const CLOUD_FADE = [0.806, 0.826] as const;
/** Where the room's floor meets its far wall once the room has risen (the scene's horizon is 330). */
export const ROOM_FLOOR_LINE = 330 + FLOOR_FAR;

export const WARP_TONES = 4;
export const WEFT_TONES = 4;

export interface LoomWarp {
  readonly y: number;
  readonly thickness: number;
  readonly tone: number;
  readonly label: string;
  readonly labelX: number;
  readonly labelWidth: number;
  /** Where the strand starts, high in the sky, before it lies down. */
  readonly lift: number;
  readonly phase: number;
}

export interface LoomWeft {
  readonly x: number;
  readonly width: number;
  readonly tone: number;
  readonly downward: boolean;
  /** Fraction of the weft phase before this strand starts. */
  readonly delay: number;
}

export interface LoomLayout {
  readonly viewBox: string;
  readonly visible: { left: number; right: number; top: number; bottom: number };
  readonly portrait: boolean;
  readonly matTop: number;
  readonly matBottom: number;
  readonly fontSize: number;
  readonly shadow: number;
  readonly warps: readonly LoomWarp[];
  readonly wefts: readonly LoomWeft[];
  /** over[warp][weft]: the warp strand passes over the weft at this crossing. */
  readonly over: readonly (readonly boolean[])[];
  readonly weftTop: number;
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

export function loomLayout(width: number, height: number, threads: readonly string[]): LoomLayout {
  const visible = visibleSceneRect(width, height);
  const visibleWidth = visible.right - visible.left;
  const visibleHeight = visible.bottom - visible.top;
  const portrait = visibleWidth < visibleHeight;
  const count = Math.max(1, threads.length);
  const matTop = visible.top + visibleHeight * (portrait ? 0.5 : 0.47);
  // The last strand runs off the bottom edge, so the floor reads as continuing.
  const pitch = (visible.bottom - matTop) / (count - 0.15);
  const thickness = pitch * 0.82;
  const fontSize = round2(Math.min(thickness * 0.4, portrait ? 48 : 30));
  const spots = portrait ? LABEL_SPOTS.portrait : LABEL_SPOTS.landscape;

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
      lift: round2(visibleHeight * (0.34 + 0.07 * ((index * 5) % 7))),
      phase: round2(index * 1.9 + 0.6),
    };
  });

  const weftWidth = thickness * (portrait ? 0.86 : 0.96);
  const weftPitch = weftWidth + (pitch - thickness);
  const firstX = visible.left - weftPitch * 0.6;
  const weftCount = Math.ceil((visible.right + weftPitch - firstX) / weftPitch);
  const wefts: LoomWeft[] = Array.from({ length: weftCount }, (_, index) => ({
    x: round2(firstX + index * weftPitch),
    width: round2(weftWidth),
    tone: (index * 7 + 2) % WEFT_TONES,
    downward: index % 2 === 0,
    delay: round2((index / Math.max(1, weftCount - 1)) * 0.62),
  }));

  // Plain weave, except where a label is written: there the strand floats over
  // the weft so the word stays whole.
  const over = warps.map((warp, row) =>
    wefts.map((weft, column) => {
      const pad = fontSize * 0.4;
      const underLabel =
        weft.x + weft.width > warp.labelX - pad && weft.x < warp.labelX + warp.labelWidth + pad;
      return underLabel || (row + column) % 2 === 0;
    }),
  );

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
    matBottom: round2(visible.bottom + pitch),
    fontSize,
    shadow: round2(Math.max(6, thickness * 0.16)),
    warps,
    wefts,
    over,
    weftTop: round2(matTop - (pitch - thickness) * 0.5 - thickness * 0.24),
    matTopFraction: round2((matTop - visible.top) / visibleHeight),
    floorFraction: round2((ROOM_FLOOR_LINE - visible.top) / visibleHeight),
  };
}

/** Outline of a warp strand: wavy and lifted like a cloud at 0, a straight band at 1. */
export function warpPath(layout: LoomLayout, warp: LoomWarp, settle: number): string {
  const s = clamp(settle);
  const left = layout.visible.left - 80;
  const right = layout.visible.right + 80;
  const samples = 10;
  const thickness = warp.thickness * mix(0.5, 1, s);
  const amplitude = warp.thickness * 0.55 * (1 - s);
  const baseY = warp.y - warp.lift * (1 - s);
  const top: ScenePoint[] = [];
  const bottom: ScenePoint[] = [];
  for (let index = 0; index <= samples; index += 1) {
    const x = mix(left, right, index / samples);
    const wave = Math.sin(x * 0.0046 + warp.phase) * amplitude;
    // Cloud strands are thicker in the middle and taper at their ends.
    const swell = mix(Math.sin((index / samples) * Math.PI) * 0.6 + 0.4, 1, s);
    top.push({ x, y: baseY + wave + (thickness * (1 - swell)) / 2 });
    bottom.push({ x, y: baseY + wave + thickness - (thickness * (1 - swell)) / 2 });
  }
  return smoothPath([...top, ...bottom.reverse()], true, s > 0.98 ? 0 : 0.9);
}

export interface LoomFrame {
  readonly visible: boolean;
  /** Opacity of the sky wash that hides the scene beneath. */
  readonly wash: number;
  /** Opacity of the woven floor. */
  readonly mat: number;
  /** Opacity of the dark ground that shows between the strands once they have landed. */
  readonly ground: number;
  /** 0 flat to the camera, 1 lying in the room. */
  readonly lie: number;
  /** Opacity of the room's wall rising behind the floor. */
  readonly room: number;
  readonly warps: readonly { settle: number; opacity: number; cloud: number }[];
  readonly labels: readonly { opacity: number; shift: number }[];
  /** How much of each weft strand has been woven, 0 to 1. */
  readonly wefts: readonly number[];
}

/** Everything that moves in the loom at a scene progress. */
export function loomFrame(progress: number, layout: LoomLayout): LoomFrame {
  const p = clamp(progress);
  const [enterStart, enterEnd] = LOOM_PHASES.enter;
  const [leaveStart, leaveEnd] = LOOM_PHASES.leave;
  const visible = p > enterStart && p < leaveEnd;
  const leave = rangeProgress(p, leaveStart, leaveEnd);
  const wash = easeInOut(rangeProgress(p, enterStart, enterEnd)) * (1 - easeInOut(leave));
  const lie = easeInOut(rangeProgress(p, LOOM_PHASES.lie[0], LOOM_PHASES.lie[1]));
  const warpPhase = rangeProgress(p, LOOM_PHASES.warp[0], LOOM_PHASES.warp[1]);
  const labelPhase = rangeProgress(p, LOOM_PHASES.labels[0], LOOM_PHASES.labels[1]);
  const weftPhase = rangeProgress(p, LOOM_PHASES.weft[0], LOOM_PHASES.weft[1]);
  const count = layout.warps.length;
  // Labels leave as soon as the floor starts to lie down.
  const labelsLeave = 1 - rangeProgress(p, LOOM_PHASES.lie[0], LOOM_PHASES.lie[0] + 0.012);

  return {
    visible,
    wash: round2(wash),
    mat: round2(clamp(rangeProgress(p, enterStart + 0.006, enterEnd - 0.008)) * (1 - leave)),
    ground: round2(easeInOut(rangeProgress(p, CLOUD_FADE[0], CLOUD_FADE[1]))),
    lie: round2(lie),
    room: round2(easeInOut(rangeProgress(p, LOOM_PHASES.room[0], LOOM_PHASES.room[1]))),
    warps: layout.warps.map((_, index) => {
      const delay = (index / Math.max(1, count - 1)) * 0.45;
      const local = clamp((warpPhase - delay) / 0.55);
      return {
        settle: round2(easeInOut(local)),
        opacity: round2(clamp(local * 3)),
        // Cloud white gives way to the strand's own colour before the weft arrives.
        cloud: round2(1 - easeInOut(rangeProgress(p, CLOUD_FADE[0], CLOUD_FADE[1]))),
      };
    }),
    labels: layout.warps.map((_, index) => {
      const delay = (index / Math.max(1, count - 1)) * 0.5;
      const local = easeOut(clamp((labelPhase - delay) / 0.5));
      return { opacity: round2(local * labelsLeave), shift: round2((1 - local) * 18) };
    }),
    wefts: layout.wefts.map((weft) => round2(easeInOut(clamp((weftPhase - weft.delay) / 0.38)))),
  };
}

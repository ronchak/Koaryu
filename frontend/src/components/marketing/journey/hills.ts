// Shared hill geometry: the opening landscape of the story, used by the scene
// and by the landing hero. Pure data and paths, safe on the server.
import {
  SCENE_OVERSCAN,
  SCENE_WIDTH,
  makeCloudPath,
  mulberry32,
  smoothPath,
  type ScenePoint,
} from "./scene-model.ts";

export const MOUNTAIN_COLORS = Object.freeze([
  "#EFE2C0",
  "#E7CC97",
  "#C9A75E",
  "#A28341",
  "#7A612E",
] as const);

export interface Ridge {
  readonly color: string;
  readonly baseY: number;
  readonly amplitude: number;
  readonly frequency: number;
  readonly phase: number;
  readonly speed: number;
  readonly scale: number;
}

export const RIDGES: readonly Ridge[] = [
  {
    color: MOUNTAIN_COLORS[0],
    baseY: 552,
    amplitude: 74,
    frequency: 0.9,
    phase: 0.4,
    speed: 190,
    scale: 0.05,
  },
  {
    color: MOUNTAIN_COLORS[1],
    baseY: 638,
    amplitude: 92,
    frequency: 1.2,
    phase: 2.1,
    speed: 300,
    scale: 0.1,
  },
  {
    color: MOUNTAIN_COLORS[2],
    baseY: 728,
    amplitude: 104,
    frequency: 0.8,
    phase: 4.3,
    speed: 440,
    scale: 0.17,
  },
  {
    color: MOUNTAIN_COLORS[3],
    baseY: 826,
    amplitude: 118,
    frequency: 1.1,
    phase: 1.2,
    speed: 640,
    scale: 0.27,
  },
  {
    color: MOUNTAIN_COLORS[4],
    baseY: 940,
    amplitude: 130,
    frequency: 0.7,
    phase: 5.6,
    speed: 900,
    scale: 0.42,
  },
];

export function ridgeLine(
  baseY: number,
  amplitude: number,
  frequency: number,
  phase: number,
  resolution = 46,
): readonly ScenePoint[] {
  return Array.from({ length: resolution + 1 }, (_, index) => {
    const progress = index / resolution;
    return {
      x: -260 + progress * (SCENE_WIDTH + 520),
      y:
        baseY +
        Math.sin(progress * Math.PI * 2 * frequency + phase) * amplitude +
        Math.sin(progress * Math.PI * 2 * frequency * 2.31 + phase * 1.7) * amplitude * 0.4 +
        Math.sin(progress * Math.PI * 2 * frequency * 0.57 + phase * 0.45) * amplitude * 0.72,
    };
  });
}

export function closedRidgePath(
  baseY: number,
  amplitude: number,
  frequency: number,
  phase: number,
  resolution = 46,
): string {
  return `${smoothPath(ridgeLine(baseY, amplitude, frequency, phase, resolution))}L${SCENE_OVERSCAN.x + SCENE_OVERSCAN.width} 1900 L${SCENE_OVERSCAN.x} 1900 Z`;
}

export const RIDGE_PATHS = Object.freeze(
  RIDGES.map(({ baseY, amplitude, frequency, phase }) =>
    closedRidgePath(baseY, amplitude, frequency, phase),
  ),
);

export const MOUNTAIN_WISPS = Object.freeze(
  (() => {
    const random = mulberry32(31);
    return Array.from({ length: 5 }, () => ({
      x: 120 + random() * 1400,
      y: 180 + random() * 210,
      scale: 0.45 + random() * 0.6,
      opacity: 0.4 + random() * 0.4,
      path: makeCloudPath(Math.floor(random() * 9999)),
    }));
  })(),
);

// The hills the story opens on, drawn again for the close so the page ends
// where it began. Pure geometry (the same ridges as the opening scene), safe to
// render on the server; colours come from CSS so night can repaint them.
import { SCENE_WIDTH, smoothPath, type ScenePoint } from "../journey/scene-model.ts";

export interface CloseRidge {
  readonly baseY: number;
  readonly amplitude: number;
  readonly frequency: number;
  readonly phase: number;
  /** How far the ridge rises into place as the close arrives, far hills least. */
  readonly rise: number;
}

export const CLOSE_RIDGES: readonly CloseRidge[] = Object.freeze([
  { baseY: 552, amplitude: 74, frequency: 0.9, phase: 0.4, rise: 0.1 },
  { baseY: 638, amplitude: 92, frequency: 1.2, phase: 2.1, rise: 0.18 },
  { baseY: 728, amplitude: 104, frequency: 0.8, phase: 4.3, rise: 0.28 },
  { baseY: 826, amplitude: 118, frequency: 1.1, phase: 1.2, rise: 0.4 },
  { baseY: 940, amplitude: 130, frequency: 0.7, phase: 5.6, rise: 0.54 },
]);

function ridgeLine(ridge: CloseRidge, resolution = 46): ScenePoint[] {
  const { baseY, amplitude, frequency, phase } = ridge;
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

/** Closed ridge outlines in a 1600-wide viewBox, filled down past the bottom edge. */
export const CLOSE_RIDGE_PATHS: readonly string[] = Object.freeze(
  CLOSE_RIDGES.map((ridge) => `${smoothPath(ridgeLine(ridge))}L1860 1400 L-260 1400 Z`),
);

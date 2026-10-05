/**
 * The hills behind the /try miniature: the opening landscape of the landing story
 * (same ridge recipe and colours), drawn as static paths. Pure data, safe on the
 * server. Kept self-contained so the page does not depend on the landing scene's
 * internals.
 */

export type Point = Readonly<{ x: number; y: number }>;

/** The scene's coordinate space: 1600 wide, with overscan for wide crops. */
export const HILLS_WIDTH = 1600;
const OVERSCAN = { left: -520, right: 2120 } as const;

/** Golden-hour hills, far to near: the landing hero's palette. */
export const DAY_RIDGES = Object.freeze([
  "#EFE2C0",
  "#E7CC97",
  "#C9A75E",
  "#A28341",
  "#7A612E",
] as const);

/**
 * The same hills after seven in the evening: the far ridge keeps the afterglow,
 * each nearer ridge is cooler and darker.
 */
export const NIGHT_RIDGES = Object.freeze([
  "#A8705E",
  "#7C4F4C",
  "#553641",
  "#322435",
  "#1E1A27",
] as const);

/** Two near ridges carry the hills into the dark band below, by day and by night. */
export const DAY_GROUND = Object.freeze(["#5B4523", "#3A2C19"] as const);
export const NIGHT_GROUND = Object.freeze(["#191621", "#120F18"] as const);

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Catmull-Rom curve through the points, as cubic Béziers. */
export function smoothPath(points: readonly Point[], closed = false, tension = 1): string {
  const count = points.length;
  if (count < 2) return "";
  const at = (index: number) => points[(index + count) % count];
  const clampAt = (index: number) => points[Math.min(Math.max(index, 0), count - 1)];
  let path = `M${round2(points[0].x)} ${round2(points[0].y)}`;
  const last = closed ? count : count - 1;
  for (let index = 0; index < last; index += 1) {
    const p0 = closed ? at(index - 1) : clampAt(index - 1);
    const p1 = closed ? at(index) : clampAt(index);
    const p2 = closed ? at(index + 1) : clampAt(index + 1);
    const p3 = closed ? at(index + 2) : clampAt(index + 2);
    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension;
    path += `C${round2(c1x)} ${round2(c1y)},${round2(c2x)} ${round2(c2y)},${round2(p2.x)} ${round2(p2.y)}`;
  }
  return closed ? `${path}Z` : path;
}

export interface RidgeShape {
  readonly baseY: number;
  readonly amplitude: number;
  readonly frequency: number;
  readonly phase: number;
}

/** The landing hero's five ridges, far to near. */
export const RIDGE_SHAPES: readonly RidgeShape[] = Object.freeze([
  { baseY: 552, amplitude: 74, frequency: 0.9, phase: 0.4 },
  { baseY: 638, amplitude: 92, frequency: 1.2, phase: 2.1 },
  { baseY: 728, amplitude: 104, frequency: 0.8, phase: 4.3 },
  { baseY: 826, amplitude: 118, frequency: 1.1, phase: 1.2 },
  { baseY: 940, amplitude: 130, frequency: 0.7, phase: 5.6 },
]);

export function ridgeLine(
  { baseY, amplitude, frequency, phase }: RidgeShape,
  resolution = 46,
): readonly Point[] {
  return Array.from({ length: resolution + 1 }, (_, index) => {
    const progress = index / resolution;
    return {
      x: -260 + progress * (HILLS_WIDTH + 520),
      y:
        baseY +
        Math.sin(progress * Math.PI * 2 * frequency + phase) * amplitude +
        Math.sin(progress * Math.PI * 2 * frequency * 2.31 + phase * 1.7) * amplitude * 0.4 +
        Math.sin(progress * Math.PI * 2 * frequency * 0.57 + phase * 0.45) * amplitude * 0.72,
    };
  });
}

/** A ridge closed far down to `floor`, so a sinking ridge never shows its lower edge. */
export function closedRidgePath(shape: RidgeShape, floor = 6400): string {
  return `${smoothPath(ridgeLine(shape))}L${OVERSCAN.right} ${floor} L${OVERSCAN.left} ${floor} Z`;
}

/** Just the crest line, for the rim of light along each ridge at dusk. */
export function crestPath(shape: RidgeShape): string {
  return smoothPath(ridgeLine(shape));
}

export const RIDGE_PATHS = Object.freeze(RIDGE_SHAPES.map((shape) => closedRidgePath(shape)));
export const CREST_PATHS = Object.freeze(RIDGE_SHAPES.map((shape) => crestPath(shape)));

/** Near ridges for the ground the page continues on (drawn in a 1600 x 540 box). */
export const GROUND_PATHS = Object.freeze([
  closedRidgePath({ baseY: 150, amplitude: 56, frequency: 0.9, phase: 3.4 }, 900),
  closedRidgePath({ baseY: 250, amplitude: 46, frequency: 1.3, phase: 0.8 }, 900),
]);

/** Where the dark band ends, hills rise back into the page (a 1600 x 160 box). */
export const EDGE_PATHS = Object.freeze([
  closedRidgePath({ baseY: 70, amplitude: 22, frequency: 0.8, phase: 2.2 }, 400),
  closedRidgePath({ baseY: 112, amplitude: 18, frequency: 1.1, phase: 4.6 }, 400),
]);

/** A soft cloud wisp centred on the origin. */
export function cloudPath(seed: number): string {
  const random = mulberry32(seed);
  const width = 380 + random() * 560;
  const height = 44 + random() * 52;
  const lobes = 4 + Math.floor(random() * 4);
  const top: Point[] = [];
  const bottom: Point[] = [];
  for (let index = 0; index <= lobes; index += 1) {
    const progress = index / lobes;
    top.push({
      x: -width / 2 + progress * width,
      y: -height * Math.sin(progress * Math.PI) * (0.5 + 0.55 * random()),
    });
  }
  const segments = 5 + Math.floor(random() * 3);
  for (let index = segments; index >= 0; index -= 1) {
    const progress = index / segments;
    const tail = index === 0 || index === segments ? 0.12 : 0.35 + 0.75 * random();
    bottom.push({ x: -width / 2 + progress * width, y: height * 0.34 * tail });
  }
  return smoothPath([...top, ...bottom], true, 0.9);
}

export const WISPS = Object.freeze(
  (() => {
    const random = mulberry32(31);
    return Array.from({ length: 3 }, () => ({
      x: 120 + random() * 1400,
      path: cloudPath(Math.floor(random() * 9999)),
    }));
  })(),
);

/** The first stars over the hills, fixed so server and client render the same sky. */
export const STARS = Object.freeze(
  (() => {
    const random = mulberry32(7);
    return Array.from({ length: 46 }, () => ({
      x: round2(random() * 100),
      y: round2(Math.pow(random(), 1.6) * 62),
      r: round2(0.6 + random() * 1.1),
      opacity: round2(0.35 + random() * 0.6),
    }));
  })(),
);

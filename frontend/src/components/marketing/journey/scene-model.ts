export const SCENE_WIDTH = 1600;
export const SCENE_HEIGHT = 1000;

export const SCENE_OVERSCAN = Object.freeze({
  x: -520,
  y: -740,
  width: 2640,
  height: 2480,
});

export const SCENE_PHASES = Object.freeze({
  mountains: Object.freeze([0, 0.1] as const),
  drop: Object.freeze([0.1, 0.22] as const),
  settle: Object.freeze([0.22, 0.3] as const),
  push: Object.freeze([0.3, 0.5] as const),
  door: Object.freeze([0.34, 0.5] as const),
  students: Object.freeze([0.54, 0.96] as const),
});

export type ScenePoint = Readonly<{ x: number; y: number }>;

export interface SceneFrame {
  readonly viewBox: string;
  readonly visibleHalfWidth: number;
  readonly studentSpread: number;
  readonly variant: "landscape" | "portrait";
}

export function clamp(value: number, minimum = 0, maximum = 1): number {
  if (Number.isNaN(value)) {
    return minimum;
  }

  return value < minimum ? minimum : value > maximum ? maximum : value;
}

export function mix(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

export function rangeProgress(progress: number, start: number, end: number): number {
  if (end <= start) {
    return progress >= end ? 1 : 0;
  }

  return clamp((progress - start) / (end - start));
}

export function easeIn(progress: number): number {
  const value = clamp(progress);
  return value * value * value;
}

export function easeOut(progress: number): number {
  const value = clamp(progress);
  return 1 - (1 - value) ** 3;
}

export function easeInOut(progress: number): number {
  const value = clamp(progress);
  return value < 0.5 ? 2 * value * value : 1 - (-2 * value + 2) ** 2 / 2;
}

export function frameForDimensions(viewportWidth: number, viewportHeight: number): SceneFrame {
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : SCENE_WIDTH;
  const height =
    Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : SCENE_HEIGHT;
  const aspect = width / height;
  const viewBoxHeight = clamp(SCENE_WIDTH / aspect, SCENE_HEIGHT, 2000);
  const visibleHalfWidth = Math.min(SCENE_WIDTH / 2, (viewBoxHeight / 2) * aspect);
  // Narrow crops pull the seated class toward the center so nobody is cut off.
  const studentSpread = clamp(visibleHalfWidth / 540, 0.6, 1);

  return Object.freeze({
    viewBox: `0 ${round2(SCENE_HEIGHT / 2 - viewBoxHeight / 2)} ${SCENE_WIDTH} ${round2(viewBoxHeight)}`,
    visibleHalfWidth,
    studentSpread,
    variant: aspect < SCENE_WIDTH / SCENE_HEIGHT ? "portrait" : "landscape",
  });
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

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function smoothPath(points: readonly ScenePoint[], closed = false, tension = 1): string {
  const count = points.length;
  if (count < 2) {
    return "";
  }

  const pointAt = (index: number): ScenePoint =>
    points[(index + count) % count] ?? points[0] ?? { x: 0, y: 0 };
  const first = points[0];
  if (!first) {
    return "";
  }

  let path = `M${round2(first.x)} ${round2(first.y)}`;
  const last = closed ? count : count - 1;

  for (let index = 0; index < last; index += 1) {
    const p0 = closed ? pointAt(index - 1) : (points[Math.max(index - 1, 0)] ?? first);
    const p1 = points[index % count] ?? first;
    const p2 = closed ? pointAt(index + 1) : (points[Math.min(index + 1, count - 1)] ?? first);
    const p3 = closed ? pointAt(index + 2) : (points[Math.min(index + 2, count - 1)] ?? first);
    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension;
    path += `C${round2(c1x)} ${round2(c1y)},${round2(c2x)} ${round2(c2y)},${round2(p2.x)} ${round2(p2.y)}`;
  }

  return closed ? `${path}Z` : path;
}

export function polygonPoints(points: readonly ScenePoint[]): string {
  return points.map(({ x, y }) => `${round2(x)},${round2(y)}`).join(" ");
}

export function makeCloudPath(seed: number): string {
  const random = mulberry32(seed);
  const width = 380 + random() * 560;
  const height = 44 + random() * 52;
  const lobes = 4 + Math.floor(random() * 4);
  const top: ScenePoint[] = [];
  const bottom: ScenePoint[] = [];

  for (let index = 0; index <= lobes; index += 1) {
    const progress = index / lobes;
    const arch = Math.sin(progress * Math.PI);
    top.push({
      x: -width / 2 + progress * width,
      y: -height * arch * (0.5 + 0.55 * random()),
    });
  }

  const segments = 5 + Math.floor(random() * 3);
  for (let index = segments; index >= 0; index -= 1) {
    const progress = index / segments;
    const tail = index === 0 || index === segments ? 0.12 : 0.35 + 0.75 * random();
    bottom.push({
      x: -width / 2 + progress * width,
      y: height * 0.34 * tail,
    });
  }

  return smoothPath([...top, ...bottom], true, 0.9);
}

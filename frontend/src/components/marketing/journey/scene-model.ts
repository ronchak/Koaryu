import { landingPageContent } from "../../../lib/landing-page-content.ts";

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
  drop: Object.freeze([0.1, 0.212] as const),
  settle: Object.freeze([0.212, 0.288] as const),
  portal: Object.freeze([0.288, 0.52] as const),
  door: Object.freeze([0.404, 0.52] as const),
  through: Object.freeze([0.516, 0.64] as const),
  sky: Object.freeze([0.6, 0.7] as const),
  clouds: Object.freeze([0.66, 0.802] as const),
  morph: Object.freeze([0.802, 0.892] as const),
  floor: Object.freeze([0.892, 0.952] as const),
  students: Object.freeze([0.952, 1] as const),
});

export type ScenePhaseName = keyof typeof SCENE_PHASES;
export type ScenePoint = Readonly<{ x: number; y: number }>;

export interface SceneFrame {
  readonly viewBox: string;
  readonly visibleHalfWidth: number;
  readonly studentSpread: number;
  readonly variant: "landscape" | "portrait";
}

export interface SceneProgressModel {
  readonly progress: number;
  readonly phase: Readonly<Record<ScenePhaseName, number>>;
  readonly mountainsFall: number;
  readonly curtainOpen: number;
  readonly dojoArrival: number;
  readonly portalDolly: number;
  readonly doorOpen: number;
  readonly doorwayPush: number;
  readonly skySettle: number;
  readonly cloudGather: number;
  readonly weaveMorph: number;
  readonly floorSettle: number;
  readonly studentArrival: number;
}

export const JOURNEY_SCENE_STOPS = Object.freeze(
  Object.fromEntries(
    landingPageContent.chapters.map(({ id, scene }) => [id, scene])
  ) as Record<(typeof landingPageContent.chapters)[number]["id"], number>
);

export function clamp(value: number, minimum = 0, maximum = 1): number {
  if (Number.isNaN(value)) {
    return minimum;
  }

  return value < minimum ? minimum : value > maximum ? maximum : value;
}

export function mix(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

export function rangeProgress(
  progress: number,
  start: number,
  end: number
): number {
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
  return value < 0.5
    ? 2 * value * value
    : 1 - (-2 * value + 2) ** 2 / 2;
}

export function phaseProgress(
  progress: number,
  phase: ScenePhaseName
): number {
  const [start, end] = SCENE_PHASES[phase];
  return rangeProgress(clamp(progress), start, end);
}

export function sceneProgressModel(progress: number): SceneProgressModel {
  const safeProgress = clamp(progress);
  const phase = Object.freeze(
    Object.fromEntries(
      (Object.keys(SCENE_PHASES) as ScenePhaseName[]).map((name) => [
        name,
        phaseProgress(safeProgress, name),
      ])
    ) as Record<ScenePhaseName, number>
  );

  return Object.freeze({
    progress: safeProgress,
    phase,
    mountainsFall: easeIn(phase.mountains),
    curtainOpen: easeInOut(phase.drop),
    dojoArrival: easeOut(phase.drop),
    portalDolly: easeInOut(phase.portal),
    doorOpen: easeInOut(phase.door),
    doorwayPush: easeIn(phase.through),
    skySettle: easeInOut(phase.sky),
    cloudGather: easeOut(phase.clouds),
    weaveMorph: easeInOut(phase.morph),
    floorSettle: easeInOut(phase.floor),
    studentArrival: easeOut(phase.students),
  });
}

export function frameForDimensions(
  viewportWidth: number,
  viewportHeight: number
): SceneFrame {
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0
    ? viewportWidth
    : SCENE_WIDTH;
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0
    ? viewportHeight
    : SCENE_HEIGHT;
  const aspect = width / height;
  const viewBoxHeight = clamp(SCENE_WIDTH / aspect, SCENE_HEIGHT, 2000);
  const visibleHalfWidth = Math.min(
    SCENE_WIDTH / 2,
    (viewBoxHeight / 2) * aspect
  );
  const studentSpread = clamp(
    (visibleHalfWidth - 210) / (SCENE_WIDTH / 2 - 210),
    0.34,
    1
  );

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

export function smoothPath(
  points: readonly ScenePoint[],
  closed = false,
  tension = 1
): string {
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
    const p0 = closed
      ? pointAt(index - 1)
      : points[Math.max(index - 1, 0)] ?? first;
    const p1 = points[index % count] ?? first;
    const p2 = closed
      ? pointAt(index + 1)
      : points[Math.min(index + 1, count - 1)] ?? first;
    const p3 = closed
      ? pointAt(index + 2)
      : points[Math.min(index + 2, count - 1)] ?? first;
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

export interface CloudGeometry {
  readonly seed: number;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly tier: number;
  readonly direction: -1 | 1;
  readonly tone: number;
  readonly arrival: number;
  readonly drift: number;
  readonly path: string;
}

export interface PlankGeometry {
  readonly uv: readonly ScenePoint[];
  readonly flat: readonly ScenePoint[];
  readonly cloud: readonly ScenePoint[];
  readonly rowPosition: number;
  readonly horizontalOrder: number;
  readonly verticalOrder: number;
  readonly normalizedDepth: number;
  readonly tone: number;
}

export const WEAVE_COLUMNS = 16;
export const WEAVE_ROWS = 16;
export const PLANK_LENGTH = 2.02;
export const PLANK_WIDTH = 0.7;
export const COLUMN_STEP = PLANK_LENGTH / Math.SQRT2;
export const ROW_STEP = PLANK_WIDTH * Math.SQRT2;
export const U_SPAN = WEAVE_COLUMNS * COLUMN_STEP;
export const V_SPAN = WEAVE_ROWS * ROW_STEP;
export const FLOOR_FAR = 168;
export const FLOOR_NEAR = 960;
export const HALF_FAR = 990;
export const HALF_NEAR = 2500;
const EDGE_POINTS = 4;

function makeCloudPath(seed: number): string {
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

export function createCloudGeometry(seed = 1207): readonly CloudGeometry[] {
  const random = mulberry32(seed);
  const clouds: Omit<CloudGeometry, "path">[] = [];

  for (let index = 0; index < 42; index += 1) {
    const tier = index < 13 ? 0 : index < 29 ? 1 : 2;
    const scale = [0.72, 1.1, 1.7][tier]! * (0.8 + random() * 0.5);
    const cloudSeed = Math.floor(random() * 99999);
    clouds.push({
      seed: cloudSeed,
      x: -180 + random() * (SCENE_WIDTH + 360),
      y: -110 + random() * (SCENE_HEIGHT + 240),
      scale,
      tier,
      direction: random() < 0.5 ? -1 : 1,
      tone: Math.min(4, tier + (random() < 0.5 ? 0 : 1)),
      arrival: random() ** 0.9 * 0.6,
      drift: (0.35 + random() * 0.9) * [0.4, 0.8, 1.5][tier]!,
    });
  }

  return Object.freeze(
    clouds
      .sort((a, b) => a.tier - b.tier)
      .map((cloud) => Object.freeze({ ...cloud, path: makeCloudPath(cloud.seed) }))
  );
}

export function flatWeavePoint(u: number, v: number): ScenePoint {
  return {
    x: (u / U_SPAN) * (SCENE_WIDTH + 420) - 210,
    y: (v / V_SPAN) * (SCENE_HEIGHT + 520) - 260,
  };
}

export function floorPoint(u: number, v: number, horizon: number): ScenePoint {
  const depth = v / V_SPAN;
  const vertical = mix(FLOOR_FAR, FLOOR_NEAR, depth);
  const halfWidth = mix(HALF_FAR, HALF_NEAR, depth);
  return {
    x: SCENE_WIDTH / 2 + (u / U_SPAN - 0.5) * 2 * halfWidth,
    y: horizon + vertical,
  };
}

export function createPlankGeometry(seed = 88041): readonly PlankGeometry[] {
  const random = mulberry32(seed);
  const planks: PlankGeometry[] = [];

  for (let column = 0; column < WEAVE_COLUMNS; column += 1) {
    for (let row = 0; row < WEAVE_ROWS; row += 1) {
      const direction = column % 2 === 0 ? 1 : -1;
      const angle = (direction * Math.PI) / 4;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const columnPosition = column * COLUMN_STEP + COLUMN_STEP * 0.5;
      const rowPosition = row * ROW_STEP + (column % 2 ? ROW_STEP * 0.5 : 0);
      const uv: ScenePoint[] = [];

      for (let index = 0; index < EDGE_POINTS; index += 1) {
        const progress = -0.5 + index / (EDGE_POINTS - 1);
        uv.push({
          x: columnPosition + progress * PLANK_LENGTH * cosine + (PLANK_WIDTH / 2) * sine,
          y: rowPosition + progress * PLANK_LENGTH * sine - (PLANK_WIDTH / 2) * cosine,
        });
      }
      for (let index = EDGE_POINTS - 1; index >= 0; index -= 1) {
        const progress = -0.5 + index / (EDGE_POINTS - 1);
        uv.push({
          x: columnPosition + progress * PLANK_LENGTH * cosine - (PLANK_WIDTH / 2) * sine,
          y: rowPosition + progress * PLANK_LENGTH * sine + (PLANK_WIDTH / 2) * cosine,
        });
      }

      const flat = uv.map((point) => flatWeavePoint(point.x, point.y));
      const center = flatWeavePoint(columnPosition, rowPosition);
      const ribbonCenterX = SCENE_WIDTH / 2 + (center.x - SCENE_WIDTH / 2) * 1.72 + (random() - 0.5) * 140;
      const ribbonCenterY = center.y * 0.94 + 34 + (random() - 0.5) * 46;
      const ribbonWidth = 540 + random() * 520;
      const ribbonHeight = 34 + random() * 40;
      const phase = random() * Math.PI * 2;
      const amplitude = 20 + random() * 26;
      const waveY = (x: number) =>
        Math.sin(x * 0.0042 + phase) * amplitude +
        Math.sin(x * 0.0013 + phase * 1.7) * amplitude * 1.25;
      const cloud: ScenePoint[] = [];

      for (let index = 0; index < EDGE_POINTS; index += 1) {
        const progress = -0.5 + index / (EDGE_POINTS - 1);
        const x = ribbonCenterX + progress * ribbonWidth;
        cloud.push({ x, y: ribbonCenterY - ribbonHeight / 2 + waveY(x) });
      }
      for (let index = EDGE_POINTS - 1; index >= 0; index -= 1) {
        const progress = -0.5 + index / (EDGE_POINTS - 1);
        const x = ribbonCenterX + progress * ribbonWidth;
        cloud.push({ x, y: ribbonCenterY + ribbonHeight / 2 + waveY(x) });
      }

      planks.push({
        uv,
        flat,
        cloud,
        rowPosition,
        horizontalOrder: center.x / SCENE_WIDTH,
        verticalOrder: center.y / SCENE_HEIGHT,
        normalizedDepth: rowPosition / V_SPAN,
        tone: Math.min(4, Math.floor(random() * 3) + (row % 2)),
      });
    }
  }

  return Object.freeze(
    planks
      .sort((a, b) => a.rowPosition - b.rowPosition)
      .map((plank) => Object.freeze({
        ...plank,
        uv: Object.freeze(plank.uv.map((point) => Object.freeze(point))),
        flat: Object.freeze(plank.flat.map((point) => Object.freeze(point))),
        cloud: Object.freeze(plank.cloud.map((point) => Object.freeze(point))),
      }))
  );
}

export const CLOUD_GEOMETRY = createCloudGeometry();
export const PLANK_GEOMETRY = createPlankGeometry();

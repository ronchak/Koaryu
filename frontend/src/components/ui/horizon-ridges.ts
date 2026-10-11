// The landing page's ridge geometry for product pages: the wide hero shot and
// the same hills re-sampled for a short header band. Pure data, safe in Node.

export const HORIZON_VIEWBOX = { width: 1600, height: 300 } as const;
export const HORIZON_BAND_VIEWBOX = { width: 1600, height: 160 } as const;

type Ridge = {
  readonly baseY: number;
  readonly amplitude: number;
  readonly frequency: number;
  readonly phase: number;
};

// Same frequencies and phases as the landing's close hills (close-hills.ts),
// compressed into the bottom of a 300-unit band, far ridge first.
const HORIZON_RIDGES: readonly Ridge[] = [
  { baseY: 150, amplitude: 22, frequency: 0.9, phase: 0.4 },
  { baseY: 190, amplitude: 26, frequency: 1.2, phase: 2.1 },
  { baseY: 230, amplitude: 30, frequency: 0.8, phase: 4.3 },
  { baseY: 268, amplitude: 30, frequency: 1.1, phase: 1.2 },
  { baseY: 300, amplitude: 28, frequency: 0.7, phase: 5.6 },
];

// The page-header band: the same ridges, lower and flatter, under a short sky.
const HORIZON_BAND_RIDGES: readonly Ridge[] = [
  { baseY: 92, amplitude: 12, frequency: 0.9, phase: 0.4 },
  { baseY: 114, amplitude: 14, frequency: 1.2, phase: 2.1 },
  { baseY: 134, amplitude: 14, frequency: 0.8, phase: 4.3 },
  { baseY: 152, amplitude: 12, frequency: 1.1, phase: 1.2 },
  { baseY: 168, amplitude: 10, frequency: 0.7, phase: 5.6 },
];

type Point = readonly [number, number];

function ridgeLine(ridge: Ridge, width: number, resolution = 46): Point[] {
  const { baseY, amplitude, frequency, phase } = ridge;
  return Array.from({ length: resolution + 1 }, (_, index) => {
    const progress = index / resolution;
    return [
      -120 + progress * (width + 240),
      baseY +
        Math.sin(progress * Math.PI * 2 * frequency + phase) * amplitude +
        Math.sin(progress * Math.PI * 2 * frequency * 2.31 + phase * 1.7) * amplitude * 0.4 +
        Math.sin(progress * Math.PI * 2 * frequency * 0.57 + phase * 0.45) * amplitude * 0.72,
    ] as const;
  });
}

function smoothPath(points: readonly Point[]): string {
  const fixed = (value: number) => value.toFixed(1);
  let path = `M${fixed(points[0][0])} ${fixed(points[0][1])}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index - 1] ?? points[index];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[index + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    path += ` C${fixed(c1x)} ${fixed(c1y)} ${fixed(c2x)} ${fixed(c2y)} ${fixed(p2[0])} ${fixed(p2[1])}`;
  }
  return path;
}

function closedRidgePaths(
  ridges: readonly Ridge[],
  viewBox: { width: number; height: number },
): readonly string[] {
  return Object.freeze(
    ridges.map(
      (ridge) =>
        `${smoothPath(ridgeLine(ridge, viewBox.width))} L${viewBox.width + 120} ${viewBox.height + 40} L-120 ${viewBox.height + 40} Z`,
    ),
  );
}

/** Closed ridge outlines, far to near, filled down past the bottom edge. */
export const HORIZON_RIDGE_PATHS: readonly string[] = closedRidgePaths(
  HORIZON_RIDGES,
  HORIZON_VIEWBOX,
);

/** The compact page-header version of the same hills. */
export const HORIZON_BAND_RIDGE_PATHS: readonly string[] = closedRidgePaths(
  HORIZON_BAND_RIDGES,
  HORIZON_BAND_VIEWBOX,
);

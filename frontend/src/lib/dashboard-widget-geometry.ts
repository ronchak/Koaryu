import {
  getDashboardWidgetFootprint,
} from "./dashboard-layout-store.ts";
import type { DashboardWidgetSize } from "./dashboard-widget-catalog.ts";

export type DashboardGridMetrics = {
  columnGap: number;
  columnWidth: number;
  columns: number;
  maxRows: number;
  rowGap: number;
  rowHeight: number;
  sequenceLeft: number;
  sequenceTop: number;
};

type PointerTargetInput = DashboardGridMetrics & {
  grabOffsetX: number;
  grabOffsetY: number;
  pointerX: number;
  pointerY: number;
  previousColumn: number;
  previousRow: number;
  size: DashboardWidgetSize;
};

type ResizeTargetInput = Pick<
  DashboardGridMetrics,
  "columnGap" | "columnWidth" | "rowGap" | "rowHeight"
> & {
  allowedSizes: readonly DashboardWidgetSize[];
  currentSize: DashboardWidgetSize;
  height: number;
  width: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function resolveHystereticIndex(
  rawIndex: number,
  previousIndex: number,
  maximum: number,
  hysteresis = 0.16
): number {
  const candidate = clamp(Math.round(rawIndex), 0, maximum);
  if (previousIndex < 0 || candidate === previousIndex) {
    return candidate;
  }
  if (candidate > previousIndex && rawIndex < previousIndex + 0.5 + hysteresis) {
    return previousIndex;
  }
  if (candidate < previousIndex && rawIndex > previousIndex - 0.5 - hysteresis) {
    return previousIndex;
  }
  return candidate;
}

export function dashboardSizePixels(
  size: DashboardWidgetSize,
  metrics: Pick<DashboardGridMetrics, "columnGap" | "columnWidth" | "rowGap" | "rowHeight">
): { height: number; width: number } {
  const footprint = getDashboardWidgetFootprint(size);
  return {
    width: footprint.columns * metrics.columnWidth + (footprint.columns - 1) * metrics.columnGap,
    height: footprint.rows * metrics.rowHeight + (footprint.rows - 1) * metrics.rowGap,
  };
}

export function resolveDashboardPointerTarget(input: PointerTargetInput): {
  column: number;
  row: number;
} {
  const footprint = getDashboardWidgetFootprint(input.size);
  const columnStride = Math.max(1, input.columnWidth + input.columnGap);
  const rowStride = Math.max(1, input.rowHeight + input.rowGap);
  const previewLeft = input.pointerX - input.grabOffsetX;
  const previewTop = input.pointerY - input.grabOffsetY;
  const rawColumn = (previewLeft - input.sequenceLeft) / columnStride;
  const rawRow = (previewTop - input.sequenceTop) / rowStride;
  return {
    column: resolveHystereticIndex(
      rawColumn,
      input.previousColumn,
      Math.max(0, input.columns - footprint.columns)
    ),
    row: resolveHystereticIndex(
      rawRow,
      input.previousRow,
      Math.max(0, input.maxRows - footprint.rows)
    ),
  };
}

export function chooseDashboardResizeSize(input: ResizeTargetInput): DashboardWidgetSize {
  const normalizedDistance = (size: DashboardWidgetSize): number => {
    const pixels = dashboardSizePixels(size, input);
    const horizontal = (input.width - pixels.width) / Math.max(1, input.columnWidth);
    const vertical = (input.height - pixels.height) / Math.max(1, input.rowHeight);
    return Math.hypot(horizontal, vertical);
  };
  const currentDistance = normalizedDistance(input.currentSize);
  let bestSize = input.currentSize;
  let bestDistance = currentDistance;
  for (const size of input.allowedSizes) {
    const distance = normalizedDistance(size);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSize = size;
    }
  }

  // Once a footprint owns the placeholder, require a meaningful improvement
  // before switching it. This prevents reflow chatter at size midpoints.
  return bestSize !== input.currentSize && bestDistance + 0.18 < currentDistance
    ? bestSize
    : input.currentSize;
}

export function clampDashboardResizePreview(
  width: number,
  height: number,
  allowedSizes: readonly DashboardWidgetSize[],
  metrics: Pick<DashboardGridMetrics, "columnGap" | "columnWidth" | "rowGap" | "rowHeight">
): { height: number; width: number } {
  const dimensions = allowedSizes.map((size) => dashboardSizePixels(size, metrics));
  return {
    width: clamp(width, Math.min(...dimensions.map((value) => value.width)), Math.max(...dimensions.map((value) => value.width))),
    height: clamp(height, Math.min(...dimensions.map((value) => value.height)), Math.max(...dimensions.map((value) => value.height))),
  };
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chooseDashboardResizeSize,
  clampDashboardResizePreview,
  dashboardSizePixels,
  resolveDashboardPointerTarget,
} from "../src/lib/dashboard-widget-geometry.ts";

const metrics = {
  columnGap: 12,
  columnWidth: 100,
  columns: 4,
  maxRows: 8,
  rowGap: 12,
  rowHeight: 160,
  sequenceLeft: 20,
  sequenceTop: 80,
};

describe("dashboard widget interaction geometry", () => {
  it("keeps the original grab point while resolving a clamped grid target", () => {
    assert.deepEqual(resolveDashboardPointerTarget({
      ...metrics,
      grabOffsetX: 25,
      grabOffsetY: 40,
      pointerX: 45,
      pointerY: 120,
      previousColumn: -1,
      previousRow: -1,
      size: "1x1",
    }), { column: 0, row: 0 });
    assert.deepEqual(resolveDashboardPointerTarget({
      ...metrics,
      grabOffsetX: 25,
      grabOffsetY: 40,
      pointerX: 999,
      pointerY: 999,
      previousColumn: -1,
      previousRow: -1,
      size: "2x2",
    }), { column: 2, row: 5 });
  });

  it("holds the current slot through a midpoint dead band", () => {
    const input = {
      ...metrics,
      grabOffsetX: 0,
      grabOffsetY: 0,
      pointerY: 80,
      previousColumn: 0,
      previousRow: 0,
      size: "1x1",
    };
    assert.equal(resolveDashboardPointerTarget({ ...input, pointerX: 20 + 0.62 * 112 }).column, 0);
    assert.equal(resolveDashboardPointerTarget({ ...input, pointerX: 20 + 0.7 * 112 }).column, 1);
  });

  it("maps only to supported resize footprints and adds switch hysteresis", () => {
    assert.deepEqual(dashboardSizePixels("2x2", metrics), { width: 212, height: 332 });
    assert.equal(chooseDashboardResizeSize({
      ...metrics,
      allowedSizes: ["1x1", "2x1", "2x2"],
      currentSize: "1x1",
      width: 205,
      height: 165,
    }), "2x1");
    assert.equal(chooseDashboardResizeSize({
      ...metrics,
      allowedSizes: ["1x1", "2x1"],
      currentSize: "1x1",
      width: 156,
      height: 160,
    }), "1x1");
  });

  it("clamps the continuous resize preview to the supported envelope", () => {
    assert.deepEqual(clampDashboardResizePreview(500, 40, ["1x1", "2x2"], metrics), {
      width: 212,
      height: 160,
    });
  });
});

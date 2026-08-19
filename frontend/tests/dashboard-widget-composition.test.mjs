import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DASHBOARD_WIDGET_CATALOG } from "../src/lib/dashboard-widget-catalog.ts";
import { getDashboardWidgetComposition } from "../src/lib/dashboard-widget-composition.ts";

describe("dashboard widget composition", () => {
  it("maps every catalog footprint to one bounded density contract", () => {
    const expected = {
      "1x1": { density: "compact", rowCapacity: 0, listColumns: 1 },
      "2x1": { density: "wide", rowCapacity: 1, listColumns: 1 },
      "1x2": { density: "tall", rowCapacity: 4, listColumns: 1 },
      "2x2": { density: "full", rowCapacity: 8, listColumns: 2 },
    };
    for (const entry of DASHBOARD_WIDGET_CATALOG) {
      for (const size of entry.allowedSizes) {
        const composition = getDashboardWidgetComposition(size);
        assert.deepEqual(
          {
            density: composition.density,
            rowCapacity: composition.rowCapacity,
            listColumns: composition.listColumns,
          },
          expected[size],
          `${entry.id}:${size}`
        );
      }
    }
  });

  it("limits compact actions and state decoration to the available body budget", () => {
    const compact = getDashboardWidgetComposition("1x1");
    assert.equal(compact.actionCapacity, 2);
    assert.equal(compact.stateRuleCapacity, 0);
    assert.equal(getDashboardWidgetComposition("2x1").stateRuleCapacity, 1);
    assert.equal(getDashboardWidgetComposition("2x2").stateRuleCapacity, 3);
  });
});

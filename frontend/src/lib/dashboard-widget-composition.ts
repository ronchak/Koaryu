import type { DashboardWidgetSize } from "./dashboard-widget-catalog.ts";

export type DashboardWidgetDensity = "compact" | "wide" | "tall" | "full";

export type DashboardWidgetComposition = Readonly<{
  actionCapacity: number;
  density: DashboardWidgetDensity;
  listColumns: number;
  rowCapacity: number;
  stateRuleCapacity: number;
}>;

const COMPOSITION_BY_SIZE: Readonly<Record<DashboardWidgetSize, DashboardWidgetComposition>> = {
  "1x1": {
    actionCapacity: 2,
    density: "compact",
    listColumns: 1,
    rowCapacity: 0,
    stateRuleCapacity: 0,
  },
  "2x1": {
    actionCapacity: 4,
    density: "wide",
    listColumns: 1,
    rowCapacity: 1,
    stateRuleCapacity: 1,
  },
  "1x2": {
    actionCapacity: 4,
    density: "tall",
    listColumns: 1,
    rowCapacity: 4,
    stateRuleCapacity: 3,
  },
  "2x2": {
    actionCapacity: 4,
    density: "full",
    listColumns: 2,
    rowCapacity: 8,
    stateRuleCapacity: 3,
  },
};

export function getDashboardWidgetComposition(
  size: DashboardWidgetSize
): DashboardWidgetComposition {
  return COMPOSITION_BY_SIZE[size];
}

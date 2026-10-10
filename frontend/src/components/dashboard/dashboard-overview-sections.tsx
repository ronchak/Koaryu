"use client";

import type { CSSProperties } from "react";
import { getDashboardWidgetComposition } from "@/lib/dashboard-widget-composition";
import { DASHBOARD_WIDGET_BY_ID } from "@/lib/dashboard-widget-catalog";
import {
  getDashboardWidgetFootprint,
  packDashboardLayoutItems,
  type DashboardLayout,
} from "@/lib/dashboard-layout-store";
import styles from "./dashboard-home.module.css";

export function DashboardLoadingPanel({ layout }: { layout: DashboardLayout }) {
  const tabletItems = new Map(
    packDashboardLayoutItems(layout.items, 2, false).map((item) => [item.widget_id, item]),
  );
  return (
    <section
      className={`${styles.canvas} koaryu-skeleton-reveal`}
      id="dashboard-layout-status"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <p className="sr-only">Loading Dashboard panels.</p>
      <div className={styles.sequence} aria-hidden="true">
        {layout.items.map((item) => {
          const footprint = getDashboardWidgetFootprint(item.size);
          const tabletItem = tabletItems.get(item.widget_id) ?? item;
          return (
            <article
              key={item.widget_id}
              className={styles.widget}
              data-widget-id={item.widget_id}
              data-density={getDashboardWidgetComposition(item.size).density}
              data-size={item.size}
              style={
                {
                  "--dashboard-column": item.column + 1,
                  "--dashboard-row": item.row + 1,
                  "--dashboard-column-span": footprint.columns,
                  "--dashboard-row-span": footprint.rows,
                  "--dashboard-tablet-column": tabletItem.column + 1,
                  "--dashboard-tablet-row": tabletItem.row + 1,
                } as CSSProperties
              }
            >
              <header className={styles.widgetBand}>
                <span>{DASHBOARD_WIDGET_BY_ID.get(item.widget_id)?.title}</span>
              </header>
              <div className={styles.widgetBody}>
                <div className="h-6 w-1/3 rounded-[6px] bg-border" />
                <div className="mt-3 h-3 w-3/4 rounded-[6px] bg-border" />
              </div>
              <footer className={styles.widgetFooting}>
                <div className="h-3 w-24 rounded-[6px] bg-border" />
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}

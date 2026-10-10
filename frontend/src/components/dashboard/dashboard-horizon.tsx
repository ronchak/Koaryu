"use client";

import { useSyncExternalStore } from "react";
import { IntentPrefetchLink as Link } from "@/components/intent-prefetch-link";
import { DASHBOARD_WIDGET_BY_ID, type DashboardWidgetId } from "@/lib/dashboard-widget-catalog";
import {
  dayPeriodForHour,
  HORIZON_RIDGE_PATHS,
  HORIZON_VIEWBOX,
  horizonWeek,
  type DayPeriod,
} from "@/lib/dashboard-horizon";
import type { DashboardWidgetViewModel } from "@/lib/dashboard-widget-view-models";
import styles from "./dashboard-horizon.module.css";

function subscribeToClock(onChange: () => void) {
  const timer = window.setInterval(onChange, 60_000);
  return () => window.clearInterval(timer);
}

/** The viewer's part of the day; null while server rendering and hydrating. */
export function useDayPeriod(): DayPeriod | null {
  return useSyncExternalStore(
    subscribeToClock,
    () => dayPeriodForHour(new Date().getHours()),
    () => null,
  );
}

/** The landing page's hills and sun, drawn behind the Dashboard greeting. */
export function HorizonHills() {
  const { width, height } = HORIZON_VIEWBOX;
  return (
    <svg
      className={styles.hills}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      focusable="false"
    >
      <circle className={styles.sun} cx="1160" cy="132" r="46" />
      <circle className={styles.sunHalo} cx="1166" cy="138" r="46" />
      {HORIZON_RIDGE_PATHS.map((path, index) => (
        <path key={index} d={path} fill={`var(--hz-ridge-${index})`} />
      ))}
    </svg>
  );
}

type PulseCandidate = {
  id: DashboardWidgetId;
  label: string;
  note: (model: DashboardWidgetViewModel) => string;
  requiresPanel?: boolean;
};

function stripPeriod(value: string): string {
  return value.replace(/\.$/, "");
}

const PULSE_CANDIDATES: readonly PulseCandidate[] = [
  {
    id: "student_pulse",
    label: "Active students",
    note: (model) =>
      model.state === "empty" ? "No active students yet" : stripPeriod(model.detail),
  },
  {
    id: "attendance",
    label: "Attendance",
    note: (model) =>
      model.visual && model.visual.max > 0
        ? `${model.visual.value} of ${model.visual.max} seats · 30 days`
        : stripPeriod(model.detail),
  },
  {
    id: "lead_follow_ups",
    label: "Follow-ups due",
    note: (model) =>
      model.rows[0]?.note ??
      (model.state === "empty" ? "Nothing due today" : stripPeriod(model.detail)),
  },
  {
    id: "promotions_due",
    label: "Ready to promote",
    note: (model) => stripPeriod(model.detail),
    // Eligibility only loads while its panel is on the Dashboard.
    requiresPanel: true,
  },
  {
    id: "classes_today",
    label: "Classes today",
    note: (model) => {
      if (model.state === "empty") return "Nothing on the schedule";
      const first = model.rows[0]?.meta?.split(" · ")[0];
      return first ? `First at ${first}` : stripPeriod(model.detail);
    },
  },
  {
    id: "billing_exceptions",
    label: "Billing exceptions",
    note: (model) => (model.state === "empty" ? "All payments clear" : stripPeriod(model.detail)),
  },
];

function PulseValue({ model }: { model: DashboardWidgetViewModel }) {
  if (model.state === "loading") {
    return <span className={styles.pulsePending} aria-label="Loading" />;
  }
  if (!model.metric) {
    return <span className={styles.pulseValue}>—</span>;
  }
  const percent = /^(\d+)%$/.exec(model.metric);
  return (
    <span className={styles.pulseValue}>
      {percent ? percent[1] : model.metric}
      {percent ? <small>%</small> : null}
    </span>
  );
}

/** Four headline numbers on the near ridge, each a way into its page. */
export function HorizonPulse({
  panelIds,
  viewModels,
}: {
  panelIds: readonly DashboardWidgetId[];
  viewModels: Partial<Record<DashboardWidgetId, DashboardWidgetViewModel>>;
}) {
  const items = PULSE_CANDIDATES.filter((candidate) => {
    const model = viewModels[candidate.id];
    if (!model || model.state === "unavailable") return false;
    return !candidate.requiresPanel || panelIds.includes(candidate.id);
  }).slice(0, 4);
  if (items.length === 0) return null;
  return (
    <section className={styles.pulse} aria-label="Studio pulse">
      {items.map((candidate) => {
        const model = viewModels[candidate.id] as DashboardWidgetViewModel;
        const href = DASHBOARD_WIDGET_BY_ID.get(candidate.id)?.sourceRoute ?? "/dashboard";
        const note =
          model.state === "loading"
            ? "Loading"
            : model.state === "error"
              ? "Could not load"
              : candidate.note(model);
        return (
          <Link
            key={candidate.id}
            href={href}
            className={styles.pulseItem}
            data-state={model.state}
          >
            <span className={styles.pulseLabel}>{candidate.label}</span>
            <PulseValue model={model} />
            <span className={styles.pulseNote}>{note}</span>
          </Link>
        );
      })}
    </section>
  );
}

/** Sunday to Saturday around the studio's business date, today marked. */
export function HorizonWeekStrip({ today }: { today: string }) {
  const week = horizonWeek(today);
  if (week.length === 0) return null;
  return (
    <ol className={styles.week} aria-label="This week">
      {week.map((day) => (
        <li key={day.iso} data-today={day.isToday ? "true" : undefined}>
          <span>{day.weekday}</span>
          <strong>{day.day}</strong>
          {day.isToday ? <span className="sr-only">Today</span> : null}
        </li>
      ))}
    </ol>
  );
}

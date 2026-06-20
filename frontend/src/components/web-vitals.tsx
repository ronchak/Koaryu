"use client";

import { useReportWebVitals } from "next/web-vitals";

type WebVitalMetric = Parameters<typeof useReportWebVitals>[0] extends (metric: infer Metric) => void
  ? Metric
  : never;

const DEBUG_FLAG = "koaryu:debug-performance";
const ENV_DEBUG_ENABLED = process.env.NEXT_PUBLIC_KOARYU_PERFORMANCE_DEBUG === "true";

function shouldLogVitals() {
  if (process.env.NODE_ENV !== "production" || ENV_DEBUG_ENABLED) {
    return true;
  }

  try {
    return window.localStorage.getItem(DEBUG_FLAG) === "true";
  } catch {
    return false;
  }
}

function reportMetric(metric: WebVitalMetric) {
  if (!shouldLogVitals()) {
    return;
  }

  console.info("[koaryu:web-vital]", {
    name: metric.name,
    value: Math.round(metric.value),
    delta: Math.round(metric.delta),
    rating: metric.rating,
    navigationType: metric.navigationType,
  });
}

export function WebVitals() {
  useReportWebVitals(reportMetric);
  return null;
}

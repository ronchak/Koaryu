"use client";

import { useReportWebVitals } from "next/web-vitals";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { configurePerformanceCollection, flushPerformanceMetrics, navigationTimer, recordPerformanceMetric, startMeasuredNavigation, stopMeasuredNavigation } from "@/lib/navigation-telemetry";
import { metricRoute, type PerformanceMetric } from "@/lib/performance-metrics";

let documentRoute: PerformanceMetric["route"] = "public";

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
  if (metric.name === "LCP" || metric.name === "INP" || metric.name === "CLS") {
    recordPerformanceMetric({ route: documentRoute, name: metric.name, value: metric.value, navigation: "document", outcome: "success" });
  }
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

export function WebVitals({ version }: { version: string | null }) {
  const pathname = usePathname();
  useEffect(() => {
    documentRoute = metricRoute(window.location.pathname);
    configurePerformanceCollection(version);
    if (!document.hidden) startMeasuredNavigation(window.location.pathname, "document", 0);
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-koaryu-navigation-link="true"]') : null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href);
      if (url.origin === window.location.origin && url.pathname !== window.location.pathname) startMeasuredNavigation(url.pathname, "link");
    };
    const onHistory = () => startMeasuredNavigation(window.location.pathname, "history");
    const onHide = () => { stopMeasuredNavigation("interrupted"); flushPerformanceMetrics(); };
    const onVisibility = () => { if (document.hidden) { stopMeasuredNavigation("interrupted"); flushPerformanceMetrics(); } };
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onHistory);
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onHistory);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      onHide();
    };
  }, [version]);
  useEffect(() => {
    if (["/503", "/504", "/502", "/login", "/access-denied", "/onboarding", "/account-archived", "/subscription-required"].includes(pathname)) stopMeasuredNavigation("redirect");
    else navigationTimer.stage(metricRoute(pathname), "commit");
  }, [pathname]);
  useReportWebVitals(reportMetric);
  return null;
}

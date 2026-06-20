import type { StudentListQuery } from "./student-list-page";

type PerfDetail = Record<string, string | number | boolean | null | undefined>;

const PREFIX = "koaryu.";
const DEBUG_FLAG = "koaryu:debug-performance";
const ENV_DEBUG_ENABLED = process.env.NEXT_PUBLIC_KOARYU_PERFORMANCE_DEBUG === "true";
let performanceSpanSequence = 0;

function canUsePerformance() {
  return typeof window !== "undefined" && typeof window.performance !== "undefined";
}

function isDebugEnabled() {
  if (process.env.NODE_ENV !== "production" || ENV_DEBUG_ENABLED) {
    return true;
  }

  try {
    return window.localStorage.getItem(DEBUG_FLAG) === "true";
  } catch {
    return false;
  }
}

function safeDetail(detail?: PerfDetail) {
  if (!detail) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(detail)
      .filter(([, value]) => value == null || ["string", "number", "boolean"].includes(typeof value))
      .map(([key, value]) => [key, value ?? null])
  );
}

function logPerformance(event: string, detail?: PerfDetail) {
  if (!canUsePerformance() || !isDebugEnabled()) {
    return;
  }

  console.info("[koaryu:performance]", {
    event,
    ...safeDetail(detail),
  });
}

export function markPerformance(name: string, detail?: PerfDetail) {
  if (!canUsePerformance()) {
    return;
  }

  const markName = `${PREFIX}${name}`;
  try {
    window.performance.mark(markName);
    logPerformance(name, detail);
  } catch {
    // Performance marks are observational only; never break product flows.
  }
}

export function measurePerformance(name: string, startName: string, endName?: string, detail?: PerfDetail) {
  if (!canUsePerformance()) {
    return;
  }

  const measureName = `${PREFIX}${name}`;
  const start = `${PREFIX}${startName}`;
  const end = endName ? `${PREFIX}${endName}` : undefined;

  try {
    window.performance.measure(measureName, start, end);
    const entries = window.performance.getEntriesByName(measureName, "measure");
    const latest = entries[entries.length - 1];
    logPerformance(name, {
      ...detail,
      duration_ms: latest ? Math.round(latest.duration) : null,
    });
  } catch {
    // Missing marks are acceptable during interrupted navigations.
  }
}

function nextPerformanceSpanId() {
  performanceSpanSequence = (performanceSpanSequence + 1) % Number.MAX_SAFE_INTEGER;
  return performanceSpanSequence.toString(36);
}

export function startPerformanceSpan(name: string, detail?: PerfDetail) {
  const spanId = nextPerformanceSpanId();
  const startName = `${name}.${spanId}.started`;
  const endName = `${name}.${spanId}.finished`;

  markPerformance(startName, { ...detail, span_id: spanId });

  return {
    id: spanId,
    finish(finishDetail?: PerfDetail) {
      const mergedDetail = { ...detail, ...finishDetail, span_id: spanId };
      markPerformance(endName, mergedDetail);
      measurePerformance(`${name}.duration`, startName, endName, mergedDetail);
    },
  };
}

export function startStudentPagePerformanceSpan(query: StudentListQuery = {}) {
  return startPerformanceSpan("students.page", {
    page: query.page || 1,
    page_size: query.pageSize || 50,
  });
}

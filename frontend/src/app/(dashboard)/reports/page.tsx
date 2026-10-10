"use client";
import { markDashboardReadiness } from "@/lib/performance";
import { useResumeRefresh } from "@/lib/use-resume-refresh";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DatasetReadinessErrorPanel } from "@/components/dataset-readiness-panel";
import { Header } from "@/components/header";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { ProgramBadge } from "@/components/programs/program-picker";
import { ReportsDataExportsPanel } from "@/components/reports/reports-data-exports-panel";
import {
  EmptyState,
  MetricCard,
  Panel,
  PanelHeader,
  ReportRowsLoading,
  ReportSessionCardsLoading,
  StatBadge,
} from "@/components/reports/reports-page-sections";
import {
  buildReportsPageModel,
  formatReportDate,
  formatReportPercent,
  subtractReportDays,
} from "@/lib/report-metrics";
import { loadedDataset, resolvePageDatasetReadiness } from "@/lib/page-dataset-readiness";
import { useRetainedState } from "@/lib/retained-state";
import {
  useConfigStore,
  useLeadStore,
  useProgramStore,
  useScheduleStore,
  useStudioStore,
} from "@/lib/store";
import { BarChart3, Calendar, TrendingUp, Users } from "lucide-react";

export default function ReportsPage() {
  const { businessDate, isPreviewMode, token } = useConfigStore();
  const { leads, leadsLoadError, leadsLoaded, refreshLeads } = useLeadStore();
  const { programs, programsLoadError, programsLoaded, refreshPrograms } = useProgramStore();
  const { attendance, refreshScheduleRange, sessions } = useScheduleStore();
  const [reportScheduleStatus, setReportScheduleStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [reportScheduleError, setReportScheduleError] = useState<string | null>(null);
  const reportScheduleRequestSeqRef = useRef(0);
  const reportScheduleRange = useMemo(
    () => ({ startDate: subtractReportDays(businessDate, 29), endDate: businessDate }),
    [businessDate],
  );
  const reportScheduleRangeKey = `${reportScheduleRange.startDate}:${reportScheduleRange.endDate}`;
  const [reportScheduleReadiness, setReportScheduleReadiness] = useRetainedState(
    `reports:schedule:${reportScheduleRangeKey}`,
    { key: reportScheduleRangeKey, loaded: false },
  );
  const reportScheduleReady =
    reportScheduleReadiness.key === reportScheduleRangeKey && reportScheduleReadiness.loaded;
  const refreshReportSchedule = useCallback(async () => {
    const requestSequence = reportScheduleRequestSeqRef.current + 1;
    reportScheduleRequestSeqRef.current = requestSequence;
    setReportScheduleError(null);
    setReportScheduleStatus("loading");
    try {
      await refreshScheduleRange(
        reportScheduleRange.startDate,
        reportScheduleRange.endDate,
        "read",
      );
      if (reportScheduleRequestSeqRef.current === requestSequence) {
        setReportScheduleReadiness((current) =>
          current.key === reportScheduleRangeKey
            ? { key: reportScheduleRangeKey, loaded: true }
            : current,
        );
        setReportScheduleStatus("ready");
      }
    } catch (error) {
      if (reportScheduleRequestSeqRef.current === requestSequence) {
        setReportScheduleError(
          error instanceof Error ? error.message : "Schedule could not be loaded.",
        );
        setReportScheduleStatus("error");
      }
      throw error;
    }
  }, [
    refreshScheduleRange,
    reportScheduleRange.endDate,
    reportScheduleRange.startDate,
    reportScheduleRangeKey,
    setReportScheduleReadiness,
  ]);

  useResumeRefresh(() =>
    Promise.allSettled([
      refreshReportSchedule(),
      refreshLeads(),
      refreshPrograms({ includeArchived: true }),
    ]),
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshReportSchedule().catch((error) => {
        console.error("Failed to load reports schedule range", error);
      });
    }, 0);
    return () => {
      reportScheduleRequestSeqRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [refreshReportSchedule]);
  const { currentRole, identityReady, identityGeneration } = useStudioStore();
  const {
    attendanceMetrics,
    leadMetrics,
    programAttendanceRows,
    programById,
    programLeadRows,
    sessionRows,
    lookbackStart,
    today,
    uniqueAttendees,
    visibleSessionRows,
  } = useMemo(
    () => buildReportsPageModel({ attendance, leads, programs, sessions, today: businessDate }),
    [attendance, businessDate, leads, programs, sessions],
  );
  const datasetReadiness = resolvePageDatasetReadiness([
    loadedDataset({ error: leadsLoadError, label: "Leads", loaded: leadsLoaded }),
    loadedDataset({ error: programsLoadError, label: "Programs", loaded: programsLoaded }),
    {
      error: reportScheduleError,
      label: "Schedule",
      status: reportScheduleError ? "error" : reportScheduleReady ? "ready" : "loading",
    },
  ]);
  const hasReportData = reportScheduleReady && leadsLoaded && programsLoaded;
  const isLoadingReport = !hasReportData && datasetReadiness.status === "loading";
  const retryReportsDatasets = useCallback(() => {
    void Promise.allSettled([
      refreshPrograms({ includeArchived: true }),
      refreshLeads(),
      refreshReportSchedule(),
    ]);
  }, [refreshLeads, refreshPrograms, refreshReportSchedule]);

  useEffect(
    () =>
      markDashboardReadiness("reports", identityGeneration, {
        useful: identityReady && datasetReadiness.status === "ready",
        complete:
          identityReady &&
          datasetReadiness.status === "ready" &&
          reportScheduleStatus !== "loading",
      }),
    [identityReady, identityGeneration, datasetReadiness.status, reportScheduleStatus],
  );

  if (!hasReportData && datasetReadiness.status === "error") {
    return (
      <OperationsSurface page="reports">
        <Header title="Reports" />
        <div className="flex-1 p-6 sm:p-8">
          <div className="max-w-6xl">
            <DatasetReadinessErrorPanel
              error={datasetReadiness.error || "Report data could not be loaded."}
              onRetry={retryReportsDatasets}
              title="Reports are unavailable"
            />
          </div>
        </div>
      </OperationsSurface>
    );
  }

  return (
    <OperationsSurface page="reports">
      <Header title="Reports" />
      <article
        className="flex-1 p-4 sm:p-8"
        data-reports-reading-document="true"
        aria-busy={isLoadingReport || reportScheduleStatus === "loading"}
      >
        <div className="mx-auto max-w-6xl space-y-8">
          {hasReportData && datasetReadiness.status === "error" && (
            <DatasetReadinessErrorPanel
              error={datasetReadiness.error || "Report data could not be refreshed."}
              onRetry={retryReportsDatasets}
              title="Reports could not refresh"
            />
          )}

          <section
            className="overflow-hidden bg-surface"
            aria-label="Report scope and method"
            data-report-method-sheet="true"
          >
            <div className="grid sm:grid-cols-3">
              <div className="border-b border-border px-4 py-4 sm:border-b-0 sm:border-r">
                <p className="text-xs font-medium text-muted">Lead scope</p>
                <p className="mt-2 text-sm text-text-primary">Current loaded pipeline snapshot</p>
              </div>
              <div className="border-b border-border px-4 py-4 sm:border-b-0 sm:border-r">
                <p className="text-xs font-medium text-muted">Attendance window</p>
                <p className="mt-2 text-sm tabular-nums text-text-primary">
                  {formatReportDate(lookbackStart)} – {formatReportDate(today)}
                </p>
              </div>
              <div className="px-4 py-4">
                <p className="text-xs font-medium text-muted">As of</p>
                <p className="mt-2 text-sm tabular-nums text-text-primary">
                  {formatReportDate(today)}
                </p>
              </div>
            </div>
            <p className="border-t border-border px-4 py-3 text-xs leading-5 text-text-secondary">
              Method: lead figures group the pipeline currently loaded for this studio and are not a
              30-day lead cohort. Attendance and utilization use non-canceled sessions dated inside
              the inclusive 30-calendar-day window; unique attendees use that same session set.
            </p>
          </section>

          {isLoadingReport && (
            <span role="status" aria-live="polite" className="sr-only">
              Loading report data...
            </span>
          )}
          <div
            className={`space-y-8 ${isLoadingReport ? "koaryu-skeleton-reveal" : ""}`}
            data-reports-loading={isLoadingReport ? "true" : undefined}
          >
            {/* ── Headline comparison figures ── */}
            <section
              className="grid gap-2 bg-surface p-2 md:grid-cols-2 xl:grid-cols-[1.2fr_0.8fr_1.2fr_0.8fr]"
              aria-label="Headline report figures"
              data-report-figure-band="comparisons"
            >
              <MetricCard
                loading={isLoadingReport}
                icon={BarChart3}
                label="Leads Captured"
                value={String(leadMetrics.totalLeads)}
                sub={`${leadMetrics.activePipelineLeads} still active in the funnel`}
              />
              <MetricCard
                loading={isLoadingReport}
                icon={TrendingUp}
                label="Lead Conversion"
                value={formatReportPercent(
                  leadMetrics.totalLeads > 0
                    ? leadMetrics.enrolledLeads / leadMetrics.totalLeads
                    : null,
                )}
                sub={`${leadMetrics.enrolledLeads} currently marked enrolled`}
              />
              <MetricCard
                loading={isLoadingReport}
                icon={Users}
                label="30-Day Attendance"
                value={String(attendanceMetrics.totalAttendance)}
                sub={`${Math.round(attendanceMetrics.averageAttendance || 0)} average check-ins per class`}
              />
              <MetricCard
                loading={isLoadingReport}
                icon={Calendar}
                label="Utilization"
                value={formatReportPercent(attendanceMetrics.utilizationRate)}
                sub={
                  attendanceMetrics.sessionsWithCapacity > 0
                    ? `${attendanceMetrics.sessionsWithCapacity} classes with capacity tracking`
                    : "Add class capacities to unlock utilization"
                }
              />
            </section>

            {/* ── Lead Funnel + Lead Sources ── */}
            <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
              <Panel>
                <PanelHeader
                  title="Lead Funnel"
                  subtitle="Current leads grouped by pipeline stage."
                >
                  {!isLoadingReport && (
                    <StatBadge>{leadMetrics.leadStageCounts.closed_lost} lost</StatBadge>
                  )}
                </PanelHeader>

                {isLoadingReport ? (
                  <ReportRowsLoading rows={5} funnel />
                ) : (
                  <div className="space-y-4">
                    {leadMetrics.funnelRows.map((row) => (
                      <div key={row.stage}>
                        <div className="flex items-center justify-between text-sm mb-2">
                          <span className="text-text-primary font-medium">{row.label}</span>
                          <span className="tabular-nums text-text-secondary">{row.count}</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-surface-raised">
                          <div
                            className="h-full bg-[var(--operations-cobalt)] transition-[width] duration-150"
                            style={{
                              width: `${Math.max(row.share * 100, row.count > 0 ? 10 : 0)}%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>

              <Panel>
                <PanelHeader
                  title="Lead Sources"
                  subtitle="Compare volume and enrolled outcomes by acquisition source."
                />

                {isLoadingReport ? (
                  <ReportRowsLoading rows={4} />
                ) : (
                  <div className="divide-y divide-border border-t border-border">
                    {leadMetrics.sourceRows.map((row) => (
                      <div key={row.source} className="flex items-start justify-between gap-4 py-4">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-text-primary">{row.label}</p>
                          <p className="text-xs text-text-secondary mt-1">
                            {row.active} active · {row.enrolled} enrolled
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-base font-semibold tabular-nums text-text-primary">
                            {row.total}
                          </p>
                          <p className="text-[11px] text-muted mt-0.5">
                            {formatReportPercent(row.conversionRate)} conv.
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </div>

            {/* ── Lead Programs + Program Attendance ── */}
            <div className="grid gap-6 xl:grid-cols-2">
              <Panel>
                <PanelHeader
                  title="Lead Programs"
                  subtitle="Pipeline demand grouped by selected program."
                />

                {isLoadingReport ? (
                  <ReportRowsLoading rows={3} />
                ) : programLeadRows.length === 0 ? (
                  <EmptyState message="Program selection will appear here as leads are captured." />
                ) : (
                  <div className="divide-y divide-border border-t border-border">
                    {programLeadRows.map((row) => (
                      <div
                        key={row.programId || row.label}
                        className="flex items-start justify-between gap-4 py-4"
                      >
                        <div className="min-w-0">
                          <ProgramBadge
                            program={row.programId ? programById.get(row.programId) : null}
                            fallback={row.label}
                          />
                          <p className="text-xs text-text-secondary mt-2">
                            {row.active} active · {row.enrolled} enrolled
                          </p>
                        </div>
                        <p className="shrink-0 text-base font-semibold tabular-nums text-text-primary">
                          {row.total}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>

              <Panel>
                <PanelHeader
                  title="Program Attendance"
                  subtitle="Last 30 days of class volume and check-ins by program."
                />

                {isLoadingReport ? (
                  <ReportRowsLoading rows={3} />
                ) : programAttendanceRows.length === 0 ? (
                  <EmptyState message="Program attendance will appear after classes are scheduled." />
                ) : (
                  <div className="divide-y divide-border border-t border-border">
                    {programAttendanceRows.map((row) => (
                      <div
                        key={row.programId || row.label}
                        className="flex items-start justify-between gap-4 py-4"
                      >
                        <div className="min-w-0">
                          <ProgramBadge
                            program={row.programId ? programById.get(row.programId) : null}
                            fallback={row.label}
                          />
                          <p className="text-xs text-text-secondary mt-2">
                            {row.sessions} sessions ·{" "}
                            {row.capacity > 0
                              ? `${formatReportPercent(row.attendanceWithCapacity / row.capacity)} utilization`
                              : "No capacity tracked"}
                          </p>
                        </div>
                        <p className="shrink-0 text-base font-semibold tabular-nums text-text-primary">
                          {row.attendance}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </div>

            {/* ── Attendance & Utilization Table ── */}
            <Panel>
              <PanelHeader
                title="Attendance & Utilization"
                subtitle={`Non-canceled sessions dated ${formatReportDate(lookbackStart)} through ${formatReportDate(today)}.`}
              >
                {!isLoadingReport && (
                  <div className="flex flex-wrap gap-2">
                    <StatBadge>{sessionRows.length} sessions</StatBadge>
                    <StatBadge>{uniqueAttendees} unique attendees</StatBadge>
                    <StatBadge>
                      {attendanceMetrics.totalCapacity > 0
                        ? `${attendanceMetrics.totalCapacity} total seats tracked`
                        : "No seat caps yet"}
                    </StatBadge>
                  </div>
                )}
              </PanelHeader>

              {!isLoadingReport && sessionRows.length === 0 ? (
                <EmptyState message="No classes have been scheduled in the last 30 days yet, so attendance and utilization metrics are still warming up." />
              ) : (
                <>
                  <table className="hidden min-w-full text-sm sm:table print:table">
                    <thead>
                      <tr className="border-y border-border text-left text-xs text-muted">
                        <th className="py-3 pl-5 pr-4 font-medium">Class</th>
                        <th className="py-3 pr-4 font-medium">Date</th>
                        <th className="py-3 pr-4 font-medium">Attendance</th>
                        <th className="py-3 pr-4 font-medium">Capacity</th>
                        <th className="py-3 pr-5 font-medium">Utilization</th>
                      </tr>
                    </thead>
                    <tbody>
                      {isLoadingReport
                        ? Array.from({ length: 5 }, (_, row) => (
                            <tr
                              key={row}
                              aria-hidden="true"
                              className="border-b border-border/50 last:border-0"
                            >
                              {Array.from({ length: 5 }, (_, column) => (
                                <td
                                  key={column}
                                  className={`py-3.5 pr-4 ${column === 0 ? "pl-5" : ""}`}
                                >
                                  <div className="h-5 w-3/4 rounded bg-surface-raised" />
                                </td>
                              ))}
                            </tr>
                          ))
                        : visibleSessionRows.map((session) => (
                            <tr
                              key={session.id}
                              className="border-b border-border/50 last:border-0 hover:bg-surface-raised/30 transition-colors"
                            >
                              <td className="py-3.5 pl-5 pr-4 text-text-primary font-medium">
                                {session.name}
                              </td>
                              <td className="py-3.5 pr-4 text-text-secondary">
                                {formatReportDate(session.date)}
                              </td>
                              <td className="py-3.5 pr-4 tabular-nums text-text-primary">
                                {session.attendees}
                              </td>
                              <td className="py-3.5 pr-4 tabular-nums text-text-secondary">
                                {session.capacity ?? "—"}
                              </td>
                              <td className="py-3.5 pr-5 tabular-nums text-text-secondary">
                                {formatReportPercent(session.utilization)}
                              </td>
                            </tr>
                          ))}
                    </tbody>
                  </table>
                  <div className="divide-y divide-border border-y border-border sm:hidden print:hidden">
                    {isLoadingReport ? (
                      <ReportSessionCardsLoading rows={5} />
                    ) : (
                      visibleSessionRows.map((session) => (
                        <dl
                          key={session.id}
                          className="grid grid-cols-2 gap-x-3 gap-y-2 py-4 text-sm"
                        >
                          <div className="col-span-2">
                            <dt className="text-xs text-muted">Class</dt>
                            <dd className="mt-1 font-medium text-text-primary">{session.name}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted">Date</dt>
                            <dd className="mt-1 text-text-secondary">
                              {formatReportDate(session.date)}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted">Attendance</dt>
                            <dd className="mt-1 tabular-nums text-text-primary">
                              {session.attendees}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted">Capacity</dt>
                            <dd className="mt-1 tabular-nums text-text-secondary">
                              {session.capacity ?? "—"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted">Utilization</dt>
                            <dd className="mt-1 tabular-nums text-text-secondary">
                              {formatReportPercent(session.utilization)}
                            </dd>
                          </div>
                        </dl>
                      ))
                    )}
                  </div>
                </>
              )}
            </Panel>
          </div>

          <ReportsDataExportsPanel
            isPreviewMode={isPreviewMode}
            token={token}
            currentRole={currentRole}
          />
        </div>
      </article>
    </OperationsSurface>
  );
}

"use client";
import { markDashboardReadiness } from "@/lib/performance";
import { useResumeRefresh } from "@/lib/use-resume-refresh";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DatasetReadinessErrorPanel } from "@/components/dataset-readiness-panel";
import { Header } from "@/components/header";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { ProgramBadge } from "@/components/programs/program-picker";
import { ReportsDataExportsPanel } from "@/components/reports/reports-data-exports-panel";
import styles from "@/components/reports/reports.module.css";
import { HorizonPage } from "@/components/ui/horizon";
import {
  BarList,
  BarRow,
  EmptyState,
  MetricBand,
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

const REPORTS_DESCRIPTION = "Where the lead pipeline stands, and how classes filled over the last 30 days.";

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
        <Header title="Reports" description={REPORTS_DESCRIPTION} />
        <HorizonPage>
          <DatasetReadinessErrorPanel
            error={datasetReadiness.error || "Report data could not be loaded."}
            onRetry={retryReportsDatasets}
            title="Reports are unavailable"
          />
        </HorizonPage>
      </OperationsSurface>
    );
  }

  const funnelPeak = Math.max(1, ...leadMetrics.funnelRows.map((row) => row.count));
  const sourcePeak = Math.max(1, ...leadMetrics.sourceRows.map((row) => row.total));
  const programLeadPeak = Math.max(1, ...programLeadRows.map((row) => row.total));
  const programAttendancePeak = Math.max(1, ...programAttendanceRows.map((row) => row.attendance));

  return (
    <OperationsSurface page="reports">
      <Header title="Reports" description={REPORTS_DESCRIPTION} />
      <article
        className={styles.document}
        data-reports-reading-document="true"
        aria-busy={isLoadingReport || reportScheduleStatus === "loading"}
      >
        <HorizonPage>
          <div
            className={`space-y-5 ${isLoadingReport ? "koaryu-skeleton-reveal" : ""}`}
            data-reports-loading={isLoadingReport ? "true" : undefined}
          >
            {/* ── Headline figures: the strip on the header's ridge ── */}
            <MetricBand label="Headline report figures">
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
            </MetricBand>

            {hasReportData && datasetReadiness.status === "error" && (
              <DatasetReadinessErrorPanel
                error={datasetReadiness.error || "Report data could not be refreshed."}
                onRetry={retryReportsDatasets}
                title="Reports could not refresh"
              />
            )}

            {/* ── Lead Funnel + Lead Sources ── */}
            <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
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
                  <BarList>
                    {leadMetrics.funnelRows.map((row) => (
                      <BarRow
                        key={row.stage}
                        label={row.label}
                        share={row.count / funnelPeak}
                        value={row.count}
                      />
                    ))}
                  </BarList>
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
                  <BarList>
                    {leadMetrics.sourceRows.map((row) => (
                      <BarRow
                        key={row.source}
                        label={row.label}
                        meta={`${row.active} active · ${row.enrolled} enrolled`}
                        share={row.total / sourcePeak}
                        value={row.total}
                        valueNote={`${formatReportPercent(row.conversionRate)} conv.`}
                      />
                    ))}
                  </BarList>
                )}
              </Panel>
            </div>

            {/* ── Lead Programs + Program Attendance ── */}
            <div className="grid gap-5 xl:grid-cols-2">
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
                  <BarList>
                    {programLeadRows.map((row) => (
                      <BarRow
                        key={row.programId || row.label}
                        label={
                          <ProgramBadge
                            program={row.programId ? programById.get(row.programId) : null}
                            fallback={row.label}
                          />
                        }
                        meta={`${row.active} active · ${row.enrolled} enrolled`}
                        share={row.total / programLeadPeak}
                        value={row.total}
                      />
                    ))}
                  </BarList>
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
                  <BarList>
                    {programAttendanceRows.map((row) => (
                      <BarRow
                        key={row.programId || row.label}
                        label={
                          <ProgramBadge
                            program={row.programId ? programById.get(row.programId) : null}
                            fallback={row.label}
                          />
                        }
                        meta={`${row.sessions} sessions · ${
                          row.capacity > 0
                            ? `${formatReportPercent(row.attendanceWithCapacity / row.capacity)} utilization`
                            : "No capacity tracked"
                        }`}
                        share={row.attendance / programAttendancePeak}
                        value={row.attendance}
                        valueNote="check-ins"
                      />
                    ))}
                  </BarList>
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
                  <>
                    <StatBadge>{sessionRows.length} sessions</StatBadge>
                    <StatBadge>{uniqueAttendees} unique attendees</StatBadge>
                    <StatBadge>
                      {attendanceMetrics.totalCapacity > 0
                        ? `${attendanceMetrics.totalCapacity} total seats tracked`
                        : "No seat caps yet"}
                    </StatBadge>
                  </>
                )}
              </PanelHeader>

              {!isLoadingReport && sessionRows.length === 0 ? (
                <EmptyState message="No classes have been scheduled in the last 30 days yet, so attendance and utilization metrics are still warming up." />
              ) : (
                <>
                  <table className={`hidden sm:table print:table ${styles.table}`}>
                    <thead>
                      <tr>
                        <th scope="col">Class</th>
                        <th scope="col">Date</th>
                        <th scope="col" className={styles.num}>
                          Attendance
                        </th>
                        <th scope="col" className={styles.num}>
                          Capacity
                        </th>
                        <th scope="col" className={styles.num}>
                          Utilization
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {isLoadingReport
                        ? Array.from({ length: 5 }, (_, row) => (
                            <tr key={row} aria-hidden="true">
                              {Array.from({ length: 5 }, (_, column) => (
                                <td key={column}>
                                  <div className="h-5 w-3/4 rounded-md bg-surface-raised" />
                                </td>
                              ))}
                            </tr>
                          ))
                        : visibleSessionRows.map((session) => (
                            <tr key={session.id}>
                              <td className="font-semibold text-text-primary">{session.name}</td>
                              <td className="tabular-nums text-text-secondary">
                                {formatReportDate(session.date)}
                              </td>
                              <td className={`${styles.num} font-semibold text-text-primary`}>
                                {session.attendees}
                              </td>
                              <td className={`${styles.num} text-text-secondary`}>
                                {session.capacity ?? "—"}
                              </td>
                              <td className={`${styles.num} text-text-secondary`}>
                                {formatReportPercent(session.utilization)}
                              </td>
                            </tr>
                          ))}
                    </tbody>
                  </table>
                  <div className="divide-y divide-border sm:hidden print:hidden">
                    {isLoadingReport ? (
                      <ReportSessionCardsLoading rows={5} />
                    ) : (
                      visibleSessionRows.map((session) => (
                        <dl
                          key={session.id}
                          className="grid grid-cols-3 gap-x-3 gap-y-2 py-3.5 text-sm"
                        >
                          <div className="col-span-3 flex items-baseline justify-between gap-3">
                            <dt className="sr-only">Class</dt>
                            <dd className="font-semibold text-text-primary">{session.name}</dd>
                            <dt className="sr-only">Date</dt>
                            <dd className="shrink-0 tabular-nums text-text-secondary">
                              {formatReportDate(session.date)}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted">Attendance</dt>
                            <dd className="mt-0.5 font-semibold tabular-nums text-text-primary">
                              {session.attendees}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted">Capacity</dt>
                            <dd className="mt-0.5 tabular-nums text-text-secondary">
                              {session.capacity ?? "—"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted">Utilization</dt>
                            <dd className="mt-0.5 tabular-nums text-text-secondary">
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
          {isLoadingReport && (
            <span role="status" aria-live="polite" className="sr-only">
              Loading report data...
            </span>
          )}

          <section
            className={styles.panel}
            aria-label="Report scope and method"
            data-report-method-sheet="true"
          >
            <div className={styles.method}>
              <div>
                <p className={styles.methodLabel}>Lead scope</p>
                <p className={styles.methodValue}>Current loaded pipeline snapshot</p>
              </div>
              <div>
                <p className={styles.methodLabel}>Attendance window</p>
                <p className={styles.methodValue}>
                  {formatReportDate(lookbackStart)} – {formatReportDate(today)}
                </p>
              </div>
              <div>
                <p className={styles.methodLabel}>As of</p>
                <p className={styles.methodValue}>{formatReportDate(today)}</p>
              </div>
            </div>
            <p className={styles.methodNote}>
              Method: lead figures group the pipeline currently loaded for this studio and are not a
              30-day lead cohort. Attendance and utilization use non-canceled sessions dated inside
              the inclusive 30-calendar-day window; unique attendees use that same session set.
            </p>
          </section>

          <ReportsDataExportsPanel
            isPreviewMode={isPreviewMode}
            token={token}
            currentRole={currentRole}
          />
        </HorizonPage>
      </article>
    </OperationsSurface>
  );
}

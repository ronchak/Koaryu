"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DashboardLoadingSkeleton } from "@/components/dashboard-loading-skeleton";
import { DatasetReadinessErrorPanel } from "@/components/dataset-readiness-panel";
import { Header } from "@/components/header";
import { ProgramBadge } from "@/components/programs/program-picker";
import { ReportsDataExportsPanel } from "@/components/reports/reports-data-exports-panel";
import {
  EmptyState,
  MetricCard,
  Panel,
  PanelHeader,
  StatBadge,
} from "@/components/reports/reports-page-sections";
import {
  buildReportsPageModel,
  formatReportDate,
  formatReportPercent,
  subtractReportDays,
} from "@/lib/report-metrics";
import { toLocalDateKey } from "@/lib/date";
import { loadedDataset, resolvePageDatasetReadiness } from "@/lib/page-dataset-readiness";
import { useConfigStore, useLeadStore, useProgramStore, useScheduleStore, useStudioStore } from "@/lib/store";
import { BarChart3, Calendar, TrendingUp, Users } from "lucide-react";

export default function ReportsPage() {
  const { isPreviewMode, token } = useConfigStore();
  const { leads, leadsLoadError, leadsLoaded, refreshLeads } = useLeadStore();
  const { programs, programsLoadError, programsLoaded, refreshPrograms } = useProgramStore();
  const {
    attendance,
    refreshScheduleRange,
    sessions,
  } = useScheduleStore();
  const [reportScheduleStatus, setReportScheduleStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [reportScheduleError, setReportScheduleError] = useState<string | null>(null);
  const reportScheduleRequestSeqRef = useRef(0);
  const reportScheduleRange = useMemo(() => {
    const today = toLocalDateKey();
    return { startDate: subtractReportDays(today, 29), endDate: today };
  }, []);
  const refreshReportSchedule = useCallback(async () => {
    const requestSequence = reportScheduleRequestSeqRef.current + 1;
    reportScheduleRequestSeqRef.current = requestSequence;
    setReportScheduleError(null);
    setReportScheduleStatus("loading");
    try {
      await refreshScheduleRange(
        reportScheduleRange.startDate,
        reportScheduleRange.endDate
      );
      if (reportScheduleRequestSeqRef.current === requestSequence) {
        setReportScheduleStatus("ready");
      }
    } catch (error) {
      if (reportScheduleRequestSeqRef.current === requestSequence) {
        setReportScheduleError(
          error instanceof Error ? error.message : "Schedule could not be loaded."
        );
        setReportScheduleStatus("error");
      }
      throw error;
    }
  }, [refreshScheduleRange, reportScheduleRange.endDate, reportScheduleRange.startDate]);

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
  const { currentRole } = useStudioStore();
  const canExportStudioData = currentRole === "admin" || currentRole === "front_desk";
  const {
    attendanceMetrics,
    leadMetrics,
    programAttendanceRows,
    programById,
    programLeadRows,
    sessionRows,
    uniqueAttendees,
    visibleSessionRows,
  } = useMemo(
    () => buildReportsPageModel({ attendance, leads, programs, sessions }),
    [attendance, leads, programs, sessions]
  );
  const datasetReadiness = resolvePageDatasetReadiness([
    loadedDataset({ error: leadsLoadError, label: "Leads", loaded: leadsLoaded }),
    loadedDataset({ error: programsLoadError, label: "Programs", loaded: programsLoaded }),
    { error: reportScheduleError, label: "Schedule", status: reportScheduleStatus },
  ]);
  const retryReportsDatasets = useCallback(() => {
    void Promise.allSettled([
      refreshPrograms({ includeArchived: true }),
      refreshLeads(),
      refreshReportSchedule(),
    ]);
  }, [refreshLeads, refreshPrograms, refreshReportSchedule]);

  if (datasetReadiness.status === "loading") {
    return (
      <DashboardLoadingSkeleton
        title="Reports"
        description="Loading studio reporting panels and export controls."
        variant="table"
      />
    );
  }

  if (datasetReadiness.status === "error") {
    return (
      <>
        <Header
          title="Reports"
          description="Live lead funnel, source, and attendance trends for the current studio."
        />
        <div className="flex-1 p-6 sm:p-8">
          <div className="max-w-6xl">
            <DatasetReadinessErrorPanel
              error={datasetReadiness.error || "Report data could not be loaded."}
              onRetry={retryReportsDatasets}
              title="Reports are unavailable"
            />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header
        title="Reports"
        description="Live lead funnel, source, and attendance trends for the current studio."
      />

      <div className="flex-1 p-6 sm:p-8">
        <div className="max-w-6xl space-y-6">

          {/* ── Metric Cards ── */}
          <div className="grid gap-px bg-border md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              icon={BarChart3}
              label="Leads Captured"
              value={String(leadMetrics.totalLeads)}
              sub={`${leadMetrics.activePipelineLeads} still active in the funnel`}
              accent="#8B5CF6"
            />
            <MetricCard
              icon={TrendingUp}
              label="Lead Conversion"
              value={formatReportPercent(
                leadMetrics.totalLeads > 0
                  ? leadMetrics.enrolledLeads / leadMetrics.totalLeads
                  : null
              )}
              sub={`${leadMetrics.enrolledLeads} currently marked enrolled`}
              accent="#22C55E"
            />
            <MetricCard
              icon={Users}
              label="30-Day Attendance"
              value={String(attendanceMetrics.totalAttendance)}
              sub={`${Math.round(attendanceMetrics.averageAttendance || 0)} average check-ins per class`}
              accent="#3B82F6"
            />
            <MetricCard
              icon={Calendar}
              label="Utilization"
              value={formatReportPercent(attendanceMetrics.utilizationRate)}
              sub={
                attendanceMetrics.sessionsWithCapacity > 0
                  ? `${attendanceMetrics.sessionsWithCapacity} classes with capacity tracking`
                  : "Add class capacities to unlock utilization"
              }
              accent="#F59E0B"
            />
          </div>

          {/* ── Lead Funnel + Lead Sources ── */}
          <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
            <Panel>
              <PanelHeader
                title="Lead Funnel"
                subtitle="Current leads grouped by pipeline stage."
              >
                <StatBadge>{leadMetrics.leadStageCounts.closed_lost} lost</StatBadge>
              </PanelHeader>

              <div className="space-y-4">
                {leadMetrics.funnelRows.map((row) => (
                  <div key={row.stage}>
                    <div className="flex items-center justify-between text-sm mb-2">
                      <span className="text-text-primary font-medium">{row.label}</span>
                      <span className="font-mono text-text-secondary">{row.count}</span>
                    </div>
                    <div className="h-1.5 bg-surface-raised overflow-hidden">
                      <div
                        className="h-full bg-accent transition-[width] duration-150"
                        style={{ width: `${Math.max(row.share * 100, row.count > 0 ? 10 : 0)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel>
              <PanelHeader
                title="Lead Sources"
                subtitle="Compare volume and enrolled outcomes by acquisition source."
              />

              <div className="divide-y divide-border border-t border-border">
                {leadMetrics.sourceRows.map((row) => (
                  <div
                    key={row.source}
                    className="flex items-start justify-between gap-4 py-4"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{row.label}</p>
                      <p className="text-xs text-text-secondary mt-1">
                        {row.active} active · {row.enrolled} enrolled
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-base font-mono font-semibold text-text-primary">{row.total}</p>
                      <p className="text-[11px] text-muted mt-0.5">
                        {formatReportPercent(row.conversionRate)} conv.
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>

          {/* ── Lead Programs + Program Attendance ── */}
          <div className="grid gap-6 xl:grid-cols-2">
            <Panel>
              <PanelHeader
                title="Lead Programs"
                subtitle="Pipeline demand grouped by selected program."
              />

              {programLeadRows.length === 0 ? (
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
                      <p className="text-base font-mono font-semibold text-text-primary shrink-0">
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

              {programAttendanceRows.length === 0 ? (
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
                          {row.sessions} sessions · {row.capacity > 0 ? `${formatReportPercent(row.attendance / row.capacity)} utilization` : "No capacity tracked"}
                        </p>
                      </div>
                      <p className="text-base font-mono font-semibold text-text-primary shrink-0">
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
              subtitle="Last 30 days of completed or elapsed classes."
            >
              <div className="flex flex-wrap gap-2">
                <StatBadge>{sessionRows.length} sessions</StatBadge>
                <StatBadge>{uniqueAttendees} unique attendees</StatBadge>
                <StatBadge>
                  {attendanceMetrics.totalCapacity > 0 ? `${attendanceMetrics.totalCapacity} total seats tracked` : "No seat caps yet"}
                </StatBadge>
              </div>
            </PanelHeader>

            {sessionRows.length === 0 ? (
              <EmptyState message="No classes have been scheduled in the last 30 days yet, so attendance and utilization metrics are still warming up." />
            ) : (
              <div className="overflow-x-auto -mx-5">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-y border-border text-left text-[11px] uppercase tracking-widest text-muted">
                      <th className="py-3 pl-5 pr-4 font-medium">Class</th>
                      <th className="py-3 pr-4 font-medium">Date</th>
                      <th className="py-3 pr-4 font-medium">Attendance</th>
                      <th className="py-3 pr-4 font-medium">Capacity</th>
                      <th className="py-3 pr-5 font-medium">Utilization</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleSessionRows.map((session) => (
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
                        <td className="py-3.5 pr-4 font-mono text-text-primary">
                          {session.attendees}
                        </td>
                        <td className="py-3.5 pr-4 font-mono text-text-secondary">
                          {session.capacity ?? "—"}
                        </td>
                        <td className="py-3.5 pr-5 font-mono text-text-secondary">
                          {formatReportPercent(session.utilization)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <ReportsDataExportsPanel
            isPreviewMode={isPreviewMode}
            token={token}
            canExportStudioData={canExportStudioData}
          />
        </div>
      </div>
    </>
  );
}

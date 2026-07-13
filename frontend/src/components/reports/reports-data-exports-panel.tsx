"use client";

import { useId, useState, type ReactNode } from "react";
import { Download, FileText, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { toLocalDateKey } from "@/lib/date";

type ExportReport = {
  id: string;
  title: string;
  description: string;
};

type ExportGroup = {
  title: string;
  emphasis?: boolean;
  reports: ExportReport[];
};

const EXPORT_GROUPS: ExportGroup[] = [
  {
    title: "Owner Intelligence",
    emphasis: true,
    reports: [
      { id: "owner_kpi_summary", title: "Owner KPI Summary", description: "Active students, new joins, attendance, utilization, conversion, MRR, open invoice exposure, and failed-payment pressure." },
      { id: "quiet_churn_watchlist", title: "Quiet Churn Watchlist", description: "Active students whose attendance, billing, or progress signals suggest they may be drifting before they cancel." },
      { id: "first_90_days_onboarding", title: "First 90 Days Onboarding", description: "New students by habit formation: first visit, first week, first month, first five classes, and recommended follow-up." },
      { id: "lead_quality_after_enrollment", title: "Lead Quality After Enrollment", description: "Lead sources ranked by conversion, active converted students, first-month attendance, and collected payment value." },
      { id: "belt_momentum_testing_pipeline", title: "Belt Momentum and Testing Pipeline", description: "Students by current rank, next rank, classes and days at rank, eligibility requirements, and testing-readiness status." },
      { id: "revenue_leakage", title: "Revenue Leakage", description: "Active students, enrollments, invoices, and failed payments that may be causing missed or delayed revenue." },
      { id: "schedule_utilization_demand", title: "Schedule Utilization and Demand", description: "Class demand by program, class name, and start time using attendance, capacity, cancellation, and trend signals." },
      { id: "family_account_health", title: "Family Account Health", description: "Household-level risk using payer balance, contact completeness, active students, recent visits, and at-risk students." },
      { id: "lifecycle_segmentation", title: "Lifecycle Segmentation", description: "Students grouped into first-90-days, core engaged, active light, quiet, at-risk, paused, or inactive/canceled segments." },
      { id: "instructor_staff_impact", title: "Instructor and Staff Impact", description: "Instructor class attendance and utilization alongside assigned lead conversion where staff IDs are present." },
      { id: "data_hygiene_readiness", title: "Data Hygiene and Studio Readiness", description: "Missing guardians, emergency contacts, program/rank assignments, billing enrollments, payer contact details, and lead follow-ups." },
    ],
  },
  {
    title: "Student Records",
    reports: [
      { id: "students", title: "Students", description: "Roster, contact details, holds, tags, notes, photos, and soft-delete state." },
      { id: "guardian_contacts", title: "Guardians and Contacts", description: "Guardian records linked back to each student relationship." },
      { id: "student_program_memberships", title: "Program Enrollments", description: "Per-student program memberships and current rank assignments." },
    ],
  },
  {
    title: "Growth",
    reports: [
      { id: "leads", title: "Leads", description: "Pipeline stage, source, program interest, follow-up, guardian, and conversion fields." },
      { id: "lead_activities", title: "Lead Activities", description: "Notes, calls, meetings, emails, follow-ups, and stage-change history." },
    ],
  },
  {
    title: "Programs and Ranks",
    reports: [
      { id: "programs", title: "Programs", description: "Program setup, colors, ordering, archived state, and system flags." },
      { id: "belt_ladders", title: "Belt Ladders", description: "Rank ladder definitions and per-ladder sub-rank terminology." },
      { id: "belt_ranks", title: "Belt Ranks", description: "Belt and stripe/tip requirements, ordering, colors, and approval rules." },
      { id: "promotions", title: "Promotion History", description: "Immutable promotion records, rank changes, notes, and approving staff IDs." },
    ],
  },
  {
    title: "Schedule",
    reports: [
      { id: "class_templates", title: "Recurring Class Templates", description: "Weekly schedule definitions, dates, capacity, program, and instructor IDs." },
      { id: "class_sessions", title: "Class Sessions", description: "Individual class occurrences, status, notes, capacity, and soft-delete state." },
      { id: "attendance", title: "Attendance Records", description: "Check-ins, absences, cross-program credit, eligibility overrides, and staff IDs." },
    ],
  },
  {
    title: "Administration",
    reports: [
      { id: "studio_overview", title: "Studio Overview", description: "Studio profile, Koaryu subscription state, and payment-account readiness." },
      { id: "staff_roles", title: "Staff Roles", description: "Staff membership, role, invitation, profile, and last sign-in details." },
      { id: "audit_logs", title: "Audit Logs", description: "Sensitive action history with actor IDs, entity IDs, and metadata." },
      { id: "email_usage_events", title: "Email Usage", description: "Email usage events, recipients, provider IDs, quantities, and metadata." },
      { id: "student_import_runs", title: "Student Import Runs", description: "CSV import idempotency keys, request hashes, results, and errors." },
      { id: "export_jobs", title: "Export Jobs", description: "Queued async export requests and their status history." },
    ],
  },
];

function fallbackCsvFilename(reportId: string) {
  const date = toLocalDateKey();
  return `koaryu-${reportId.replace(/_/g, "-")}-${date}.csv`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function ExportStatBadge({ children }: { children: ReactNode }) {
  return (
    <span className="border border-border bg-surface-raised px-2 py-1 text-xs text-text-secondary">
      {children}
    </span>
  );
}

function ExportPanelHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-5">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {subtitle && (
          <p className="text-xs text-text-secondary mt-1 leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

function ExportGroupDisclosure({
  group,
  exportingReportId,
  isPreviewMode,
  canExportStudioData,
  onDownload,
}: {
  group: ExportGroup;
  exportingReportId: string | null;
  isPreviewMode: boolean;
  canExportStudioData: boolean;
  onDownload: (report: ExportReport) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const panelId = useId();
  const headerClassName = group.emphasis
    ? "relative flex w-full cursor-pointer items-start justify-between gap-4 py-4 pl-4 pr-1 text-left before:absolute before:left-0 before:top-4 before:bottom-4 before:w-[2px] before:rounded-full before:bg-accent"
    : "flex w-full cursor-pointer items-start justify-between gap-4 py-4 text-left";

  return (
    <section className="faq-item" data-state={isOpen ? "open" : "closed"}>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        className={headerClassName}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="flex min-w-0 items-start gap-3">
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-text-primary">
              {group.title}
            </span>
            <span className="mt-1 block text-xs text-text-secondary">
              {group.reports.length} CSV export{group.reports.length === 1 ? "" : "s"}
            </span>
          </span>
        </span>
        <Plus className="faq-icon mt-0.5 h-4 w-4 shrink-0 text-accent" />
      </button>

      <div id={panelId} className="faq-body" aria-hidden={!isOpen}>
        <div>
          <div className="divide-y divide-border border-t border-border pb-2">
            {group.reports.map((report) => {
              const isExporting = exportingReportId === report.id;
              const isDisabled = Boolean(exportingReportId) || isPreviewMode || !canExportStudioData;

              return (
                <div
                  key={report.id}
                  className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">{report.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                      {report.description}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="w-full shrink-0 sm:w-[118px]"
                    isLoading={isExporting}
                    disabled={isDisabled}
                    onClick={() => onDownload(report)}
                  >
                    {!isExporting ? <Download className="h-3.5 w-3.5" /> : null}
                    CSV
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

export function ReportsDataExportsPanel({
  isPreviewMode,
  token,
  canExportStudioData,
}: {
  isPreviewMode: boolean;
  token: string | null;
  canExportStudioData: boolean;
}) {
  const [exportingReportId, setExportingReportId] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState("");
  const [exportError, setExportError] = useState("");

  async function handleDownloadReport(report: ExportReport) {
    setExportError("");
    setExportMessage("");

    if (isPreviewMode) {
      setExportError("Live CSV exports are available when Koaryu is connected to a studio database.");
      return;
    }

    if (!canExportStudioData) {
      setExportError("Only admins and front desk staff can export studio data.");
      return;
    }

    if (!token) {
      setExportError("Sign in again before exporting CSVs.");
      return;
    }

    setExportingReportId(report.id);
    try {
      const { blob, filename } = await api.download(`/reports/exports/${report.id}`, token, {
        timeoutMs: 60000,
        timeoutMessage: "CSV export is taking longer than expected. Please try again.",
      });
      downloadBlob(blob, filename || fallbackCsvFilename(report.id));
      setExportMessage(`${report.title} CSV downloaded.`);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "CSV export failed.");
    } finally {
      setExportingReportId(null);
    }
  }

  return (
    <section className="bg-surface border border-border p-5">
      <ExportPanelHeader
        title="Data Exports"
        subtitle="Separate CSV downloads for the core records owned by this studio."
      >
        <ExportStatBadge>
          {EXPORT_GROUPS.reduce((count, group) => count + group.reports.length, 0)} CSV reports
        </ExportStatBadge>
      </ExportPanelHeader>

      {exportMessage ? (
        <div className="mb-4 border border-success/20 bg-success/10 px-4 py-3 text-sm text-success">
          {exportMessage}
        </div>
      ) : null}

      {exportError ? (
        <div className="mb-4 border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
          {exportError}
        </div>
      ) : null}

      <div className="divide-y divide-border border-y border-border">
        {EXPORT_GROUPS.map((group) => (
          <ExportGroupDisclosure
            key={group.title}
            group={group}
            exportingReportId={exportingReportId}
            isPreviewMode={isPreviewMode}
            canExportStudioData={canExportStudioData}
            onDownload={(report) => void handleDownloadReport(report)}
          />
        ))}
      </div>
    </section>
  );
}

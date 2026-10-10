import type { ElementType, ReactNode } from "react";

export function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  loading = false,
}: {
  icon: ElementType;
  label: string;
  value: string;
  sub: string;
  loading?: boolean;
}) {
  return (
    <figure className="bg-surface p-4" data-report-figure="headline">
      <div className="flex items-center gap-3 mb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-raised text-accent">
          <Icon className="h-4 w-4" />
        </div>
        <span className="text-xs font-medium text-text-secondary">{label}</span>
      </div>
      {loading ? (
        <div aria-hidden="true">
          <div className="h-[30px] w-20 rounded bg-surface-raised" />
          <div className="mt-2 h-[19.5px] w-3/4 rounded bg-surface-raised" />
        </div>
      ) : (
        <>
          <p className="text-3xl font-semibold tabular-nums text-text-primary leading-none">
            {value}
          </p>
          <p className="text-xs text-muted mt-2 leading-relaxed">{sub}</p>
        </>
      )}
    </figure>
  );
}

export function ReportRowsLoading({ rows, funnel = false }: { rows: number; funnel?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={funnel ? "space-y-4" : "divide-y divide-border border-t border-border"}
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={funnel ? "" : "py-4"}>
          <div className={`h-5 w-3/4 rounded bg-surface-raised ${funnel ? "mb-2" : ""}`} />
          <div
            className={
              funnel
                ? "h-1.5 rounded-full bg-surface-raised"
                : "mt-1 h-3 w-1/2 rounded bg-surface-raised"
            }
          />
        </div>
      ))}
    </div>
  );
}

export function ReportSessionCardsLoading({ rows }: { rows: number }) {
  return Array.from({ length: rows }, (_, index) => (
    <dl key={index} aria-hidden="true" className="grid grid-cols-2 gap-x-3 gap-y-2 py-4 text-sm">
      {["Class", "Date", "Attendance", "Capacity", "Utilization"].map((label, column) => (
        <div key={label} className={column === 0 ? "col-span-2" : undefined}>
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="mt-1 h-5 w-3/4 rounded bg-surface-raised" />
        </div>
      ))}
    </dl>
  ));
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`bg-surface p-4 ${className}`} data-report-section="reading-block">
      {children}
    </section>
  );
}

export function PanelHeader({
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
        {subtitle && <p className="text-xs text-text-secondary mt-1 leading-relaxed">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-[10px] bg-surface-raised/40 px-4 py-4 text-sm text-text-secondary">
      {message}
    </div>
  );
}

export function StatBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-surface-raised px-2 py-1 text-xs text-text-secondary">
      {children}
    </span>
  );
}

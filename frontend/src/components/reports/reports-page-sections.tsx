import type { ElementType, ReactNode } from "react";
import { CalmState, ToneTag } from "@/components/ui/horizon";
import styles from "./reports.module.css";

/** One headline figure in the stats strip that opens the report. */
export function MetricCard({
  label,
  value,
  sub,
  loading = false,
}: {
  /** Kept for callers; the strip reads as numbers first, so no icon is drawn. */
  icon?: ElementType;
  label: string;
  value: string;
  sub: string;
  loading?: boolean;
}) {
  return (
    <figure className={styles.figure} data-report-figure="headline">
      <figcaption className={styles.figureLabel}>{label}</figcaption>
      {loading ? (
        <div aria-hidden="true">
          <span className={styles.pending} style={{ width: "3.25rem", height: "1.9rem" }} />
          <span className={styles.pending} style={{ width: "75%", height: "1rem", marginTop: 6 }} />
        </div>
      ) : (
        <>
          <p className={styles.figureValue}>{value}</p>
          <p className={styles.figureNote}>{sub}</p>
        </>
      )}
    </figure>
  );
}

export function MetricBand({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className={styles.figures} aria-label={label} data-report-figure-band="comparisons">
      {children}
    </section>
  );
}

/** A labelled single-series bar: the value is written beside it, the bar only shows scale. */
export function BarRow({
  label,
  meta,
  share,
  value,
  valueNote,
}: {
  label: ReactNode;
  meta?: ReactNode;
  /** 0..1 of the panel's largest value. */
  share: number;
  value: ReactNode;
  valueNote?: ReactNode;
}) {
  const width = Math.max(0, Math.min(1, share)) * 100;
  return (
    <li className={styles.barRow}>
      <div className={styles.barText}>
        <span className={styles.barLabel}>
          {label}
          {meta ? <span className={styles.barMeta}>{meta}</span> : null}
        </span>
        <span className={styles.barValue}>
          {value}
          {valueNote ? <small>{valueNote}</small> : null}
        </span>
      </div>
      <div className={styles.track} aria-hidden="true">
        <div className={styles.fill} style={{ width: `${width}%` }} />
      </div>
    </li>
  );
}

export function BarList({ children }: { children: ReactNode }) {
  return <ul className={styles.bars}>{children}</ul>;
}

export function ReportRowsLoading({ rows }: { rows: number; funnel?: boolean }) {
  return (
    <ul aria-hidden="true" className={styles.bars}>
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className={styles.barRow}>
          <div className="h-5 w-3/4 rounded-md bg-surface-raised" />
          <div className={styles.track} />
        </li>
      ))}
    </ul>
  );
}

export function ReportSessionCardsLoading({ rows }: { rows: number }) {
  return Array.from({ length: rows }, (_, index) => (
    <dl key={index} aria-hidden="true" className="grid grid-cols-2 gap-x-3 gap-y-2 py-4 text-sm">
      {["Class", "Date", "Attendance", "Capacity", "Utilization"].map((label, column) => (
        <div key={label} className={column === 0 ? "col-span-2" : undefined}>
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="mt-1 h-5 w-3/4 rounded-md bg-surface-raised" />
        </div>
      ))}
    </dl>
  ));
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`${styles.panel} ${className}`.trim()} data-report-section="reading-block">
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
    <div className={styles.panelHead}>
      <div className="min-w-0">
        <h2 className={styles.panelTitle}>{title}</h2>
        {subtitle && <p className={styles.panelSubtitle}>{subtitle}</p>}
      </div>
      {children ? <div className={styles.panelTags}>{children}</div> : null}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <CalmState tone="neutral" title={message} />;
}

export function StatBadge({ children }: { children: ReactNode }) {
  return <ToneTag dot={false}>{children}</ToneTag>;
}

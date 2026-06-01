"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import type { KpiInsightForModal } from "@/components/dashboard/kpi-insight-modal";
import { ModalFrame } from "@/components/ui/modal-frame";
import { crmLinkPrefetch } from "@/lib/constants";

export interface MetricSegment {
  label: string;
  value: string | number;
  color: string;
  href?: string;
}

export type KpiInsight = KpiInsightForModal;

export function KpiInsightModalLoading() {
  return (
    <ModalFrame
      rootClassName="p-4 sm:p-6"
      panelClassName="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-[6px] border border-border bg-bg shadow-2xl"
      ariaLabel="Loading KPI insight"
    >
      <div className="border-b border-border px-5 py-4">
        <div className="h-4 w-40 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
        <div className="mt-2 h-3 w-64 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
      </div>
      <div className="grid min-h-[420px] lg:grid-cols-[300px_1fr]">
        <div className="border-b border-border bg-surface/50 px-5 py-5 lg:border-b-0 lg:border-r">
          <div className="h-20 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
          <div className="mt-5 h-3 w-24 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
          <div className="mt-3 h-24 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
        </div>
        <div className="px-5 py-5">
          <div className="h-5 w-52 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
          <div className="mt-5 grid gap-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-16 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
            ))}
          </div>
        </div>
      </div>
    </ModalFrame>
  );
}

export function SegmentedMetricBar({
  segments,
}: {
  segments: MetricSegment[];
}) {
  const columnClass = segments.length === 3
    ? "grid-cols-1 sm:grid-cols-3"
    : "grid-cols-2 sm:grid-cols-4";

  return (
    <div className={`grid ${columnClass} gap-px border border-border bg-border`}>
      {segments.map((segment) => (
        <MetricSegmentCell key={segment.label} segment={segment} />
      ))}
    </div>
  );
}

function MetricSegmentCell({ segment }: { segment: MetricSegment }) {
  const content = (
    <>
      <span
        className="absolute top-0 left-0 right-0 h-[2px] opacity-0 group-hover:opacity-100 transition-opacity duration-150"
        style={{ backgroundColor: segment.color }}
      />
      <span
        className="w-2 h-2 shrink-0"
        style={{ backgroundColor: segment.color }}
      />
      <div className="min-w-0">
        <p className="text-lg font-mono font-bold text-text-primary leading-none">
          {segment.value}
        </p>
        <p className="text-[11px] text-muted mt-1 uppercase tracking-wide">
          {segment.label}
        </p>
      </div>
    </>
  );

  if (segment.href) {
    return (
      <Link
        href={segment.href}
        prefetch={crmLinkPrefetch(segment.href)}
        className="group relative flex items-center gap-3 bg-surface px-4 py-3.5 hover:bg-surface-raised/50 transition-colors"
      >
        {content}
      </Link>
    );
  }

  return (
    <div className="group relative flex items-center gap-3 bg-surface px-4 py-3.5 hover:bg-surface-raised/50 transition-colors">
      {content}
    </div>
  );
}

export function Panel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-surface border border-border p-5 ${className}`}>
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  subtitle,
  href,
  linkLabel = "View all",
}: {
  title: string;
  subtitle?: string;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-5">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {subtitle && (
          <p className="text-xs text-text-secondary mt-1 leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>
      {href && (
        <Link
          href={href}
          prefetch={crmLinkPrefetch(href)}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover shrink-0 transition-colors"
        >
          {linkLabel}
          <ArrowRight className="w-3 h-3" />
        </Link>
      )}
    </div>
  );
}

export function MetricStripSection({
  title,
  subtitle,
  segments,
}: {
  title: string;
  subtitle: string;
  segments: MetricSegment[];
}) {
  return (
    <Panel>
      <PanelHeader title={title} subtitle={subtitle} />
      <SegmentedMetricBar segments={segments} />
    </Panel>
  );
}

export function KpiTile({
  insight,
  onOpen,
}: {
  insight: KpiInsight;
  onOpen: () => void;
}) {
  const Icon = insight.icon;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative cursor-pointer bg-surface px-4 py-4 text-left transition-colors hover:bg-surface-raised/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      aria-label={`Explain ${insight.label}`}
    >
      <span
        className="absolute top-0 left-0 right-0 h-[2px] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
        style={{ backgroundColor: insight.accent }}
      />
      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-8 h-8 flex items-center justify-center"
          style={{ backgroundColor: `${insight.accent}12` }}
        >
          <Icon className="w-4 h-4" style={{ color: insight.accent }} />
        </div>
        <span className="text-[11px] text-muted font-medium uppercase tracking-widest">
          {insight.label}
        </span>
      </div>
      <p className="text-2xl font-bold text-text-primary font-mono leading-none">{insight.value}</p>
      <p className="text-xs text-muted mt-2 leading-relaxed">{insight.sub}</p>
    </button>
  );
}

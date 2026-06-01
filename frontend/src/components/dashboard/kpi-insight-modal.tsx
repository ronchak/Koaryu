"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  X,
  type LucideIcon,
} from "lucide-react";
import { ModalFrame } from "@/components/ui/modal-frame";

export interface KpiBreakdownRow {
  id: string;
  label: string;
  value: string | number;
  detail: string;
  children?: KpiBreakdownRow[];
}

export interface KpiBreakdownSection {
  id: string;
  label: string;
  color?: string | null;
  rows: KpiBreakdownRow[];
}

export interface KpiInsightForModal {
  id: string;
  icon: LucideIcon;
  label: string;
  value: string | number;
  sub: string;
  accent: string;
  summary: string;
  measures: string;
  calculation: string;
  read: string;
  breakdownTitle: string;
  breakdownEmpty: string;
  breakdownSections: KpiBreakdownSection[];
}

export function KpiInsightModal({
  insight,
  onClose,
}: {
  insight: KpiInsightForModal;
  onClose: () => void;
}) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(insight.breakdownSections.map((section) => `${insight.id}:${section.id}`))
  );
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const Icon = insight.icon;
  const toggleSection = (sectionId: string) => {
    const key = `${insight.id}:${sectionId}`;
    setExpandedSections((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };
  const toggleRow = (rowId: string) => {
    const key = `${insight.id}:${rowId}`;
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };
  const beltGroupCount = insight.breakdownSections.reduce(
    (count, section) => count + section.rows.length,
    0
  );
  const stripeRowCount = insight.breakdownSections.reduce(
    (count, section) =>
      count + section.rows.reduce((rowCount, row) => rowCount + (row.children?.length ?? 0), 0),
    0
  );

  return (
    <ModalFrame
      rootClassName="p-4 sm:p-6"
      panelClassName="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-[6px] border border-border bg-bg shadow-2xl"
      ariaLabelledBy="kpi-insight-title"
      onBackdropClick={onClose}
    >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 flex items-center justify-center"
                style={{ backgroundColor: `${insight.accent}12` }}
              >
                <Icon className="w-4 h-4" style={{ color: insight.accent }} />
              </div>
              <div>
                <h2 id="kpi-insight-title" className="text-base font-semibold text-text-primary">
                  {insight.label}
                </h2>
                <p className="mt-1 text-xs text-muted">
                  Current value: <span className="font-mono text-text-secondary">{insight.value}</span> · {insight.sub}
                </p>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] p-1 text-muted transition-colors hover:bg-surface-raised hover:text-text-primary"
            aria-label="Close KPI explanation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid min-h-0 flex-1 lg:grid-cols-[300px_1fr]">
          <aside className="min-h-0 border-b border-border bg-surface/50 lg:border-b-0 lg:border-r">
            <div className="space-y-5 px-5 py-5 lg:max-h-full lg:overflow-y-auto">
              <div className="border border-border bg-bg px-3 py-3">
                <p className="text-[11px] font-medium uppercase tracking-widest text-muted">Current value</p>
                <p className="mt-2 font-mono text-3xl font-bold leading-none text-text-primary">
                  {insight.value}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted">{insight.sub}</p>
              </div>

              <div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-muted">What it is</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">{insight.summary}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-muted">Measures</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">{insight.measures}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-muted">Calculation</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">{insight.calculation}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-muted">Good / Bad</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">{insight.read}</p>
              </div>
            </div>
          </aside>

          <section className="flex min-h-0 flex-col">
            <div className="shrink-0 border-b border-border px-5 py-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-widest text-muted">
                    Operational breakdown
                  </p>
                  <h3 className="mt-1 text-lg font-semibold text-text-primary">{insight.breakdownTitle}</h3>
                </div>
                <div className="flex gap-4 text-right">
                  <div>
                    <p className="font-mono text-lg font-semibold leading-none text-text-primary">
                      {beltGroupCount}
                    </p>
                    <p className="mt-1 text-[10px] uppercase tracking-widest text-muted">belt groups</p>
                  </div>
                  <div>
                    <p className="font-mono text-lg font-semibold leading-none text-text-primary">
                      {stripeRowCount}
                    </p>
                    <p className="mt-1 text-[10px] uppercase tracking-widest text-muted">stripe rows</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              {beltGroupCount === 0 ? (
                <div className="border border-border bg-surface px-4 py-8 text-center text-sm leading-6 text-text-secondary">
                  {insight.breakdownEmpty}
                </div>
              ) : (
                <div className="grid gap-4">
                  {insight.breakdownSections.map((section) => {
                    const isSectionExpanded = expandedSections.has(`${insight.id}:${section.id}`);

                    return (
                      <section
                        key={section.id}
                        className="overflow-hidden border border-border bg-surface"
                      >
                        <button
                          type="button"
                          aria-expanded={isSectionExpanded}
                          onClick={() => toggleSection(section.id)}
                          className="group flex w-full items-center justify-between gap-4 border-b border-border bg-bg px-4 py-3 text-left transition-colors hover:bg-surface-raised/50"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-border bg-surface text-muted transition-colors group-hover:text-text-secondary">
                              {isSectionExpanded
                                ? <ChevronDown className="h-3.5 w-3.5" />
                                : <ChevronRight className="h-3.5 w-3.5" />}
                            </span>
                            <span
                              className="h-2.5 w-2.5 shrink-0"
                              style={{ backgroundColor: section.color || "var(--muted)" }}
                            />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-text-primary">
                                {section.label}
                              </p>
                              <p className="mt-0.5 text-[11px] uppercase tracking-widest text-muted">
                                Program
                              </p>
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="font-mono text-sm font-semibold text-text-primary">
                              {section.rows.length}
                            </p>
                            <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted">
                              belts
                            </p>
                          </div>
                        </button>

                        {isSectionExpanded && (
                          <div className="grid gap-px bg-border">
                            {section.rows.map((row) => {
                              const children = row.children ?? [];
                              const hasChildren = children.length > 0;
                              const isExpanded = expandedRows.has(`${insight.id}:${row.id}`);

                              return (
                                <div key={row.id} className="bg-surface">
                                  {hasChildren ? (
                                    <button
                                      type="button"
                                      aria-expanded={isExpanded}
                                      onClick={() => toggleRow(row.id)}
                                      className="group flex w-full items-center justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-surface-raised/50"
                                    >
                                      <div className="flex min-w-0 items-center gap-3">
                                        <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-border bg-bg text-muted transition-colors group-hover:text-text-secondary">
                                          {isExpanded
                                            ? <ChevronDown className="h-3.5 w-3.5" />
                                            : <ChevronRight className="h-3.5 w-3.5" />}
                                        </span>
                                        <div className="min-w-0">
                                          <p className="truncate text-base font-semibold text-text-primary">{row.label}</p>
                                          <p className="mt-1 text-xs text-muted">{row.detail}</p>
                                        </div>
                                      </div>
                                      <p className="shrink-0 font-mono text-2xl font-bold leading-none text-text-primary">
                                        {row.value}
                                      </p>
                                    </button>
                                  ) : (
                                    <div className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left">
                                      <div className="min-w-0">
                                        <p className="truncate text-base font-semibold text-text-primary">{row.label}</p>
                                        <p className="mt-1 text-xs text-muted">{row.detail}</p>
                                      </div>
                                      <p className="shrink-0 font-mono text-2xl font-bold leading-none text-text-primary">
                                        {row.value}
                                      </p>
                                    </div>
                                  )}

                                  {hasChildren && isExpanded && (
                                    <div className="grid gap-px border-t border-border bg-border">
                                      {children.map((child) => (
                                        <div
                                          key={child.id}
                                          className="flex items-center justify-between gap-4 bg-bg px-4 py-3 pl-14"
                                        >
                                          <div className="min-w-0">
                                            <p className="truncate text-sm font-medium text-text-secondary">{child.label}</p>
                                            <p className="mt-1 text-xs text-muted">{child.detail}</p>
                                          </div>
                                          <p className="shrink-0 font-mono text-base font-semibold text-text-primary">
                                            {child.value}
                                          </p>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
    </ModalFrame>
  );
}

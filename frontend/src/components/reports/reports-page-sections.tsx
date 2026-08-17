import type { ElementType, ReactNode } from "react";

export function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: ElementType;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="bg-surface p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="flex h-8 w-8 items-center justify-center border-r border-border text-accent">
          <Icon className="h-4 w-4" />
        </div>
        <span className="text-[11px] font-medium uppercase tracking-widest text-text-secondary">
          {label}
        </span>
      </div>
      <p className="text-3xl font-bold text-text-primary font-mono leading-none">{value}</p>
      <p className="text-xs text-muted mt-2 leading-relaxed">{sub}</p>
    </div>
  );
}

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-surface border border-border p-5 ${className}`}>
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

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="border border-border bg-surface-raised/40 px-4 py-5 text-sm text-text-secondary">
      {message}
    </div>
  );
}

export function StatBadge({ children }: { children: ReactNode }) {
  return (
    <span className="border border-border bg-surface-raised px-2 py-1 text-xs text-text-secondary">
      {children}
    </span>
  );
}

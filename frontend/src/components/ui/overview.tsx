import Link from "next/link";
import type { ElementType, ReactNode } from "react";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { crmLinkPrefetch } from "@/lib/constants";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const toneStyles: Record<Tone, { text: string; bg: string; border: string; bar: string; wash: string; ring: string }> = {
  neutral: {
    text: "text-text-secondary",
    bg: "bg-surface-raised/50",
    border: "border-border",
    bar: "bg-muted",
    wash: "from-muted/12",
    ring: "group-hover:border-muted/40 group-focus-visible:border-muted/50",
  },
  accent: {
    text: "text-accent",
    bg: "bg-accent/10",
    border: "border-accent/20",
    bar: "bg-accent",
    wash: "from-accent/18",
    ring: "group-hover:border-accent/45 group-focus-visible:border-accent/60",
  },
  success: {
    text: "text-success",
    bg: "bg-success/10",
    border: "border-success/20",
    bar: "bg-success",
    wash: "from-success/16",
    ring: "group-hover:border-success/45 group-focus-visible:border-success/60",
  },
  warning: {
    text: "text-warning",
    bg: "bg-warning/10",
    border: "border-warning/20",
    bar: "bg-warning",
    wash: "from-warning/16",
    ring: "group-hover:border-warning/45 group-focus-visible:border-warning/60",
  },
  danger: {
    text: "text-danger",
    bg: "bg-danger/10",
    border: "border-danger/20",
    bar: "bg-danger",
    wash: "from-danger/16",
    ring: "group-hover:border-danger/45 group-focus-visible:border-danger/60",
  },
  info: {
    text: "text-sky-400",
    bg: "bg-sky-400/10",
    border: "border-sky-400/20",
    bar: "bg-sky-400",
    wash: "from-sky-400/16",
    ring: "group-hover:border-sky-400/45 group-focus-visible:border-sky-400/60",
  },
};

export function OverviewPanel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`overflow-hidden rounded-[6px] border border-border bg-surface ${className}`}>
      {children}
    </section>
  );
}

export function OverviewPanelHeader({
  title,
  description,
  eyebrow,
  href,
  actionLabel = "View",
  children,
  className = "",
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  href?: string;
  actionLabel?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5 ${className}`}>
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1 text-[11px] font-medium uppercase tracking-widest text-muted">{eyebrow}</p>
        ) : null}
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-2xl text-xs leading-5 text-text-secondary">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {children}
        {href ? (
          <Link
            href={href}
            prefetch={crmLinkPrefetch(href)}
            className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 hover:text-accent-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {actionLabel}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function OverviewMetricCard({
  icon: Icon,
  label,
  value,
  helper,
  href,
  tone = "neutral",
  status,
  action,
  detail,
  className = "",
}: {
  icon: ElementType;
  label: string;
  value: string | number;
  helper?: string;
  href?: string;
  tone?: Tone;
  status?: string;
  action?: string;
  detail?: string;
  className?: string;
}) {
  const toneClass = toneStyles[tone];
  const interactive = Boolean(href);
  const content = (
    <div
      className={`
        relative h-full min-h-[172px] overflow-hidden rounded-[6px] border border-border bg-surface px-4 py-4 will-change-transform
        transition-[background-color,border-color,box-shadow,transform] duration-[260ms] ease-out
        motion-reduce:transition-none
        ${interactive ? `group-hover:-translate-y-1 group-hover:bg-surface-raised/55 group-hover:shadow-xl group-hover:shadow-black/15 group-focus-visible:-translate-y-1 group-focus-visible:shadow-xl group-focus-visible:shadow-black/15 ${toneClass.ring}` : ""}
        ${className}
      `}
    >
      <span
        className={`
          pointer-events-none absolute inset-0 bg-gradient-to-br ${toneClass.wash} via-transparent to-transparent
          opacity-0 transition-opacity duration-300 ease-out group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none
        `}
      />
      <span
        className={`pointer-events-none absolute inset-x-0 top-0 h-[2px] origin-left scale-x-0 opacity-0 transition-[opacity,transform] duration-300 ease-out group-hover:scale-x-100 group-hover:opacity-100 group-focus-visible:scale-x-100 group-focus-visible:opacity-100 motion-reduce:transition-none ${toneClass.bar}`}
      />
      <div className="relative flex items-center gap-3">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border transition-transform duration-[260ms] ease-out group-hover:-translate-y-0.5 group-focus-visible:-translate-y-0.5 motion-reduce:transition-none ${toneClass.border} ${toneClass.bg}`}>
          <Icon className={`h-4 w-4 ${toneClass.text}`} />
        </span>
        <p className="min-w-0 truncate text-[11px] font-medium uppercase tracking-widest text-muted">{label}</p>
      </div>
      <div className="relative mt-4 transition-transform duration-[260ms] ease-out group-hover:-translate-y-0.5 group-focus-visible:-translate-y-0.5 motion-reduce:transition-none">
        <div className="flex items-end justify-between gap-3">
          <p className="font-mono text-3xl font-semibold leading-none text-text-primary">{value}</p>
          {status ? (
            <span className={`mb-0.5 max-w-[8rem] truncate rounded-[4px] border px-2 py-0.5 text-[10px] font-medium ${toneClass.border} ${toneClass.bg} ${toneClass.text}`}>
              {status}
            </span>
          ) : null}
        </div>
        {helper ? <p className="mt-2 text-xs leading-5 text-muted">{helper}</p> : null}
        {detail ? <p className="mt-2 text-xs leading-5 text-text-secondary">{detail}</p> : null}
      </div>
      {action ? (
        <div className="relative mt-4 flex items-center gap-1 text-xs font-medium text-accent opacity-85 transition-[opacity,transform] duration-[260ms] ease-out group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:translate-x-0.5 group-focus-visible:opacity-100 motion-reduce:transition-none">
          <span className="truncate">{action}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0" />
        </div>
      ) : null}
    </div>
  );

  if (href) {
    return (
      <Link href={href} prefetch={crmLinkPrefetch(href)} className="group block h-full focus:outline-none focus-visible:ring-1 focus-visible:ring-accent">
        {content}
      </Link>
    );
  }

  return content;
}

export interface OverviewAction {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: ElementType;
  tone?: Tone;
  meta?: string;
}

export function OverviewActionList({
  actions,
  emptyTitle,
  emptyDescription,
}: {
  actions: OverviewAction[];
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (actions.length === 0) {
    return (
      <div className="px-4 py-8 text-center sm:px-5">
        <p className="text-sm font-medium text-text-primary">{emptyTitle}</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-text-secondary">{emptyDescription}</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {actions.map((action) => {
        const Icon = action.icon;
        const toneClass = toneStyles[action.tone ?? "neutral"];

        return (
          <Link
            key={action.id}
            href={action.href}
            prefetch={crmLinkPrefetch(action.href)}
            className="group flex items-center justify-between gap-4 px-4 py-3.5 transition-[background-color,transform] duration-200 ease-out hover:bg-surface-raised/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none sm:px-5"
          >
            <div className="flex min-w-0 items-start gap-3">
              <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border transition-transform duration-200 ease-out group-hover:-translate-y-0.5 motion-reduce:transition-none ${toneClass.border} ${toneClass.bg}`}>
                <Icon className={`h-4 w-4 ${toneClass.text}`} />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">{action.title}</p>
                <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-text-secondary">{action.description}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {action.meta ? <span className="hidden font-mono text-xs text-muted sm:inline">{action.meta}</span> : null}
              <ArrowRight className="h-3.5 w-3.5 text-muted transition-[color,transform] duration-200 ease-out group-hover:translate-x-0.5 group-hover:text-accent motion-reduce:transition-none" />
            </div>
          </Link>
        );
      })}
    </div>
  );
}

export function ActionEmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
  actionVariant = "primary",
  secondaryLabel,
  secondaryHref,
  className = "",
}: {
  icon?: ElementType;
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
  actionVariant?: "primary" | "secondary";
  secondaryLabel?: string;
  secondaryHref?: string;
  className?: string;
}) {
  return (
    <div className={`rounded-[6px] border border-dashed border-border bg-surface px-5 py-8 text-center ${className}`}>
      {Icon ? (
        <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-[6px] border border-border bg-surface-raised text-text-secondary">
          <Icon className="h-4 w-4" />
        </span>
      ) : null}
      <h3 className="mt-3 text-sm font-semibold text-text-primary">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-text-secondary">{description}</p>
      {(actionLabel || secondaryLabel) ? (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {actionLabel && actionHref ? (
            <Button asChild variant={actionVariant} size="sm">
              <Link href={actionHref} prefetch={crmLinkPrefetch(actionHref)}>{actionLabel}</Link>
            </Button>
          ) : actionLabel ? (
            <Button variant={actionVariant} size="sm" onClick={onAction}>
              {actionLabel}
            </Button>
          ) : null}
          {secondaryLabel && secondaryHref ? (
            <Button asChild variant="secondary" size="sm">
              <Link href={secondaryHref} prefetch={crmLinkPrefetch(secondaryHref)}>{secondaryLabel}</Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface SetupStep {
  id: string;
  title: string;
  description: string;
  complete: boolean;
  href?: string;
  onSelect?: () => void;
  actionLabel: string;
}

export function SetupStepList({ steps }: { steps: SetupStep[] }) {
  return (
    <div className="divide-y divide-border">
      {steps.map((step, index) => {
        const content = (
          <>
            <div className="flex items-start gap-3 sm:items-center">
              <span
                className={`
                  flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-mono text-[11px]
                  ${step.complete ? "border-success/30 bg-success/10 text-success" : "border-border bg-bg text-muted"}
                `}
              >
                {step.complete ? <CheckCircle2 className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <div className="min-w-0 sm:hidden">
                <p className="text-sm font-medium text-text-primary">{step.title}</p>
                <p className="mt-0.5 text-xs leading-5 text-text-secondary">{step.description}</p>
              </div>
            </div>
            <div className="hidden min-w-0 sm:block">
              <p className="text-sm font-medium text-text-primary">{step.title}</p>
              <p className="mt-0.5 text-xs leading-5 text-text-secondary">{step.description}</p>
            </div>
            <div className="ml-10 flex items-center gap-2 text-xs font-medium text-accent sm:ml-0">
              {step.complete ? "Review" : step.actionLabel}
              <ArrowRight className="h-3.5 w-3.5" />
            </div>
          </>
        );
        const className =
          "group grid w-full gap-3 px-4 py-3.5 text-left transition-[background-color,transform] duration-200 ease-out hover:bg-surface-raised/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none sm:grid-cols-[auto_1fr_auto] sm:items-center sm:px-5";

        if (step.onSelect) {
          return (
            <button key={step.id} type="button" onClick={step.onSelect} className={className}>
              {content}
            </button>
          );
        }

        if (step.href) {
          return (
            <Link key={step.id} href={step.href} prefetch={crmLinkPrefetch(step.href)} className={className}>
              {content}
            </Link>
          );
        }

        return (
          <div key={step.id} className={className}>
            {content}
          </div>
        );
      })}
    </div>
  );
}

export interface SegmentedTab<T extends string> {
  id: T;
  label: string;
  description?: string;
  icon?: ElementType;
  disabled?: boolean;
}

export function SegmentedTabs<T extends string>({
  tabs,
  activeTab,
  onChange,
  ariaLabel,
}: {
  tabs: SegmentedTab<T>[];
  activeTab: T;
  onChange: (tab: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="grid gap-1 rounded-[6px] border border-border bg-surface-raised/45 p-1 sm:flex sm:flex-wrap"
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const selected = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            type="button"
            aria-pressed={selected}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={`
              flex min-h-10 min-w-0 flex-1 items-center justify-center gap-2 rounded-[5px] px-3 py-2 text-sm font-medium
              transition-[background-color,color,box-shadow] duration-150 ease-out focus:outline-none focus-visible:ring-1 focus-visible:ring-accent
              disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none
              ${selected ? "bg-bg text-text-primary shadow-sm" : "text-text-secondary hover:bg-surface hover:text-text-primary"}
            `}
          >
            {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
            <span className="truncate">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

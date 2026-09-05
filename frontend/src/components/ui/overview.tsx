import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { crmLinkPrefetch } from "@/lib/constants";

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

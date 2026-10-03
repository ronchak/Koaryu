import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Logo } from "@/components/logo";

type StatusTone = "missing" | "warning" | "danger" | "offline";

interface ErrorStatusPageProps {
  statusCode: string;
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  tone?: StatusTone;
  actions?: ReactNode;
}

const toneStyles: Record<StatusTone, string> = {
  missing: "border-accent/30 bg-accent/10 text-accent",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-danger/30 bg-danger/10 text-danger",
  offline: "border-text-secondary/30 bg-text-secondary/10 text-text-secondary",
};

export function ErrorStatusPage({
  statusCode,
  eyebrow,
  title,
  description,
  icon: Icon,
  tone = "warning",
  actions,
}: ErrorStatusPageProps) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-bg text-text-primary">
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage:
            "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent"
      />

      <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-5 sm:px-8 sm:py-7">
        <header className="flex items-center justify-between gap-4">
          <Logo size="sm" />
          <span className="rounded-[6px] border border-border bg-surface px-2.5 py-1 font-mono text-xs text-muted">
            status/{statusCode}
          </span>
        </header>

        <section className="flex flex-1 items-center py-10 lg:py-14">
          <div className="mx-auto w-full max-w-2xl">
            <div
              className={`inline-flex items-center gap-2 rounded-[6px] border px-3 py-1.5 text-sm font-medium ${toneStyles[tone]}`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{eyebrow}</span>
            </div>

            <p className="mt-7 font-mono text-8xl font-semibold leading-none text-text-primary sm:text-9xl">
              {statusCode}
            </p>
            <h1 className="mt-5 max-w-xl text-3xl font-semibold leading-tight text-text-primary sm:text-4xl">
              {title}
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-text-secondary sm:text-lg">
              {description}
            </p>

            {actions && <div className="mt-7 flex flex-wrap items-center gap-3">{actions}</div>}
          </div>
        </section>
      </div>
    </main>
  );
}

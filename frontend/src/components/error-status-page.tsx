import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Logo } from "@/components/logo";

type StatusTone = "missing" | "warning" | "danger" | "offline";
type DiagnosticState = "ok" | "warn" | "bad" | "idle";

interface StatusDiagnostic {
  label: string;
  value: string;
  state?: DiagnosticState;
}

interface ErrorStatusPageProps {
  statusCode: string;
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  tone?: StatusTone;
  diagnostics?: StatusDiagnostic[];
  actions?: ReactNode;
}

const toneStyles: Record<StatusTone, string> = {
  missing: "border-accent/30 bg-accent/10 text-accent",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-danger/30 bg-danger/10 text-danger",
  offline: "border-text-secondary/30 bg-text-secondary/10 text-text-secondary",
};

const diagnosticDotStyles: Record<DiagnosticState, string> = {
  ok: "bg-success shadow-[0_0_12px_rgba(76,175,125,0.35)]",
  warn: "bg-warning shadow-[0_0_12px_rgba(232,162,58,0.35)]",
  bad: "bg-danger shadow-[0_0_12px_rgba(224,90,90,0.35)]",
  idle: "bg-muted",
};

const defaultDiagnostics: StatusDiagnostic[] = [
  { label: "App shell", value: "online", state: "ok" },
  { label: "Session", value: "preserved", state: "ok" },
  { label: "Recovery", value: "ready", state: "idle" },
];

export function ErrorStatusPage({
  statusCode,
  eyebrow,
  title,
  description,
  icon: Icon,
  tone = "warning",
  diagnostics = defaultDiagnostics,
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

        <section className="grid flex-1 items-center gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(320px,440px)] lg:py-14">
          <div className="max-w-2xl">
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

            {actions && (
              <div className="mt-7 flex flex-wrap items-center gap-3">
                {actions}
              </div>
            )}
          </div>

          <aside className="relative overflow-hidden rounded-[6px] border border-border bg-surface p-5 shadow-2xl shadow-black/20">
            <div
              aria-hidden="true"
              className="absolute inset-0 opacity-[0.18]"
              style={{
                backgroundImage:
                  "linear-gradient(135deg, transparent 0 38%, rgba(214,178,94,0.25) 38% 39%, transparent 39% 100%)",
              }}
            />
            <div className="relative">
              <div className="flex items-start justify-between gap-5 border-b border-border pb-4">
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    Status trace
                  </p>
                  <p className="mt-1 text-xs text-muted">Koaryu edge</p>
                </div>
                <span className="font-mono text-2xl font-semibold text-text-primary">
                  {statusCode}
                </span>
              </div>

              <div className="mt-3 divide-y divide-border">
                {diagnostics.map((item) => (
                  <div
                    key={`${item.label}-${item.value}`}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3"
                  >
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        diagnosticDotStyles[item.state || "idle"]
                      }`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 text-sm text-text-secondary">
                      {item.label}
                    </span>
                    <span className="min-w-0 text-right font-mono text-xs text-text-primary">
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-5 grid grid-cols-3 overflow-hidden rounded-[6px] border border-border">
                <div className="border-r border-border p-3">
                  <p className="font-mono text-sm text-text-primary">UI</p>
                  <p className="mt-1 text-xs text-muted">stable</p>
                </div>
                <div className="border-r border-border p-3">
                  <p className="font-mono text-sm text-text-primary">Auth</p>
                  <p className="mt-1 text-xs text-muted">held</p>
                </div>
                <div className="p-3">
                  <p className="font-mono text-sm text-text-primary">API</p>
                  <p className="mt-1 text-xs text-muted">checked</p>
                </div>
              </div>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}

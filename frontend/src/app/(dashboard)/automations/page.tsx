import Link from "next/link";
import { BellRing } from "lucide-react";
import { Header } from "@/components/header";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { Button } from "@/components/ui/button";
import { crmLinkPrefetch } from "@/lib/constants";

const LIVE_QUEUES = [
  { title: "Lead follow-ups", description: "Call, trial, and next-step obligations already live in Leads.", href: "/leads" },
  { title: "Students going quiet", description: "Dashboard surfaces students crossing inactivity thresholds.", href: "/dashboard" },
  { title: "Ready to promote", description: "Belt Tracker applies the current rank and approval requirements.", href: "/belt-tracker" },
  { title: "Tuition needs attention", description: "Billing holds failed payments, past-due families, and open invoices.", href: "/billing" },
] as const;

const FUTURE_WORKFLOWS = [
  ["Trial reminders", "Reminder before a trial class and a follow-up afterward."],
  ["Missed-class nudges", "Family email after a configurable attendance gap."],
  ["Payment recovery", "Failed-payment notice that stops after provider recovery."],
  ["Promotion congratulations", "Studio-approved note after a promotion is recorded."],
  ["Belt test announcements", "Notice to eligible students and families before a testing cycle."],
] as const;

export default function AutomationsPage() {
  return (
    <OperationsSurface page="automations">
      <Header
        title="Automations"
        description="A read-only catalog of live manual queues and future studio-approved workflows."
      >
        <Button asChild variant="primary" size="sm">
          <Link href="/dashboard" prefetch={crmLinkPrefetch("/dashboard")}>
            <BellRing className="h-3.5 w-3.5" />
            Open today&apos;s work
          </Link>
        </Button>
      </Header>

      <div className="flex-1 px-4 py-7 sm:px-8 lg:py-10" data-automations-readonly="true">
        <div className="mx-auto max-w-5xl space-y-9">
          <section className="border-y-2 border-border bg-surface">
            <div className="grid gap-4 px-5 py-6 sm:grid-cols-[minmax(12rem,0.36fr)_1fr] sm:gap-8">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-accent">Current status</p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-text-primary">No automation builder is live.</h2>
              </div>
              <p className="text-sm leading-6 text-text-secondary">
                There are no message toggles, schedules, forms, or hidden sends on this page. Koaryu will use deterministic templates and explicit studio approval when this work ships. Today, the four live queues below are the honest operating path.
              </p>
            </div>
          </section>

          <section aria-labelledby="live-queues-title">
            <div className="mb-3 flex items-end justify-between gap-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">Available now</p>
                <h2 id="live-queues-title" className="mt-1 text-base font-semibold text-text-primary">Four live queue destinations</h2>
              </div>
              <span className="font-mono text-xs text-muted">04</span>
            </div>
            <ol className="border-y border-border bg-surface">
              {LIVE_QUEUES.map((queue, index) => (
                <li key={queue.href} className="border-b border-border last:border-b-0">
                  <Link href={queue.href} prefetch={crmLinkPrefetch(queue.href)} className="grid min-h-20 grid-cols-[2rem_1fr_auto] items-center gap-3 px-3 py-4 hover:bg-surface-raised">
                    <span className="font-mono text-xs text-accent">{String(index + 1).padStart(2, "0")}</span>
                    <span>
                      <strong className="block text-sm font-semibold text-text-primary">{queue.title}</strong>
                      <span className="mt-1 block text-sm leading-5 text-text-secondary">{queue.description}</span>
                    </span>
                    <span aria-hidden="true" className="text-accent">→</span>
                  </Link>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="future-workflows-title">
            <div className="mb-3 flex items-end justify-between gap-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">Future catalog</p>
                <h2 id="future-workflows-title" className="mt-1 text-base font-semibold text-text-primary">Five proposed workflows</h2>
              </div>
              <span className="font-mono text-xs text-muted">Read only · 05</span>
            </div>
            <dl className="border-y border-border bg-surface">
              {FUTURE_WORKFLOWS.map(([title, description], index) => (
                <div key={title} className="grid gap-1 border-b border-border px-4 py-4 last:border-b-0 sm:grid-cols-[2rem_minmax(12rem,0.36fr)_1fr] sm:gap-4">
                  <span aria-hidden="true" className="font-mono text-xs text-muted">{String(index + 1).padStart(2, "0")}</span>
                  <dt className="text-sm font-semibold text-text-primary">{title}</dt>
                  <dd className="text-sm leading-5 text-text-secondary">{description}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </OperationsSurface>
  );
}

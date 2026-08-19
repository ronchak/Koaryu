import Link from "next/link";
import { BellRing } from "lucide-react";
import { Header } from "@/components/header";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { Button } from "@/components/ui/button";
import { crmLinkPrefetch } from "@/lib/constants";

const LIVE_QUEUES = [
  { title: "Lead follow-ups", trigger: "A lead reaches a due or overdue next step", action: "Review the call, trial, or follow-up obligation in Leads", status: "Manual queue live", href: "/leads" },
  { title: "Students going quiet", trigger: "A student crosses the inactivity threshold", action: "Review the student from today’s Dashboard work", status: "Manual queue live", href: "/dashboard" },
  { title: "Ready to promote", trigger: "Rank requirements and approvals indicate readiness", action: "Review the promotion decision in Belt Tracker", status: "Decision queue live", href: "/belt-tracker" },
  { title: "Tuition needs attention", trigger: "A payment fails or an invoice remains past due", action: "Work the family or invoice in Billing", status: "Manual queue live", href: "/billing" },
] as const;

const FUTURE_WORKFLOWS = [
  { title: "Trial reminders", trigger: "Trial class approaches or passes", action: "Reminder before class and a follow-up afterward", status: "Proposal only" },
  { title: "Missed-class nudges", trigger: "Configurable attendance gap is reached", action: "Family email about the missed training cadence", status: "Proposal only" },
  { title: "Payment recovery", trigger: "Provider reports a failed payment", action: "Recovery notice that stops after provider recovery", status: "Proposal only" },
  { title: "Promotion congratulations", trigger: "An approved promotion is recorded", action: "Studio-approved congratulations note", status: "Proposal only" },
  { title: "Belt test announcements", trigger: "A testing cycle is approved", action: "Notice to eligible students and families", status: "Proposal only" },
] as const;

export default function AutomationsPage() {
  return (
    <OperationsSurface page="automations">
      <Header title="Automations">
        <Button asChild variant="primary" size="sm" className="min-h-11">
          <Link href="/dashboard" prefetch={crmLinkPrefetch("/dashboard")}>
            <BellRing className="h-3.5 w-3.5" />
            Open today&apos;s work
          </Link>
        </Button>
      </Header>

      <div className="flex-1 px-4 py-5 sm:px-8 lg:py-7" data-automations-readonly="true" data-automation-worksheet="trigger-action-status">
        <div className="mx-auto max-w-6xl space-y-8">
          <section className="overflow-hidden bg-surface">
            <div className="grid gap-4 p-4 sm:grid-cols-[minmax(12rem,0.36fr)_1fr] sm:gap-8">
              <div>
                <p className="text-xs font-medium text-accent">Current status</p>
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
                <p className="text-xs font-medium text-muted">Available now</p>
                <h2 id="live-queues-title" className="mt-1 text-base font-semibold text-text-primary">Four live queue destinations</h2>
              </div>
              <span className="text-xs text-muted">Manual work only</span>
            </div>
            <div className="hidden grid-cols-[minmax(10rem,0.8fr)_1fr_1.2fr_minmax(8rem,0.7fr)] bg-surface-raised px-4 py-2 text-xs font-medium text-muted md:grid">
              <span>Rule</span><span>Trigger</span><span>Action</span><span>Status</span>
            </div>
            <ul className="overflow-hidden bg-surface">
              {LIVE_QUEUES.map((queue) => (
                <li key={queue.href} className="border-b border-border last:border-b-0">
                  <Link href={queue.href} prefetch={crmLinkPrefetch(queue.href)} className="grid min-h-14 gap-2 px-4 py-3 hover:bg-surface-raised md:grid-cols-[minmax(10rem,0.8fr)_1fr_1.2fr_minmax(8rem,0.7fr)] md:items-center md:py-2">
                    <strong className="text-sm font-semibold text-text-primary">{queue.title}</strong>
                    <span className="text-sm leading-5 text-text-secondary"><small className="mr-2 font-medium text-muted md:hidden">Trigger</small>{queue.trigger}</span>
                    <span className="text-sm leading-5 text-text-secondary"><small className="mr-2 font-medium text-muted md:hidden">Action</small>{queue.action} <span aria-hidden="true" className="text-accent">→</span></span>
                    <span className="w-fit rounded-full bg-accent/10 px-2 py-1 text-xs font-semibold text-text-primary">{queue.status}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="future-workflows-title">
            <div className="mb-3 flex items-end justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-muted">Future catalog</p>
                <h2 id="future-workflows-title" className="mt-1 text-base font-semibold text-text-primary">Five proposed workflows</h2>
              </div>
              <span className="text-xs text-muted">Read only · five concepts</span>
            </div>
            <div className="hidden grid-cols-[minmax(10rem,0.8fr)_1fr_1.2fr_minmax(8rem,0.7fr)] bg-surface-raised px-4 py-2 text-xs font-medium text-muted md:grid">
              <span>Recipe</span><span>Trigger</span><span>Action</span><span>Status</span>
            </div>
            <dl className="overflow-hidden bg-surface">
              {FUTURE_WORKFLOWS.map((workflow) => (
                <div key={workflow.title} className="grid min-h-14 gap-2 border-b border-border px-4 py-3 last:border-b-0 md:grid-cols-[minmax(10rem,0.8fr)_1fr_1.2fr_minmax(8rem,0.7fr)] md:items-center md:gap-4 md:py-2">
                  <dt className="text-sm font-semibold text-text-primary">{workflow.title}</dt>
                  <dd className="text-sm leading-5 text-text-secondary"><small className="mr-2 font-medium text-muted md:hidden">Trigger</small>{workflow.trigger}</dd>
                  <dd className="text-sm leading-5 text-text-secondary"><small className="mr-2 font-medium text-muted md:hidden">Action</small>{workflow.action}</dd>
                  <dd className="w-fit rounded-full bg-surface-raised px-2 py-1 text-xs font-semibold text-muted">{workflow.status}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </OperationsSurface>
  );
}

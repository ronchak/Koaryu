import { IntentPrefetchLink as Link } from "@/components/intent-prefetch-link";
import { BellRing } from "lucide-react";
import { Header } from "@/components/header";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { Button } from "@/components/ui/button";
import { WorkflowCatalogPanel } from "@/components/automations/workflow-catalog-panel";
import { MissedClassAutomation } from "@/components/automations/missed-class-automation";
import { crmLinkPrefetch } from "@/lib/constants";

const LIVE_QUEUES = [
  { title: "Lead follow-ups", description: "Call, trial, and next-step obligations already live in Leads.", href: "/leads" },
  { title: "Students going quiet", description: "Dashboard surfaces students crossing inactivity thresholds.", href: "/dashboard" },
  { title: "Ready to promote", description: "Belt Tracker applies the current rank and approval requirements.", href: "/belt-tracker" },
  { title: "Tuition needs attention", description: "Billing holds failed payments, past-due families, and open invoices.", href: "/billing" },
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

      <div
        className="min-w-0 flex-1 overflow-x-hidden px-4 py-5 sm:px-8 lg:py-7"
        data-automation-catalog="live-queues-and-workflows"
      >
        <div className="mx-auto max-w-5xl space-y-3">
          <MissedClassAutomation />

          <section aria-labelledby="live-queues-title" className="min-w-0 p-4" data-automation-sheet="true">
            <div className="mb-3 flex min-w-0 items-end justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-muted">Available now</p>
                <h2 id="live-queues-title" className="mt-1 text-base font-semibold text-text-primary">Four live queue destinations</h2>
              </div>
              <span className="shrink-0 text-xs font-semibold text-muted">04</span>
            </div>
            <ol className="min-w-0 overflow-hidden" data-automation-inset="true" data-automation-live-list="four-destinations">
              {LIVE_QUEUES.map((queue) => (
                <li key={queue.href} className="border-b border-border last:border-b-0">
                  <Link
                    href={queue.href}
                    prefetch={crmLinkPrefetch(queue.href)}
                    className="grid min-h-20 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[10px] px-3 py-4 hover:bg-surface-hover"
                    data-automation-live-target="true"
                  >
                    <span className="min-w-0">
                      <strong className="block break-words text-sm font-semibold text-text-primary">{queue.title}</strong>
                      <span className="mt-1 block break-words text-sm leading-5 text-text-secondary">{queue.description}</span>
                    </span>
                    <span aria-hidden="true" className="text-accent">→</span>
                  </Link>
                </li>
              ))}
            </ol>
          </section>

          <WorkflowCatalogPanel />
        </div>
      </div>
    </OperationsSurface>
  );
}

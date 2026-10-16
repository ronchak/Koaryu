import { IntentPrefetchLink as Link } from "@/components/intent-prefetch-link";
import { ArrowRight, Award, Clock3, CreditCard, LayoutTemplate, PhoneCall } from "lucide-react";
import { Header } from "@/components/header";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { Button } from "@/components/ui/button";
import { HorizonPage, HorizonPanel, ToneChip } from "@/components/ui/horizon";
import { WorkflowCatalogPanel } from "@/components/automations/workflow-catalog-panel";
import { MissedClassSummaryRow } from "@/components/automations/missed-class-summary-row";
import { NewWorkflowButton } from "@/components/automations/new-workflow-button";
import { crmLinkPrefetch } from "@/lib/constants";
import styles from "./automations-page.module.css";

const LIVE_QUEUES = [
  {
    title: "Lead follow-ups",
    description: "Call, trial, and next-step obligations already live in Leads.",
    href: "/leads",
    icon: PhoneCall,
  },
  {
    title: "Students going quiet",
    description: "Dashboard surfaces students crossing inactivity thresholds.",
    href: "/dashboard",
    icon: Clock3,
  },
  {
    title: "Ready to promote",
    description: "Belt Tracker applies the current rank and approval requirements.",
    href: "/belt-tracker",
    icon: Award,
  },
  {
    title: "Tuition needs attention",
    description: "Billing holds failed payments, past-due families, and open invoices.",
    href: "/billing",
    icon: CreditCard,
  },
] as const;

export default function AutomationsPage() {
  return (
    <OperationsSurface page="automations">
      <Header
        title="Automations"
        description="Follow-ups that run on their own. Each one says what starts it, what it does, and whether it is on."
      >
        <Button asChild variant="secondary" size="lg">
          <a href="#workflow-templates">
            <LayoutTemplate className="h-4 w-4" aria-hidden="true" />
            Templates
          </a>
        </Button>
        <NewWorkflowButton />
      </Header>

      <div className={styles.body} data-automation-catalog="automations-and-live-queues">
        <HorizonPage className={styles.page}>
          <WorkflowCatalogPanel builtIn={<MissedClassSummaryRow />} />

          <HorizonPanel
            title="Live queues"
            titleId="live-queues-title"
            description="These lists stay current on their own pages. Open one to act on it."
            flush
          >
            <ol className={styles.queues} data-automation-live-list="four-destinations">
              {LIVE_QUEUES.map((queue) => {
                const Icon = queue.icon;
                return (
                  <li key={queue.href}>
                    <Link
                      href={queue.href}
                      prefetch={crmLinkPrefetch(queue.href)}
                      className={styles.queue}
                      data-automation-live-target="true"
                    >
                      <ToneChip size={32}>
                        <Icon />
                      </ToneChip>
                      <span className={styles.queueText}>
                        <strong>{queue.title}</strong>
                        <span>{queue.description}</span>
                      </span>
                      <ArrowRight aria-hidden="true" className={styles.queueArrow} />
                    </Link>
                  </li>
                );
              })}
            </ol>
          </HorizonPanel>
        </HorizonPage>
      </div>
    </OperationsSurface>
  );
}

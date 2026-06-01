import Link from "next/link";
import {
  Award,
  BellRing,
  CalendarClock,
  CreditCard,
  Mail,
  ShieldCheck,
  TrendingDown,
  UserPlus,
  Zap,
} from "lucide-react";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { OverviewActionList, OverviewPanel, OverviewPanelHeader, type OverviewAction } from "@/components/ui/overview";
import { crmLinkPrefetch } from "@/lib/constants";

const MANUAL_SIGNALS: OverviewAction[] = [
  {
    id: "lead-followups",
    title: "Lead follow-ups",
    description: "Use Dashboard and Leads to see which prospects need a call, trial reminder, or next step today.",
    href: "/leads",
    icon: UserPlus,
    tone: "accent",
  },
  {
    id: "missed-class",
    title: "Students going quiet",
    description: "Dashboard highlights students crossing inactivity thresholds before they become cancellations.",
    href: "/dashboard",
    icon: TrendingDown,
    tone: "warning",
  },
  {
    id: "ready-to-promote",
    title: "Ready to promote",
    description: "Belt Tracker shows students who meet class, time, and approval requirements for the next rank.",
    href: "/belt-tracker",
    icon: Award,
    tone: "success",
  },
  {
    id: "tuition-attention",
    title: "Tuition needs attention",
    description: "Billing keeps failed payments, past-due families, and open invoices in one operational queue.",
    href: "/billing",
    icon: CreditCard,
    tone: "danger",
  },
];

const UPCOMING_WORKFLOWS = [
  {
    icon: UserPlus,
    title: "Trial reminders",
    description: "Send a prewritten reminder before a lead's trial class and a follow-up afterward.",
  },
  {
    icon: TrendingDown,
    title: "Missed-class nudges",
    description: "Email families after configurable 14-day or 30-day attendance gaps.",
  },
  {
    icon: CreditCard,
    title: "Payment recovery",
    description: "Notify families when a payment fails, then stop reminders when Stripe recovers it.",
  },
  {
    icon: Award,
    title: "Promotion congratulations",
    description: "Send a polished note after a promotion is recorded in the belt history.",
  },
  {
    icon: CalendarClock,
    title: "Belt test announcements",
    description: "Notify eligible students and families before a testing cycle.",
  },
];

export default function AutomationsPage() {
  return (
    <>
      <Header
        title="Automations"
        description="Rules-based email workflows are planned; today's retention signals already live across Dashboard, Leads, Belt Tracker, and Billing."
      >
        <Button asChild variant="secondary" size="sm">
          <Link href="/dashboard" prefetch={crmLinkPrefetch("/dashboard")}>
            <BellRing className="h-3.5 w-3.5" />
            Today&apos;s actions
          </Link>
        </Button>
      </Header>

      <div className="flex-1 p-6 sm:p-8">
        <div className="mx-auto max-w-6xl space-y-5">
          <OverviewPanel>
            <div className="grid gap-px bg-border lg:grid-cols-[0.9fr_1.1fr]">
              <section className="bg-surface px-5 py-6 sm:px-6">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-[6px] border border-warning/20 bg-warning/10 text-warning">
                    <Zap className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-widest text-warning">Planned module</p>
                    <h2 className="mt-1 text-lg font-semibold text-text-primary">Automation builder is not live yet</h2>
                  </div>
                </div>
                <p className="mt-4 text-sm leading-6 text-text-secondary">
                  Koaryu will use deterministic templates and studio-approved rules, not AI-written messages in the critical path. Until this ships, this page stays honest and points you to the manual queues that already protect retention.
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button asChild variant="primary" size="sm">
                    <Link href="/dashboard" prefetch={crmLinkPrefetch("/dashboard")}>Open Dashboard</Link>
                  </Button>
                  <Button asChild variant="secondary" size="sm">
                    <Link href="/billing" prefetch={crmLinkPrefetch("/billing")}>Review Billing</Link>
                  </Button>
                </div>
              </section>

              <section className="bg-surface px-5 py-6 sm:px-6">
                <div className="flex items-start gap-3 rounded-[6px] border border-border bg-bg px-4 py-4">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <div>
                    <h3 className="text-sm font-medium text-text-primary">What will ship here</h3>
                    <p className="mt-1 text-xs leading-5 text-text-secondary">
                      Studio admins will be able to toggle templates, edit copy, choose triggers, and review email usage before anything sends automatically.
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex items-start gap-3 rounded-[6px] border border-border bg-bg px-4 py-4">
                  <Mail className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  <div>
                    <h3 className="text-sm font-medium text-text-primary">What will not happen silently</h3>
                    <p className="mt-1 text-xs leading-5 text-text-secondary">
                      No hidden SMS charges, no unreviewed AI copy, and no surprise messages to families before the studio turns a workflow on.
                    </p>
                  </div>
                </div>
              </section>
            </div>
          </OverviewPanel>

          <OverviewPanel>
            <OverviewPanelHeader
              title="Use these queues now"
              description="The automation builder is future work, but these live screens already surface the moments a studio owner cares about."
            />
            <OverviewActionList
              actions={MANUAL_SIGNALS}
              emptyTitle="No manual queues configured"
              emptyDescription="Dashboard, Leads, Belt Tracker, and Billing become more useful as setup data is added."
            />
          </OverviewPanel>

          <OverviewPanel>
            <OverviewPanelHeader
              title="Workflow library coming next"
              description="Initial automations should be simple, editable, and safe enough for a busy front desk to trust."
            />
            <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-5">
              {UPCOMING_WORKFLOWS.map((workflow) => {
                const Icon = workflow.icon;

                return (
                  <div key={workflow.title} className="bg-surface px-4 py-4">
                    <Icon className="h-4 w-4 text-accent" />
                    <h3 className="mt-3 text-sm font-medium text-text-primary">{workflow.title}</h3>
                    <p className="mt-1 text-xs leading-5 text-text-secondary">{workflow.description}</p>
                  </div>
                );
              })}
            </div>
          </OverviewPanel>
        </div>
      </div>
    </>
  );
}

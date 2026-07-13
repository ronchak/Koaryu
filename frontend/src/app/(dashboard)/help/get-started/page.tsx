import Link from "next/link";
import { Award, Calendar, CreditCard, Settings, Users } from "lucide-react";
import { AccountPageShell, AccountSection } from "@/components/account-page-shell";
import { Button } from "@/components/ui/button";

const steps = [
  {
    title: "Confirm studio settings",
    description: "Set the studio name, programs, and staff access before adding operational records.",
    href: "/settings",
    icon: Settings,
  },
  {
    title: "Add students",
    description: "Create students manually or import a CSV roster when a school already has records.",
    href: "/students",
    icon: Users,
  },
  {
    title: "Configure ranks",
    description: "Build a belt ladder that matches the studio's actual promotion system.",
    href: "/belt-tracker",
    icon: Award,
  },
  {
    title: "Create the schedule",
    description: "Add recurring classes and use attendance to make the dashboard useful day to day.",
    href: "/schedule",
    icon: Calendar,
  },
  {
    title: "Review supported billing records",
    description:
      "Admin or Front Desk can review existing billing state, attach external-only records, record payer-level external payments, and reconcile existing provider invoices.",
    href: "/billing",
    icon: CreditCard,
  },
];

export default function GetStartedPage() {
  return (
    <AccountPageShell
      title="Get started"
      description="A practical first-day path for operating one Friendly Pilot studio."
    >
      <AccountSection title="Recommended setup order">
        <div className="space-y-3">
          {steps.map((step, index) => {
            const Icon = step.icon;
            return (
              <Link
                key={step.href}
                href={step.href}
                className="flex items-start gap-4 rounded-[6px] border border-border bg-surface-raised p-4 hover:bg-surface-hover"
              >
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[6px] bg-accent/10 text-xs font-semibold text-accent">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                    <Icon className="h-4 w-4 text-accent" />
                    {step.title}
                  </span>
                  <span className="mt-1 block text-sm text-text-secondary">{step.description}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </AccountSection>

      <AccountSection title="Staff roles and studio boundary">
        <div className="space-y-2 text-sm leading-6 text-text-secondary">
          <p>
            Admin controls staff, studio settings, and protected configuration. Front Desk handles students,
            rosters, leads, schedules, attendance, and supported routine billing. Instructors may edit existing
            student profiles, take attendance, and use named promotion or demotion actions, but cannot create or
            archive students, manage leads or schedules, or view any billing data.
          </p>
          <p>
            Each user belongs to one studio. If Koaryu reports an unexpected existing multi-studio membership,
            stop and contact support; the memberships are preserved and the app fails closed until they are
            reviewed.
          </p>
        </div>
      </AccountSection>

      <AccountSection title="First-day checks">
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-text-secondary">
          <li>Verify one Admin, one Front Desk, and one Instructor account against the expected permissions.</li>
          <li>Check a sample of imported students, guardians, programs, ranks, and statuses.</li>
          <li>Open the current schedule on the phone used at the studio and record attendance for a test class.</li>
          <li>Confirm an Instructor receives the billing access-denied page without billing data.</li>
          <li>Submit a signed-in test request through Contact support and confirm the expected notification path.</li>
        </ol>
      </AccountSection>

      <AccountSection title="Daily rhythm">
        <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-text-secondary">
          <li>Review dashboard attention items, leads, and today&apos;s classes.</li>
          <li>Take attendance from the correct class and use named rank actions so history stays auditable.</li>
          <li>Have Admin or Front Desk review billing attention and refresh before retrying an ambiguous action.</li>
          <li>Use Contact support for access, missing-data, or provider/local-state disagreements.</li>
        </ul>
        <p className="mt-4 text-sm leading-6 text-text-secondary">
          Friendly Pilot does not create plans or payers, enable autopay, change provider-backed enrollments,
          create or retry invoices, issue refunds, or activate Stripe. Live outbound Stripe mutation remains
          closed and requires a separate explicit approval.
        </p>
      </AccountSection>

      <Button asChild variant="secondary" size="sm">
        <Link href="/help">Back to help center</Link>
      </Button>
    </AccountPageShell>
  );
}

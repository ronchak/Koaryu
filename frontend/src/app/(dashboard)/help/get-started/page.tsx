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
    title: "Turn on billing",
    description: "Connect Stripe, create plans, add payers, and verify webhook health before charging students.",
    href: "/billing",
    icon: CreditCard,
  },
];

export default function GetStartedPage() {
  return (
    <AccountPageShell
      title="Get started"
      description="A practical first-run path for turning a blank Koaryu studio into something demo-ready."
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

      <Button asChild variant="secondary" size="sm">
        <Link href="/help">Back to help center</Link>
      </Button>
    </AccountPageShell>
  );
}

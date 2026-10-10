"use client";

import { Bell, CreditCard, Mail, ShieldAlert, Users } from "lucide-react";
import {
  AccountInfoRow,
  AccountNotice,
  AccountPageShell,
  AccountSection,
} from "@/components/account-page-shell";

const OPTIONS: Array<{
  title: string;
  description: string;
  icon: typeof Bell;
  status: string;
}> = [
  {
    title: "Billing and payments",
    description:
      "Failed payments, webhook issues, Connect requirements, and billing reconciliation alerts.",
    icon: CreditCard,
    status: "Planned",
  },
  {
    title: "Students and attendance",
    description:
      "Important student lifecycle reminders, attendance gaps, and profile hygiene prompts.",
    icon: Users,
    status: "Planned",
  },
  {
    title: "Staff and access",
    description: "Staff invitations, role changes, and account access changes.",
    icon: Mail,
    status: "Planned",
  },
  {
    title: "Security",
    description:
      "Suspicious access patterns, high-risk data operations, and account recovery notices.",
    icon: ShieldAlert,
    status: "Always shown when critical",
  },
];

export default function NotificationsPage() {
  return (
    <AccountPageShell
      title="Notifications"
      description="Review the notification categories Koaryu will support as delivery controls come online."
    >
      <AccountSection
        title="Notification categories"
        description="Delivery preferences are not enabled yet, so this page is intentionally read-only."
      >
        <div>
          {OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <div
                key={option.title}
                className="flex w-full items-start gap-3 border-b border-border py-4 text-left first:pt-1 last:border-b-0 last:pb-1"
              >
                <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[11px] bg-[var(--hz-tile)] text-accent">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-text-primary">
                    {option.title}
                  </span>
                  <span className="mt-1 block text-sm text-text-secondary">
                    {option.description}
                  </span>
                </span>
                <span className="mt-1 flex-shrink-0 rounded-full bg-[var(--hz-tile)] px-2.5 py-0.5 text-xs font-bold text-text-secondary">
                  {option.status}
                </span>
              </div>
            );
          })}
        </div>
      </AccountSection>

      <AccountSection title="Delivery status">
        <AccountInfoRow label="Preference controls" value="Planned" />
        <AccountInfoRow label="In-app notification delivery" value="Planned" />
        <AccountInfoRow label="Email delivery" value="Planned" />
        <AccountInfoRow label="Push notifications" value="Planned" />
        <div className="mt-4">
          <AccountNotice>
            Critical security and billing notices may still be shown in-product when Koaryu needs to
            protect the account or payment flow. User-level delivery preferences will become
            actionable after notification delivery is implemented.
          </AccountNotice>
        </div>
      </AccountSection>
    </AccountPageShell>
  );
}

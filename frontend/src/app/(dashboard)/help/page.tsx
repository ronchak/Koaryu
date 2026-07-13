import { BookOpen, Bug, Download, FileText, LifeBuoy, Megaphone, Shield } from "lucide-react";
import {
  AccountLinkTile,
  AccountNotice,
  AccountPageShell,
  AccountSection,
} from "@/components/account-page-shell";

export default function HelpPage() {
  return (
    <AccountPageShell
      title="Help center"
      description="Quick answers and support routes for running Koaryu in a real studio."
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <AccountLinkTile
          href="/help/get-started"
          icon={BookOpen}
          title="Get started"
          description="A short path for setting up one studio, staff roles, students, ranks, schedule, and supported billing records."
        />
        <AccountLinkTile
          href="/help/release-notes"
          icon={Megaphone}
          title="Release notes"
          description="Recent product changes, billing hardening, and demo-readiness improvements."
        />
        <AccountLinkTile
          href="/help/downloads"
          icon={Download}
          title="Download apps"
          description="Install Koaryu as a browser app on desktop, tablet, or phone."
        />
        <AccountLinkTile
          href="/help/contact"
          icon={LifeBuoy}
          title="Contact support"
          description="Report bugs, request help, or ask about billing/account access."
        />
        <AccountLinkTile
          href="/terms"
          icon={FileText}
          title="Terms of Service"
          description="Review the operating terms for Koaryu software and billing tools."
        />
        <AccountLinkTile
          href="/privacy"
          icon={Shield}
          title="Privacy Policy"
          description="Understand how Koaryu handles account, studio, student, and payment data."
        />
        <AccountLinkTile
          href="/help/contact?topic=bug#bug"
          icon={Bug}
          title="Report a bug"
          description="Send a focused report with page, steps, expected behavior, and screenshots."
        />
      </div>

      <AccountSection title="Billing support priority">
        <AccountNotice>
          Admin and Front Desk may review billing and use the supported external-record and invoice-reconciliation
          actions. Instructors have no billing access. Payment issues should include the studio name, payer name,
          invoice number if visible, and whether Stripe shows the payment as succeeded or failed. Do not include
          card data, passwords, API keys, webhook secrets, or raw production exports.
        </AccountNotice>
      </AccountSection>

      <AccountSection title="Support diagnostics">
        <AccountNotice>
          Use Contact support while signed in. Include the affected page, approximate time, staff role, steps,
          expected result, and a non-sensitive screenshot when useful. If the support page is unavailable, email
          support@koaryu.app.
        </AccountNotice>
      </AccountSection>
    </AccountPageShell>
  );
}

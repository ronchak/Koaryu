import { Header } from "@/components/header";
import { CreditCard, ArrowRight } from "lucide-react";

export default function BillingPage() {
  return (
    <>
      <Header title="Billing" description="Subscriptions, payments, and invoices." />
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <div className="w-12 h-12 rounded-[12px] bg-accent/10 flex items-center justify-center mx-auto mb-4">
            <CreditCard className="w-6 h-6 text-accent" />
          </div>
          <h2 className="text-base font-semibold text-text-primary mb-2">
            Billing coming soon
          </h2>
          <p className="text-sm text-text-secondary leading-relaxed mb-4">
            Stripe integration is on the roadmap. You&apos;ll be able to collect monthly tuition, send invoices, and manage payment plans — all from this page.
          </p>
          <div className="bg-surface border border-border rounded-[6px] p-4 text-left space-y-2">
            <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">Planned features</p>
            {[
              "Automated monthly tuition collection",
              "Family & sibling discount plans",
              "Payment history & receipts",
              "Overdue payment notifications",
            ].map((f) => (
              <div key={f} className="flex items-center gap-2 text-xs text-muted">
                <ArrowRight className="w-3 h-3 text-accent flex-shrink-0" />
                {f}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

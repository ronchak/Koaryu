"use client";

import { Users } from "lucide-react";
import { formatMoney } from "@/lib/billing-page-utils";
import type { BillingPayer } from "@/types";
import { SectionHeader, StatusPill } from "./billing-page-sections";

export function BillingFamiliesTab({ billingPayers }: { billingPayers: BillingPayer[] }) {
  return (
    <div className="space-y-5">
      <section className="rounded-[6px] border border-border bg-surface p-5">
        <SectionHeader
          icon={Users}
          title="Family payer accounts are read-only"
          description="Friendly Pilot displays existing payer and provider status. Creating, syncing, or changing autopay is outside this release."
        />
      </section>

      <section className="rounded-[6px] border border-border bg-surface">
        <div className="hidden grid-cols-[1.1fr_1fr_1fr_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted md:grid">
          <span>Payer</span>
          <span>Contact</span>
          <span>Stripe</span>
          <span>Autopay</span>
        </div>
        {billingPayers.length === 0 ? (
          <p className="p-4 text-sm text-muted">No payer accounts yet.</p>
        ) : billingPayers.map((payer) => (
          <div key={payer.id} className="grid min-w-0 grid-cols-1 gap-3 border-b border-border px-4 py-4 text-sm last:border-b-0 md:grid-cols-[1.1fr_1fr_1fr_auto] md:gap-4">
            <div className="min-w-0">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted md:hidden">Payer</p>
              <p className="font-medium text-text-primary">{payer.display_name}</p>
              <div className="mt-1"><StatusPill status={payer.billing_status} /></div>
              <p className="mt-1 text-xs text-muted">{formatMoney(payer.balance_cents)}</p>
            </div>
            <div className="min-w-0 text-text-secondary">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted md:hidden">Contact</p>
              <p className="break-words [overflow-wrap:anywhere]">{payer.email || "No email"}</p>
              <p className="text-xs text-muted">{payer.phone || "No phone"}</p>
            </div>
            <div className="min-w-0 text-xs text-muted">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted md:hidden">Provider</p>
              <p className="break-words [overflow-wrap:anywhere] md:truncate">{payer.stripe_customer_id || "No Stripe customer"}</p>
              <p className="break-words [overflow-wrap:anywhere] md:truncate">
                {payer.stripe_payment_method_last4
                  ? `${payer.stripe_payment_method_brand || payer.stripe_payment_method_type || "card"} ending ${payer.stripe_payment_method_last4}`
                  : payer.stripe_payment_method_id
                    ? payer.stripe_payment_method_brand || payer.stripe_payment_method_type || "Saved payment method"
                    : "No payment method"}
              </p>
            </div>
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted md:hidden">Autopay</p>
              <StatusPill status={payer.autopay_status} />
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

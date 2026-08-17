"use client";

import { Receipt } from "lucide-react";
import { formatMoney, intervalLabel } from "@/lib/billing-page-utils";
import type { BillingPlan } from "@/types";
import { ProgramChip, SectionHeader, StatusPill } from "./billing-page-sections";

export function BillingPlansTab({ billingPlans }: { billingPlans: BillingPlan[] }) {
  return (
    <div className="space-y-5">
      <section className="border-y border-border bg-surface p-5">
        <SectionHeader
          icon={Receipt}
          title="Tuition plans are read-only"
          description="Koaryu displays existing local and provider references. Creating or syncing plans is currently unavailable."
        />
      </section>

      <section className="border-y border-border bg-surface">
        <div className="hidden grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted md:grid">
          <span>Plan</span>
          <span>Amount</span>
          <span>Stripe</span>
          <span>Status</span>
        </div>
        {billingPlans.length === 0 ? (
          <p className="p-4 text-sm text-muted">No billing plans yet.</p>
        ) : billingPlans.map((plan) => (
          <div key={plan.id} className="grid min-w-0 grid-cols-1 gap-3 border-b border-border px-4 py-4 last:border-b-0 md:grid-cols-[1fr_auto_auto_auto] md:gap-4">
            <div className="min-w-0">
              <p className="font-medium text-text-primary">{plan.name}</p>
              <p className="mt-1 text-xs text-muted">{plan.description || intervalLabel(plan.billing_interval)}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {plan.programs.length
                  ? plan.programs.map((program) => <ProgramChip key={program.program_id} program={program} />)
                  : <span className="text-xs text-muted">No programs attached</span>}
              </div>
              {plan.pending_reason ? <p className="mt-2 text-xs text-warning">{plan.pending_reason}</p> : null}
            </div>
            <div className="text-right">
              <p className="mb-1 text-left text-[11px] font-medium uppercase tracking-wide text-muted md:hidden">Amount</p>
              <p className="text-sm font-medium text-text-primary">{formatMoney(plan.amount_cents, plan.currency)}</p>
              <p className="text-xs text-muted">{intervalLabel(plan.billing_interval)}</p>
            </div>
            <div className="max-w-[220px] text-right text-xs text-muted">
              <p className="mb-1 text-left text-[11px] font-medium uppercase tracking-wide text-muted md:hidden">Provider references</p>
              <p className="truncate">{plan.stripe_product_id || "No product"}</p>
              <p className="truncate">{plan.stripe_price_id || "No price"}</p>
            </div>
            <div><p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted md:hidden">Status</p><StatusPill status={plan.status} /></div>
          </div>
        ))}
      </section>
    </div>
  );
}

"use client";

import { Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoney, intervalLabel } from "@/lib/billing-page-utils";
import type { BillingPlan } from "@/types";
import { ProgramChip, SectionHeader, StatusPill } from "./billing-page-sections";

export function BillingPlansTab({
  billingPlans,
  canUseWorkflow,
  isActionLoading,
  isLoadingAction,
  onPlanSync,
}: {
  billingPlans: BillingPlan[];
  canUseWorkflow: (workflowId: string) => boolean;
  isActionLoading: boolean;
  isLoadingAction: (action: string) => boolean;
  onPlanSync: (planId: string) => void;
}) {
  return (
    <div className="space-y-5">
      <section className="rounded-[14px] border border-border bg-surface p-4">
        <SectionHeader
          icon={Receipt}
          title="Tuition plan workflows"
          description="Existing plans can sync through one replay-safe provider workflow when the server capability is enabled."
        />
      </section>

      <section className="overflow-hidden rounded-[14px] border border-border bg-surface">
        <div className="hidden grid-cols-[1fr_auto_auto_auto_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted md:grid">
          <span>Plan</span>
          <span>Amount</span>
          <span>Stripe</span>
          <span>Status</span>
          <span>Actions</span>
        </div>
        {billingPlans.length === 0 ? (
          <p className="p-4 text-sm text-muted">No billing plans yet.</p>
        ) : billingPlans.map((plan) => (
          <div key={plan.id} className="grid min-w-0 grid-cols-1 gap-3 border-b border-border px-4 py-3 last:border-b-0 md:min-h-14 md:grid-cols-[1fr_auto_auto_auto_auto] md:items-center md:gap-4 md:py-2">
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
              <p className="mb-1 text-left text-xs font-medium text-muted md:hidden">Amount</p>
              <p className="text-sm font-medium text-text-primary">{formatMoney(plan.amount_cents, plan.currency)}</p>
              <p className="text-xs text-muted">{intervalLabel(plan.billing_interval)}</p>
            </div>
            <div className="max-w-[220px] text-right text-xs text-muted">
              <p className="mb-1 text-left text-xs font-medium text-muted md:hidden">Provider references</p>
              <p>{plan.stripe_product_id ? "Provider product linked" : "Product not synced"}</p>
              <p>{plan.stripe_price_id ? "Provider price linked" : "Price not synced"}</p>
            </div>
            <div><p className="mb-1 text-xs font-medium text-muted md:hidden">Status</p><StatusPill status={plan.status} /></div>
            <div>
              {canUseWorkflow("plan.sync") ? (
                <Button size="sm" disabled={isActionLoading} isLoading={isLoadingAction(`plan-sync:${plan.id}`)} onClick={() => onPlanSync(plan.id)}>
                  {isLoadingAction(`plan-sync:${plan.id}`) ? "Syncing..." : "Sync plan"}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

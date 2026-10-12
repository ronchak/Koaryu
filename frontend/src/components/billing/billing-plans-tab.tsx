"use client";

import { billingLedgerLayout } from "./billing-layout";
import { Button } from "@/components/ui/button";
import { formatMoney, intervalLabel } from "@/lib/billing-page-utils";
import type { BillingPlan } from "@/types";
import { BillingEmpty, BillingPanel, ProgramChip, StatusPill } from "./billing-page-sections";

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
    <BillingPanel
      title="Tuition plans"
      description="Existing plans can sync through one replay-safe provider workflow when the server capability is enabled."
      flush
    >
      <div className={billingLedgerLayout.plans.header}>
        <span>Plan</span>
        <span className="text-right">Amount</span>
        <span>Stripe</span>
        <span>Status</span>
        <span className="sr-only">Actions</span>
      </div>
      {billingPlans.length === 0 ? (
        <BillingEmpty title="No billing plans yet." />
      ) : (
        billingPlans.map((plan) => (
          <div key={plan.id} className={billingLedgerLayout.plans.row}>
            <div className="col-span-2 min-w-0 lg:col-span-1">
              <p className="font-semibold text-text-primary">{plan.name}</p>
              <p className="mt-0.5 text-xs text-muted">
                {plan.description || intervalLabel(plan.billing_interval)}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {plan.programs.length ? (
                  plan.programs.map((program) => (
                    <ProgramChip key={program.program_id} program={program} />
                  ))
                ) : (
                  <span className="text-xs text-muted">No programs attached</span>
                )}
              </div>
              {plan.pending_reason ? (
                <p className="mt-2 text-xs font-semibold text-warning">{plan.pending_reason}</p>
              ) : null}
            </div>
            <div className="lg:text-right">
              <p className="text-xs text-muted lg:hidden">Amount</p>
              <p className="text-base font-bold tabular-nums text-text-primary">
                {formatMoney(plan.amount_cents, plan.currency)}
              </p>
              <p className="text-xs text-muted">{intervalLabel(plan.billing_interval)}</p>
            </div>
            <div className="min-w-0 text-xs text-muted">
              <p className="text-xs text-muted lg:hidden">Provider references</p>
              <p>{plan.stripe_product_id ? "Provider product linked" : "Product not synced"}</p>
              <p>{plan.stripe_price_id ? "Provider price linked" : "Price not synced"}</p>
            </div>
            <div>
              <p className="mb-1 text-xs text-muted lg:hidden">Status</p>
              <StatusPill status={plan.status} />
            </div>
            <div className="flex lg:justify-end">
              {canUseWorkflow("plan.sync") ? (
                <Button
                  variant="secondary"
                  size="md"
                  disabled={isActionLoading}
                  isLoading={isLoadingAction(`plan-sync:${plan.id}`)}
                  onClick={() => onPlanSync(plan.id)}
                >
                  {isLoadingAction(`plan-sync:${plan.id}`) ? "Syncing..." : "Sync plan"}
                </Button>
              ) : null}
            </div>
          </div>
        ))
      )}
    </BillingPanel>
  );
}

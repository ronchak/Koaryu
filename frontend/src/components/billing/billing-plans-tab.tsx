"use client";

import type { FormEvent } from "react";
import { Plus, Receipt, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney, intervalLabel } from "@/lib/billing-page-utils";
import type { BillingPlan, Program } from "@/types";
import { ProgramChip, SectionHeader, StatusPill } from "./billing-page-sections";

const BILLING_INTERVAL_OPTIONS: BillingPlan["billing_interval"][] = [
  "monthly",
  "annual",
  "weekly",
  "biweekly",
  "paid_in_full",
  "fixed_term",
  "trial",
];

export function BillingPlansTab({
  activePrograms,
  billingPlans,
  canManageStudioBilling,
  isActionLoading,
  isLoadingAction,
  onCreatePlan,
  onPlanAmountChange,
  onPlanDescriptionChange,
  onPlanIntervalChange,
  onPlanNameChange,
  onPlanProgramToggle,
  onPlanSignupFeeChange,
  onPlanSync,
  onPlanTrialDaysChange,
  planAmount,
  planDescription,
  planInterval,
  planName,
  planProgramIds,
  planSignupFee,
  planTrialDays,
}: {
  activePrograms: Program[];
  billingPlans: BillingPlan[];
  canManageStudioBilling: boolean;
  isActionLoading: boolean;
  isLoadingAction: (action: string) => boolean;
  onCreatePlan: (event: FormEvent<HTMLFormElement>) => void;
  onPlanAmountChange: (value: string) => void;
  onPlanDescriptionChange: (value: string) => void;
  onPlanIntervalChange: (value: BillingPlan["billing_interval"]) => void;
  onPlanNameChange: (value: string) => void;
  onPlanProgramToggle: (programId: string) => void;
  onPlanSignupFeeChange: (value: string) => void;
  onPlanSync: (planId: string) => void;
  onPlanTrialDaysChange: (value: string) => void;
  planAmount: string;
  planDescription: string;
  planInterval: BillingPlan["billing_interval"];
  planName: string;
  planProgramIds: string[];
  planSignupFee: string;
  planTrialDays: string;
}) {
  return (
    <div className="space-y-5">
      <section className="border border-border bg-surface rounded-[6px] p-5">
        <SectionHeader icon={Receipt} title="Create billing plan" description="Plans can be drafted before Stripe verification. Pending plans cannot generate invoices or accept payments until charges are enabled." />
        <form onSubmit={onCreatePlan} className="grid gap-3 lg:grid-cols-[1.2fr_0.6fr_0.5fr_0.5fr_0.8fr]">
          <Input label="Plan name" value={planName} onChange={(event) => onPlanNameChange(event.target.value)} placeholder="Kids Unlimited" disabled={!canManageStudioBilling} />
          <Input label="Monthly amount" value={planAmount} onChange={(event) => onPlanAmountChange(event.target.value)} placeholder="129" inputMode="decimal" disabled={!canManageStudioBilling} />
          <Input label="Signup fee" value={planSignupFee} onChange={(event) => onPlanSignupFeeChange(event.target.value)} placeholder="49" inputMode="decimal" disabled={!canManageStudioBilling} />
          <Input label="Trial days" value={planTrialDays} onChange={(event) => onPlanTrialDaysChange(event.target.value)} placeholder="14" inputMode="numeric" disabled={!canManageStudioBilling} />
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-text-secondary font-medium" htmlFor="billing-interval">Interval</label>
            <select
              id="billing-interval"
              value={planInterval}
              onChange={(event) => onPlanIntervalChange(event.target.value as BillingPlan["billing_interval"])}
              disabled={!canManageStudioBilling}
              className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            >
              {BILLING_INTERVAL_OPTIONS.map((interval) => (
                <option key={interval} value={interval}>{intervalLabel(interval)}</option>
              ))}
            </select>
          </div>
          <div className="lg:col-span-5">
            <Input label="Description" value={planDescription} onChange={(event) => onPlanDescriptionChange(event.target.value)} placeholder="Optional internal notes" disabled={!canManageStudioBilling} />
          </div>
          <div className="lg:col-span-5">
            <p className="mb-2 text-sm font-medium text-text-secondary">Programs</p>
            <div className="flex flex-wrap gap-2">
              {activePrograms.length === 0 ? (
                <p className="text-sm text-muted">Create a program in Settings before attaching billing plans.</p>
              ) : activePrograms.map((program) => (
                <label key={program.id} className="inline-flex cursor-pointer items-center gap-2 rounded-[6px] border border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
                  <input
                    type="checkbox"
                    checked={planProgramIds.includes(program.id)}
                    onChange={() => onPlanProgramToggle(program.id)}
                    disabled={!canManageStudioBilling}
                    className="accent-[#E5C15C]"
                  />
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: program.color_hex }} />
                  {program.name}
                </label>
              ))}
            </div>
          </div>
          <div className="lg:col-span-5">
            <Button type="submit" size="sm" disabled={!canManageStudioBilling || isActionLoading || activePrograms.length === 0} isLoading={isLoadingAction("create-plan")}>
              <Plus className="h-3.5 w-3.5" />
              {isLoadingAction("create-plan") ? "Creating..." : "Create plan"}
            </Button>
          </div>
        </form>
      </section>

      <section className="border border-border bg-surface rounded-[6px]">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted">
          <span>Plan</span>
          <span>Amount</span>
          <span>Stripe</span>
          <span>Status</span>
        </div>
        {billingPlans.length === 0 ? (
          <p className="p-4 text-sm text-muted">No billing plans yet.</p>
        ) : billingPlans.map((plan) => (
          <div key={plan.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-border px-4 py-4 last:border-b-0">
            <div className="min-w-0">
              <p className="font-medium text-text-primary">{plan.name}</p>
              <p className="mt-1 text-xs text-muted">{plan.description || intervalLabel(plan.billing_interval)}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {plan.programs.length ? plan.programs.map((program) => <ProgramChip key={program.program_id} program={program} />) : <span className="text-xs text-muted">No programs attached</span>}
              </div>
              {plan.pending_reason ? <p className="mt-2 text-xs text-warning">{plan.pending_reason}</p> : null}
            </div>
            <div className="text-right">
              <p className="text-sm font-medium text-text-primary">{formatMoney(plan.amount_cents, plan.currency)}</p>
              <p className="text-xs text-muted">{intervalLabel(plan.billing_interval)}</p>
              {(plan.signup_fee_cents || plan.trial_days) ? (
                <p className="text-xs text-muted">
                  {plan.signup_fee_cents ? `${formatMoney(plan.signup_fee_cents, plan.currency)} signup` : null}
                  {plan.signup_fee_cents && plan.trial_days ? " / " : null}
                  {plan.trial_days ? `${plan.trial_days} day trial` : null}
                </p>
              ) : null}
            </div>
            <div className="max-w-[220px] text-right text-xs text-muted">
              <p className="truncate">{plan.stripe_product_id || "No product"}</p>
              <p className="truncate">{plan.stripe_price_id || "No price"}</p>
              {(!plan.stripe_price_id || plan.status === "pending") ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  disabled={!canManageStudioBilling || isActionLoading}
                  isLoading={isLoadingAction(`plan-sync:${plan.id}`)}
                  onClick={() => onPlanSync(plan.id)}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {isLoadingAction(`plan-sync:${plan.id}`) ? "Syncing..." : "Sync"}
                </Button>
              ) : null}
            </div>
            <div>
              <StatusPill status={plan.status} />
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

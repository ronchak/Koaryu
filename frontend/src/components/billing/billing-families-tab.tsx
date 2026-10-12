"use client";

import { billingLedgerLayout } from "./billing-layout";
import { Button } from "@/components/ui/button";
import { payerSetupActionLabel } from "@/lib/billing-payer-setup-model";
import type { BillingPayer } from "@/types";
import { BillingEmpty, BillingPanel, PayerBalances, StatusPill } from "./billing-page-sections";

function paymentMethodLabel(payer: BillingPayer) {
  if (payer.stripe_payment_method_last4) {
    return `${payer.stripe_payment_method_brand || payer.stripe_payment_method_type || "card"} ending ${payer.stripe_payment_method_last4}`;
  }
  if (payer.stripe_payment_method_id) {
    return (
      payer.stripe_payment_method_brand ||
      payer.stripe_payment_method_type ||
      "Saved payment method"
    );
  }
  return "No payment method";
}

export function BillingFamiliesTab({
  billingPayers,
  canUseWorkflow,
  isActionLoading,
  isLoadingAction,
  onAutopayDisable,
  onAutopaySetup,
  onPayerSync,
}: {
  billingPayers: BillingPayer[];
  canUseWorkflow: (workflowId: string) => boolean;
  isActionLoading: boolean;
  isLoadingAction: (action: string) => boolean;
  onAutopayDisable: (payerId: string) => void;
  onAutopaySetup: (payer: BillingPayer) => void;
  onPayerSync: (payerId: string) => void;
}) {
  return (
    <BillingPanel
      title="Families"
      description="Sync and payer-owned setup are shown only when the current server capability permits them. Staff cannot accept payment terms for a payer."
      flush
    >
      <div className={billingLedgerLayout.families.header}>
        <span>Payer</span>
        <span>Balance</span>
        <span>Contact</span>
        <span>Autopay</span>
        <span className="sr-only">Actions</span>
      </div>
      {billingPayers.length === 0 ? (
        <BillingEmpty title="No payer accounts yet." />
      ) : (
        billingPayers.map((payer) => {
          const atRisk = payer.billing_status === "past_due" || payer.billing_status === "failed";
          return (
            <div key={payer.id} className={billingLedgerLayout.families.row}>
              <div className="min-w-0">
                <p className="font-semibold text-text-primary">{payer.display_name}</p>
                <div className="mt-1">
                  <StatusPill status={payer.billing_status} />
                </div>
              </div>
              <div className="min-w-0">
                <PayerBalances
                  balanceCents={payer.balance_cents}
                  overdueCents={payer.overdue_balance_cents}
                  uncollectibleCents={payer.uncollectible_balance_cents}
                  tone={atRisk ? "alert" : undefined}
                />
              </div>
              <div className="min-w-0 text-text-secondary">
                <p className="text-xs text-muted xl:hidden">Contact</p>
                <p className="break-words [overflow-wrap:anywhere]">{payer.email || "No email"}</p>
                <p className="text-xs text-muted">{payer.phone || "No phone"}</p>
              </div>
              <div className="min-w-0">
                <p className="mb-1 text-xs text-muted xl:hidden">Autopay</p>
                <StatusPill status={payer.autopay_status} />
                <p className="mt-1 break-words text-xs text-muted [overflow-wrap:anywhere]">
                  {paymentMethodLabel(payer)}
                </p>
                <p className="text-xs text-muted">
                  {payer.stripe_customer_id ? "Provider customer linked" : "Customer not synced"}
                </p>
              </div>
              <div className="col-span-2 flex flex-wrap gap-2 xl:col-span-1 xl:justify-end">
                {canUseWorkflow("payer.sync") ? (
                  <Button
                    variant="secondary"
                    size="md"
                    disabled={isActionLoading}
                    isLoading={isLoadingAction(`payer-sync:${payer.id}`)}
                    onClick={() => onPayerSync(payer.id)}
                  >
                    {isLoadingAction(`payer-sync:${payer.id}`) ? "Syncing..." : "Sync payer"}
                  </Button>
                ) : null}
                {canUseWorkflow("payer.setup") ? (
                  <Button
                    variant="secondary"
                    size="md"
                    disabled={isActionLoading}
                    isLoading={isLoadingAction(`autopay-setup:${payer.id}`)}
                    onClick={() => onAutopaySetup(payer)}
                  >
                    {isLoadingAction(`autopay-setup:${payer.id}`)
                      ? "Preparing..."
                      : payerSetupActionLabel(payer)}
                  </Button>
                ) : null}
                {payer.autopay_status === "enabled" && canUseWorkflow("payer.autopay.disable") ? (
                  <Button
                    variant="ghost"
                    size="md"
                    disabled={isActionLoading}
                    isLoading={isLoadingAction(`autopay-disable:${payer.id}`)}
                    onClick={() => {
                      if (window.confirm(`Disable autopay for ${payer.display_name}? Future invoices will no longer use the saved payment method automatically.`)) {
                        onAutopayDisable(payer.id);
                      }
                    }}
                  >
                    {isLoadingAction(`autopay-disable:${payer.id}`)
                      ? "Disabling..."
                      : "Disable autopay"}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })
      )}
    </BillingPanel>
  );
}

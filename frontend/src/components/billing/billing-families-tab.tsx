"use client";

import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/billing-page-utils";
import type { BillingPayer } from "@/types";
import { SectionHeader, StatusPill } from "./billing-page-sections";

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
  onAutopaySetup: (payerId: string) => void;
  onPayerSync: (payerId: string) => void;
}) {
  return (
    <div className="space-y-5">
      <section className="rounded-[14px] border border-border bg-surface p-4">
        <SectionHeader
          icon={Users}
          title="Family payer workflows"
          description="Sync and payer-owned setup are shown only when the current server capability permits them. Staff cannot accept payment terms for a payer."
        />
      </section>

      <section className="overflow-hidden rounded-[14px] border border-border bg-surface">
        <div className="hidden grid-cols-[1.1fr_1fr_1fr_auto_1.3fr] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted md:grid">
          <span>Payer</span>
          <span>Contact</span>
          <span>Stripe</span>
          <span>Autopay</span>
          <span>Actions</span>
        </div>
        {billingPayers.length === 0 ? (
          <p className="p-4 text-sm text-muted">No payer accounts yet.</p>
        ) : billingPayers.map((payer) => (
          <div key={payer.id} className="grid min-w-0 grid-cols-1 gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0 md:min-h-14 md:grid-cols-[1.1fr_1fr_1fr_auto_1.3fr] md:items-center md:gap-4 md:py-2">
            <div className="min-w-0">
              <p className="mb-1 text-xs font-medium text-muted md:hidden">Payer</p>
              <p className="font-medium text-text-primary">{payer.display_name}</p>
              <div className="mt-1"><StatusPill status={payer.billing_status} /></div>
              <p className="mt-1 text-xs text-muted">{formatMoney(payer.balance_cents)}</p>
            </div>
            <div className="min-w-0 text-text-secondary">
              <p className="mb-1 text-xs font-medium text-muted md:hidden">Contact</p>
              <p className="break-words [overflow-wrap:anywhere]">{payer.email || "No email"}</p>
              <p className="text-xs text-muted">{payer.phone || "No phone"}</p>
            </div>
            <div className="min-w-0 text-xs text-muted">
              <p className="mb-1 text-xs font-medium text-muted md:hidden">Provider</p>
              <p>{payer.stripe_customer_id ? "Provider customer linked" : "Customer not synced"}</p>
              <p className="break-words [overflow-wrap:anywhere] md:truncate">
                {payer.stripe_payment_method_last4
                  ? `${payer.stripe_payment_method_brand || payer.stripe_payment_method_type || "card"} ending ${payer.stripe_payment_method_last4}`
                  : payer.stripe_payment_method_id
                    ? payer.stripe_payment_method_brand || payer.stripe_payment_method_type || "Saved payment method"
                    : "No payment method"}
              </p>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted md:hidden">Autopay</p>
              <StatusPill status={payer.autopay_status} />
            </div>
            <div className="flex flex-wrap gap-2">
              {canUseWorkflow("payer.sync") ? (
                <Button size="sm" disabled={isActionLoading} isLoading={isLoadingAction(`payer-sync:${payer.id}`)} onClick={() => onPayerSync(payer.id)}>
                  {isLoadingAction(`payer-sync:${payer.id}`) ? "Syncing..." : "Sync payer"}
                </Button>
              ) : null}
              {canUseWorkflow("payer.setup") ? (
                <Button variant="secondary" size="sm" disabled={isActionLoading} isLoading={isLoadingAction(`autopay-setup:${payer.id}`)} onClick={() => onAutopaySetup(payer.id)}>
                  {isLoadingAction(`autopay-setup:${payer.id}`) ? "Preparing..." : "Payer setup link"}
                </Button>
              ) : null}
              {payer.autopay_status === "enabled" && canUseWorkflow("payer.autopay.disable") ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isActionLoading}
                  isLoading={isLoadingAction(`autopay-disable:${payer.id}`)}
                  onClick={() => {
                    if (window.confirm(`Disable autopay for ${payer.display_name}? Future invoices will no longer use the saved payment method automatically.`)) {
                      onAutopayDisable(payer.id);
                    }
                  }}
                >
                  {isLoadingAction(`autopay-disable:${payer.id}`) ? "Disabling..." : "Disable autopay"}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

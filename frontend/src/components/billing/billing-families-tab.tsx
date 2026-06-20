"use client";

import type { FormEvent } from "react";
import { CreditCard, Plus, RefreshCw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/billing-page-utils";
import type { BillingPayer } from "@/types";
import { SectionHeader, StatusPill } from "./billing-page-sections";

export function BillingFamiliesTab({
  billingPayers,
  canManageStudioBilling,
  isActionLoading,
  isLoadingAction,
  onAutopayDisable,
  onAutopaySetup,
  onCreatePayer,
  onPayerEmailChange,
  onPayerNameChange,
  onPayerPhoneChange,
  onPayerSync,
  payerEmail,
  payerName,
  payerPhone,
}: {
  billingPayers: BillingPayer[];
  canManageStudioBilling: boolean;
  isActionLoading: boolean;
  isLoadingAction: (action: string) => boolean;
  onAutopayDisable: (payerId: string) => void;
  onAutopaySetup: (payerId: string) => void;
  onCreatePayer: (event: FormEvent<HTMLFormElement>) => void;
  onPayerEmailChange: (value: string) => void;
  onPayerNameChange: (value: string) => void;
  onPayerPhoneChange: (value: string) => void;
  onPayerSync: (payerId: string) => void;
  payerEmail: string;
  payerName: string;
  payerPhone: string;
}) {
  return (
    <div className="space-y-5">
      <section className="border border-border bg-surface rounded-[6px] p-5">
        <SectionHeader icon={Users} title="Family payer accounts" description="Payers are separate from student enrollment. A student can train actively even when billing is past due." />
        <form onSubmit={onCreatePayer} className="grid gap-3 md:grid-cols-[1fr_1fr_0.8fr_auto] md:items-end">
          <Input label="Name" value={payerName} onChange={(event) => onPayerNameChange(event.target.value)} placeholder="Family or payer name" disabled={!canManageStudioBilling} />
          <Input label="Email" value={payerEmail} onChange={(event) => onPayerEmailChange(event.target.value)} placeholder="payer@example.com" disabled={!canManageStudioBilling} />
          <Input label="Phone" value={payerPhone} onChange={(event) => onPayerPhoneChange(event.target.value)} placeholder="Optional" disabled={!canManageStudioBilling} />
          <Button type="submit" size="sm" disabled={!canManageStudioBilling || isActionLoading} isLoading={isLoadingAction("create-payer")}>
            <Plus className="h-3.5 w-3.5" />
            {isLoadingAction("create-payer") ? "Creating..." : "Create"}
          </Button>
        </form>
      </section>

      <section className="border border-border bg-surface rounded-[6px]">
        <div className="grid grid-cols-[1.1fr_1fr_1fr_auto_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted">
          <span>Payer</span>
          <span>Contact</span>
          <span>Stripe</span>
          <span>Autopay</span>
          <span>Actions</span>
        </div>
        {billingPayers.length === 0 ? (
          <p className="p-4 text-sm text-muted">No payer accounts yet.</p>
        ) : billingPayers.map((payer) => (
          <div key={payer.id} className="grid grid-cols-[1.1fr_1fr_1fr_auto_auto] gap-4 border-b border-border px-4 py-4 text-sm last:border-b-0">
            <div>
              <p className="font-medium text-text-primary">{payer.display_name}</p>
              <div className="mt-1"><StatusPill status={payer.billing_status} /></div>
              <p className="mt-1 text-xs text-muted">{formatMoney(payer.balance_cents)}</p>
            </div>
            <div className="text-text-secondary">
              <p>{payer.email || "No email"}</p>
              <p className="text-xs text-muted">{payer.phone || "No phone"}</p>
            </div>
            <div className="min-w-0 text-xs text-muted">
              <p className="truncate">{payer.stripe_customer_id || "No Stripe customer"}</p>
              <p className="truncate">
                {payer.stripe_payment_method_last4
                  ? `${payer.stripe_payment_method_brand || payer.stripe_payment_method_type || "card"} ending ${payer.stripe_payment_method_last4}`
                  : payer.stripe_payment_method_id
                    ? payer.stripe_payment_method_brand || payer.stripe_payment_method_type || "Saved payment method"
                    : "No payment method"}
              </p>
            </div>
            <StatusPill status={payer.autopay_status} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" size="sm" disabled={!canManageStudioBilling || isActionLoading} isLoading={isLoadingAction(`payer-sync:${payer.id}`)} onClick={() => onPayerSync(payer.id)}>
                <RefreshCw className="h-3.5 w-3.5" />
                {isLoadingAction(`payer-sync:${payer.id}`) ? "Syncing..." : "Sync"}
              </Button>
              <Button variant="secondary" size="sm" disabled={!canManageStudioBilling || isActionLoading} isLoading={isLoadingAction(`autopay-setup:${payer.id}`)} onClick={() => onAutopaySetup(payer.id)}>
                <CreditCard className="h-3.5 w-3.5" />
                {isLoadingAction(`autopay-setup:${payer.id}`) ? "Opening..." : "Setup"}
              </Button>
              <Button variant="ghost" size="sm" disabled={!canManageStudioBilling || isActionLoading || payer.autopay_status !== "enabled"} isLoading={isLoadingAction(`autopay-disable:${payer.id}`)} onClick={() => onAutopayDisable(payer.id)}>
                {isLoadingAction(`autopay-disable:${payer.id}`) ? "Disabling..." : "Disable"}
              </Button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

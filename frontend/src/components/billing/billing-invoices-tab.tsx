"use client";

import type { FormEvent } from "react";
import { AlertTriangle, ArrowUpRight, Plus, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate, formatMoney } from "@/lib/billing-page-utils";
import type { BillingInvoice, BillingPayer, StudentBillingEnrollment } from "@/types";
import { SectionHeader, StatusPill } from "./billing-page-sections";

type StudentOption = {
  id: string;
  name: string;
};

export function BillingInvoicesTab({
  billingEnrollments,
  billingInvoices,
  billingPayers,
  billingStudentOptions,
  canManageStudioBilling,
  invoiceAmount,
  invoiceDescription,
  invoiceDueDate,
  invoiceEnrollmentId,
  invoicePayerId,
  invoiceSendHosted,
  invoiceStudentId,
  isActionLoading,
  isLoadingAction,
  isPreviewMode,
  onCreateInvoice,
  onInvoiceAction,
  onInvoiceAmountChange,
  onInvoiceDescriptionChange,
  onInvoiceDraftChange,
  onInvoiceDueDateChange,
  onInvoiceEnrollmentChange,
  onInvoicePayerChange,
  onInvoiceSendHostedChange,
  onInvoiceStudentChange,
  planNameById,
  studentNameById,
}: {
  billingEnrollments: StudentBillingEnrollment[];
  billingInvoices: BillingInvoice[];
  billingPayers: BillingPayer[];
  billingStudentOptions: StudentOption[];
  canManageStudioBilling: boolean;
  invoiceAmount: string;
  invoiceDescription: string;
  invoiceDueDate: string;
  invoiceEnrollmentId: string;
  invoicePayerId: string;
  invoiceSendHosted: boolean;
  invoiceStudentId: string;
  isActionLoading: boolean;
  isLoadingAction: (action: string) => boolean;
  isPreviewMode: boolean;
  onCreateInvoice: (event: FormEvent<HTMLFormElement>) => void;
  onInvoiceAction: (invoiceId: string, action: "finalize" | "void" | "retry" | "reconcile") => void;
  onInvoiceAmountChange: (value: string) => void;
  onInvoiceDescriptionChange: (value: string) => void;
  onInvoiceDraftChange: () => void;
  onInvoiceDueDateChange: (value: string) => void;
  onInvoiceEnrollmentChange: (value: string) => void;
  onInvoicePayerChange: (value: string) => void;
  onInvoiceSendHostedChange: (value: boolean) => void;
  onInvoiceStudentChange: (value: string) => void;
  planNameById: Map<string, string>;
  studentNameById: Map<string, string>;
}) {
  const failedPayers = billingPayers.filter((payer) => payer.billing_status === "past_due" || payer.billing_status === "failed");
  const updateInvoiceDraft = <T,>(onChange: (value: T) => void, value: T) => {
    onChange(value);
    onInvoiceDraftChange();
  };

  return (
    <div className="space-y-5">
      <section className="border border-border bg-surface rounded-[6px] p-5">
        <SectionHeader icon={Receipt} title="Create hosted invoice" description="Draft a one-off invoice and optionally send the Stripe hosted invoice link." />
        <form onSubmit={onCreateInvoice} className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr_0.6fr_0.7fr_1fr_auto] lg:items-end">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-text-secondary font-medium" htmlFor="invoice-payer">Payer</label>
            <select
              id="invoice-payer"
              value={invoicePayerId}
              onChange={(event) => updateInvoiceDraft(onInvoicePayerChange, event.target.value)}
              disabled={!canManageStudioBilling || billingPayers.length === 0}
              className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            >
              <option value="">Choose payer</option>
              {billingPayers.map((payer) => (
                <option key={payer.id} value={payer.id}>{payer.display_name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-text-secondary font-medium" htmlFor="invoice-enrollment">Enrollment</label>
            <select
              id="invoice-enrollment"
              value={invoiceEnrollmentId}
              onChange={(event) => updateInvoiceDraft(onInvoiceEnrollmentChange, event.target.value)}
              disabled={!canManageStudioBilling}
              className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            >
              <option value="">Optional</option>
              {billingEnrollments.map((enrollment) => (
                <option key={enrollment.id} value={enrollment.id}>
                  {(studentNameById.get(enrollment.student_id) || "Student")} / {planNameById.get(enrollment.billing_plan_id || enrollment.plan_id || "") || "Plan"}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-text-secondary font-medium" htmlFor="invoice-student">Student</label>
            <select
              id="invoice-student"
              value={invoiceStudentId}
              onChange={(event) => updateInvoiceDraft(onInvoiceStudentChange, event.target.value)}
              disabled={!canManageStudioBilling}
              className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            >
              <option value="">Optional</option>
              {billingStudentOptions.map((student) => (
                <option key={student.id} value={student.id}>{student.name}</option>
              ))}
            </select>
          </div>
          <Input
            label="Amount"
            value={invoiceAmount}
            onChange={(event) => updateInvoiceDraft(onInvoiceAmountChange, event.target.value)}
            placeholder="129"
            inputMode="decimal"
            disabled={!canManageStudioBilling}
          />
          <Input
            label="Due date"
            type="date"
            value={invoiceDueDate}
            onChange={(event) => updateInvoiceDraft(onInvoiceDueDateChange, event.target.value)}
            disabled={!canManageStudioBilling}
          />
          <Input
            label="Memo"
            value={invoiceDescription}
            onChange={(event) => updateInvoiceDraft(onInvoiceDescriptionChange, event.target.value)}
            placeholder="Optional"
            disabled={!canManageStudioBilling}
          />
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={invoiceSendHosted}
                onChange={(event) => updateInvoiceDraft(onInvoiceSendHostedChange, event.target.checked)}
                disabled={!canManageStudioBilling}
                className="accent-[#E5C15C]"
              />
              Send
            </label>
            <Button type="submit" size="sm" disabled={!canManageStudioBilling || isActionLoading || billingPayers.length === 0} isLoading={isLoadingAction("create-invoice")}>
              <Plus className="h-3.5 w-3.5" />
              {isLoadingAction("create-invoice") ? "Creating..." : "Create"}
            </Button>
          </div>
        </form>
      </section>

      <section className="border border-border bg-surface rounded-[6px] p-5">
        <SectionHeader icon={AlertTriangle} title="Failed payment queue" description="Follow up with families without changing the student's training status." />
        {failedPayers.length === 0 ? (
          <p className="text-sm text-muted">No failed payer accounts right now.</p>
        ) : (
          <div className="divide-y divide-border border border-border rounded-[6px]">
            {failedPayers.map((payer) => (
              <div key={payer.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="font-medium text-text-primary">{payer.display_name}</p>
                  <p className="text-xs text-muted">{payer.email || "No email on file"}</p>
                </div>
                <div className="text-right">
                  <p className="font-medium text-danger">{formatMoney(payer.balance_cents)}</p>
                  <StatusPill status={payer.billing_status} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="border border-border bg-surface rounded-[6px]">
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted">
          <span>Invoice</span>
          <span>Due</span>
          <span>Amount</span>
          <span>Status</span>
          <span>Actions</span>
        </div>
        {billingInvoices.length === 0 ? (
          <p className="p-4 text-sm text-muted">No invoices yet.</p>
        ) : billingInvoices.map((invoice) => (
          <div key={invoice.id} className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 border-b border-border px-4 py-4 text-sm last:border-b-0">
            <div>
              <p className="font-medium text-text-primary">{invoice.invoice_type.replace(/_/g, " ")}</p>
              <p className="text-xs text-muted">{invoice.external ? "External payment record" : invoice.number || invoice.stripe_invoice_id || "Draft invoice"}</p>
              {invoice.hosted_invoice_url && !isPreviewMode ? (
                <a className="mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline" href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">
                  Hosted invoice <ArrowUpRight className="h-3 w-3" />
                </a>
              ) : null}
            </div>
            <p className="text-text-secondary">{formatDate(invoice.due_date)}</p>
            <p className="font-medium text-text-primary">{formatMoney(invoice.amount_due_cents, invoice.currency)}</p>
            <StatusPill status={invoice.status} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" size="sm" disabled={!canManageStudioBilling || isActionLoading || invoice.status !== "draft"} isLoading={isLoadingAction(`invoice:${invoice.id}:finalize`)} onClick={() => onInvoiceAction(invoice.id, "finalize")}>
                {isLoadingAction(`invoice:${invoice.id}:finalize`) ? "Finalizing..." : "Finalize"}
              </Button>
              {invoice.hosted_invoice_url && !isPreviewMode ? (
                <Button asChild variant="secondary" size="sm">
                  <a href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">
                    <ArrowUpRight className="h-3.5 w-3.5" />
                    Open
                  </a>
                </Button>
              ) : null}
              <Button variant="secondary" size="sm" disabled={!canManageStudioBilling || isActionLoading || invoice.status !== "open"} isLoading={isLoadingAction(`invoice:${invoice.id}:retry`)} onClick={() => onInvoiceAction(invoice.id, "retry")}>
                {isLoadingAction(`invoice:${invoice.id}:retry`) ? "Retrying..." : "Retry"}
              </Button>
              <Button variant="ghost" size="sm" disabled={!canManageStudioBilling || isActionLoading || invoice.status === "void" || invoice.status === "paid"} isLoading={isLoadingAction(`invoice:${invoice.id}:void`)} onClick={() => onInvoiceAction(invoice.id, "void")}>
                {isLoadingAction(`invoice:${invoice.id}:void`) ? "Voiding..." : "Void"}
              </Button>
              <Button variant="ghost" size="sm" disabled={!canManageStudioBilling || isActionLoading || invoice.status !== "paid"} isLoading={isLoadingAction(`invoice:${invoice.id}:reconcile`)} onClick={() => onInvoiceAction(invoice.id, "reconcile")}>
                {isLoadingAction(`invoice:${invoice.id}:reconcile`) ? "Reconciling..." : "Reconcile"}
              </Button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

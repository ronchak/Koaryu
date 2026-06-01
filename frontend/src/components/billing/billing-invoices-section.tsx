"use client";

import type { FormEvent } from "react";
import type { BillingInvoiceAction } from "@/lib/billing-invoice-controller";
import type {
  BillingInvoice,
  BillingPayer,
  StudentBillingEnrollment,
} from "@/types";
import { BillingInvoicesTab } from "./billing-invoices-tab";

type StudentOption = {
  id: string;
  name: string;
};

export function BillingInvoicesSection({
  billingEnrollments,
  billingInvoices,
  billingPayers,
  billingStudentOptions,
  canManageStudioBilling,
  isActionLoading,
  isLoadingAction,
  isPreviewMode,
  invoiceAmount,
  invoiceDescription,
  invoiceDueDate,
  invoiceEnrollmentId,
  invoicePayerId,
  invoiceSendHosted,
  invoiceStudentId,
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
  isActionLoading: boolean;
  isLoadingAction: (action: string) => boolean;
  isPreviewMode: boolean;
  invoiceAmount: string;
  invoiceDescription: string;
  invoiceDueDate: string;
  invoiceEnrollmentId: string;
  invoicePayerId: string;
  invoiceSendHosted: boolean;
  invoiceStudentId: string;
  onCreateInvoice: (event: FormEvent<HTMLFormElement>) => void;
  onInvoiceAction: (invoiceId: string, action: BillingInvoiceAction) => void;
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
  return (
    <BillingInvoicesTab
      billingEnrollments={billingEnrollments}
      billingInvoices={billingInvoices}
      billingPayers={billingPayers}
      billingStudentOptions={billingStudentOptions}
      canManageStudioBilling={canManageStudioBilling}
      invoiceAmount={invoiceAmount}
      invoiceDescription={invoiceDescription}
      invoiceDueDate={invoiceDueDate}
      invoiceEnrollmentId={invoiceEnrollmentId}
      invoicePayerId={invoicePayerId}
      invoiceSendHosted={invoiceSendHosted}
      invoiceStudentId={invoiceStudentId}
      isActionLoading={isActionLoading}
      isLoadingAction={isLoadingAction}
      isPreviewMode={isPreviewMode}
      onCreateInvoice={onCreateInvoice}
      onInvoiceAction={onInvoiceAction}
      onInvoiceAmountChange={onInvoiceAmountChange}
      onInvoiceDescriptionChange={onInvoiceDescriptionChange}
      onInvoiceDraftChange={onInvoiceDraftChange}
      onInvoiceDueDateChange={onInvoiceDueDateChange}
      onInvoiceEnrollmentChange={onInvoiceEnrollmentChange}
      onInvoicePayerChange={onInvoicePayerChange}
      onInvoiceSendHostedChange={onInvoiceSendHostedChange}
      onInvoiceStudentChange={onInvoiceStudentChange}
      planNameById={planNameById}
      studentNameById={studentNameById}
    />
  );
}

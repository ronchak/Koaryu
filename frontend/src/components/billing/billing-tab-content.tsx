"use client";

import type { BillingTab } from "@/components/billing/billing-page-chrome";
import { BillingEnrollmentsTab } from "@/components/billing/billing-enrollments-tab";
import { BillingFamiliesTab } from "@/components/billing/billing-families-tab";
import { BillingInvoicesSection } from "@/components/billing/billing-invoices-section";
import { BillingOverviewTab } from "@/components/billing/billing-page-sections";
import { BillingPlansTab } from "@/components/billing/billing-plans-tab";
import { BillingReportsTab } from "@/components/billing/billing-reports-tab";
import type { BillingActionController } from "@/lib/billing-action-controller";
import type { BillingInvoiceController } from "@/lib/billing-invoice-controller";
import type {
  BillingInvoice,
  BillingPayment,
  BillingPayer,
  BillingPlan,
  ExportJob,
  PlatformBillingStatus,
  Program,
  StudentBillingEnrollment,
  StudioPaymentAccount,
} from "@/types";

type BillingPeriodCopy = {
  label: string;
  value: string;
};

type BillingConnectRequirementItem = {
  id: string;
  label: string;
  description: string;
  complete: boolean;
};

type BillingStudentOption = {
  id: string;
  name: string;
};

type BillingTabContentProps = {
  actions: BillingActionController;
  activePrograms: Program[];
  activeStudents: number;
  activeSubscriptionCount: number;
  activeTab: BillingTab;
  billingConnect: StudioPaymentAccount | null;
  billingEnrollments: StudentBillingEnrollment[];
  billingInvoices: BillingInvoice[];
  billingPayers: BillingPayer[];
  billingPayments: BillingPayment[];
  billingPeriod: BillingPeriodCopy;
  billingPlans: BillingPlan[];
  billingPlatform: PlatformBillingStatus | null;
  billingStudentOptions: BillingStudentOption[];
  canManageKoaryuSubscription: boolean;
  canManageStudioBilling: boolean;
  canOpenCustomerPortal: boolean;
  canOpenStripeDashboard: boolean;
  canSubmitEnrollmentForm: boolean;
  connectActionLabel: string;
  connectRequirementItems: BillingConnectRequirementItem[];
  currentMonthPaymentCount: number;
  externalPaymentTotal: number;
  exportJobs: ExportJob[];
  failedInvoiceCount: number;
  hasStripeConnectedAccount: boolean;
  invoiceController: BillingInvoiceController;
  isEnrollmentPayerSelectDisabled: boolean;
  isPreviewMode: boolean;
  koaryuFeeBasis: number;
  onConnectClick: () => void;
  openInvoiceTotal: number;
  paidRevenue: number;
  paymentCohortAvailable: boolean;
  payerNameById: Map<string, string>;
  planNameById: Map<string, string>;
  stripePaymentTotal: number;
  studentNameById: Map<string, string>;
  studentsLoaded: boolean;
};

export function BillingTabContent({
  actions,
  activePrograms,
  activeStudents,
  activeSubscriptionCount,
  activeTab,
  billingConnect,
  billingEnrollments,
  billingInvoices,
  billingPayers,
  billingPayments,
  billingPeriod,
  billingPlans,
  billingPlatform,
  billingStudentOptions,
  canManageKoaryuSubscription,
  canManageStudioBilling,
  canOpenCustomerPortal,
  canOpenStripeDashboard,
  canSubmitEnrollmentForm,
  connectActionLabel,
  connectRequirementItems,
  currentMonthPaymentCount,
  externalPaymentTotal,
  exportJobs,
  failedInvoiceCount,
  hasStripeConnectedAccount,
  isEnrollmentPayerSelectDisabled,
  isPreviewMode,
  invoiceController,
  koaryuFeeBasis,
  onConnectClick,
  openInvoiceTotal,
  paidRevenue,
  paymentCohortAvailable,
  payerNameById,
  planNameById,
  stripePaymentTotal,
  studentNameById,
  studentsLoaded,
}: BillingTabContentProps) {
  const {
    enrollmentCollectionMode,
    enrollmentEndDate,
    enrollmentNextBillDate,
    enrollmentPayerId,
    enrollmentPlanId,
    enrollmentStartDate,
    enrollmentStudentId,
    externalAmount,
    externalMethod,
    externalNote,
    externalPayerId,
    isActionLoading,
    isLoadingAction,
    onAutopayDisable,
    onAutopaySetup,
    onConnectReset,
    onCreateEnrollment,
    onCreateExport,
    onCreatePayer,
    onCreatePlan,
    onEnrollmentAction,
    onEnrollmentCollectionModeChange,
    onEnrollmentEndDateChange,
    onEnrollmentModeUpdate,
    onEnrollmentNextBillDateChange,
    onEnrollmentPayerChange,
    onEnrollmentPlanChange,
    onEnrollmentStartDateChange,
    onEnrollmentStudentChange,
    onExternalAmountChange,
    onExternalMethodChange,
    onExternalNoteChange,
    onExternalPayerChange,
    onPayerEmailChange,
    onPayerNameChange,
    onPayerPhoneChange,
    onPayerSync,
    onPlanAmountChange,
    onPlanDescriptionChange,
    onPlanIntervalChange,
    onPlanNameChange,
    onPlanProgramToggle,
    onPlanSignupFeeChange,
    onPlanSync,
    onPlanTrialDaysChange,
    onRecordExternalPayment,
    openBillingLink,
    payerEmail,
    payerName,
    payerPhone,
    planAmount,
    planDescription,
    planInterval,
    planName,
    planProgramIds,
    planSignupFee,
    planTrialDays,
  } = actions;
  const {
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
  } = invoiceController;
  if (activeTab === "overview") {
    return (
      <BillingOverviewTab
        activeStudents={activeStudents}
        activeSubscriptionCount={activeSubscriptionCount}
        billingConnect={billingConnect}
        billingInvoicesLength={billingInvoices.length}
        currentMonthPaymentCount={currentMonthPaymentCount}
        billingPeriod={billingPeriod}
        billingPlatform={billingPlatform}
        canManageKoaryuSubscription={canManageKoaryuSubscription}
        canOpenCustomerPortal={canOpenCustomerPortal}
        canOpenStripeDashboard={canOpenStripeDashboard}
        connectActionLabel={connectActionLabel}
        connectRequirementItems={connectRequirementItems}
        externalPaymentTotal={externalPaymentTotal}
        failedInvoiceCount={failedInvoiceCount}
        hasStripeConnectedAccount={hasStripeConnectedAccount}
        isActionLoading={isActionLoading}
        isLoadingAction={isLoadingAction}
        onConnectClick={onConnectClick}
        onConnectReset={onConnectReset}
        openBillingLink={openBillingLink}
        openInvoiceTotal={openInvoiceTotal}
        paidRevenue={paidRevenue}
        paymentCohortAvailable={paymentCohortAvailable}
        stripePaymentTotal={stripePaymentTotal}
        studentsLoaded={studentsLoaded}
      />
    );
  }

  if (activeTab === "plans") {
    return (
      <BillingPlansTab
        activePrograms={activePrograms}
        billingPlans={billingPlans}
        canManageStudioBilling={canManageStudioBilling}
        isActionLoading={isActionLoading}
        isLoadingAction={isLoadingAction}
        onCreatePlan={onCreatePlan}
        onPlanAmountChange={onPlanAmountChange}
        onPlanDescriptionChange={onPlanDescriptionChange}
        onPlanIntervalChange={onPlanIntervalChange}
        onPlanNameChange={onPlanNameChange}
        onPlanProgramToggle={onPlanProgramToggle}
        onPlanSignupFeeChange={onPlanSignupFeeChange}
        onPlanSync={onPlanSync}
        onPlanTrialDaysChange={onPlanTrialDaysChange}
        planAmount={planAmount}
        planDescription={planDescription}
        planInterval={planInterval}
        planName={planName}
        planProgramIds={planProgramIds}
        planSignupFee={planSignupFee}
        planTrialDays={planTrialDays}
      />
    );
  }

  if (activeTab === "families") {
    return (
      <BillingFamiliesTab
        billingPayers={billingPayers}
        canManageStudioBilling={canManageStudioBilling}
        isActionLoading={isActionLoading}
        isLoadingAction={isLoadingAction}
        onAutopayDisable={onAutopayDisable}
        onAutopaySetup={onAutopaySetup}
        onCreatePayer={onCreatePayer}
        onPayerEmailChange={onPayerEmailChange}
        onPayerNameChange={onPayerNameChange}
        onPayerPhoneChange={onPayerPhoneChange}
        onPayerSync={onPayerSync}
        payerEmail={payerEmail}
        payerName={payerName}
        payerPhone={payerPhone}
      />
    );
  }

  if (activeTab === "enrollments") {
    return (
      <BillingEnrollmentsTab
        billingEnrollments={billingEnrollments}
        billingPayers={billingPayers}
        billingPlans={billingPlans}
        billingStudentOptions={billingStudentOptions}
        canManageStudioBilling={canManageStudioBilling}
        canSubmitEnrollmentForm={canSubmitEnrollmentForm}
        enrollmentCollectionMode={enrollmentCollectionMode}
        enrollmentEndDate={enrollmentEndDate}
        enrollmentNextBillDate={enrollmentNextBillDate}
        enrollmentPayerId={enrollmentPayerId}
        enrollmentPlanId={enrollmentPlanId}
        enrollmentStartDate={enrollmentStartDate}
        enrollmentStudentId={enrollmentStudentId}
        isActionLoading={isActionLoading}
        isEnrollmentPayerSelectDisabled={isEnrollmentPayerSelectDisabled}
        isLoadingAction={isLoadingAction}
        onCreateEnrollment={onCreateEnrollment}
        onEnrollmentAction={onEnrollmentAction}
        onEnrollmentCollectionModeChange={onEnrollmentCollectionModeChange}
        onEnrollmentEndDateChange={onEnrollmentEndDateChange}
        onEnrollmentModeUpdate={onEnrollmentModeUpdate}
        onEnrollmentNextBillDateChange={onEnrollmentNextBillDateChange}
        onEnrollmentPayerChange={onEnrollmentPayerChange}
        onEnrollmentPlanChange={onEnrollmentPlanChange}
        onEnrollmentStartDateChange={onEnrollmentStartDateChange}
        onEnrollmentStudentChange={onEnrollmentStudentChange}
        payerNameById={payerNameById}
        planNameById={planNameById}
        studentNameById={studentNameById}
      />
    );
  }

  if (activeTab === "invoices") {
    return (
      <BillingInvoicesSection
        billingEnrollments={billingEnrollments}
        billingInvoices={billingInvoices}
        billingPayers={billingPayers}
        billingStudentOptions={billingStudentOptions}
        canManageStudioBilling={canManageStudioBilling}
        isActionLoading={isActionLoading}
        isLoadingAction={isLoadingAction}
        isPreviewMode={isPreviewMode}
        invoiceAmount={invoiceAmount}
        invoiceDescription={invoiceDescription}
        invoiceDueDate={invoiceDueDate}
        invoiceEnrollmentId={invoiceEnrollmentId}
        invoicePayerId={invoicePayerId}
        invoiceSendHosted={invoiceSendHosted}
        invoiceStudentId={invoiceStudentId}
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

  if (activeTab === "reports") {
    return (
      <BillingReportsTab
        billingPayers={billingPayers}
        billingPayments={billingPayments}
        canManageStudioBilling={canManageStudioBilling}
        externalAmount={externalAmount}
        externalMethod={externalMethod}
        externalNote={externalNote}
        externalPayerId={externalPayerId}
        externalPaymentTotal={externalPaymentTotal}
        exportJobs={exportJobs}
        isActionLoading={isActionLoading}
        isLoadingAction={isLoadingAction}
        koaryuFeeBasis={koaryuFeeBasis}
        onCreateExport={onCreateExport}
        onExternalAmountChange={onExternalAmountChange}
        onExternalMethodChange={onExternalMethodChange}
        onExternalNoteChange={onExternalNoteChange}
        onExternalPayerChange={onExternalPayerChange}
        onRecordExternalPayment={onRecordExternalPayment}
        paymentCohortAvailable={paymentCohortAvailable}
        stripePaymentTotal={stripePaymentTotal}
      />
    );
  }

  return null;
}

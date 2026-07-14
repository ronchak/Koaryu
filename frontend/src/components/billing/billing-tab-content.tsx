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
  StudentBillingEnrollment,
  StudioPaymentAccount,
} from "@/types";

type BillingTabContentProps = {
  actions: BillingActionController;
  activeStudents: number;
  activeSubscriptionCount: number;
  activeTab: BillingTab;
  billingConnect: StudioPaymentAccount | null;
  billingEnrollments: StudentBillingEnrollment[];
  billingInvoices: BillingInvoice[];
  billingPayers: BillingPayer[];
  billingPayments: BillingPayment[];
  billingPeriod: { label: string; value: string };
  billingPlans: BillingPlan[];
  billingPlatform: PlatformBillingStatus | null;
  billingStudentOptions: { id: string; name: string }[];
  canManageKoaryuSubscription: boolean;
  canManageRoutineBilling: boolean;
  canOpenCustomerPortal: boolean;
  canOpenStripeDashboard: boolean;
  canSubmitEnrollmentForm: boolean;
  connectActionLabel: string;
  connectRequirementItems: { id: string; label: string; description: string; complete: boolean }[];
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
  providerMutationsEnabled: boolean;
  stripePaymentTotal: number;
  studentNameById: Map<string, string>;
  studentsLoaded: boolean;
};

export function BillingTabContent(props: BillingTabContentProps) {
  const {
    actions,
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
    canManageRoutineBilling,
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
    invoiceController,
    isEnrollmentPayerSelectDisabled,
    isPreviewMode,
    koaryuFeeBasis,
    onConnectClick,
    openInvoiceTotal,
    paidRevenue,
    paymentCohortAvailable,
    payerNameById,
    planNameById,
    providerMutationsEnabled,
    stripePaymentTotal,
    studentNameById,
    studentsLoaded,
  } = props;
  const {
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
    onCreateEnrollment,
    onEnrollmentEndDateChange,
    onEnrollmentNextBillDateChange,
    onEnrollmentPayerChange,
    onEnrollmentPlanChange,
    onEnrollmentStartDateChange,
    onEnrollmentStudentChange,
    onExternalAmountChange,
    onExternalMethodChange,
    onExternalNoteChange,
    onExternalPayerChange,
    onRecordExternalPayment,
    openBillingLink,
  } = actions;

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
        openBillingLink={openBillingLink}
        openInvoiceTotal={openInvoiceTotal}
        paidRevenue={paidRevenue}
        paymentCohortAvailable={paymentCohortAvailable}
        providerMutationsEnabled={providerMutationsEnabled}
        stripePaymentTotal={stripePaymentTotal}
        studentsLoaded={studentsLoaded}
      />
    );
  }
  if (activeTab === "plans") return <BillingPlansTab billingPlans={billingPlans} />;
  if (activeTab === "families") return <BillingFamiliesTab billingPayers={billingPayers} />;
  if (activeTab === "enrollments") {
    return (
      <BillingEnrollmentsTab
        billingEnrollments={billingEnrollments}
        billingPayers={billingPayers}
        billingPlans={billingPlans}
        billingStudentOptions={billingStudentOptions}
        canManageRoutineBilling={canManageRoutineBilling}
        canSubmitEnrollmentForm={canSubmitEnrollmentForm}
        enrollmentEndDate={enrollmentEndDate}
        enrollmentNextBillDate={enrollmentNextBillDate}
        enrollmentPayerId={enrollmentPayerId}
        enrollmentPlanId={enrollmentPlanId}
        enrollmentStartDate={enrollmentStartDate}
        enrollmentStudentId={enrollmentStudentId}
        isEnrollmentPayerSelectDisabled={isEnrollmentPayerSelectDisabled}
        isLoadingAction={isLoadingAction}
        onCreateEnrollment={onCreateEnrollment}
        onEnrollmentEndDateChange={onEnrollmentEndDateChange}
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
        billingInvoices={billingInvoices}
        billingPayers={billingPayers}
        canReconcileInvoices={canManageRoutineBilling}
        isActionLoading={isActionLoading}
        isLoadingAction={isLoadingAction}
        isPreviewMode={isPreviewMode}
        onInvoiceAction={invoiceController.onInvoiceAction}
      />
    );
  }
  if (activeTab === "reports") {
    return (
      <BillingReportsTab
        billingPayers={billingPayers}
        billingPayments={billingPayments}
        canManageRoutineBilling={canManageRoutineBilling}
        externalAmount={externalAmount}
        externalMethod={externalMethod}
        externalNote={externalNote}
        externalPayerId={externalPayerId}
        externalPaymentTotal={externalPaymentTotal}
        exportJobs={exportJobs}
        isActionLoading={isActionLoading}
        isLoadingAction={isLoadingAction}
        koaryuFeeBasis={koaryuFeeBasis}
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

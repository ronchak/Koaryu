"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type BillingSetupStep,
  type BillingTab,
} from "@/components/billing/billing-page-chrome";
import { useBillingConnectEntityModal } from "@/components/billing/billing-connect-entity-modal";
import { useBillingActionController } from "@/lib/billing-action-controller";
import { useBillingDataController } from "@/lib/billing-data-controller";
import {
  canSubmitStudentBillingEnrollmentForm,
  shouldDisableStudentBillingEnrollmentPayerSelect,
} from "@/lib/billing-page-form-model";
import { buildBillingPageModel } from "@/lib/billing-page-model";
import { shouldSettleBillingLoadEarly, shouldShowBillingLoading } from "@/lib/billing-page-state";
import { requirementGroupItems } from "@/lib/billing-page-utils";
import { useBillingInvoiceController } from "@/lib/billing-invoice-controller";
import { subscriptionPeriodCopy } from "@/lib/billing-period";
import {
  PREVIEW_CONNECT,
  PREVIEW_ENROLLMENTS,
  PREVIEW_INVOICES,
  PREVIEW_PAYERS,
  PREVIEW_PAYMENTS,
  PREVIEW_PLANS,
  PREVIEW_PLATFORM,
  PREVIEW_SUBSCRIPTIONS,
} from "@/lib/billing-preview-data";
import type {
  ConfigStoreContextValue,
  ProgramsStoreContextValue,
  StudentsStoreContextValue,
  StudioStoreContextValue,
} from "@/lib/store-contexts";

type BillingPageControllerOptions = {
  config: Pick<ConfigStoreContextValue, "isPreviewMode" | "markSubscriptionRequired" | "studioBootstrapSettled" | "token">;
  programsStore: Pick<ProgramsStoreContextValue, "programs" | "programsLoaded" | "refreshPrograms">;
  studentsStore: Pick<
    StudentsStoreContextValue,
    "refreshStudents" | "students" | "studentsLoaded" | "studentsMayBePartial"
  >;
  studioStore: Pick<StudioStoreContextValue, "currentRole">;
};

export function useBillingPageController({
  config,
  programsStore,
  studentsStore,
  studioStore,
}: BillingPageControllerOptions) {
  const router = useRouter();
  const { isPreviewMode, token, markSubscriptionRequired, studioBootstrapSettled } = config;
  const { currentRole } = studioStore;
  const { programs, programsLoaded, refreshPrograms } = programsStore;
  const { refreshStudents, students, studentsLoaded, studentsMayBePartial } = studentsStore;
  const [activeTab, setActiveTab] = useState<BillingTab>("overview");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const canManageKoaryuSubscription = currentRole === "admin";
  const canViewStudioBilling = currentRole === "admin" || currentRole === "front_desk";
  const canManageStudioBilling = currentRole === "admin";
  const isLiveRestricted = !isPreviewMode && currentRole !== null && !canViewStudioBilling;
  const shouldSettleEarly = shouldSettleBillingLoadEarly({
    isPreviewMode,
    hasKnownRestrictedRole: isLiveRestricted,
  });
  const handleSubscriptionRequired = useCallback(() => {
    markSubscriptionRequired();
    router.replace("/subscription-required");
  }, [markSubscriptionRequired, router]);
  const {
    enrollments,
    exportJobs,
    hasBillingLoadSettled,
    invoices,
    isLoading,
    payers,
    paymentAccount,
    payments,
    plans,
    platformBilling,
    refreshBilling,
    refreshConnectStatus,
    setExportJobs,
    subscriptions,
  } = useBillingDataController({
    canManageKoaryuSubscription,
    canViewStudioBilling,
    isPreviewMode,
    onSubscriptionRequired: handleSubscriptionRequired,
    setError,
    setMessage,
    shouldSettleEarly,
    token,
  });
  const showBillingLoading = shouldShowBillingLoading({
    isPreviewMode,
    isStudioBootstrapSettled: studioBootstrapSettled,
    hasPaymentAccount: paymentAccount !== null,
    isLoading,
    hasBillingLoadSettled,
    error,
  });
  const billingPlatform = isPreviewMode ? PREVIEW_PLATFORM : platformBilling;
  const billingConnect = isPreviewMode ? PREVIEW_CONNECT : paymentAccount;
  const billingPlans = isPreviewMode ? PREVIEW_PLANS : plans;
  const billingPayers = isPreviewMode ? PREVIEW_PAYERS : payers;
  const billingSubscriptions = isPreviewMode ? PREVIEW_SUBSCRIPTIONS : subscriptions;
  const billingEnrollments = isPreviewMode ? PREVIEW_ENROLLMENTS : enrollments;
  const billingInvoices = isPreviewMode ? PREVIEW_INVOICES : invoices;
  const billingPayments = isPreviewMode ? PREVIEW_PAYMENTS : payments;
  const billingActions = useBillingActionController({
    billingConnect,
    canManageStudioBilling,
    isPreviewMode,
    refreshBilling,
    setError,
    setExportJobs,
    setMessage,
    token,
  });
  const isEnrollmentPayerSelectDisabled = shouldDisableStudentBillingEnrollmentPayerSelect({
    canManageStudioBilling,
    collectionMode: billingActions.enrollmentCollectionMode,
    payerCount: billingPayers.length,
  });
  const canSubmitEnrollmentForm = canSubmitStudentBillingEnrollmentForm({
    canManageStudioBilling,
    collectionMode: billingActions.enrollmentCollectionMode,
    isActionLoading: billingActions.isActionLoading,
    payerCount: billingPayers.length,
    planCount: billingPlans.length,
  });
  const billingPeriod = subscriptionPeriodCopy(billingPlatform);
  const canOpenCustomerPortal = canManageKoaryuSubscription && Boolean(billingPlatform?.stripe_customer_id);
  const hasStripeConnectedAccount = Boolean(billingConnect?.stripe_connected_account_id);
  const canOpenStripeDashboard = Boolean(hasStripeConnectedAccount && billingConnect?.status !== "deauthorized");
  const needsConnectOnboarding = Boolean(
    hasStripeConnectedAccount
      && (
        !billingConnect?.charges_enabled
        || !billingConnect.details_submitted
        || billingConnect.status !== "charges_enabled"
        || Boolean(billingConnect.requirements_due?.length)
      )
  );
  const connectActionLabel = needsConnectOnboarding
    ? "Continue onboarding"
    : "Connect Stripe";
  const connectRequirementItems = useMemo(
    () => requirementGroupItems(billingConnect?.requirements_due ?? []),
    [billingConnect?.requirements_due]
  );
  const billingPageModel = useMemo(() => buildBillingPageModel({
    billingConnect,
    billingEnrollments,
    billingInvoices,
    billingPayers,
    billingPayments,
    billingPlans,
    billingSubscriptions,
    isPreviewMode,
    previewEnrollments: PREVIEW_ENROLLMENTS,
    programs,
    students,
  }), [
    billingConnect,
    billingEnrollments,
    billingInvoices,
    billingPayers,
    billingPayments,
    billingPlans,
    billingSubscriptions,
    isPreviewMode,
    programs,
    students,
  ]);
  const {
    activePrograms,
    activeStudents,
    activeSubscriptionCount,
    billingStudentOptions,
    externalPaymentTotal,
    failedInvoiceCount,
    hasBillingPlans,
    hasCollectionHistory,
    hasFamilyAccounts,
    hasStudentBilling,
    koaryuFeeBasis,
    openInvoiceTotal,
    paidRevenue,
    payerNameById,
    paymentsReady,
    planNameById,
    stripePaymentTotal,
    studentNameById,
  } = billingPageModel;
  const billingSetupSteps = useMemo<BillingSetupStep[]>(() => [
    {
      id: "payments",
      title: "Set up payments",
      description: paymentsReady
        ? "Stripe can collect card payments and send payouts for this studio."
        : "Connect Stripe when the studio is ready for autopay and hosted invoices. External payments can still be tracked.",
      complete: paymentsReady,
      onSelect: () => setActiveTab("overview"),
      actionLabel: paymentsReady ? "Review status" : "Review setup",
    },
    {
      id: "plans",
      title: "Create tuition plans",
      description: "Define monthly tuition, paid-in-full offers, signup fees, trial days, and program fit.",
      complete: hasBillingPlans,
      onSelect: () => setActiveTab("plans"),
      actionLabel: "Create plan",
    },
    {
      id: "families",
      title: "Add families",
      description: "Create payer accounts for parents, guardians, or adult students who handle tuition.",
      complete: hasFamilyAccounts,
      onSelect: () => setActiveTab("families"),
      actionLabel: "Add family",
    },
    {
      id: "student-billing",
      title: "Attach students",
      description: "Connect active students to the right family, tuition plan, collection mode, and billing dates.",
      complete: hasStudentBilling,
      onSelect: () => setActiveTab("enrollments"),
      actionLabel: "Attach student",
    },
    {
      id: "collect",
      title: "Collect or send invoice",
      description: "Send a hosted invoice, collect through autopay, or record a cash, check, Zelle, or Venmo payment.",
      complete: hasCollectionHistory,
      onSelect: () => setActiveTab("invoices"),
      actionLabel: "Create invoice",
    },
  ], [hasBillingPlans, hasCollectionHistory, hasFamilyAccounts, hasStudentBilling, paymentsReady]);
  const billingSetupCompleteCount = billingSetupSteps.filter((step) => step.complete).length;

  useEffect(() => {
    if (!studioBootstrapSettled) {
      return;
    }

    if (!programsLoaded) {
      void refreshPrograms({ includeArchived: false }).catch(() => undefined);
    }
  }, [programsLoaded, refreshPrograms, studioBootstrapSettled]);

  useEffect(() => {
    if (!studioBootstrapSettled || !studentsMayBePartial || isPreviewMode) {
      return;
    }

    let cancelled = false;
    void refreshStudents()
      .catch((error) => {
        console.error("Failed to load complete billing roster", error);
        if (!cancelled) {
          setError("Could not load the complete student roster for billing.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isPreviewMode, refreshStudents, studioBootstrapSettled, studentsMayBePartial]);

  useEffect(() => {
    if (!studioBootstrapSettled) {
      return;
    }

    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      if (params.get("connect") === "return") {
        void refreshConnectStatus({ sync: canManageStudioBilling });
        return;
      }
      void refreshBilling();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [canManageStudioBilling, refreshBilling, refreshConnectStatus, studioBootstrapSettled]);

  const { connectEntityModal, openConnectEntityModal } = useBillingConnectEntityModal({
    isActionLoading: billingActions.isActionLoading,
    isConnectLoading: billingActions.isLoadingAction("connect"),
    onConfirmConnectEntity: billingActions.openConnectOnboarding,
  });

  function handleConnectClick() {
    if (!hasStripeConnectedAccount) {
      openConnectEntityModal();
      return;
    }
    void billingActions.openConnectOnboarding();
  }

  const invoiceController = useBillingInvoiceController({
    claimAction: billingActions.claimAction,
    isPreviewMode,
    releaseAction: billingActions.releaseAction,
    refreshBilling,
    setError,
    setMessage,
    token,
  });

  return {
    contentProps: {
      activeTab,
      billingSetupCompleteCount,
      billingSetupSteps,
      connectEntityModal,
      error,
      isLiveRestricted,
      isLoading,
      isRefreshDisabled: isPreviewMode || isLoading || !canViewStudioBilling,
      message,
      onChangeTab: setActiveTab,
      onDismissError: () => setError(""),
      onDismissMessage: () => setMessage(""),
      onRefresh: () => void refreshBilling(),
      showBillingLoading,
      tabContentProps: {
        actions: billingActions,
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
        externalPaymentTotal,
        exportJobs,
        failedInvoiceCount,
        hasStripeConnectedAccount,
        isEnrollmentPayerSelectDisabled,
        isPreviewMode,
        invoiceController,
        koaryuFeeBasis,
        onConnectClick: handleConnectClick,
        openInvoiceTotal,
        paidRevenue,
        payerNameById,
        planNameById,
        stripePaymentTotal,
        studentNameById,
        studentsLoaded: studentsLoaded && !studentsMayBePartial,
      },
    },
  };
}

export type BillingPageController = ReturnType<typeof useBillingPageController>;

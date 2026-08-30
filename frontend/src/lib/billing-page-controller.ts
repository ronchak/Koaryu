"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import {
  getBillingInitialLoadAction,
  getBillingTabFromSearch,
  getBillingUrlForTab,
  getBillingUrlAfterConnectReturn,
  resolveBillingAuxiliaryReadiness,
  shouldSettleBillingLoadEarly,
  shouldShowBillingLoading,
} from "@/lib/billing-page-state";
import { requirementGroupItems } from "@/lib/billing-page-utils";
import { useBillingInvoiceController } from "@/lib/billing-invoice-controller";
import { useBillingRefundController } from "@/lib/billing-refund-controller";
import {
  areProviderMutationsEnabled,
  canManageRoutineBilling,
  resolveBillingProviderActionCapabilities,
  resolveBillingProviderCopy,
} from "@/lib/billing-policy";
import {
  billingWorkflowEnabled,
  enabledBillingWorkflowIds,
} from "@/lib/billing-workflow-capabilities";
import { subscriptionPeriodCopy } from "@/lib/billing-period";
import {
  PREVIEW_CONNECT,
  PREVIEW_BILLING_METRICS_AS_OF,
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
  config: Pick<ConfigStoreContextValue, "isPreviewMode" | "markSubscriptionRequired" | "token">;
  programsStore: Pick<
    ProgramsStoreContextValue,
    "programs" | "programsLoaded" | "programsLoadError" | "refreshPrograms"
  >;
  studentsStore: Pick<
    StudentsStoreContextValue,
    | "refreshStudents"
    | "students"
    | "studentsLoaded"
    | "studentsLoadError"
    | "studentsMayBePartial"
  >;
  studioStore: Pick<
    StudioStoreContextValue,
    "currentRole" | "currentStudioId" | "currentUserId"
  >;
};

export function useBillingPageController({
  config,
  programsStore,
  studentsStore,
  studioStore,
}: BillingPageControllerOptions) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isPreviewMode, token, markSubscriptionRequired } = config;
  const { currentRole, currentStudioId, currentUserId } = studioStore;
  const { programs, programsLoaded, programsLoadError, refreshPrograms } = programsStore;
  const {
    refreshStudents,
    students,
    studentsLoaded,
    studentsLoadError,
    studentsMayBePartial,
  } = studentsStore;
  const billingInitialLoadAction = getBillingInitialLoadAction(searchParams.toString());
  const [connectReturnPending, setConnectReturnPending] = useState(
    billingInitialLoadAction === "connect-return"
  );
  const skipNextNormalBillingRefreshRef = useRef(false);
  const activeTab = getBillingTabFromSearch(searchParams.toString());
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const changeBillingTab = useCallback((tab: BillingTab) => {
    const currentSearch = searchParams.toString();
    if (getBillingTabFromSearch(currentSearch) !== tab) {
      router.replace(getBillingUrlForTab(currentSearch, tab), { scroll: false });
    }
  }, [router, searchParams]);

  const canManageKoaryuSubscription = currentRole === "admin";
  const canViewStudioBilling = currentRole === "admin" || currentRole === "front_desk";
  const canManageStudioBilling = currentRole === "admin";
  const canManageRoutineBillingActions = canManageRoutineBilling(currentRole);
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
    billingSystemStatus,
    enrollments,
    exportJobs,
    hasBillingLoadSettled,
    invoices,
    isLoading,
    payers,
    paymentAccount,
    paymentCohortSummary,
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
  const enabledWorkflowIds = enabledBillingWorkflowIds(
    billingSystemStatus,
    currentRole,
    isPreviewMode,
  );
  const {
    connectDashboardEnabled,
    connectOnboardingEnabled,
    coreCheckoutEnabled,
    corePortalEnabled,
  } = resolveBillingProviderActionCapabilities({
    enabledWorkflowIds,
    isPreviewMode,
    role: currentRole,
  });
  const connectPaymentsEnabled = areProviderMutationsEnabled(
    isPreviewMode,
    billingWorkflowEnabled(enabledWorkflowIds, "payer.setup", isPreviewMode)
  );
  const billingProviderCopy = resolveBillingProviderCopy({
    isPreviewMode,
    providerMode: billingSystemStatus?.configured_stripe_mode,
    coreSubscription: coreCheckoutEnabled || corePortalEnabled,
    connectOnboarding: connectOnboardingEnabled,
    connectPayments: connectPaymentsEnabled,
  });
  const showPrimaryBillingLoading = shouldShowBillingLoading({
    isPreviewMode,
    hasPaymentAccount: paymentAccount !== null,
    isLoading,
    hasBillingLoadSettled,
    error,
  });
  const auxiliaryReadiness = resolveBillingAuxiliaryReadiness({
    activeTab,
    bypassForConnectReturn: connectReturnPending,
    programsLoadError,
    programsLoaded,
    studentsLoadError,
    studentsLoaded,
    studentsMayBePartial,
  });
  const showBillingLoading = showPrimaryBillingLoading || auxiliaryReadiness.status === "loading";
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
    canManageRoutineBilling: canManageRoutineBillingActions,
    isPreviewMode,
    payerOperationIdentity:
      currentUserId && currentStudioId
        ? { userId: currentUserId, studioId: currentStudioId }
        : null,
    refreshBilling,
    setError,
    setExportJobs,
    setMessage,
    token,
    enabledWorkflowIds,
  });
  const refundController = useBillingRefundController({
    enabledWorkflowIds,
    identity: currentUserId && currentStudioId
      ? { userId: currentUserId, studioId: currentStudioId }
      : null,
    isPreviewMode,
    refreshBilling,
    role: currentRole,
    setError,
    setMessage,
    token,
  });
  const isEnrollmentPayerSelectDisabled = shouldDisableStudentBillingEnrollmentPayerSelect({
    canManageStudioBilling: canManageRoutineBillingActions,
    collectionMode: billingActions.enrollmentCollectionMode,
    payerCount: billingPayers.length,
  });
  const canSubmitEnrollmentForm = canSubmitStudentBillingEnrollmentForm({
    canManageStudioBilling: canManageRoutineBillingActions,
    collectionMode: billingActions.enrollmentCollectionMode,
    isActionLoading: billingActions.isActionLoading,
    payerCount: billingPayers.length,
    planCount: billingPlans.length,
  });
  const billingPeriod = subscriptionPeriodCopy(billingPlatform);
  const canOpenCustomerPortal = canManageKoaryuSubscription && Boolean(billingPlatform?.stripe_customer_id);
  const hasStripeConnectedAccount = Boolean(billingConnect?.stripe_connected_account_id);
  const canOpenStripeDashboard = Boolean(hasStripeConnectedAccount && billingConnect?.status !== "deauthorized");
  const canResetConnect = Boolean(
    !isPreviewMode
      && canManageKoaryuSubscription
      && hasStripeConnectedAccount
      && connectOnboardingEnabled
  );
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
    billingMetricsAsOf: isPreviewMode ? PREVIEW_BILLING_METRICS_AS_OF : undefined,
    billingPaymentCohortSummary: isPreviewMode ? null : paymentCohortSummary,
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
    paymentCohortSummary,
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
    currentMonthPaymentCount,
    externalPaymentTotal,
    failedInvoiceCount,
    hasBillingPlans,
    hasCollectionHistory,
    hasFamilyAccounts,
    hasStudentBilling,
    koaryuFeeBasis,
    openInvoiceTotal,
    paidRevenue,
    paymentCohortAvailable,
    payerNameById,
    paymentsReady,
    planNameById,
    stripePaymentTotal,
    studentNameById,
  } = billingPageModel;
  const billingSetupSteps = useMemo<BillingSetupStep[]>(() => [
    {
      id: "payments",
      title: "Review payment status",
      description: paymentsReady
        ? "Review the studio's existing Stripe status without changing provider state."
        : billingProviderCopy.connectPayments,
      complete: paymentsReady,
      onSelect: () => changeBillingTab("overview"),
      actionLabel: paymentsReady ? "Review status" : "Review setup",
    },
    {
      id: "plans",
      title: "Review tuition plans",
      description: "Review the studio's existing tuition plans. Plan changes are currently unavailable.",
      complete: hasBillingPlans,
      onSelect: () => changeBillingTab("plans"),
      actionLabel: "Review plans",
    },
    {
      id: "families",
      title: "Review families",
      description: "Review existing payer accounts for parents, guardians, or adult students.",
      complete: hasFamilyAccounts,
      onSelect: () => changeBillingTab("families"),
      actionLabel: "Review families",
    },
    {
      id: "student-billing",
      title: "Attach students",
      description: "Connect active students to the right family, tuition plan, collection mode, and billing dates.",
      complete: hasStudentBilling,
      onSelect: () => changeBillingTab("enrollments"),
      actionLabel: "Attach student",
    },
    {
      id: "collect",
      title: "Review invoices and payments",
      description: "Record payer-level external payments and reconcile existing provider invoices.",
      complete: hasCollectionHistory,
      onSelect: () => changeBillingTab("invoices"),
      actionLabel: "Review invoices",
    },
  ], [
    hasBillingPlans,
    hasCollectionHistory,
    hasFamilyAccounts,
    hasStudentBilling,
    paymentsReady,
    billingProviderCopy.connectPayments,
    changeBillingTab,
  ]);
  const billingSetupCompleteCount = billingSetupSteps.filter((step) => step.complete).length;

  useEffect(() => {
    if (!programsLoaded) {
      void refreshPrograms({ includeArchived: false }).catch(() => undefined);
    }
  }, [programsLoaded, refreshPrograms]);

  useEffect(() => {
    if ((studentsLoaded && !studentsMayBePartial) || isPreviewMode) {
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
  }, [isPreviewMode, refreshStudents, studentsLoaded, studentsMayBePartial]);

  useEffect(() => {
    if (!connectReturnPending || !token || currentRole === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      void refreshConnectStatus({ sync: canManageStudioBilling })
        .finally(() => {
          skipNextNormalBillingRefreshRef.current = true;
          setConnectReturnPending(false);
          router.replace(getBillingUrlAfterConnectReturn(searchParams.toString()));
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    canManageStudioBilling,
    connectReturnPending,
    currentRole,
    refreshConnectStatus,
    router,
    searchParams,
    token,
  ]);

  useEffect(() => {
    if (
      connectReturnPending
      || billingInitialLoadAction === "connect-return"
      || !token
      || currentRole === null
    ) {
      return;
    }
    if (skipNextNormalBillingRefreshRef.current) {
      skipNextNormalBillingRefreshRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      void refreshBilling();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    billingInitialLoadAction,
    connectReturnPending,
    currentRole,
    refreshBilling,
    token,
  ]);

  const refreshRequiredBillingDatasets = useCallback(async () => {
    const requests: Promise<unknown>[] = [refreshBilling()];
    if (activeTab === "plans") {
      requests.push(refreshPrograms({ includeArchived: false }));
    }
    if (["overview", "enrollments", "invoices"].includes(activeTab)) {
      requests.push(refreshStudents());
    }
    await Promise.allSettled(requests);
  }, [activeTab, refreshBilling, refreshPrograms, refreshStudents]);

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
    canReconcileInvoices: canManageRoutineBillingActions,
    canUseWorkflow: billingActions.canUseWorkflow,
    claimAction: billingActions.claimAction,
    isPreviewMode,
    operationIdentity: currentUserId && currentStudioId
      ? { userId: currentUserId, studioId: currentStudioId }
      : null,
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
      billingProviderCopy,
      connectEntityModal,
      error: auxiliaryReadiness.error || error,
      isLiveRestricted,
      isLoading,
      isRefreshDisabled: isPreviewMode || isLoading || !canViewStudioBilling,
      message,
      onChangeTab: changeBillingTab,
      onDismissError: () => setError(""),
      onDismissMessage: () => setMessage(""),
      onRefresh: () => void refreshRequiredBillingDatasets(),
      showBillingContent:
        auxiliaryReadiness.status === "ready" && !showPrimaryBillingLoading,
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
        billingProviderCopy,
        billingStudentOptions,
        canManageKoaryuSubscription,
        canManageRoutineBilling: canManageRoutineBillingActions,
        canOpenCustomerPortal,
        canOpenStripeDashboard,
        canResetConnect,
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
        coreCheckoutEnabled,
        corePortalEnabled,
        connectDashboardEnabled,
        connectOnboardingEnabled,
        invoiceController,
        refundController,
        koaryuFeeBasis,
        onConnectClick: handleConnectClick,
        openInvoiceTotal,
        paidRevenue,
        paymentCohortAvailable,
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

"use client";

import type { Dispatch, SetStateAction } from "react";
import { useBillingActionRuntime } from "@/lib/billing-action-runtime";
import { useBillingConnectActions } from "@/lib/billing-connect-actions";
import { useBillingEnrollmentActions } from "@/lib/billing-enrollment-actions";
import { useBillingPayerActions } from "@/lib/billing-payer-actions";
import { useBillingPlanActions } from "@/lib/billing-plan-actions";
import { useBillingReportActions } from "@/lib/billing-report-actions";
import type { ExportJob, StudioPaymentAccount } from "@/types";

type UseBillingActionControllerOptions = {
  billingConnect: StudioPaymentAccount | null;
  canManageRoutineBilling: boolean;
  isPreviewMode: boolean;
  refreshBilling: () => Promise<void>;
  setError: (message: string) => void;
  setExportJobs: Dispatch<SetStateAction<ExportJob[]>>;
  setMessage: (message: string) => void;
  token: string | null;
};

export function useBillingActionController({
  billingConnect,
  canManageRoutineBilling,
  isPreviewMode,
  refreshBilling,
  setError,
  setExportJobs,
  setMessage,
  token,
}: UseBillingActionControllerOptions) {
  const runtime = useBillingActionRuntime({
    isPreviewMode,
    refreshBilling,
    setError,
    setMessage,
    token,
  });
  const connectActions = useBillingConnectActions(runtime);
  const planActions = useBillingPlanActions({ billingConnect, runtime });
  const payerActions = useBillingPayerActions(runtime);
  const enrollmentActions = useBillingEnrollmentActions({ canManageRoutineBilling, runtime });
  const reportActions = useBillingReportActions({
    canManageRoutineBilling,
    runtime,
    setExportJobs,
  });

  return {
    activeAction: runtime.activeAction,
    claimAction: runtime.claimAction,
    isActionLoading: runtime.isActionLoading,
    isLoadingAction: runtime.isLoadingAction,
    releaseAction: runtime.releaseAction,
    ...connectActions,
    ...planActions,
    ...payerActions,
    ...enrollmentActions,
    ...reportActions,
  };
}

export type BillingActionController = ReturnType<typeof useBillingActionController>;

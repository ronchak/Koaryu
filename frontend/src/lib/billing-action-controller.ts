"use client";

import { useBillingActionRuntime } from "@/lib/billing-action-runtime";
import { useBillingConnectActions } from "@/lib/billing-connect-actions";
import { useBillingEnrollmentActions } from "@/lib/billing-enrollment-actions";
import { useBillingPayerActions } from "@/lib/billing-payer-actions";
import { useBillingPlanActions } from "@/lib/billing-plan-actions";
import { useBillingReportActions } from "@/lib/billing-report-actions";
import type { PayerOperationIdentity } from "@/lib/billing-payer-setup-model";
import type { StudioPaymentAccount } from "@/types";

type UseBillingActionControllerOptions = {
  billingConnect: StudioPaymentAccount | null;
  canManageRoutineBilling: boolean;
  isPreviewMode: boolean;
  payerOperationIdentity: PayerOperationIdentity | null;
  identityKey: string | null;
  refreshBilling: () => Promise<void>;
  setError: (message: string) => void;
  setMessage: (message: string) => void;
  token: string | null;
  enabledWorkflowIds: ReadonlySet<string>;
};

export function useBillingActionController({
  billingConnect,
  canManageRoutineBilling,
  isPreviewMode,
  payerOperationIdentity,
  identityKey,
  refreshBilling,
  setError,
  setMessage,
  token,
  enabledWorkflowIds,
}: UseBillingActionControllerOptions) {
  const runtime = useBillingActionRuntime({
    enabledWorkflowIds,
    isPreviewMode,
    refreshBilling,
    setError,
    setMessage,
    token,
  });
  const connectActions = useBillingConnectActions(runtime);
  const planActions = useBillingPlanActions({
    billingConnect,
    operationIdentity: payerOperationIdentity,
    runtime,
  });
  const payerActions = useBillingPayerActions(runtime, payerOperationIdentity);
  const enrollmentActions = useBillingEnrollmentActions({
    canManageRoutineBilling,
    operationIdentity: payerOperationIdentity,
    runtime,
  });
  const reportActions = useBillingReportActions({
    canManageRoutineBilling,
    identity: payerOperationIdentity,
    identityKey,
    runtime,
  });

  return {
    activeAction: runtime.activeAction,
    claimAction: runtime.claimAction,
    canUseWorkflow: runtime.canUseWorkflow,
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

"use client";

import { useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import type { BillingActionRuntime } from "@/lib/billing-action-runtime";
import { buildBillingPlanCreatePayload } from "@/lib/billing-page-form-model";
import {
  buildPlanSyncRequest,
  clearPlanSyncRequestKey,
  resolvePlanSyncRequestKey,
  type PlanSyncIdentity,
} from "@/lib/billing-plan-sync-model";
import type { BillingPlan, StudioPaymentAccount } from "@/types";

type BillingPlanActionsOptions = {
  billingConnect: StudioPaymentAccount | null;
  operationIdentity: PlanSyncIdentity | null;
  runtime: BillingActionRuntime;
};

export function useBillingPlanActions({
  billingConnect,
  operationIdentity,
  runtime,
}: BillingPlanActionsOptions) {
  const planSyncKeysRef = useRef(new Map<string, string>());
  const [planName, setPlanName] = useState("");
  const [planAmount, setPlanAmount] = useState("");
  const [planSignupFee, setPlanSignupFee] = useState("");
  const [planTrialDays, setPlanTrialDays] = useState("");
  const [planDescription, setPlanDescription] = useState("");
  const [planInterval, setPlanInterval] = useState<BillingPlan["billing_interval"]>("monthly");
  const [planProgramIds, setPlanProgramIds] = useState<string[]>([]);

  function resetPlanForm() {
    setPlanName("");
    setPlanAmount("");
    setPlanSignupFee("");
    setPlanTrialDays("");
    setPlanDescription("");
    setPlanProgramIds([]);
  }

  function togglePlanProgram(programId: string) {
    setPlanProgramIds((current) =>
      current.includes(programId)
        ? current.filter((id) => id !== programId)
        : [...current, programId]
    );
  }

  async function handlePlanSync(
    planId: string,
    options: { startNewRequest?: boolean } = {},
  ) {
    const requestKey = resolvePlanSyncRequestKey({
      identity: operationIdentity,
      keysByPlan: planSyncKeysRef.current,
      planId,
      startNewRequest: options.startNewRequest,
    });
    const request = buildPlanSyncRequest(requestKey);
    const result = await runtime.postBillingAction<BillingPlan>({
      action: `plan-sync:${planId}`,
      path: `/billing/plans/${planId}/sync`,
      refresh: false,
      requestOptions: { headers: request.headers },
      successMessage: "Plan sync requested.",
      workflowId: "plan.sync",
    });
    if (result) {
      clearPlanSyncRequestKey({
        identity: operationIdentity,
        keysByPlan: planSyncKeysRef.current,
        planId,
      });
      try {
        await runtime.refreshBilling();
      } catch {
        runtime.setError("Plan synced, but billing data could not be refreshed.");
      }
    }
    return result;
  }

  async function handleCreatePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runtime.setError("");
    runtime.setMessage("");
    const payloadResult = buildBillingPlanCreatePayload({
      planName,
      planDescription,
      planAmount,
      planInterval,
      planProgramIds,
      planSignupFee,
      planTrialDays,
    });
    if (!payloadResult.ok) {
      runtime.setError(payloadResult.error);
      return;
    }
    if (runtime.isPreviewMode) {
      runtime.setMessage("Demo plan drafted. Live studios save this to Supabase and Stripe when payments are enabled.");
      resetPlanForm();
      return;
    }
    if (!runtime.canUseWorkflow("plan.create")) {
      runtime.setError("Plan creation is not available for the current studio and role.");
      return;
    }
    if (!runtime.token || !runtime.claimAction("create-plan")) {
      return;
    }
    try {
      await api.post<BillingPlan>("/billing/plans", payloadResult.payload, runtime.token);
      runtime.setMessage(
        billingConnect?.charges_enabled
          ? "Billing plan created."
          : "Billing plan drafted. It will stay pending until Stripe charges are enabled."
      );
      resetPlanForm();
      await runtime.refreshBilling();
    } catch (err) {
      runtime.setError(err instanceof Error ? err.message : "Billing plan could not be created.");
    } finally {
      runtime.releaseAction("create-plan");
    }
  }

  return {
    onCreatePlan: handleCreatePlan,
    onPlanAmountChange: setPlanAmount,
    onPlanDescriptionChange: setPlanDescription,
    onPlanIntervalChange: setPlanInterval,
    onPlanNameChange: setPlanName,
    onPlanProgramToggle: togglePlanProgram,
    onPlanSignupFeeChange: setPlanSignupFee,
    onPlanSync: handlePlanSync,
    onPlanTrialDaysChange: setPlanTrialDays,
    planAmount,
    planDescription,
    planInterval,
    planName,
    planProgramIds,
    planSignupFee,
    planTrialDays,
  };
}

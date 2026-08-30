"use client";

import { useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import type { BillingActionRuntime } from "@/lib/billing-action-runtime";
import { buildStudentBillingEnrollmentCreatePayload } from "@/lib/billing-page-form-model";
import {
  buildEnrollmentActivationRequest,
  clearEnrollmentActivationRequestKey,
  resolveEnrollmentActivationRequestKey,
  type EnrollmentActivationIdentity,
} from "@/lib/billing-enrollment-activation-model";
import type { StudentBillingEnrollment } from "@/types";
import {
  clearEnrollmentTransitionRequestKey,
  enrollmentTransitionRequestOptions,
  resolveEnrollmentTransitionRequestKey,
  type EnrollmentTransitionAction,
} from "@/lib/billing-enrollment-transition-model";

export function useBillingEnrollmentActions({
  canManageRoutineBilling,
  operationIdentity,
  runtime,
}: {
  canManageRoutineBilling: boolean;
  operationIdentity: EnrollmentActivationIdentity | null;
  runtime: BillingActionRuntime;
}) {
  const activationKeysRef = useRef(new Map<string, string>());
  const transitionKeysRef = useRef(new Map<string, string>());
  const [enrollmentStudentId, setEnrollmentStudentId] = useState("");
  const [enrollmentPayerId, setEnrollmentPayerId] = useState("");
  const [enrollmentPlanId, setEnrollmentPlanId] = useState("");
  const [enrollmentCollectionMode, setEnrollmentCollectionMode] =
    useState<StudentBillingEnrollment["collection_mode"]>("external");
  const [enrollmentStartDate, setEnrollmentStartDate] = useState("");
  const [enrollmentEndDate, setEnrollmentEndDate] = useState("");
  const [enrollmentNextBillDate, setEnrollmentNextBillDate] = useState("");

  function resetEnrollmentForm() {
    setEnrollmentStudentId("");
    setEnrollmentPayerId("");
    setEnrollmentPlanId("");
    setEnrollmentCollectionMode("external");
    setEnrollmentStartDate("");
    setEnrollmentEndDate("");
    setEnrollmentNextBillDate("");
  }

  async function handleEnrollmentAction(enrollmentId: string, action: "pause" | "resume" | "cancel") {
    void enrollmentId;
    void action;
    runtime.setError("Enrollment lifecycle changes are currently unavailable.");
  }

  async function handleEnrollmentModeUpdate(
    enrollmentId: string,
    collectionMode: StudentBillingEnrollment["collection_mode"]
  ) {
    void enrollmentId;
    void collectionMode;
    runtime.setError("Collection-mode changes are currently unavailable.");
  }

  async function handleEnrollmentActivation(
    enrollmentId: string,
    options: { startNewRequest?: boolean } = {},
  ) {
    const requestKey = resolveEnrollmentActivationRequestKey({
      enrollmentId,
      identity: operationIdentity,
      keysByEnrollment: activationKeysRef.current,
      startNewRequest: options.startNewRequest,
    });
    const result = await runtime.postBillingAction<StudentBillingEnrollment>({
      action: `enrollment-activate:${enrollmentId}`,
      path: `/billing/enrollments/${enrollmentId}/activate`,
      onTerminalIdempotencyError: () => clearEnrollmentActivationRequestKey({
        enrollmentId,
        identity: operationIdentity,
        keysByEnrollment: activationKeysRef.current,
      }),
      refresh: false,
      requestOptions: buildEnrollmentActivationRequest(requestKey),
      successMessage: "Enrollment activation requested.",
      workflowId: "enrollment.activate",
    });
    if (result) {
      clearEnrollmentActivationRequestKey({
        enrollmentId,
        identity: operationIdentity,
        keysByEnrollment: activationKeysRef.current,
      });
      await runtime.refreshBilling();
    }
    return result;
  }

  async function handleNamedTransition({
    action,
    body,
    path,
    resourceId,
    startNewRequest = false,
  }: {
    action: EnrollmentTransitionAction;
    body: Record<string, unknown>;
    path: string;
    resourceId: string;
    startNewRequest?: boolean;
  }) {
    const workflowId = {
      "cancel-immediate": "enrollment.cancel.immediate",
      "revoke-scheduled": "enrollment.cancel.period_end.revoke",
      "schedule-period-end": "enrollment.cancel.period_end.schedule",
    }[action];
    const requestKey = resolveEnrollmentTransitionRequestKey({
      action,
      identity: operationIdentity,
      keys: transitionKeysRef.current,
      resourceId,
      startNewRequest,
    });
    const result = await runtime.postBillingAction<Record<string, unknown>>({
      action: `enrollment-transition:${action}:${resourceId}`,
      path,
      body,
      onTerminalIdempotencyError: () => clearEnrollmentTransitionRequestKey({
        action,
        identity: operationIdentity,
        keys: transitionKeysRef.current,
        resourceId,
      }),
      refresh: false,
      requestOptions: enrollmentTransitionRequestOptions(requestKey),
      successMessage: "Enrollment transition requested.",
      workflowId,
    });
    if (result) {
      clearEnrollmentTransitionRequestKey({
        action,
        identity: operationIdentity,
        keys: transitionKeysRef.current,
        resourceId,
      });
      await runtime.refreshBilling();
    }
    return result;
  }

  async function handleCreateEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runtime.setError("");
    runtime.setMessage("");
    if (!canManageRoutineBilling) {
      runtime.setError("Only studio admins and front desk staff can attach external billing records.");
      return;
    }
    const payloadResult = buildStudentBillingEnrollmentCreatePayload({
      enrollmentStudentId,
      enrollmentPayerId,
      enrollmentPlanId,
      enrollmentCollectionMode,
      enrollmentStartDate,
      enrollmentEndDate,
      enrollmentNextBillDate,
    });
    if (!payloadResult.ok) {
      runtime.setError(payloadResult.error);
      return;
    }
    if (runtime.isPreviewMode) {
      runtime.setMessage("Demo enrollment attached.");
      return;
    }
    if (!runtime.canUseWorkflow("enrollment.create.external")) {
      runtime.setError("Enrollment creation is not available for the current studio and role.");
      return;
    }
    if (!runtime.token || !runtime.claimAction("create-enrollment")) {
      return;
    }
    try {
      await api.post<StudentBillingEnrollment>("/billing/enrollments", payloadResult.payload, runtime.token);
      runtime.setMessage("Billing enrollment created.");
      resetEnrollmentForm();
      await runtime.refreshBilling();
    } catch (err) {
      runtime.setError(err instanceof Error ? err.message : "Enrollment could not be created.");
    } finally {
      runtime.releaseAction("create-enrollment");
    }
  }

  return {
    enrollmentCollectionMode,
    enrollmentEndDate,
    enrollmentNextBillDate,
    enrollmentPayerId,
    enrollmentPlanId,
    enrollmentStartDate,
    enrollmentStudentId,
    onCreateEnrollment: handleCreateEnrollment,
    onEnrollmentAction: handleEnrollmentAction,
    onEnrollmentActivate: handleEnrollmentActivation,
    onEnrollmentCancelImmediate: (
      enrollmentId: string,
      options: { reasonCode?: string; startNewRequest?: boolean } = {},
    ) => handleNamedTransition({
      action: "cancel-immediate",
      body: { reason_code: options.reasonCode ?? "staff_requested" },
      path: `/billing/enrollments/${enrollmentId}/cancel-immediate`,
      resourceId: enrollmentId,
      startNewRequest: options.startNewRequest,
    }),
    onEnrollmentRevokeScheduled: (
      transitionIntentId: string,
      expectedRevision: number,
      options: { reasonCode?: string; startNewRequest?: boolean } = {},
    ) => handleNamedTransition({
      action: "revoke-scheduled",
      body: {
        expected_revision: expectedRevision,
        reason_code: options.reasonCode ?? "staff_requested",
      },
      path: `/billing/enrollment-transitions/${transitionIntentId}/revoke-scheduled`,
      resourceId: transitionIntentId,
      startNewRequest: options.startNewRequest,
    }),
    onEnrollmentSchedulePeriodEnd: (
      enrollmentId: string,
      options: { reasonCode?: string; startNewRequest?: boolean } = {},
    ) => handleNamedTransition({
      action: "schedule-period-end",
      body: { reason_code: options.reasonCode ?? "staff_requested" },
      path: `/billing/enrollments/${enrollmentId}/schedule-period-end`,
      resourceId: enrollmentId,
      startNewRequest: options.startNewRequest,
    }),
    onEnrollmentCollectionModeChange: setEnrollmentCollectionMode,
    onEnrollmentEndDateChange: setEnrollmentEndDate,
    onEnrollmentModeUpdate: handleEnrollmentModeUpdate,
    onEnrollmentNextBillDateChange: setEnrollmentNextBillDate,
    onEnrollmentPayerChange: setEnrollmentPayerId,
    onEnrollmentPlanChange: setEnrollmentPlanId,
    onEnrollmentStartDateChange: setEnrollmentStartDate,
    onEnrollmentStudentChange: setEnrollmentStudentId,
  };
}

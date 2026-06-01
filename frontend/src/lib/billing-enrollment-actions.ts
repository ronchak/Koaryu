"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import type { BillingActionRuntime } from "@/lib/billing-action-runtime";
import { buildStudentBillingEnrollmentCreatePayload } from "@/lib/billing-page-form-model";
import type { StudentBillingEnrollment } from "@/types";

export function useBillingEnrollmentActions(runtime: BillingActionRuntime) {
  const [enrollmentStudentId, setEnrollmentStudentId] = useState("");
  const [enrollmentPayerId, setEnrollmentPayerId] = useState("");
  const [enrollmentPlanId, setEnrollmentPlanId] = useState("");
  const [enrollmentCollectionMode, setEnrollmentCollectionMode] =
    useState<StudentBillingEnrollment["collection_mode"]>("autopay");
  const [enrollmentStartDate, setEnrollmentStartDate] = useState("");
  const [enrollmentEndDate, setEnrollmentEndDate] = useState("");
  const [enrollmentNextBillDate, setEnrollmentNextBillDate] = useState("");

  function resetEnrollmentForm() {
    setEnrollmentStudentId("");
    setEnrollmentPayerId("");
    setEnrollmentPlanId("");
    setEnrollmentCollectionMode("autopay");
    setEnrollmentStartDate("");
    setEnrollmentEndDate("");
    setEnrollmentNextBillDate("");
  }

  async function handleEnrollmentAction(enrollmentId: string, action: "pause" | "resume" | "cancel") {
    await runtime.postBillingAction<StudentBillingEnrollment>({
      action: `enrollment:${enrollmentId}:${action}`,
      path: `/billing/enrollments/${enrollmentId}/${action}`,
      successMessage: `Enrollment ${action} requested.`,
    });
  }

  async function handleEnrollmentModeUpdate(
    enrollmentId: string,
    collectionMode: StudentBillingEnrollment["collection_mode"]
  ) {
    if (runtime.isPreviewMode) {
      runtime.setMessage("Demo enrollment collection mode updated.");
      return;
    }
    if (!runtime.token || !runtime.claimAction(`enrollment-mode:${enrollmentId}`)) {
      return;
    }
    try {
      await api.patch<StudentBillingEnrollment>(
        `/billing/enrollments/${enrollmentId}`,
        { collection_mode: collectionMode },
        runtime.token
      );
      runtime.setMessage("Enrollment collection mode updated.");
      await runtime.refreshBilling();
    } catch (err) {
      runtime.setError(err instanceof Error ? err.message : "Enrollment could not be updated.");
    } finally {
      runtime.releaseAction(`enrollment-mode:${enrollmentId}`);
    }
  }

  async function handleCreateEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runtime.setError("");
    runtime.setMessage("");
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

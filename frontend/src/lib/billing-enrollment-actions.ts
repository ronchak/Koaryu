"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import type { BillingActionRuntime } from "@/lib/billing-action-runtime";
import { buildStudentBillingEnrollmentCreatePayload } from "@/lib/billing-page-form-model";
import type { StudentBillingEnrollment } from "@/types";

export function useBillingEnrollmentActions({
  canManageRoutineBilling,
  runtime,
}: {
  canManageRoutineBilling: boolean;
  runtime: BillingActionRuntime;
}) {
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
    runtime.setError("Enrollment lifecycle changes are not enabled for the Friendly Pilot release.");
  }

  async function handleEnrollmentModeUpdate(
    enrollmentId: string,
    collectionMode: StudentBillingEnrollment["collection_mode"]
  ) {
    void enrollmentId;
    void collectionMode;
    runtime.setError("Collection-mode changes are not enabled for the Friendly Pilot release.");
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

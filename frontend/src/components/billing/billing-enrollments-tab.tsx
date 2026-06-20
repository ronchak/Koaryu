"use client";

import type { FormEvent } from "react";
import { Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/billing-page-utils";
import type { BillingPayer, BillingPlan, StudentBillingEnrollment } from "@/types";
import { SectionHeader, StatusPill } from "./billing-page-sections";

type StudentOption = {
  id: string;
  name: string;
};

export function BillingEnrollmentsTab({
  billingEnrollments,
  billingPayers,
  billingPlans,
  billingStudentOptions,
  canManageStudioBilling,
  canSubmitEnrollmentForm,
  enrollmentCollectionMode,
  enrollmentEndDate,
  enrollmentNextBillDate,
  enrollmentPayerId,
  enrollmentPlanId,
  enrollmentStartDate,
  enrollmentStudentId,
  isActionLoading,
  isEnrollmentPayerSelectDisabled,
  isLoadingAction,
  onCreateEnrollment,
  onEnrollmentAction,
  onEnrollmentCollectionModeChange,
  onEnrollmentEndDateChange,
  onEnrollmentModeUpdate,
  onEnrollmentNextBillDateChange,
  onEnrollmentPayerChange,
  onEnrollmentPlanChange,
  onEnrollmentStartDateChange,
  onEnrollmentStudentChange,
  payerNameById,
  planNameById,
  studentNameById,
}: {
  billingEnrollments: StudentBillingEnrollment[];
  billingPayers: BillingPayer[];
  billingPlans: BillingPlan[];
  billingStudentOptions: StudentOption[];
  canManageStudioBilling: boolean;
  canSubmitEnrollmentForm: boolean;
  enrollmentCollectionMode: StudentBillingEnrollment["collection_mode"];
  enrollmentEndDate: string;
  enrollmentNextBillDate: string;
  enrollmentPayerId: string;
  enrollmentPlanId: string;
  enrollmentStartDate: string;
  enrollmentStudentId: string;
  isActionLoading: boolean;
  isEnrollmentPayerSelectDisabled: boolean;
  isLoadingAction: (action: string) => boolean;
  onCreateEnrollment: (event: FormEvent<HTMLFormElement>) => void;
  onEnrollmentAction: (enrollmentId: string, action: "pause" | "resume" | "cancel") => void;
  onEnrollmentCollectionModeChange: (mode: StudentBillingEnrollment["collection_mode"]) => void;
  onEnrollmentEndDateChange: (value: string) => void;
  onEnrollmentModeUpdate: (enrollmentId: string, mode: StudentBillingEnrollment["collection_mode"]) => void;
  onEnrollmentNextBillDateChange: (value: string) => void;
  onEnrollmentPayerChange: (value: string) => void;
  onEnrollmentPlanChange: (value: string) => void;
  onEnrollmentStartDateChange: (value: string) => void;
  onEnrollmentStudentChange: (value: string) => void;
  payerNameById: Map<string, string>;
  planNameById: Map<string, string>;
  studentNameById: Map<string, string>;
}) {
  return (
    <div className="space-y-5">
      <section className="border border-border bg-surface rounded-[6px] p-5">
        <SectionHeader icon={Users} title="Attach student billing" description="Connect an active student to a payer, plan, and collection mode without changing training status." />
        <form onSubmit={onCreateEnrollment} className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr_0.8fr_0.7fr_0.7fr_0.7fr_auto] lg:items-end">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-text-secondary font-medium" htmlFor="enrollment-student">Student</label>
            <select
              id="enrollment-student"
              value={enrollmentStudentId}
              onChange={(event) => onEnrollmentStudentChange(event.target.value)}
              disabled={!canManageStudioBilling || billingStudentOptions.length === 0}
              className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            >
              <option value="">Choose student</option>
              {billingStudentOptions.map((student) => (
                <option key={student.id} value={student.id}>{student.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-text-secondary font-medium" htmlFor="enrollment-payer">Payer</label>
            <select
              id="enrollment-payer"
              value={enrollmentPayerId}
              onChange={(event) => onEnrollmentPayerChange(event.target.value)}
              disabled={isEnrollmentPayerSelectDisabled}
              className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            >
              <option value="">Choose payer</option>
              {billingPayers.map((payer) => (
                <option key={payer.id} value={payer.id}>{payer.display_name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-text-secondary font-medium" htmlFor="enrollment-plan">Plan</label>
            <select
              id="enrollment-plan"
              value={enrollmentPlanId}
              onChange={(event) => onEnrollmentPlanChange(event.target.value)}
              disabled={!canManageStudioBilling || billingPlans.length === 0}
              className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            >
              <option value="">Choose plan</option>
              {billingPlans.map((plan) => (
                <option key={plan.id} value={plan.id}>{plan.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-text-secondary font-medium" htmlFor="collection-mode">Collect</label>
            <select
              id="collection-mode"
              value={enrollmentCollectionMode}
              onChange={(event) => onEnrollmentCollectionModeChange(event.target.value as StudentBillingEnrollment["collection_mode"])}
              disabled={!canManageStudioBilling}
              className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            >
              <option value="autopay">Autopay</option>
              <option value="invoice_link">Invoice link</option>
              <option value="external">External</option>
            </select>
          </div>
          <Input label="Start" type="date" value={enrollmentStartDate} onChange={(event) => onEnrollmentStartDateChange(event.target.value)} disabled={!canManageStudioBilling} />
          <Input label="End" type="date" value={enrollmentEndDate} onChange={(event) => onEnrollmentEndDateChange(event.target.value)} disabled={!canManageStudioBilling} />
          <Input label="Next bill" type="date" value={enrollmentNextBillDate} onChange={(event) => onEnrollmentNextBillDateChange(event.target.value)} disabled={!canManageStudioBilling} />
          <Button type="submit" size="sm" disabled={!canSubmitEnrollmentForm} isLoading={isLoadingAction("create-enrollment")}>
            <Plus className="h-3.5 w-3.5" />
            {isLoadingAction("create-enrollment") ? "Attaching..." : "Attach"}
          </Button>
        </form>
      </section>

      <section className="border border-border bg-surface rounded-[6px]">
        <div className="grid grid-cols-[1fr_1fr_0.8fr_1fr_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted">
          <span>Student</span>
          <span>Plan</span>
          <span>Dates</span>
          <span>Stripe refs</span>
          <span>Actions</span>
        </div>
        {billingEnrollments.length === 0 ? (
          <p className="p-4 text-sm text-muted">No billing enrollments yet.</p>
        ) : billingEnrollments.map((enrollment) => (
          <div key={enrollment.id} className="grid grid-cols-[1fr_1fr_0.8fr_1fr_auto] gap-4 border-b border-border px-4 py-4 text-sm last:border-b-0">
            <div>
              <p className="font-medium text-text-primary">{studentNameById.get(enrollment.student_id) || "Student"}</p>
              <p className="text-xs text-muted">{payerNameById.get(enrollment.payer_id || "") || "No payer"}</p>
              <div className="mt-1"><StatusPill status={enrollment.status} /></div>
            </div>
            <div>
              <p className="text-text-primary">{planNameById.get(enrollment.billing_plan_id || enrollment.plan_id || "") || "Plan"}</p>
              <select
                value={enrollment.collection_mode}
                onChange={(event) => onEnrollmentModeUpdate(enrollment.id, event.target.value as StudentBillingEnrollment["collection_mode"])}
                disabled={!canManageStudioBilling || isActionLoading}
                className="mt-2 w-full rounded-[6px] border border-border bg-surface-raised px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
              >
                <option value="autopay">Autopay</option>
                <option value="invoice_link">Invoice link</option>
                <option value="external">External</option>
              </select>
            </div>
            <div className="text-xs text-muted">
              <p>Start {formatDate(enrollment.start_date)}</p>
              <p>End {formatDate(enrollment.end_date)}</p>
              <p>Next {formatDate(enrollment.next_bill_on || enrollment.next_bill_date)}</p>
            </div>
            <div className="min-w-0 text-xs text-muted">
              <p className="truncate">{enrollment.stripe_subscription_id || "No subscription"}</p>
              <p className="truncate">{enrollment.stripe_subscription_item_id || "No item"}</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" size="sm" disabled={!canManageStudioBilling || isActionLoading || enrollment.status === "paused"} isLoading={isLoadingAction(`enrollment:${enrollment.id}:pause`)} onClick={() => onEnrollmentAction(enrollment.id, "pause")}>
                {isLoadingAction(`enrollment:${enrollment.id}:pause`) ? "Pausing..." : "Pause"}
              </Button>
              <Button variant="secondary" size="sm" disabled={!canManageStudioBilling || isActionLoading || enrollment.status !== "paused"} isLoading={isLoadingAction(`enrollment:${enrollment.id}:resume`)} onClick={() => onEnrollmentAction(enrollment.id, "resume")}>
                {isLoadingAction(`enrollment:${enrollment.id}:resume`) ? "Resuming..." : "Resume"}
              </Button>
              <Button variant="ghost" size="sm" disabled={!canManageStudioBilling || isActionLoading || enrollment.status === "canceled"} isLoading={isLoadingAction(`enrollment:${enrollment.id}:cancel`)} onClick={() => onEnrollmentAction(enrollment.id, "cancel")}>
                {isLoadingAction(`enrollment:${enrollment.id}:cancel`) ? "Canceling..." : "Cancel"}
              </Button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

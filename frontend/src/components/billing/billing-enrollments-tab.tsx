"use client";

import type { FormEvent } from "react";
import { Plus } from "lucide-react";
import { billingLedgerLayout, billingEnrollmentFormClass } from "./billing-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBillingCalendarDate } from "@/lib/billing-page-utils";
import type { BillingPayer, BillingPlan, StudentBillingEnrollment } from "@/types";
import { BillingEmpty, BillingPanel, StatusPill } from "./billing-page-sections";

type StudentOption = { id: string; name: string };

const selectClass =
  "w-full rounded-[10px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary";

export function BillingEnrollmentsTab({
  billingEnrollments,
  billingPayers,
  billingPlans,
  billingStudentOptions,
  canManageRoutineBilling,
  canSubmitEnrollmentForm,
  canUseWorkflow,
  enrollmentEndDate,
  enrollmentNextBillDate,
  enrollmentPayerId,
  enrollmentPlanId,
  enrollmentStartDate,
  enrollmentStudentId,
  isEnrollmentPayerSelectDisabled,
  isActionLoading,
  isLoadingAction,
  onCreateEnrollment,
  onEnrollmentEndDateChange,
  onEnrollmentNextBillDateChange,
  onEnrollmentPayerChange,
  onEnrollmentPlanChange,
  onEnrollmentStartDateChange,
  onEnrollmentStudentChange,
  onEnrollmentActivate,
  onEnrollmentCancelImmediate,
  onEnrollmentRevokeScheduled,
  onEnrollmentSchedulePeriodEnd,
  payerNameById,
  planNameById,
  studentNameById,
}: {
  billingEnrollments: StudentBillingEnrollment[];
  billingPayers: BillingPayer[];
  billingPlans: BillingPlan[];
  billingStudentOptions: StudentOption[];
  canManageRoutineBilling: boolean;
  canSubmitEnrollmentForm: boolean;
  canUseWorkflow: (workflowId: string) => boolean;
  enrollmentEndDate: string;
  enrollmentNextBillDate: string;
  enrollmentPayerId: string;
  enrollmentPlanId: string;
  enrollmentStartDate: string;
  enrollmentStudentId: string;
  isEnrollmentPayerSelectDisabled: boolean;
  isActionLoading: boolean;
  isLoadingAction: (action: string) => boolean;
  onCreateEnrollment: (event: FormEvent<HTMLFormElement>) => void;
  onEnrollmentEndDateChange: (value: string) => void;
  onEnrollmentNextBillDateChange: (value: string) => void;
  onEnrollmentPayerChange: (value: string) => void;
  onEnrollmentPlanChange: (value: string) => void;
  onEnrollmentStartDateChange: (value: string) => void;
  onEnrollmentStudentChange: (value: string) => void;
  onEnrollmentActivate: (enrollmentId: string) => void;
  onEnrollmentCancelImmediate: (enrollmentId: string) => void;
  onEnrollmentRevokeScheduled: (intentId: string, revision: number) => void;
  onEnrollmentSchedulePeriodEnd: (enrollmentId: string) => void;
  payerNameById: Map<string, string>;
  planNameById: Map<string, string>;
  studentNameById: Map<string, string>;
}) {
  return (
    <div className="space-y-5">
      <BillingPanel
        title="Attach external student billing"
        description="Admin and Front Desk can add a local record only. This does not create a Stripe subscription, charge a payer, or change training status."
      >
        <form onSubmit={onCreateEnrollment} className={billingEnrollmentFormClass}>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-semibold text-text-secondary" htmlFor="enrollment-student">
              Student
            </label>
            <select
              id="enrollment-student"
              value={enrollmentStudentId}
              onChange={(event) => onEnrollmentStudentChange(event.target.value)}
              disabled={!canManageRoutineBilling || billingStudentOptions.length === 0}
              className={selectClass}
            >
              <option value="">Choose student</option>
              {billingStudentOptions.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-semibold text-text-secondary" htmlFor="enrollment-payer">
              Payer (optional)
            </label>
            <select
              id="enrollment-payer"
              value={enrollmentPayerId}
              onChange={(event) => onEnrollmentPayerChange(event.target.value)}
              disabled={isEnrollmentPayerSelectDisabled}
              className={selectClass}
            >
              <option value="">No payer</option>
              {billingPayers.map((payer) => (
                <option key={payer.id} value={payer.id}>
                  {payer.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-semibold text-text-secondary" htmlFor="enrollment-plan">
              Plan
            </label>
            <select
              id="enrollment-plan"
              value={enrollmentPlanId}
              onChange={(event) => onEnrollmentPlanChange(event.target.value)}
              disabled={!canManageRoutineBilling || billingPlans.length === 0}
              className={selectClass}
            >
              <option value="">Choose plan</option>
              {billingPlans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-text-secondary">Collection</span>
            <span className="flex min-h-11 items-center rounded-[10px] border border-dashed border-border px-3 text-sm text-text-secondary">
              External / record only
            </span>
          </div>
          <Input
            label="Start"
            type="date"
            value={enrollmentStartDate}
            onChange={(event) => onEnrollmentStartDateChange(event.target.value)}
            disabled={!canManageRoutineBilling}
          />
          <Input
            label="End"
            type="date"
            value={enrollmentEndDate}
            onChange={(event) => onEnrollmentEndDateChange(event.target.value)}
            disabled={!canManageRoutineBilling}
          />
          <Input
            label="Next bill"
            type="date"
            value={enrollmentNextBillDate}
            onChange={(event) => onEnrollmentNextBillDateChange(event.target.value)}
            disabled={!canManageRoutineBilling}
          />
          <Button
            type="submit"
            size="md"
            disabled={!canSubmitEnrollmentForm}
            isLoading={isLoadingAction("create-enrollment")}
          >
            <Plus className="h-3.5 w-3.5" />
            {isLoadingAction("create-enrollment") ? "Attaching..." : "Attach"}
          </Button>
        </form>
      </BillingPanel>

      <BillingPanel title="Student billing" flush>
        <div className={billingLedgerLayout.enrollments.header}>
          <span>Student</span>
          <span>Plan</span>
          <span>Dates</span>
          <span>Billing state and actions</span>
        </div>
        {billingEnrollments.length === 0 ? (
          <BillingEmpty title="No billing enrollments yet." />
        ) : (
          billingEnrollments.map((enrollment) => {
            const scheduled = enrollment.scheduled_period_end_transition;
            const hasProviderSubscription = Boolean(
              enrollment.stripe_subscription_id && enrollment.stripe_subscription_item_id,
            );
            const canActivate =
              !hasProviderSubscription &&
              enrollment.collection_mode !== "external" &&
              enrollment.status !== "canceled" &&
              canUseWorkflow("enrollment.activate");
            const canSchedule =
              hasProviderSubscription &&
              enrollment.status === "active" &&
              canUseWorkflow("enrollment.cancel.period_end.schedule");
            const canCancelImmediate = !scheduled
              && hasProviderSubscription
              && enrollment.status === "active"
              && canUseWorkflow("enrollment.cancel.immediate");
            return (
              <div key={enrollment.id} className={billingLedgerLayout.enrollments.row}>
                <div className="min-w-0">
                  <p className="font-semibold capitalize text-text-primary">
                    {studentNameById.get(enrollment.student_id) || "Student"}
                  </p>
                  <p className="text-xs text-muted">
                    {payerNameById.get(enrollment.payer_id || "") || "No payer"}
                  </p>
                  <div className="mt-1">
                    <StatusPill status={enrollment.status} />
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted lg:hidden">Plan</p>
                  <p className="font-medium text-text-primary">
                    {planNameById.get(enrollment.billing_plan_id || enrollment.plan_id || "") ||
                      "Plan"}
                  </p>
                  <p className="mt-0.5 text-xs capitalize text-muted">
                    {enrollment.collection_mode.replace(/_/g, " ")}
                  </p>
                </div>
                <dl className="col-span-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs tabular-nums lg:col-span-1">
                  <dt className="text-muted">Next</dt>
                  <dd className="font-semibold text-text-primary">
                    {formatBillingCalendarDate(enrollment.next_bill_on || enrollment.next_bill_date)}
                  </dd>
                  <dt className="text-muted">Start</dt>
                  <dd className="text-text-secondary">
                    {formatBillingCalendarDate(enrollment.start_date)}
                  </dd>
                  <dt className="text-muted">End</dt>
                  <dd className="text-text-secondary">
                    {formatBillingCalendarDate(enrollment.end_date)}
                  </dd>
                </dl>
                <div className="col-span-2 min-w-0 text-xs text-muted lg:col-span-1">
                  <p>
                    {hasProviderSubscription
                      ? "Recurring provider billing linked"
                      : "No provider subscription"}
                  </p>
                  {scheduled ? (
                    <p className="mt-1 font-semibold text-warning">
                      Period-end cancellation is scheduled.
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {canActivate ? (
                      <Button
                        size="md"
                        disabled={isActionLoading}
                        isLoading={isLoadingAction(`enrollment-activate:${enrollment.id}`)}
                        onClick={() => onEnrollmentActivate(enrollment.id)}
                      >
                        {isLoadingAction(`enrollment-activate:${enrollment.id}`)
                          ? "Activating..."
                          : "Activate recurring"}
                      </Button>
                    ) : null}
                    {canSchedule && !scheduled ? (
                      <Button
                        variant="secondary"
                        size="md"
                        disabled={isActionLoading}
                        isLoading={isLoadingAction(
                          `enrollment-transition:schedule-period-end:${enrollment.id}`,
                        )}
                        onClick={() => onEnrollmentSchedulePeriodEnd(enrollment.id)}
                      >
                        {isLoadingAction(
                          `enrollment-transition:schedule-period-end:${enrollment.id}`,
                        )
                          ? "Scheduling..."
                          : "Cancel at period end"}
                      </Button>
                    ) : null}
                    {scheduled && canUseWorkflow("enrollment.cancel.period_end.revoke") ? (
                      <Button
                        variant="secondary"
                        size="md"
                        disabled={isActionLoading}
                        isLoading={isLoadingAction(
                          `enrollment-transition:revoke-scheduled:${scheduled.intent_id}`,
                        )}
                        onClick={() => onEnrollmentRevokeScheduled(scheduled.intent_id, scheduled.revision)}
                      >
                        {isLoadingAction(
                          `enrollment-transition:revoke-scheduled:${scheduled.intent_id}`,
                        )
                          ? "Revoking..."
                          : "Revoke scheduled cancel"}
                      </Button>
                    ) : null}
                    {canCancelImmediate ? (
                      <Button
                        variant="ghost"
                        size="md"
                        disabled={isActionLoading}
                        isLoading={isLoadingAction(
                          `enrollment-transition:cancel-immediate:${enrollment.id}`,
                        )}
                        onClick={() => {
                          if (window.confirm("Cancel this recurring enrollment immediately? This ends provider billing now and cannot be changed to a period-end cancellation afterward.")) {
                            onEnrollmentCancelImmediate(enrollment.id);
                          }
                        }}
                      >
                        {isLoadingAction(`enrollment-transition:cancel-immediate:${enrollment.id}`)
                          ? "Canceling..."
                          : "Cancel now"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </BillingPanel>
    </div>
  );
}

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import {
  clearEnrollmentTransitionRequestKey,
  enrollmentTransitionRequestOptions,
  resolveEnrollmentTransitionRequestKey,
} from "../src/lib/billing-enrollment-transition-model.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function loadBillingEnrollmentsTab() {
  const source = fs.readFileSync(
    path.join(root, "src/components/billing/billing-enrollments-tab.tsx"), "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const componentModule = { exports: {} };
  const testRequire = (specifier) => {
    if (specifier === "react/jsx-runtime") return require(specifier);
    if (specifier === "lucide-react") {
      return {
        Plus: () => React.createElement("span", null, "+"),
        Users: () => React.createElement("span", null, "Users"),
      };
    }
    if (specifier === "@/components/ui/button") {
      return {
        Button: (props) => React.createElement(
          "button",
          Object.fromEntries(Object.entries(props).filter(([key]) => (
            !["children", "isLoading", "size", "variant"].includes(key)
          ))),
          props.children,
        ),
      };
    }
    if (specifier === "@/components/ui/input") {
      return { Input: ({ label, ...props }) => React.createElement("label", null, label, React.createElement("input", props)) };
    }
    if (specifier === "@/lib/billing-page-utils") {
      return { formatDate: (value) => value ?? "Never" };
    }
    if (specifier === "./billing-page-sections") {
      return {
        SectionHeader: ({ title }) => React.createElement("h2", null, title),
        StatusPill: ({ status }) => React.createElement("span", null, status),
      };
    }
    throw new Error(`Unexpected component import: ${specifier}`);
  };

  Function("require", "module", "exports", compiled)(
    testRequire,
    componentModule,
    componentModule.exports,
  );
  return componentModule.exports.BillingEnrollmentsTab;
}

function renderEnrollmentActions({ scheduled, workflows }) {
  const BillingEnrollmentsTab = loadBillingEnrollmentsTab();
  const enrollment = {
    billing_plan_id: "plan-1",
    collection_mode: "automatic",
    end_date: null,
    id: "enrollment-1",
    next_bill_date: "2026-09-01",
    next_bill_on: "2026-09-01",
    payer_id: "payer-1",
    plan_id: "plan-1",
    scheduled_period_end_transition: scheduled,
    start_date: "2026-08-01",
    status: "active",
    stripe_subscription_id: "sub-1",
    stripe_subscription_item_id: "si-1",
    student_id: "student-1",
  };
  const noop = () => {};

  return renderToStaticMarkup(React.createElement(BillingEnrollmentsTab, {
    billingEnrollments: [enrollment],
    billingPayers: [],
    billingPlans: [],
    billingStudentOptions: [],
    canManageRoutineBilling: true,
    canSubmitEnrollmentForm: false,
    canUseWorkflow: (workflowId) => workflows.has(workflowId),
    enrollmentEndDate: "",
    enrollmentNextBillDate: "",
    enrollmentPayerId: "",
    enrollmentPlanId: "",
    enrollmentStartDate: "",
    enrollmentStudentId: "",
    isActionLoading: false,
    isEnrollmentPayerSelectDisabled: false,
    isLoadingAction: () => false,
    onCreateEnrollment: noop,
    onEnrollmentActivate: noop,
    onEnrollmentCancelImmediate: noop,
    onEnrollmentEndDateChange: noop,
    onEnrollmentNextBillDateChange: noop,
    onEnrollmentPayerChange: noop,
    onEnrollmentPlanChange: noop,
    onEnrollmentRevokeScheduled: noop,
    onEnrollmentSchedulePeriodEnd: noop,
    onEnrollmentStartDateChange: noop,
    onEnrollmentStudentChange: noop,
    payerNameById: new Map([["payer-1", "Payer"]]),
    planNameById: new Map([["plan-1", "Plan"]]),
    studentNameById: new Map([["student-1", "Student"]]),
  }));
}

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

describe("billing enrollment transition request keys", () => {
  it("persists across reload and scopes by user, studio, action, and resource", () => {
    const persisted = storage();
    const identity = { userId: "user-1", studioId: "studio-1" };
    const first = resolveEnrollmentTransitionRequestKey({
      action: "schedule-period-end",
      createKey: () => "key-1",
      identity,
      keys: new Map(),
      resourceId: "enrollment-1",
      storage: persisted,
    });
    const reloaded = resolveEnrollmentTransitionRequestKey({
      action: "schedule-period-end",
      createKey: () => "wrong",
      identity,
      keys: new Map(),
      resourceId: "enrollment-1",
      storage: persisted,
    });
    const otherAction = resolveEnrollmentTransitionRequestKey({
      action: "cancel-immediate",
      createKey: () => "key-2",
      identity,
      keys: new Map(),
      resourceId: "enrollment-1",
      storage: persisted,
    });
    const otherStudio = resolveEnrollmentTransitionRequestKey({
      action: "schedule-period-end",
      createKey: () => "key-3",
      identity: { userId: "user-1", studioId: "studio-2" },
      keys: new Map(),
      resourceId: "enrollment-1",
      storage: persisted,
    });

    assert.equal(first, "key-1");
    assert.equal(reloaded, "key-1");
    assert.equal(otherAction, "key-2");
    assert.equal(otherStudio, "key-3");
  });

  it("retains unknown attempts, rotates deliberately, and clears only confirmed success", () => {
    const persisted = storage();
    const keys = new Map();
    const identity = { userId: "user-1", studioId: "studio-1" };
    const base = {
      action: "revoke-scheduled",
      identity,
      keys,
      resourceId: "transition-1",
      storage: persisted,
    };
    assert.equal(resolveEnrollmentTransitionRequestKey({ ...base, createKey: () => "key-1" }), "key-1");
    assert.equal(resolveEnrollmentTransitionRequestKey({ ...base, createKey: () => "wrong" }), "key-1");
    assert.equal(resolveEnrollmentTransitionRequestKey({
      ...base,
      createKey: () => "key-2",
      startNewRequest: true,
    }), "key-2");
    clearEnrollmentTransitionRequestKey(base);
    assert.equal(resolveEnrollmentTransitionRequestKey({ ...base, createKey: () => "key-3" }), "key-3");
    assert.deepEqual(enrollmentTransitionRequestOptions("key-3"), {
      headers: { "Idempotency-Key": "key-3" },
    });
  });

  it("keeps working when browser storage is blocked", () => {
    const blocked = {
      getItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
    };
    const keys = new Map();
    const options = {
      action: "cancel-immediate",
      identity: { userId: "user", studioId: "studio" },
      keys,
      resourceId: "enrollment",
      storage: blocked,
    };
    assert.equal(resolveEnrollmentTransitionRequestKey({ ...options, createKey: () => "key-1" }), "key-1");
    assert.equal(resolveEnrollmentTransitionRequestKey({ ...options, createKey: () => "wrong" }), "key-1");
  });

  it("wires named routes into capability-gated controls without clearing unknown attempts", () => {
    const actions = fs.readFileSync(
      path.join(root, "src/lib/billing-enrollment-actions.ts"), "utf8",
    );
    const tab = fs.readFileSync(
      path.join(root, "src/components/billing/billing-enrollments-tab.tsx"), "utf8",
    );
    const contracts = fs.readFileSync(
      path.join(root, "src/types/generated/api-contracts.ts"), "utf8",
    );

    assert.match(actions, /enrollmentTransitionRequestOptions\(requestKey\)/);
    assert.match(actions, /if \(result\) \{[\s\S]*clearEnrollmentTransitionRequestKey/);
    assert.doesNotMatch(actions, /scheduledTransitions|setScheduledTransitions/);
    assert.match(actions, /schedule-period-end/);
    assert.match(actions, /revoke-scheduled/);
    assert.match(actions, /cancel-immediate/);
    assert.match(tab, /onEnrollmentSchedulePeriodEnd\(enrollment\.id\)/);
    assert.match(tab, /const scheduled = enrollment\.scheduled_period_end_transition/);
    assert.match(tab, /onEnrollmentRevokeScheduled\(scheduled\.intent_id, scheduled\.revision\)/);
    assert.doesNotMatch(tab, /scheduled in this session/);
    assert.match(tab, /onEnrollmentCancelImmediate\(enrollment\.id\)/);
    assert.match(tab, /window\.confirm\("Cancel this recurring enrollment immediately\?/);
    assert.match(tab, /enrollment\.cancel\.period_end\.schedule/);
    assert.match(tab, /enrollment\.cancel\.period_end\.revoke/);
    assert.match(tab, /enrollment\.cancel\.immediate/);
    assert.match(tab, /const canCancelImmediate = !scheduled[\s\S]*enrollment\.cancel\.immediate/);
    assert.match(
      contracts,
      /export interface ApiBillingEnrollmentScheduledTransitionResponse \{[\s\S]*intent_id: string;[\s\S]*revision: number;/,
    );
    assert.match(
      contracts,
      /scheduled_period_end_transition\?: ApiBillingEnrollmentScheduledTransitionResponse \| null;/,
    );
  });

  it("renders immediate and period-end cancellation when no transition is scheduled", () => {
    const markup = renderEnrollmentActions({
      scheduled: null,
      workflows: new Set([
        "enrollment.cancel.immediate",
        "enrollment.cancel.period_end.schedule",
      ]),
    });

    assert.match(markup, />Cancel now</);
    assert.match(markup, />Cancel at period end</);
    assert.doesNotMatch(markup, />Revoke scheduled cancel</);
  });

  it("renders revoke but not conflicting cancellation actions while a transition is scheduled", () => {
    const markup = renderEnrollmentActions({
      scheduled: { intent_id: "intent-1", revision: 2 },
      workflows: new Set([
        "enrollment.cancel.immediate",
        "enrollment.cancel.period_end.revoke",
        "enrollment.cancel.period_end.schedule",
      ]),
    });

    assert.match(markup, /Period-end cancellation is scheduled\./);
    assert.match(markup, />Revoke scheduled cancel</);
    assert.doesNotMatch(markup, />Cancel now</);
    assert.doesNotMatch(markup, />Cancel at period end</);
  });

  it("does not leak either action when the scheduled-transition capabilities are absent", () => {
    const markup = renderEnrollmentActions({
      scheduled: { intent_id: "intent-1", revision: 2 },
      workflows: new Set(["enrollment.cancel.immediate"]),
    });

    assert.match(markup, /Period-end cancellation is scheduled\./);
    assert.doesNotMatch(markup, />Revoke scheduled cancel</);
    assert.doesNotMatch(markup, />Cancel now</);
  });
});

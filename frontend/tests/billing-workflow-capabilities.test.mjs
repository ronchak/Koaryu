import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  billingWorkflowEnabled,
  enabledBillingWorkflowIds,
} from "../src/lib/billing-workflow-capabilities.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("billing workflow capabilities", () => {
  const status = {
    workflow_capabilities: [
      { workflow_id: "plan.sync", enabled: true, denial_reason_code: null },
      {
        workflow_id: "payment.refund",
        enabled: false,
        denial_reason_code: "billing_workflow_live_grant_operations_missing",
      },
    ],
  };

  it("returns enabled workflow ids only to billing roles", () => {
    assert.deepEqual([...enabledBillingWorkflowIds(status, "admin", false)], ["plan.sync"]);
    assert.deepEqual([...enabledBillingWorkflowIds(status, "front_desk", false)], ["plan.sync"]);
    assert.deepEqual([...enabledBillingWorkflowIds(status, "instructor", false)], []);
  });

  it("keeps preview local while live callers require the exact workflow", () => {
    const enabled = enabledBillingWorkflowIds(status, "admin", false);
    assert.equal(billingWorkflowEnabled(enabled, "plan.sync", false), true);
    assert.equal(billingWorkflowEnabled(enabled, "payment.refund", false), false);
    assert.equal(billingWorkflowEnabled(new Set(), "payment.refund", true), true);
  });

  it("makes action code consume exact catalog workflow ids", () => {
    const sources = [
      "billing-action-runtime.ts",
      "billing-connect-actions.ts",
      "billing-plan-actions.ts",
      "billing-payer-actions.ts",
      "billing-payer-setup-action.ts",
      "billing-enrollment-actions.ts",
      "billing-report-actions.ts",
    ].map((file) => fs.readFileSync(path.join(root, "src/lib", file), "utf8")).join("\n");

    for (const workflowId of [
      "connect.onboarding",
      "connect.reset",
      "plan.create",
      "plan.sync",
      "payer.create",
      "payer.sync",
      "payer.setup",
      "enrollment.create.external",
      "enrollment.activate",
      "enrollment.cancel.immediate",
      "payment.external.record",
    ]) {
      assert.match(sources, new RegExp(workflowId.replaceAll(".", "\\.")));
    }
    assert.match(sources, /enabledWorkflowIds\.has\(workflowId\)/);
  });
});

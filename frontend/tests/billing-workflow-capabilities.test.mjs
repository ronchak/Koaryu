import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  billingWorkflowEnabled,
  enabledBillingWorkflowIds,
} from "../src/lib/billing-workflow-capabilities.ts";

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
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { enabledBillingWorkflowIds } from "../src/lib/billing-workflow-capabilities.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("billing data capability loading", () => {
  it("loads studio billing capabilities for front desk without exposing platform billing", () => {
    const source = fs.readFileSync(path.join(root, "src/lib/billing-data-controller.ts"), "utf8");
    assert.match(source, /api\.get<BillingLanding>\("\/billing\/landing", currentToken,/);
    assert.doesNotMatch(source, /api\.get<PlatformBillingStatus>/);
    assert.doesNotMatch(source, /api\.get<BillingSystemStatus>/);

    const status = {
      workflow_capabilities: [
        { enabled: true, denial_reason_code: null, workflow_id: "invoice.reconcile" },
        { enabled: false, denial_reason_code: "role_not_allowed", workflow_id: "core.subscription.checkout" },
      ],
    };
    assert.deepEqual(
      [...enabledBillingWorkflowIds(status, "front_desk", false)],
      ["invoice.reconcile"],
    );
  });
});

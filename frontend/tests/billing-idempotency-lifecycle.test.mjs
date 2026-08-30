import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { clearBillingIdempotencyKeyAfterTerminalError } from "../src/lib/billing-idempotency-lifecycle.ts";
import {
  clearPersistedPayerOperationRequestKey,
  resolvePersistedPayerOperationRequestKey,
} from "../src/lib/billing-payer-setup-model.ts";
import {
  clearPlanSyncRequestKey,
  resolvePlanSyncRequestKey,
} from "../src/lib/billing-plan-sync-model.ts";
import {
  clearEnrollmentActivationRequestKey,
  resolveEnrollmentActivationRequestKey,
} from "../src/lib/billing-enrollment-activation-model.ts";
import {
  clearEnrollmentTransitionRequestKey,
  resolveEnrollmentTransitionRequestKey,
} from "../src/lib/billing-enrollment-transition-model.ts";
import {
  clearPersistedInvoiceOperationRequestKey,
  resolvePersistedInvoiceOperationRequestKey,
} from "../src/lib/billing-invoice-action-model.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const identity = { userId: "user-1", studioId: "studio-1" };

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function apiError(message, status) {
  return Object.assign(new Error(message), { status });
}

function assertTerminalRotation({ clear, resolve }) {
  const first = resolve(() => "request-key-1");
  assert.equal(
    clearBillingIdempotencyKeyAfterTerminalError(
      apiError(
        "This billing operation was rejected. Use a new Idempotency-Key after correcting the request.",
        409,
      ),
      clear,
    ),
    true,
  );
  const second = resolve(() => "request-key-2");
  assert.notEqual(second, first);
}

describe("billing idempotency-key lifecycle", () => {
  it("rotates payer setup and payer sync keys after a terminal 409", () => {
    for (const operation of ["payer.setup", "payer.sync"]) {
      const storage = memoryStorage();
      const keysByPayer = new Map();
      const options = {
        identity,
        keysByPayer,
        operation,
        payerId: "payer-1",
        storage,
      };
      assertTerminalRotation({
        clear: () => clearPersistedPayerOperationRequestKey(options),
        resolve: (createKey) => resolvePersistedPayerOperationRequestKey({
          ...options,
          createKey,
        }),
      });
    }
  });

  it("rotates a payer setup key only after confirmed completion or expiry", () => {
    for (const message of [
      "Autopay setup is already complete. Start a new setup with a new Idempotency-Key.",
      "The Stripe autopay setup session expired. Start a new setup with a new Idempotency-Key.",
    ]) {
      const storage = memoryStorage();
      const keysByPayer = new Map();
      const options = {
        identity,
        keysByPayer,
        operation: "payer.setup",
        payerId: "payer-1",
        storage,
      };
      const first = resolvePersistedPayerOperationRequestKey({
        ...options,
        createKey: () => "request-key-1",
      });

      assert.equal(
        clearBillingIdempotencyKeyAfterTerminalError(
          apiError(message, 409),
          () => clearPersistedPayerOperationRequestKey(options),
        ),
        true,
      );
      assert.notEqual(
        resolvePersistedPayerOperationRequestKey({
          ...options,
          createKey: () => "request-key-2",
        }),
        first,
      );
    }
  });

  it("rotates plan, enrollment activation, transition, and invoice keys after a terminal 409", () => {
    {
      const storage = memoryStorage();
      const keysByPlan = new Map();
      const options = { identity, keysByPlan, planId: "plan-1", storage };
      assertTerminalRotation({
        clear: () => clearPlanSyncRequestKey(options),
        resolve: (createKey) => resolvePlanSyncRequestKey({ ...options, createKey }),
      });
    }
    {
      const storage = memoryStorage();
      const keysByEnrollment = new Map();
      const options = {
        enrollmentId: "enrollment-1",
        identity,
        keysByEnrollment,
        storage,
      };
      assertTerminalRotation({
        clear: () => clearEnrollmentActivationRequestKey(options),
        resolve: (createKey) => resolveEnrollmentActivationRequestKey({
          ...options,
          createKey,
        }),
      });
    }
    {
      const storage = memoryStorage();
      const keys = new Map();
      const options = {
        action: "schedule-period-end",
        identity,
        keys,
        resourceId: "enrollment-1",
        storage,
      };
      assertTerminalRotation({
        clear: () => clearEnrollmentTransitionRequestKey(options),
        resolve: (createKey) => resolveEnrollmentTransitionRequestKey({
          ...options,
          createKey,
        }),
      });
    }
    {
      const storage = memoryStorage();
      const keysByTarget = new Map();
      const options = {
        identity,
        keysByTarget,
        operation: "invoice.finalize",
        storage,
        targetId: "invoice-1",
      };
      assertTerminalRotation({
        clear: () => clearPersistedInvoiceOperationRequestKey(options),
        resolve: (createKey) => resolvePersistedInvoiceOperationRequestKey({
          ...options,
          createKey,
        }),
      });
    }
  });

  it("retains the same key for ambiguous, nonterminal, and network failures", () => {
    for (const error of [
      apiError("This operation is still in progress.", 409),
      apiError("Autopay consent is recorded but local completion is still pending.", 409),
      apiError("Provider outcome is ambiguous.", 503),
      new Error("Failed to reach the backend."),
    ]) {
      let cleared = false;
      assert.equal(
        clearBillingIdempotencyKeyAfterTerminalError(error, () => {
          cleared = true;
        }),
        false,
      );
      assert.equal(cleared, false);
    }
  });

  it("wires terminal rotation into every persisted action family and retains usable payer setup sessions", () => {
    const actionRuntime = fs.readFileSync(
      path.join(root, "src/lib/billing-action-runtime.ts"),
      "utf8",
    );
    const payerActions = fs.readFileSync(
      path.join(root, "src/lib/billing-payer-actions.ts"),
      "utf8",
    );
    const payerSetupAction = fs.readFileSync(
      path.join(root, "src/lib/billing-payer-setup-action.ts"),
      "utf8",
    );
    const planActions = fs.readFileSync(
      path.join(root, "src/lib/billing-plan-actions.ts"),
      "utf8",
    );
    const enrollmentActions = fs.readFileSync(
      path.join(root, "src/lib/billing-enrollment-actions.ts"),
      "utf8",
    );
    const invoiceController = fs.readFileSync(
      path.join(root, "src/lib/billing-invoice-controller.ts"),
      "utf8",
    );

    assert.match(actionRuntime, /onTerminalIdempotencyError/);
    assert.equal((payerActions.match(/onTerminalIdempotencyError/g) || []).length, 1);
    assert.match(payerSetupAction, /clearBillingIdempotencyKeyAfterTerminalError/);
    assert.equal((planActions.match(/onTerminalIdempotencyError/g) || []).length, 1);
    assert.equal((enrollmentActions.match(/onTerminalIdempotencyError/g) || []).length, 2);
    assert.match(invoiceController, /clearBillingIdempotencyKeyAfterTerminalError/);
    assert.doesNotMatch(
      payerActions,
      /if \(link\?\.url\) \{\s*clearPersistedPayerOperationRequestKey/s,
    );
  });
});

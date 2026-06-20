"use client";

import { useRef } from "react";
import { api } from "@/lib/api";
import type { BillingActionRuntime } from "@/lib/billing-action-runtime";
import {
  connectRefreshUrl,
  connectReturnUrl,
} from "@/lib/billing-page-utils";
import type {
  BillingLinkResponse,
  ConnectBusinessEntityType,
  StudioPaymentAccount,
} from "@/types";

function createCoreCheckoutRequestKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `core-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useBillingConnectActions(runtime: BillingActionRuntime) {
  const coreCheckoutRequestKeyRef = useRef<string | null>(null);

  async function openBillingLink(
    path: string,
    body: Record<string, string | undefined>,
    action = "stripe-link"
  ) {
    if (runtime.isPreviewMode) {
      runtime.setMessage("Demo mode uses Stripe-hosted surfaces in production.");
      return;
    }
    if (!runtime.token || !runtime.claimAction(action)) {
      return;
    }
    try {
      let requestKey: string | null = null;
      if (action === "checkout") {
        coreCheckoutRequestKeyRef.current ??= createCoreCheckoutRequestKey();
        requestKey = coreCheckoutRequestKeyRef.current;
      }
      const link = await api.post<BillingLinkResponse>(path, body, runtime.token, {
        timeoutMs: 30000,
        headers: requestKey ? { "Idempotency-Key": requestKey } : undefined,
      });
      if (action === "checkout") {
        coreCheckoutRequestKeyRef.current = null;
      }
      window.location.assign(link.url);
    } catch (err) {
      runtime.setError(err instanceof Error ? err.message : "Stripe link could not be created.");
    } finally {
      runtime.releaseAction(action);
    }
  }

  async function openConnectOnboarding(businessEntityType?: ConnectBusinessEntityType) {
    await openBillingLink(
      "/billing/connect/onboarding-link",
      {
        return_url: connectReturnUrl(),
        refresh_url: connectRefreshUrl(),
        business_entity_type: businessEntityType,
      },
      "connect"
    );
  }

  async function handleConnectReset() {
    await runtime.postBillingAction<StudioPaymentAccount>({
      action: "connect-reset",
      path: "/billing/connect/reset",
      successMessage: "Stripe connection cleared. Start onboarding again to connect the active Stripe platform.",
    });
  }

  return {
    onConnectReset: handleConnectReset,
    openBillingLink,
    openConnectOnboarding,
  };
}

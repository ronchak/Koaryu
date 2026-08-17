"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FocusedOperationsSheet } from "@/components/operations/operations-surface";
import { api } from "@/lib/api";
import {
  acknowledgeConnectOnboardingBeforeNavigation,
  createConnectOnboardingRequestKey,
} from "@/lib/billing-connect-delivery";
import { createClient } from "@/lib/supabase/client";
import type {
  ConnectOnboardingDeliveryAckResponse,
  ConnectOnboardingLinkResponse,
} from "@/types";

function connectReturnUrl() {
  return `${window.location.origin}/billing?connect=return`;
}

function connectRefreshUrl() {
  return `${window.location.origin}/billing/connect/refresh`;
}

export default function StripeConnectRefreshPage() {
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function refreshStripeLink() {
      try {
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          throw new Error("Sign in again to continue Stripe onboarding.");
        }

        const link = await api.post<ConnectOnboardingLinkResponse>(
          "/billing/connect/onboarding-link",
          {
            return_url: connectReturnUrl(),
            refresh_url: connectRefreshUrl(),
          },
          session.access_token,
          {
            timeoutMs: 30000,
            headers: { "Idempotency-Key": createConnectOnboardingRequestKey() },
          }
        );

        if (!cancelled) {
          await acknowledgeConnectOnboardingBeforeNavigation(
            link,
            async (receipt) => {
              await api.post<ConnectOnboardingDeliveryAckResponse>(
                "/billing/connect/onboarding-link/acknowledge",
                { receipt },
                session.access_token,
                { timeoutMs: 30000 },
              );
            },
            (url) => window.location.assign(url),
          );
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Stripe onboarding could not be refreshed.");
        }
      }
    }

    void refreshStripeLink();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <FocusedOperationsSheet page="connect-refresh" eyebrow="Stripe Connect">
      <div className="text-center">
        {error ? (
          <>
            <h1 className="text-base font-semibold text-text-primary">Stripe link expired</h1>
            <p className="mt-2 text-sm text-muted">{error}</p>
            <Button asChild variant="primary" size="sm" className="mt-5">
              <Link href="/billing">Return to billing</Link>
            </Button>
          </>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-accent" />
            <h1 className="text-base font-semibold text-text-primary">Opening Stripe...</h1>
            <p className="text-sm text-muted">Creating a fresh secure onboarding link.</p>
          </div>
        )}
      </div>
    </FocusedOperationsSheet>
  );
}

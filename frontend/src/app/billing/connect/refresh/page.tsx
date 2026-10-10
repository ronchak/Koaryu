"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  HorizonScene,
  SceneSheet,
  SceneSolo,
  sceneSheetLedeClassName,
  sceneSheetTitleClassName,
} from "@/components/auth/horizon-scene";
import { api } from "@/lib/api";
import {
  acknowledgeConnectOnboardingBeforeNavigation,
  createConnectOnboardingRequestKey,
} from "@/lib/billing-connect-delivery";
import { hasConnectOnboardingCapability } from "@/lib/billing-route-access";
import { createClient } from "@/lib/supabase/client";
import type {
  BillingSystemStatus,
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
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) {
          throw new Error("Sign in again to continue Stripe onboarding.");
        }

        const status = await api.get<BillingSystemStatus>(
          "/billing/system/status",
          session.access_token,
        );
        if (!hasConnectOnboardingCapability(status)) {
          throw new Error("Stripe onboarding is not available for the current studio and role.");
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
          },
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
          setError(
            err instanceof Error ? err.message : "Stripe onboarding could not be refreshed.",
          );
        }
      }
    }

    void refreshStripeLink();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <HorizonScene homeHref="/dashboard">
      <SceneSolo>
        <SceneSheet labelledBy="connect-refresh-title">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted">Stripe Connect</p>
          {error ? (
            <>
              <h1 id="connect-refresh-title" className={`mt-2 ${sceneSheetTitleClassName}`}>
                Stripe link expired
              </h1>
              <p className={sceneSheetLedeClassName}>{error}</p>
              <Button asChild variant="primary" size="lg" className="mt-6 w-full">
                <Link href="/billing">Return to billing</Link>
              </Button>
            </>
          ) : (
            <div role="status" aria-live="polite">
              <h1
                id="connect-refresh-title"
                className={`mt-2 flex items-center gap-3 ${sceneSheetTitleClassName}`}
              >
                <Loader2 className="h-5 w-5 animate-spin text-accent" aria-hidden="true" />
                Opening Stripe...
              </h1>
              <p className={sceneSheetLedeClassName}>Creating a fresh secure onboarding link.</p>
            </div>
          )}
        </SceneSheet>
      </SceneSolo>
    </HorizonScene>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import type { BillingLinkResponse } from "@/types";

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

        const link = await api.post<BillingLinkResponse>(
          "/billing/connect/onboarding-link",
          {
            return_url: connectReturnUrl(),
            refresh_url: connectRefreshUrl(),
          },
          session.access_token,
          { timeoutMs: 30000 }
        );

        if (!cancelled) {
          window.location.assign(link.url);
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
    <main className="flex min-h-screen items-center justify-center bg-bg px-4">
      <section className="w-full max-w-md rounded-[6px] border border-border bg-surface p-6 text-center">
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
      </section>
    </main>
  );
}

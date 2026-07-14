"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import { useConfigStore } from "@/lib/store";
import type { AuthResponse, PlatformBillingStatus } from "@/types";

function formatMoney(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function statusLabel(status?: string | null) {
  if (!status) return "subscription required";
  return status.replace(/_/g, " ");
}

function hasAccess(status?: PlatformBillingStatus | null) {
  if (!status) return false;
  return status.comped || status.status === "active" || status.status === "trialing";
}

export default function SubscriptionRequiredPage() {
  const router = useRouter();
  const { clearSubscriptionRequired } = useConfigStore();
  const [authProfile, setAuthProfile] = useState<AuthResponse | null>(null);
  const [billingStatus, setBillingStatus] = useState<PlatformBillingStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const isAdmin = authProfile?.role === "admin";
  const price = billingStatus ? formatMoney(billingStatus.monthly_price_cents, billingStatus.currency) : "$27";
  const currentStatus = billingStatus?.status || "incomplete";
  const showAdminBillingDetails = isAdmin && billingStatus !== null;

  const statusTone = useMemo(() => {
    if (hasAccess(billingStatus)) return "text-success";
    if (currentStatus === "past_due" || currentStatus === "unpaid") return "text-danger";
    return "text-warning";
  }, [billingStatus, currentStatus]);

  useEffect(() => {
    let mounted = true;
    const supabase = createClient();

    async function loadStatus() {
      setIsLoading(true);
      setError("");
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return;
      if (!session) {
        router.replace("/login");
        return;
      }

      try {
        const profile = await api.get<AuthResponse>("/auth/me", session.access_token, {
          omitStudioHeader: false,
        });
        if (!mounted) return;
        setAuthProfile(profile);

        if (!profile.studio_id) {
          router.replace("/onboarding");
          return;
        }

        if (profile.role !== "admin") {
          return;
        }

        const status = await api.get<PlatformBillingStatus>(
          "/platform-billing/status",
          session.access_token
        );
        if (!mounted) return;
        setBillingStatus(status);
        if (hasAccess(status)) {
          clearSubscriptionRequired();
          // The store was intentionally emptied while access was blocked. A
          // document navigation guarantees a fresh authenticated bootstrap for
          // every newly gated dataset before the dashboard renders.
          window.location.replace("/dashboard");
        }
      } catch {
        if (!mounted) return;
        setError("Workspace access could not be verified. Contact Koaryu support for help.");
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    }

    void loadStatus();
    return () => {
      mounted = false;
    };
  }, [clearSubscriptionRequired, router]);

  return (
    <>
      <Header
        title={isAdmin ? "Subscription required" : "Workspace access required"}
        description={isAdmin
          ? "Koaryu Core access needs review before this studio can continue."
          : "A studio administrator or Koaryu support can help restore workspace access."}
      />

      <div className="flex-1 overflow-auto px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
        <div className="mx-auto max-w-[1080px]">
          {isLoading ? (
            <div className="flex items-center gap-2 border-b border-border py-8 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking workspace access...
            </div>
          ) : showAdminBillingDetails ? (
            <>
              <div className="border-b border-border pb-10">
                <div className="mb-5 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-accent">
                  <ShieldCheck className="h-4 w-4" />
                  Koaryu Core access
                </div>
                <div className="grid gap-8 lg:grid-cols-[1.35fr_0.65fr] lg:items-end">
                  <div>
                    <h2 className="max-w-[780px] text-4xl font-semibold leading-tight text-text-primary sm:text-5xl">
                      Support can restore workspace access safely.
                    </h2>
                    <p className="mt-5 max-w-[680px] text-base leading-7 text-text-secondary">
                      Koaryu support can review the studio subscription without changing student,
                      staff, attendance, or payment records.
                    </p>
                  </div>

                  <div className="space-y-4 lg:text-right">
                    <div>
                      <p className="text-xs uppercase tracking-[0.14em] text-muted">Current state</p>
                      <p className={`mt-1 text-lg font-medium capitalize ${statusTone}`}>
                        {statusLabel(currentStatus)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.14em] text-muted">Koaryu Core</p>
                      <p className="mt-1 text-3xl font-semibold text-text-primary">
                        {price}
                        <span className="text-sm font-normal text-muted"> / month</span>
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid gap-6 border-b border-border py-8 md:grid-cols-3">
                <div className="space-y-2">
                  <CheckCircle2 className="h-4 w-4 text-accent" />
                  <p className="text-sm font-medium text-text-primary">Support-mediated recovery</p>
                  <p className="text-sm leading-6 text-text-secondary">No unsupported checkout control is presented.</p>
                </div>
                <div className="space-y-2">
                  <CheckCircle2 className="h-4 w-4 text-accent" />
                  <p className="text-sm font-medium text-text-primary">Live Stripe remains disabled</p>
                  <p className="text-sm leading-6 text-text-secondary">Provider writes are currently unavailable.</p>
                </div>
                <div className="space-y-2">
                  <CheckCircle2 className="h-4 w-4 text-accent" />
                  <p className="text-sm font-medium text-text-primary">Studio data stays preserved</p>
                  <p className="text-sm leading-6 text-text-secondary">Access recovery does not delete operational history.</p>
                </div>
              </div>
            </>
          ) : (
            <div className="border-b border-border pb-10">
              <div className="mb-5 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-accent">
                <ShieldCheck className="h-4 w-4" />
                Workspace access
              </div>
              <h2 className="max-w-[780px] text-4xl font-semibold leading-tight text-text-primary sm:text-5xl">
                {isAdmin
                  ? "Contact Koaryu support to review workspace access."
                  : "Ask a studio administrator or Koaryu support for help."}
              </h2>
              <p className="mt-5 max-w-[680px] text-base leading-7 text-text-secondary">
                {isAdmin
                  ? "Subscription details are unavailable right now. Studio data remains preserved while access is reviewed."
                  : "Billing details are limited to studio administrators. Your studio data remains preserved while access is reviewed."}
              </p>
            </div>
          )}

          {!isLoading ? (
            <div className="flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                {isAdmin ? (
                  <p className="text-sm text-text-secondary">
                    Koaryu Core checkout and portal actions are currently disabled.
                    Contact support to restore access for this studio.
                  </p>
                ) : (
                  <p className="text-sm text-text-secondary">
                    No subscription status, price, or payment details are shown on this page.
                  </p>
                )}
                {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button asChild variant="primary" size="lg">
                  <a href="mailto:support@koaryu.app?subject=Koaryu%20Core%20access">
                    Contact Koaryu support
                  </a>
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CheckCircle2, CreditCard, Loader2, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import { useConfigStore } from "@/lib/store";
import type { AuthResponse, BillingLinkResponse, PlatformBillingStatus } from "@/types";

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
  const [token, setToken] = useState<string | null>(null);
  const [authProfile, setAuthProfile] = useState<AuthResponse | null>(null);
  const [billingStatus, setBillingStatus] = useState<PlatformBillingStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [error, setError] = useState("");

  const isAdmin = authProfile?.role === "admin";
  const price = billingStatus ? formatMoney(billingStatus.monthly_price_cents, billingStatus.currency) : "$27";
  const currentStatus = billingStatus?.status || "incomplete";
  const showPortal = Boolean(billingStatus?.stripe_customer_id);

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

      setToken(session.access_token);

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
      } catch (loadError) {
        if (!mounted) return;
        setError(loadError instanceof Error ? loadError.message : "Subscription status could not be loaded.");
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

  async function openBillingLink(path: "/platform-billing/checkout" | "/platform-billing/portal") {
    if (!token) return;
    setIsActionLoading(true);
    setError("");

    try {
      const origin = window.location.origin;
      const link = await api.post<BillingLinkResponse>(
        path,
        path === "/platform-billing/checkout"
          ? {
              success_url: `${origin}/dashboard`,
              cancel_url: `${origin}/subscription-required`,
            }
          : {
              return_url: `${origin}/subscription-required`,
            },
        token
      );
      window.location.assign(link.url);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Billing could not be opened.");
      setIsActionLoading(false);
    }
  }

  return (
    <>
      <Header
        title="Subscription required"
        description="Koaryu Core must be active before this studio can continue."
      />

      <div className="flex-1 overflow-auto px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
        <div className="mx-auto max-w-[1080px]">
          <div className="border-b border-border pb-10">
            <div className="mb-5 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-accent">
              <ShieldCheck className="h-4 w-4" />
              Koaryu Core access
            </div>
            <div className="grid gap-8 lg:grid-cols-[1.35fr_0.65fr] lg:items-end">
              <div>
                <h2 className="max-w-[780px] text-4xl font-semibold leading-tight text-text-primary sm:text-5xl">
                  Keep the studio workspace active.
                </h2>
                <p className="mt-5 max-w-[680px] text-base leading-7 text-text-secondary">
                  Start or restore the Koaryu Core subscription to unlock students, scheduling,
                  belt tracking, leads, automations, and reports.
                </p>
              </div>

              <div className="space-y-4 lg:text-right">
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-muted">Current state</p>
                  <p className={`mt-1 text-lg font-medium capitalize ${statusTone}`}>
                    {isLoading ? "checking" : statusLabel(currentStatus)}
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
              <p className="text-sm font-medium text-text-primary">Flat software subscription</p>
              <p className="text-sm leading-6 text-text-secondary">One physical location, every Koaryu module.</p>
            </div>
            <div className="space-y-2">
              <CheckCircle2 className="h-4 w-4 text-accent" />
              <p className="text-sm font-medium text-text-primary">30-day Stripe trial</p>
              <p className="text-sm leading-6 text-text-secondary">Trial access begins after checkout is completed.</p>
            </div>
            <div className="space-y-2">
              <CheckCircle2 className="h-4 w-4 text-accent" />
              <p className="text-sm font-medium text-text-primary">No student or staff cap</p>
              <p className="text-sm leading-6 text-text-secondary">Growth stays predictable at the same monthly rate.</p>
            </div>
          </div>

          <div className="flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              {isLoading ? (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Checking subscription status...
                </p>
              ) : isAdmin ? (
                <p className="text-sm text-text-secondary">
                  Use the secure Stripe flow to restore access for this studio.
                </p>
              ) : (
                <p className="text-sm text-text-secondary">
                  A studio admin needs to restore Koaryu Core before staff can continue.
                </p>
              )}
              {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="lg"
                disabled={!isAdmin || isLoading || isActionLoading}
                isLoading={isActionLoading}
                onClick={() => void openBillingLink("/platform-billing/checkout")}
              >
                <CreditCard className="h-4 w-4" />
                Resume subscription
              </Button>
              {showPortal ? (
                <Button
                  variant="secondary"
                  size="lg"
                  disabled={!isAdmin || isLoading || isActionLoading}
                  onClick={() => void openBillingLink("/platform-billing/portal")}
                >
                  Manage billing
                  <ArrowRight className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, CheckCircle2, CreditCard, Loader2, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import { useConfigStore } from "@/lib/store";
import type {
  AuthResponse,
  BillingLinkResponse,
  BillingSystemStatus,
  PlatformBillingStatus,
} from "@/types";

const LIVE_STRIPE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
]);

function createCheckoutRequestKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `core-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
  const [billingSystemStatus, setBillingSystemStatus] = useState<BillingSystemStatus | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [billingAction, setBillingAction] = useState<"checkout" | "portal" | null>(null);
  const [error, setError] = useState("");
  const checkoutRequestKeyRef = useRef<string | null>(null);

  const isAdmin = authProfile?.role === "admin";
  const price = billingStatus ? formatMoney(billingStatus.monthly_price_cents, billingStatus.currency) : "$27";
  const currentStatus = billingStatus?.status || "incomplete";
  const showAdminBillingDetails = isAdmin && billingStatus !== null;
  const coreBillingEnabled = billingSystemStatus?.mutation_capabilities.core_subscription === true;
  const hasLiveStripeSubscription = Boolean(
    billingStatus?.stripe_subscription_id
      && LIVE_STRIPE_SUBSCRIPTION_STATUSES.has(currentStatus)
  );
  const canStartCheckout = coreBillingEnabled && !hasLiveStripeSubscription;
  const canOpenPortal = coreBillingEnabled && Boolean(billingStatus?.stripe_customer_id);

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
      setAuthToken(session.access_token);

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
          return;
        }

        try {
          const systemStatus = await api.get<BillingSystemStatus>(
            "/billing/system/status",
            session.access_token
          );
          if (!mounted) return;
          setBillingSystemStatus(systemStatus);
        } catch {
          if (!mounted) return;
          setError("Self-service billing is unavailable right now. Contact Koaryu support for help.");
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

  async function openBillingLink(action: "checkout" | "portal") {
    if (!authToken || !coreBillingEnabled || billingAction) return;
    setBillingAction(action);
    setError("");
    try {
      const headers: Record<string, string> = {};
      if (action === "checkout") {
        checkoutRequestKeyRef.current ??= createCheckoutRequestKey();
        headers["Idempotency-Key"] = checkoutRequestKeyRef.current;
      }
      const link = await api.post<BillingLinkResponse>(
        `/platform-billing/${action}`,
        action === "checkout"
          ? { success_url: window.location.href, cancel_url: window.location.href }
          : { return_url: window.location.href },
        authToken,
        { timeoutMs: 30000, headers }
      );
      if (action === "checkout") {
        checkoutRequestKeyRef.current = null;
      }
      window.location.assign(link.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stripe billing could not be opened.");
      setBillingAction(null);
    }
  }

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
                      {coreBillingEnabled
                        ? "Restore access through secure Stripe billing."
                        : "Support can restore workspace access safely."}
                    </h2>
                    <p className="mt-5 max-w-[680px] text-base leading-7 text-text-secondary">
                      {coreBillingEnabled
                        ? "Start or manage the Koaryu Core subscription without changing student, staff, attendance, or tuition records."
                        : "Koaryu support can review the studio subscription without changing student, staff, attendance, or payment records."}
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
                  <p className="text-sm font-medium text-text-primary">
                    {coreBillingEnabled ? "Self-service recovery" : "Support-mediated recovery"}
                  </p>
                  <p className="text-sm leading-6 text-text-secondary">
                    {coreBillingEnabled
                      ? "Authorized studio admins can open Stripe-hosted billing."
                      : "No unsupported checkout control is presented."}
                  </p>
                </div>
                <div className="space-y-2">
                  <CheckCircle2 className="h-4 w-4 text-accent" />
                  <p className="text-sm font-medium text-text-primary">
                    {coreBillingEnabled ? "Stripe capability verified" : "Live Stripe remains disabled"}
                  </p>
                  <p className="text-sm leading-6 text-text-secondary">
                    {coreBillingEnabled
                      ? "The backend authorized Koaryu Core billing for this studio."
                      : "Provider writes are currently unavailable."}
                  </p>
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
                    {coreBillingEnabled
                      ? "Use Stripe Checkout to start Koaryu Core or open the customer portal to manage existing billing."
                      : "Koaryu Core checkout and portal actions are currently disabled. Contact support to restore access for this studio."}
                  </p>
                ) : (
                  <p className="text-sm text-text-secondary">
                    No subscription status, price, or payment details are shown on this page.
                  </p>
                )}
                {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
              </div>

              <div className="flex flex-wrap gap-2">
                {isAdmin && canStartCheckout ? (
                  <Button
                    variant="primary"
                    size="lg"
                    isLoading={billingAction === "checkout"}
                    disabled={billingAction !== null}
                    onClick={() => void openBillingLink("checkout")}
                  >
                    <CreditCard className="h-4 w-4" />
                    {billingAction === "checkout" ? "Opening Stripe..." : "Start Koaryu Core"}
                  </Button>
                ) : null}
                {isAdmin && canOpenPortal ? (
                  <Button
                    variant="secondary"
                    size="lg"
                    isLoading={billingAction === "portal"}
                    disabled={billingAction !== null}
                    onClick={() => void openBillingLink("portal")}
                  >
                    <ArrowUpRight className="h-4 w-4" />
                    {billingAction === "portal" ? "Opening Stripe..." : "Customer portal"}
                  </Button>
                ) : null}
                <Button asChild variant={coreBillingEnabled ? "secondary" : "primary"} size="lg">
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

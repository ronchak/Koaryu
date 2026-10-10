"use client";

import { publishAccessIdentity } from "@/lib/access-identity";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, CheckCircle2, CreditCard, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/header";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { Button } from "@/components/ui/button";
import {
  HorizonPage,
  HorizonPanel,
  ToneChip,
  ToneTag,
  type HorizonTone,
} from "@/components/ui/horizon";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import { ACCOUNT_ARCHIVED_ROUTE } from "@/lib/auth-route-model";
import { SUPPORT_EMAIL } from "@/lib/constants";
import { parseAuthProfileResponse } from "@/lib/store-bootstrap-model";
import { syncStoredStudioSessionCookies } from "@/lib/store-session-cookies";
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
  const price = billingStatus
    ? formatMoney(billingStatus.monthly_price_cents, billingStatus.currency)
    : "$27";
  const currentStatus = billingStatus?.status || "incomplete";
  const showAdminBillingDetails = isAdmin && billingStatus !== null;
  const coreBillingEnabled = billingSystemStatus?.mutation_capabilities.core_subscription === true;
  const hasLiveStripeSubscription = Boolean(
    billingStatus?.stripe_subscription_id && LIVE_STRIPE_SUBSCRIPTION_STATUSES.has(currentStatus),
  );
  const canStartCheckout = coreBillingEnabled && !hasLiveStripeSubscription;
  const canOpenPortal = coreBillingEnabled && Boolean(billingStatus?.stripe_customer_id);

  const statusTone = useMemo<HorizonTone>(() => {
    if (hasAccess(billingStatus)) return "calm";
    if (currentStatus === "past_due" || currentStatus === "unpaid") return "alert";
    return "warn";
  }, [billingStatus, currentStatus]);

  useEffect(() => {
    let mounted = true;
    const supabase = createClient();

    async function loadStatus() {
      setIsLoading(true);
      setError("");
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!mounted) return;
      if (!session) {
        router.replace("/login");
        return;
      }
      setAuthToken(session.access_token);

      try {
        const profile = parseAuthProfileResponse(
          await api.get<unknown>("/auth/me", session.access_token, {
            omitStudioHeader: false,
          }),
        );
        if (!mounted) return;
        publishAccessIdentity(profile);
        setAuthProfile(profile);
        syncStoredStudioSessionCookies(
          session.user.id,
          profile.studio_id,
          profile.membership_status,
        );

        if (profile.membership_status === "archived") {
          clearSubscriptionRequired();
          window.location.replace(ACCOUNT_ARCHIVED_ROUTE);
          return;
        }

        if (profile.membership_status !== "active" || !profile.studio_id) {
          router.replace("/onboarding");
          return;
        }

        if (profile.role !== "admin") {
          return;
        }

        const status = await api.get<PlatformBillingStatus>(
          "/platform-billing/status",
          session.access_token,
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
            session.access_token,
          );
          if (!mounted) return;
          setBillingSystemStatus(systemStatus);
        } catch {
          if (!mounted) return;
          setError(
            "Self-service billing is unavailable right now. Contact Koaryu support for help.",
          );
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
        { timeoutMs: 30000, headers },
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
    <OperationsSurface page="subscription-required">
      <Header
        eyebrow="Koaryu Core"
        title={isAdmin ? "Subscription required" : "Workspace access required"}
        description={
          isAdmin
            ? "Koaryu Core access needs review before this studio can continue."
            : "A studio administrator or Koaryu support can help restore workspace access."
        }
      />

      <HorizonPage>
        {isLoading ? (
          <div
            className="koaryu-skeleton-reveal"
            role="status"
            aria-label="Checking workspace access"
            aria-busy="true"
          >
            <HorizonPanel>
              <div aria-hidden="true" className="space-y-5">
                <div className="h-4 w-40 rounded-md bg-surface-raised" />
                <div className="grid gap-6 md:grid-cols-[1fr_auto] md:items-end">
                  <div className="space-y-3">
                    <div className="h-10 max-w-[560px] rounded-md bg-surface-raised" />
                    <div className="h-12 max-w-[520px] rounded-md bg-surface-raised" />
                  </div>
                  <div className="h-16 w-40 rounded-md bg-surface-raised" />
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  {[0, 1, 2].map((column) => (
                    <div key={column} className="h-20 rounded-[12px] bg-surface-raised" />
                  ))}
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="h-10 w-full max-w-md rounded-md bg-surface-raised" />
                  <div className="h-11 w-52 shrink-0 rounded-[10px] bg-surface-raised" />
                </div>
              </div>
            </HorizonPanel>
          </div>
        ) : (
          <HorizonPanel>
            {showAdminBillingDetails ? (
              <>
                <div className="grid gap-6 md:grid-cols-[1fr_auto] md:items-start">
                  <div className="min-w-0">
                    <div className="mb-3 flex items-center gap-3">
                      <ToneChip tone={statusTone} size={32}>
                        <ShieldCheck />
                      </ToneChip>
                      <span className="text-sm font-semibold text-text-secondary">
                        Koaryu Core access
                      </span>
                    </div>
                    <h2 className="max-w-[640px] text-2xl font-extrabold leading-tight tracking-[-0.03em] text-text-primary sm:text-3xl">
                      {coreBillingEnabled
                        ? "Restore access through secure Stripe billing."
                        : "Support can restore workspace access safely."}
                    </h2>
                    <p className="mt-3 max-w-[600px] text-[15px] leading-7 text-text-secondary">
                      {coreBillingEnabled
                        ? "Start or manage the Koaryu Core subscription without changing student, staff, attendance, or tuition records."
                        : "Koaryu support can review the studio subscription without changing student, staff, attendance, or payment records."}
                    </p>
                  </div>

                  <dl className="grid min-w-[12rem] gap-3 rounded-[12px] bg-[var(--hz-tile)] p-4 md:text-right">
                    <div>
                      <dt className="text-xs font-semibold text-muted">Current state</dt>
                      <dd className="mt-1.5">
                        <ToneTag tone={statusTone} className="capitalize">
                          {statusLabel(currentStatus)}
                        </ToneTag>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-muted">Koaryu Core</dt>
                      <dd className="mt-1 text-3xl font-extrabold tabular-nums tracking-[-0.04em] text-text-primary">
                        {price}
                        <span className="ml-1 text-sm font-semibold tracking-normal text-muted">
                          / month
                        </span>
                      </dd>
                    </div>
                  </dl>
                </div>

                <ul className="mt-6 grid gap-3 md:grid-cols-3">
                  {[
                    {
                      title: coreBillingEnabled
                        ? "Self-service recovery"
                        : "Support-mediated recovery",
                      detail: coreBillingEnabled
                        ? "Authorized studio admins can open Stripe-hosted billing."
                        : "No unsupported checkout control is presented.",
                    },
                    {
                      title: coreBillingEnabled
                        ? "Stripe capability verified"
                        : "Self-service is unavailable",
                      detail: coreBillingEnabled
                        ? "The backend authorized Koaryu Core billing for this studio."
                        : "Koaryu Core billing is not available for this studio right now.",
                    },
                    {
                      title: "Studio data stays preserved",
                      detail: "Access recovery does not delete operational history.",
                    },
                  ].map((point) => (
                    <li
                      key={point.title}
                      className="flex gap-3 rounded-[12px] border border-border p-4"
                    >
                      <CheckCircle2
                        aria-hidden="true"
                        className="mt-0.5 h-4 w-4 shrink-0 text-accent"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-text-primary">{point.title}</p>
                        <p className="mt-1 text-sm leading-6 text-text-secondary">{point.detail}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="flex gap-4">
                <ToneChip tone="warn">
                  <ShieldCheck />
                </ToneChip>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text-secondary">Workspace access</p>
                  <h2 className="mt-1 max-w-[640px] text-2xl font-extrabold leading-tight tracking-[-0.03em] text-text-primary sm:text-3xl">
                    {isAdmin
                      ? "Contact Koaryu support to review workspace access."
                      : "Ask a studio administrator or Koaryu support for help."}
                  </h2>
                  <p className="mt-3 max-w-[600px] text-[15px] leading-7 text-text-secondary">
                    {isAdmin
                      ? "Subscription details are unavailable right now. Studio data remains preserved while access is reviewed."
                      : "Billing details are limited to studio administrators. Your studio data remains preserved while access is reviewed."}
                  </p>
                </div>
              </div>
            )}

            <div className="mt-6 flex flex-col gap-4 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
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
                {error ? (
                  <p className="mt-2 rounded-[10px] bg-[var(--hz-alert-wash)] px-3 py-2 text-sm text-danger">
                    {error}
                  </p>
                ) : null}
              </div>

              <div className="flex shrink-0 flex-wrap gap-2">
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
                  <a href={`mailto:${SUPPORT_EMAIL}?subject=Koaryu%20Core%20access`}>
                    Contact Koaryu support
                  </a>
                </Button>
              </div>
            </div>
          </HorizonPanel>
        )}
      </HorizonPage>
    </OperationsSurface>
  );
}

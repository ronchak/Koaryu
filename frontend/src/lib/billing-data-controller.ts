"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { api, isSubscriptionRequiredError } from "@/lib/api";
import type {
  BillingInvoice,
  BillingPayment,
  BillingPayer,
  BillingPlan,
  BillingSubscription,
  ExportJob,
  PlatformBillingStatus,
  StudentBillingEnrollment,
  StudioPaymentAccount,
} from "@/types";

type UseBillingDataControllerOptions = {
  canManageKoaryuSubscription: boolean;
  canManageStudioBilling: boolean;
  isPreviewMode: boolean;
  onSubscriptionRequired: () => void;
  setError: (message: string) => void;
  setMessage: (message: string) => void;
  shouldSettleEarly: boolean;
  token: string | null;
};

type BillingAccessSnapshot = {
  accessKey: string;
};

export function useBillingDataController({
  canManageKoaryuSubscription,
  canManageStudioBilling,
  isPreviewMode,
  onSubscriptionRequired,
  setError,
  setMessage,
  shouldSettleEarly,
  token,
}: UseBillingDataControllerOptions) {
  const [platformBilling, setPlatformBilling] = useState<PlatformBillingStatus | null>(null);
  const [paymentAccount, setPaymentAccount] = useState<StudioPaymentAccount | null>(null);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [payers, setPayers] = useState<BillingPayer[]>([]);
  const [subscriptions, setSubscriptions] = useState<BillingSubscription[]>([]);
  const [enrollments, setEnrollments] = useState<StudentBillingEnrollment[]>([]);
  const [invoices, setInvoices] = useState<BillingInvoice[]>([]);
  const [payments, setPayments] = useState<BillingPayment[]>([]);
  const [exportJobs, setExportJobs] = useState<ExportJob[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasBillingLoadSettled, setHasBillingLoadSettled] = useState(isPreviewMode);
  const [loadedAccessKey, setLoadedAccessKey] = useState<string | null>(null);
  const activeAccessKey = token && canManageStudioBilling && !shouldSettleEarly
    ? `${token}:${canManageKoaryuSubscription ? "subscription-admin" : "studio-billing"}`
    : null;
  const requestSequenceRef = useRef(0);
  const latestAccessKeyRef = useRef(activeAccessKey);

  const shouldSettleWithoutAccess = !token || shouldSettleEarly;
  const resetBillingData = useCallback(({ settled }: { settled: boolean }) => {
    setPlatformBilling(null);
    setPaymentAccount(null);
    setPlans([]);
    setPayers([]);
    setSubscriptions([]);
    setEnrollments([]);
    setInvoices([]);
    setPayments([]);
    setExportJobs([]);
    setIsLoading(false);
    setHasBillingLoadSettled(settled);
    setLoadedAccessKey(null);
  }, []);

  const isCurrentRequest = useCallback((requestId: number, access: BillingAccessSnapshot) => {
    return requestSequenceRef.current === requestId && latestAccessKeyRef.current === access.accessKey;
  }, []);

  useLayoutEffect(() => {
    requestSequenceRef.current += 1;
    latestAccessKeyRef.current = activeAccessKey;
  }, [activeAccessKey]);

  const refreshBilling = useCallback(async () => {
    if (!activeAccessKey || !token) {
      resetBillingData({ settled: shouldSettleWithoutAccess });
      return;
    }
    const requestAccess = { accessKey: activeAccessKey };
    const requestId = requestSequenceRef.current += 1;
    setIsLoading(true);
    setHasBillingLoadSettled(false);
    setError("");
    try {
      const results = await Promise.allSettled([
        canManageKoaryuSubscription
          ? api.get<PlatformBillingStatus>("/platform-billing/status", token)
          : Promise.resolve(null),
        api.get<StudioPaymentAccount>("/billing/connect/status", token),
        api.get<BillingPlan[]>("/billing/plans", token),
        api.get<BillingPayer[]>("/billing/payers", token),
        api.get<BillingSubscription[]>("/billing/subscriptions", token),
        api.get<StudentBillingEnrollment[]>("/billing/enrollments", token),
        api.get<BillingInvoice[]>("/billing/invoices", token),
        api.get<BillingPayment[]>("/billing/payments", token),
      ] as const);

      const [
        platformResult,
        connectResult,
        plansResult,
        payersResult,
        subscriptionsResult,
        enrollmentsResult,
        invoicesResult,
        paymentsResult,
      ] = results;

      const failures: string[] = [];
      const subscriptionRequired = results.some((result) =>
        result.status === "rejected" && isSubscriptionRequiredError(result.reason)
      );
      if (!isCurrentRequest(requestId, requestAccess)) {
        return;
      }
      if (subscriptionRequired) {
        resetBillingData({ settled: true });
        onSubscriptionRequired();
        return;
      }

      const applyResult = <T,>(
        label: string,
        result: PromiseSettledResult<T>,
        apply: (value: T) => void,
        clear: () => void
      ) => {
        if (result.status === "fulfilled") {
          apply(result.value);
          return;
        }
        clear();
        const message = result.reason instanceof Error ? result.reason.message : "could not be loaded";
        failures.push(`${label}: ${message}`);
      };

      applyResult("Koaryu Core", platformResult, setPlatformBilling, () => setPlatformBilling(null));
      applyResult("Stripe Connect", connectResult, setPaymentAccount, () => setPaymentAccount(null));
      applyResult("Plans", plansResult, setPlans, () => setPlans([]));
      applyResult("Families", payersResult, setPayers, () => setPayers([]));
      applyResult("Subscriptions", subscriptionsResult, setSubscriptions, () => setSubscriptions([]));
      applyResult("Enrollments", enrollmentsResult, setEnrollments, () => setEnrollments([]));
      applyResult("Invoices", invoicesResult, setInvoices, () => setInvoices([]));
      applyResult("Payments", paymentsResult, setPayments, () => setPayments([]));
      setLoadedAccessKey(requestAccess.accessKey);

      if (failures.length > 0) {
        setError(`Some billing data is unavailable. ${failures.join(" ")}`);
      }
    } catch (err) {
      if (!isCurrentRequest(requestId, requestAccess)) {
        return;
      }
      setError(err instanceof Error ? err.message : "Billing could not be loaded.");
    } finally {
      if (isCurrentRequest(requestId, requestAccess)) {
        setIsLoading(false);
        setHasBillingLoadSettled(true);
      }
    }
  }, [
    activeAccessKey,
    canManageKoaryuSubscription,
    isCurrentRequest,
    onSubscriptionRequired,
    resetBillingData,
    setError,
    shouldSettleWithoutAccess,
    token,
  ]);

  const refreshConnectStatus = useCallback(async ({ sync = false }: { sync?: boolean } = {}) => {
    if (!activeAccessKey || !token) {
      resetBillingData({ settled: shouldSettleWithoutAccess });
      return;
    }
    const requestAccess = { accessKey: activeAccessKey };
    const requestId = requestSequenceRef.current += 1;
    setIsLoading(true);
    setHasBillingLoadSettled(false);
    setError("");
    try {
      const account = sync
        ? await api.post<StudioPaymentAccount>("/billing/connect/sync", {}, token, { timeoutMs: 30000 })
        : await api.get<StudioPaymentAccount>("/billing/connect/status", token);
      if (!isCurrentRequest(requestId, requestAccess)) {
        return;
      }
      setPaymentAccount(account);
      if (sync) {
        setMessage(account.charges_enabled ? "Stripe verification is complete." : "Stripe account status updated.");
        await refreshBilling();
      }
    } catch (err) {
      if (!isCurrentRequest(requestId, requestAccess)) {
        return;
      }
      if (isSubscriptionRequiredError(err)) {
        resetBillingData({ settled: true });
        onSubscriptionRequired();
        return;
      }
      setError(err instanceof Error ? err.message : "Stripe Connect status could not be loaded.");
    } finally {
      if (isCurrentRequest(requestId, requestAccess)) {
        setIsLoading(false);
        setHasBillingLoadSettled(true);
      }
    }
  }, [
    activeAccessKey,
    isCurrentRequest,
    onSubscriptionRequired,
    refreshBilling,
    resetBillingData,
    setError,
    setMessage,
    shouldSettleWithoutAccess,
    token,
  ]);

  const hasVisibleBillingData = activeAccessKey !== null && loadedAccessKey === activeAccessKey;

  return {
    enrollments: hasVisibleBillingData ? enrollments : [],
    exportJobs: hasVisibleBillingData ? exportJobs : [],
    hasBillingLoadSettled: activeAccessKey ? hasVisibleBillingData && hasBillingLoadSettled : shouldSettleWithoutAccess,
    invoices: hasVisibleBillingData ? invoices : [],
    isLoading: activeAccessKey ? isLoading : false,
    payers: hasVisibleBillingData ? payers : [],
    paymentAccount: hasVisibleBillingData ? paymentAccount : null,
    payments: hasVisibleBillingData ? payments : [],
    plans: hasVisibleBillingData ? plans : [],
    platformBilling: hasVisibleBillingData ? platformBilling : null,
    refreshBilling,
    refreshConnectStatus,
    setExportJobs,
    subscriptions: hasVisibleBillingData ? subscriptions : [],
  };
}

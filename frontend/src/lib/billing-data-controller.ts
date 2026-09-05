"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { api, isSubscriptionRequiredError } from "@/lib/api";
import type { BillingLanding, BillingInvoicePage, BillingPaymentPage } from "@/lib/billing-landing";
import type { BillingTab } from "@/lib/billing-page-state";
import type {
  BillingInvoice,
  BillingPayment,
  BillingPaymentCohortSummary,
  BillingPayer,
  BillingPlan,
  BillingSystemStatus,
  BillingSubscription,
  ExportJob,
  PlatformBillingStatus,
  StudentBillingEnrollment,
  StudioPaymentAccount,
} from "@/types";

type UseBillingDataControllerOptions = {
  canManageKoaryuSubscription: boolean;
  identityKey: string | null;
  activeTab: BillingTab;
  canViewStudioBilling: boolean;
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
  identityKey,
  activeTab,
  canViewStudioBilling,
  isPreviewMode,
  onSubscriptionRequired,
  setError,
  setMessage,
  shouldSettleEarly,
  token,
}: UseBillingDataControllerOptions) {
  const [landing, setLanding] = useState<BillingLanding | null>(null);
  const tokenRef = useRef(token);
  const retainedRef = useRef(new Map<string, number>());
  const errorsRef = useRef(new Map<string, string>());
  const dataScopeRef = useRef<string | null>(null);
  const [platformBilling, setPlatformBilling] = useState<PlatformBillingStatus | null>(null);
  const [billingSystemStatus, setBillingSystemStatus] = useState<BillingSystemStatus | null>(null);
  const [paymentAccount, setPaymentAccount] = useState<StudioPaymentAccount | null>(null);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [payers, setPayers] = useState<BillingPayer[]>([]);
  const [subscriptions, setSubscriptions] = useState<BillingSubscription[]>([]);
  const [enrollments, setEnrollments] = useState<StudentBillingEnrollment[]>([]);
  const [invoiceCursor, setInvoiceCursor] = useState<string | null>(null);
  const [paymentCursor, setPaymentCursor] = useState<string | null>(null);
  const loadMoreInFlightRef = useRef<symbol | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [invoices, setInvoices] = useState<BillingInvoice[]>([]);
  const [payments, setPayments] = useState<BillingPayment[]>([]);
  const [paymentCohortSummary, setPaymentCohortSummary] = useState<BillingPaymentCohortSummary | null>(null);
  const [exportJobs, setExportJobs] = useState<ExportJob[]>([]);
  const [settledTabs, setSettledTabs] = useState<ReadonlySet<string>>(() => new Set());
  const [settledAttemptKey, setSettledAttemptKey] = useState<string | null>(null);
  const markTabSettled = useCallback((key: string, settled: boolean, retain = false) => {
    setSettledAttemptKey(settled ? key : null);
    setSettledTabs((previous) => {
      if (settled && !retain) return previous;
      const next = new Set(previous);
      if (settled) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const [loadedAccessKey, setLoadedAccessKey] = useState<string | null>(null);
  const activeAccessKey = token && canViewStudioBilling && !shouldSettleEarly
    ? identityKey ? `${identityKey}:${canManageKoaryuSubscription ? "subscription-admin" : "studio-billing"}` : null
    : null;
  const requestSequenceRef = useRef(0);
  const latestAccessKeyRef = useRef(activeAccessKey);
  const showTabError = useCallback((cacheKey: string, message?: string) => {
    if (message !== undefined) errorsRef.current.set(cacheKey, message);
    setError([
      errorsRef.current.get(`${activeAccessKey}:landing`),
      errorsRef.current.get(cacheKey),
    ].filter(Boolean).join(" "));
  }, [activeAccessKey, setError]);

  const shouldSettleWithoutAccess = !token || shouldSettleEarly;
  const clearFinancialData = useCallback(() => {
    setPlans([]);
    setPayers([]);
    setSubscriptions([]);
    setEnrollments([]);
    setInvoices([]);
    setPayments([]);
    setInvoiceCursor(null);
    setPaymentCursor(null);
    setPaymentCohortSummary(null);
    setExportJobs([]);
    setIsLoadingMore(false);
    loadMoreInFlightRef.current = null;
    retainedRef.current.clear();
    errorsRef.current.clear();
    setSettledTabs(new Set());
    setSettledAttemptKey(null);
  }, []);
  const resetBillingData = useCallback(() => {
    clearFinancialData();
    setLanding(null);
    setPlatformBilling(null);
    setBillingSystemStatus(null);
    setPaymentAccount(null);
    setLoadedAccessKey(null);
    setError("");
  }, [clearFinancialData, setError]);

  const isCurrentRequest = useCallback((requestId: number, access: BillingAccessSnapshot) => {
    return requestSequenceRef.current === requestId && latestAccessKeyRef.current === access.accessKey;
  }, []);

  useLayoutEffect(() => { tokenRef.current = token; }, [token]);

  useLayoutEffect(() => {
    requestSequenceRef.current += 1;
    retainedRef.current.clear();
    errorsRef.current.clear();
    setError("");
    latestAccessKeyRef.current = activeAccessKey;
    return () => { requestSequenceRef.current += 1; };
  }, [activeAccessKey, setError]);

  useLayoutEffect(() => {
    requestSequenceRef.current += 1;
  }, [activeTab]);

  const loadBilling = useCallback(async (force: boolean) => {
    const currentToken = tokenRef.current;
    if (!activeAccessKey || !currentToken) {
      resetBillingData();
      return;
    }
    if (dataScopeRef.current !== activeAccessKey) {
      resetBillingData();
      dataScopeRef.current = activeAccessKey;
    }
    setIsLoadingMore(false);
    loadMoreInFlightRef.current = null;
    if (force) {
      retainedRef.current.clear();
      errorsRef.current.clear();
      setSettledTabs(new Set());
    }
    const cacheKey = `${activeAccessKey}:${activeTab}`;
    const freshAt = retainedRef.current.get(cacheKey);
    if (freshAt !== undefined && Date.now() - freshAt < 30_000) {
      showTabError(cacheKey);
      markTabSettled(cacheKey, true, true);
      return;
    }
    const requestAccess = { accessKey: activeAccessKey };
    const requestId = requestSequenceRef.current += 1;
    markTabSettled(cacheKey, false);
    showTabError(cacheKey, "");
    try {
      const freshLanding = retainedRef.current.get(`${activeAccessKey}:landing`);
      if (force || freshLanding === undefined || Date.now() - freshLanding >= 30_000) {
        const result = await api.get<BillingLanding>("/billing/landing", currentToken, {
          // The composed endpoint has a 30s provider deadline. Leave room for
          // admission, response headers, and the body before the browser aborts.
          timeoutMs: 35_000,
        });
        if (!isCurrentRequest(requestId, requestAccess)) return;
        setLanding(result);
        setPlatformBilling(result.platform_status ?? null);
        setBillingSystemStatus(result.system_status ?? null);
        setPaymentAccount(result.system_status?.payment_account ?? result.payment_account ?? null);
        setPaymentCohortSummary(result.aggregates?.payment_cohort ?? null);
        setLoadedAccessKey(requestAccess.accessKey);
        if (result.financial_access !== "available") {
          clearFinancialData();
          errorsRef.current.set(`${activeAccessKey}:landing`, result.financial_access === "subscription_required"
            ? "Koaryu Core subscription is required for financial data. Account status and recovery remain available."
            : result.errors.join(" ") || "Financial totals are unavailable.");
          showTabError(cacheKey);
          return;
        }
        retainedRef.current.set(`${activeAccessKey}:landing`, Date.now());
        errorsRef.current.set(`${activeAccessKey}:landing`, result.errors.join(" "));
        showTabError(cacheKey);
      }
      const requests: Promise<void>[] = [];
      const load = <T,>(path: string, apply: (value: T) => void) => {
        requests.push(api.get<T>(path, currentToken).then((value) => {
          if (isCurrentRequest(requestId, requestAccess)) apply(value);
        }));
      };
      if (["plans", "enrollments", "invoices"].includes(activeTab)) load("/billing/plans", setPlans);
      if (["families", "enrollments", "invoices", "reports"].includes(activeTab)) load("/billing/payers", setPayers);
      if (activeTab === "enrollments") {
        load("/billing/enrollments", setEnrollments);
        load("/billing/subscriptions", setSubscriptions);
      }
      if (activeTab === "invoices") {
        load<BillingInvoicePage>("/billing/invoices/page", (page) => { setInvoices(page.items); setInvoiceCursor(page.next_cursor ?? null); });
      }
      if (activeTab === "reports") {
        load<BillingPaymentPage>("/billing/payments/page", (page) => { setPayments(page.items); setPaymentCursor(page.next_cursor ?? null); });
      }
      const results = await Promise.allSettled(requests);
      if (!isCurrentRequest(requestId, requestAccess)) return;
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      retainedRef.current.set(cacheKey, Date.now());
      markTabSettled(cacheKey, true, true);
      setLoadedAccessKey(requestAccess.accessKey);
    } catch (err) {
      if (!isCurrentRequest(requestId, requestAccess)) return;
      if (isSubscriptionRequiredError(err)) {
        resetBillingData();
        onSubscriptionRequired();
        return;
      }
      showTabError(cacheKey, err instanceof Error ? err.message : "Billing could not be loaded.");
    } finally {
      if (isCurrentRequest(requestId, requestAccess)) {
        markTabSettled(cacheKey, true);
      }
    }
  }, [activeAccessKey, activeTab, clearFinancialData, isCurrentRequest, markTabSettled, onSubscriptionRequired, resetBillingData, showTabError]);
  const refreshBilling = useCallback(() => loadBilling(true), [loadBilling]);
  const ensureBilling = useCallback(() => loadBilling(false), [loadBilling]);

  const loadMoreHistory = useCallback(async () => {
    const currentToken = tokenRef.current;
    if (!activeAccessKey || !currentToken || loadMoreInFlightRef.current) return;
    const operation = Symbol("history-page");
    loadMoreInFlightRef.current = operation;
    const requestId = requestSequenceRef.current;
    const cacheKey = `${activeAccessKey}:${activeTab}`;
    showTabError(cacheKey, "");
    setIsLoadingMore(true);
    try {
      const results = await Promise.allSettled([
        activeTab === "invoices" && invoiceCursor ? api.get<BillingInvoicePage>(`/billing/invoices/page?cursor=${encodeURIComponent(invoiceCursor)}`, currentToken).then(page => {
          if (!isCurrentRequest(requestId, { accessKey: activeAccessKey })) return;
          setInvoices(current => [...current, ...page.items]);
          setInvoiceCursor(page.next_cursor ?? null);
        }) : Promise.resolve(),
        activeTab === "reports" && paymentCursor ? api.get<BillingPaymentPage>(`/billing/payments/page?cursor=${encodeURIComponent(paymentCursor)}`, currentToken).then(page => {
          if (!isCurrentRequest(requestId, { accessKey: activeAccessKey })) return;
          setPayments(current => [...current, ...page.items]);
          setPaymentCursor(page.next_cursor ?? null);
        }) : Promise.resolve(),
      ]);
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } catch (err) {
      if (isCurrentRequest(requestId, { accessKey: activeAccessKey })) showTabError(cacheKey, err instanceof Error ? err.message : "Older billing history is unavailable.");
    } finally {
      if (loadMoreInFlightRef.current === operation) loadMoreInFlightRef.current = null;
      if (isCurrentRequest(requestId, { accessKey: activeAccessKey })) setIsLoadingMore(false);
    }
  }, [activeAccessKey, activeTab, invoiceCursor, paymentCursor, isCurrentRequest, showTabError]);

  const refreshConnectStatus = useCallback(async ({ sync = false }: { sync?: boolean } = {}) => {
    if (!activeAccessKey || !token) {
      resetBillingData();
      return;
    }
    const cacheKey = `${activeAccessKey}:${activeTab}`;
    const requestAccess = { accessKey: activeAccessKey };
    const requestId = requestSequenceRef.current += 1;
    markTabSettled(cacheKey, false);
    showTabError(cacheKey, "");
    try {
      const account = sync
        ? await api.post<StudioPaymentAccount>("/billing/connect/sync", {}, token, { timeoutMs: 30000 })
        : await api.get<StudioPaymentAccount>("/billing/connect/status", token);
      if (!isCurrentRequest(requestId, requestAccess)) {
        return;
      }
      setPaymentAccount(account);
      if (sync) {
        setMessage("Stripe account status refreshed. Review every requirement before enabling payments.");
      }
      await refreshBilling();
    } catch (err) {
      if (!isCurrentRequest(requestId, requestAccess)) {
        return;
      }
      if (isSubscriptionRequiredError(err)) {
        resetBillingData();
        onSubscriptionRequired();
        return;
      }
      showTabError(cacheKey, err instanceof Error ? err.message : "Stripe Connect status could not be loaded.");
    } finally {
      if (isCurrentRequest(requestId, requestAccess)) {
        markTabSettled(cacheKey, true);
      }
    }
  }, [
    activeAccessKey,
    activeTab,
    markTabSettled,
    isCurrentRequest,
    onSubscriptionRequired,
    refreshBilling,
    resetBillingData,
    showTabError,
    setMessage,
    token,
  ]);

  const hasVisibleBillingData = activeAccessKey !== null && loadedAccessKey === activeAccessKey;
  const activeTabHasSettled = activeAccessKey !== null
    && (settledTabs.has(`${activeAccessKey}:${activeTab}`) || settledAttemptKey === `${activeAccessKey}:${activeTab}`);

  return {
    billingSystemStatus: hasVisibleBillingData ? billingSystemStatus : null,
    enrollments: hasVisibleBillingData ? enrollments : [],
    exportJobs: hasVisibleBillingData ? exportJobs : [],
    hasBillingLoadSettled: isPreviewMode || (activeAccessKey ? activeTabHasSettled : shouldSettleWithoutAccess),
    invoices: hasVisibleBillingData ? invoices : [],
    isLoading: activeAccessKey ? !activeTabHasSettled : false,
    payers: hasVisibleBillingData ? payers : [],
    paymentAccount: hasVisibleBillingData ? paymentAccount : null,
    paymentCohortSummary: hasVisibleBillingData ? paymentCohortSummary : null,
    payments: hasVisibleBillingData ? payments : [],
    plans: hasVisibleBillingData ? plans : [],
    platformBilling: hasVisibleBillingData ? platformBilling : null,
    ensureBilling,
    loadMoreHistory,
    hasMoreHistory: hasVisibleBillingData && Boolean(
      (activeTab === "invoices" && invoiceCursor) || (activeTab === "reports" && paymentCursor)
    ),
    isLoadingMore,
    landing: hasVisibleBillingData ? landing : null,
    refreshBilling,
    refreshConnectStatus,
    setExportJobs,
    subscriptions: hasVisibleBillingData ? subscriptions : [],
  };
}

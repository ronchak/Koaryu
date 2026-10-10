"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError, isSubscriptionRequiredError } from "@/lib/api";
import { useRetainedState } from "@/lib/retained-state";
import {
  isMatchingRefundPayment,
  type RefundIdentity,
  type RefundPaymentRefreshResult,
} from "@/lib/billing-refund-model";
import type {
  BillingEnrollmentPage,
  BillingInvoicePage,
  BillingLanding,
  BillingPaymentPage,
} from "@/lib/billing-landing";
import type { BillingTab } from "@/lib/billing-page-state";
import type {
  BillingInvoice,
  BillingPayment,
  BillingPaymentCohortSummary,
  BillingPayer,
  BillingPlan,
  BillingSystemStatus,
  PlatformBillingStatus,
  StudentBillingEnrollment,
  StudioPaymentAccount,
} from "@/types";

type UseBillingDataControllerOptions = {
  canManageKoaryuSubscription: boolean;
  identityKey: string | null;
  identity: RefundIdentity | null;
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
  identity,
  activeTab,
  canViewStudioBilling,
  isPreviewMode,
  onSubscriptionRequired,
  setError,
  setMessage,
  shouldSettleEarly,
  token,
}: UseBillingDataControllerOptions) {
  const activeAccessKey =
    token && canViewStudioBilling && !shouldSettleEarly
      ? identityKey
        ? `${identityKey}:${canManageKoaryuSubscription ? "subscription-admin" : "studio-billing"}`
        : null
      : null;
  const retainedKey = activeAccessKey ? `billing:${activeAccessKey}` : null;
  const [landing, setLanding] = useRetainedState<BillingLanding | null>(
    retainedKey && `${retainedKey}:landing`,
    null,
  );
  const tokenRef = useRef(token);
  const activeTabRef = useRef(activeTab);
  const [tabCache, setTabCache] = useRetainedState<ReadonlyMap<string, number>>(
    retainedKey && `${retainedKey}:tab-cache`,
    () => new Map(),
  );
  const retainedRef = useRef(tabCache);
  const updateTabCache = useCallback(
    (update: (cache: Map<string, number>) => void) => {
      const next = new Map(retainedRef.current);
      update(next);
      retainedRef.current = next;
      setTabCache(next);
    },
    [setTabCache],
  );
  const errorsRef = useRef(new Map<string, string>());
  const dataScopeRef = useRef(activeAccessKey);
  const paymentReadRevisionRef = useRef(0);
  // Retained status is presentation only; verify capabilities again on each mount.
  const verifiedAccessKeyRef = useRef<string | null>(null);
  const [verifiedBillingStatus, setVerifiedBillingStatus] = useState<{
    accessKey: string;
    status: BillingSystemStatus | null;
  } | null>(null);
  const [verificationScope, setVerificationScope] = useState(activeAccessKey);
  if (verificationScope !== activeAccessKey) {
    setVerificationScope(activeAccessKey);
    setVerifiedBillingStatus(null);
  }
  const [platformBilling, setPlatformBilling] = useRetainedState<PlatformBillingStatus | null>(
    retainedKey && `${retainedKey}:platformBilling`,
    null,
  );
  const [billingSystemStatus, setBillingSystemStatus] =
    useRetainedState<BillingSystemStatus | null>(
      retainedKey && `${retainedKey}:billingSystemStatus`,
      null,
    );
  const [paymentAccount, setPaymentAccount] = useRetainedState<StudioPaymentAccount | null>(
    retainedKey && `${retainedKey}:paymentAccount`,
    null,
  );
  const [plans, setPlans] = useRetainedState<BillingPlan[]>(
    retainedKey && `${retainedKey}:plans`,
    [],
  );
  const [payers, setPayers] = useRetainedState<BillingPayer[]>(
    retainedKey && `${retainedKey}:payers`,
    [],
  );
  const [enrollments, setEnrollments] = useRetainedState<StudentBillingEnrollment[]>(
    retainedKey && `${retainedKey}:enrollments`,
    [],
  );
  const [enrollmentCursor, setEnrollmentCursor] = useRetainedState<string | null>(
    retainedKey && `${retainedKey}:enrollmentCursor`,
    null,
  );
  const [invoiceCursor, setInvoiceCursor] = useRetainedState<string | null>(
    retainedKey && `${retainedKey}:invoiceCursor`,
    null,
  );
  const [paymentCursor, setPaymentCursor] = useRetainedState<string | null>(
    retainedKey && `${retainedKey}:paymentCursor`,
    null,
  );
  const loadMoreInFlightRef = useRef<symbol | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [invoices, setInvoices] = useRetainedState<BillingInvoice[]>(
    retainedKey && `${retainedKey}:invoices`,
    [],
  );
  const [payments, setPayments] = useRetainedState<BillingPayment[]>(
    retainedKey && `${retainedKey}:payments`,
    [],
  );
  const [paymentCohortSummary, setPaymentCohortSummary] =
    useRetainedState<BillingPaymentCohortSummary | null>(
      retainedKey && `${retainedKey}:paymentCohortSummary`,
      null,
    );
  const [settledTabs, setSettledTabs] = useRetainedState<ReadonlySet<string>>(
    retainedKey && `${retainedKey}:settledTabs`,
    () => new Set(),
  );
  const [settledAttemptKey, setSettledAttemptKey] = useState<string | null>(null);
  const [pendingAttemptKey, setPendingAttemptKey] = useState<string | null>(null);
  const markTabSettled = useCallback(
    (key: string, settled: boolean, retain = false) => {
      setSettledAttemptKey(settled ? key : null);
      setPendingAttemptKey(settled ? null : key);
      if (settled && retain) {
        setSettledTabs((previous) => new Set(previous).add(key));
      }
    },
    [setSettledTabs],
  );
  const [loadedAccessKey, setLoadedAccessKey] = useRetainedState<string | null>(
    retainedKey && `${retainedKey}:loadedAccessKey`,
    null,
  );
  const requestSequenceRef = useRef(0);
  const latestAccessKeyRef = useRef(activeAccessKey);
  const showTabError = useCallback(
    (cacheKey: string, message?: string) => {
      if (message !== undefined) errorsRef.current.set(cacheKey, message);
      setError(
        [errorsRef.current.get(`${activeAccessKey}:landing`), errorsRef.current.get(cacheKey)]
          .filter(Boolean)
          .join(" "),
      );
    },
    [activeAccessKey, setError],
  );

  const shouldSettleWithoutAccess = !token || shouldSettleEarly;
  const clearFinancialData = useCallback(() => {
    paymentReadRevisionRef.current += 1;
    setPlans([]);
    setPayers([]);
    setEnrollments([]);
    setEnrollmentCursor(null);
    setInvoices([]);
    setPayments([]);
    setInvoiceCursor(null);
    setPaymentCursor(null);
    setPaymentCohortSummary(null);
    setIsLoadingMore(false);
    loadMoreInFlightRef.current = null;
    updateTabCache((cache) => cache.clear());
    errorsRef.current.clear();
    setSettledTabs(new Set());
    setSettledAttemptKey(null);
    setPendingAttemptKey(null);
  }, [
    setEnrollmentCursor,
    setEnrollments,
    setInvoiceCursor,
    setInvoices,
    setPayers,
    setPaymentCohortSummary,
    setPaymentCursor,
    setPayments,
    setPlans,
    setSettledTabs,
    updateTabCache,
  ]);
  const resetBillingData = useCallback(() => {
    clearFinancialData();
    setLanding(null);
    setPlatformBilling(null);
    setBillingSystemStatus(null);
    setVerifiedBillingStatus(null);
    verifiedAccessKeyRef.current = null;
    setPaymentAccount(null);
    setLoadedAccessKey(null);
    setError("");
  }, [
    clearFinancialData,
    setError,
    setBillingSystemStatus,
    setLanding,
    setLoadedAccessKey,
    setPaymentAccount,
    setPlatformBilling,
  ]);

  const isCurrentRequest = useCallback((requestId: number, access: BillingAccessSnapshot) => {
    return (
      requestSequenceRef.current === requestId && latestAccessKeyRef.current === access.accessKey
    );
  }, []);

  useLayoutEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useLayoutEffect(() => {
    requestSequenceRef.current += 1;
    errorsRef.current.clear();
    setError("");
    latestAccessKeyRef.current = activeAccessKey;
    verifiedAccessKeyRef.current = null;
    return () => {
      requestSequenceRef.current += 1;
      paymentReadRevisionRef.current += 1;
    };
  }, [activeAccessKey, setError]);

  useLayoutEffect(() => {
    retainedRef.current = tabCache;
  }, [tabCache]);

  useLayoutEffect(() => {
    requestSequenceRef.current += 1;
    activeTabRef.current = activeTab;
  }, [activeTab]);

  const loadBilling = useCallback(
    async (force: boolean) => {
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
        updateTabCache((cache) => cache.clear());
        errorsRef.current.clear();
      }
      const cacheKey = `${activeAccessKey}:${activeTab}`;
      const freshAt = retainedRef.current.get(cacheKey);
      const tabIsFresh = freshAt !== undefined && Date.now() - freshAt < 30_000;
      if (tabIsFresh && verifiedAccessKeyRef.current === activeAccessKey) {
        showTabError(cacheKey);
        markTabSettled(cacheKey, true, true);
        return;
      }
      const requestAccess = { accessKey: activeAccessKey };
      const requestId = (requestSequenceRef.current += 1);
      const paymentRevision = paymentReadRevisionRef.current;
      markTabSettled(cacheKey, false);
      showTabError(cacheKey, "");
      try {
        const freshLanding = retainedRef.current.get(`${activeAccessKey}:landing`);
        if (
          force ||
          verifiedAccessKeyRef.current !== activeAccessKey ||
          freshLanding === undefined ||
          Date.now() - freshLanding >= 30_000
        ) {
          const result = await api.get<BillingLanding>("/billing/landing", currentToken, {
            // The composed endpoint has a 30s provider deadline. Leave room for
            // admission, response headers, and the body before the browser aborts.
            timeoutMs: 35_000,
          });
          if (!isCurrentRequest(requestId, requestAccess)) return;
          setLanding(result);
          setPlatformBilling(result.platform_status ?? null);
          setBillingSystemStatus(result.system_status ?? null);
          setVerifiedBillingStatus({
            accessKey: requestAccess.accessKey,
            status: result.system_status ?? null,
          });
          verifiedAccessKeyRef.current = requestAccess.accessKey;
          setPaymentAccount(
            result.system_status?.payment_account ?? result.payment_account ?? null,
          );
          if (paymentReadRevisionRef.current === paymentRevision)
            setPaymentCohortSummary(result.aggregates?.payment_cohort ?? null);
          setLoadedAccessKey(requestAccess.accessKey);
          if (result.financial_access !== "available") {
            clearFinancialData();
            errorsRef.current.set(
              `${activeAccessKey}:landing`,
              result.financial_access === "subscription_required"
                ? "Koaryu Core subscription is required for financial data. Account status and recovery remain available."
                : result.errors.join(" ") || "Financial totals are unavailable.",
            );
            showTabError(cacheKey);
            return;
          }
          if (paymentReadRevisionRef.current === paymentRevision)
            updateTabCache((cache) => cache.set(`${activeAccessKey}:landing`, Date.now()));
          errorsRef.current.set(`${activeAccessKey}:landing`, result.errors.join(" "));
          showTabError(cacheKey);
        }
        // A revisit verifies access even while its fresh financial tab stays visible.
        if (tabIsFresh && !force) {
          markTabSettled(cacheKey, true, true);
          return;
        }
        const requests: Promise<void>[] = [];
        const load = <T>(path: string, apply: (value: T) => void) => {
          requests.push(
            api.get<T>(path, currentToken).then((value) => {
              if (isCurrentRequest(requestId, requestAccess)) apply(value);
            }),
          );
        };
        if (["plans", "enrollments", "invoices"].includes(activeTab))
          load("/billing/plans", setPlans);
        if (["families", "enrollments", "invoices", "reports"].includes(activeTab))
          load("/billing/payers", setPayers);
        // Enrollments are paged so none are silently cut off. Live subscription totals
        // come from the landing aggregates, so the capped subscription list is not read.
        if (activeTab === "enrollments") {
          load<BillingEnrollmentPage>("/billing/enrollments/page", (page) => {
            setEnrollments(page.items);
            setEnrollmentCursor(page.next_cursor ?? null);
          });
        }
        if (activeTab === "invoices") {
          load<BillingInvoicePage>("/billing/invoices/page", (page) => {
            setInvoices(page.items);
            setInvoiceCursor(page.next_cursor ?? null);
          });
        }
        if (activeTab === "reports") {
          load<BillingPaymentPage>("/billing/payments/page", (page) => {
            if (paymentReadRevisionRef.current !== paymentRevision) return;
            setPayments(page.items);
            setPaymentCursor(page.next_cursor ?? null);
          });
        }
        const results = await Promise.allSettled(requests);
        if (!isCurrentRequest(requestId, requestAccess)) return;
        if (activeTab === "reports" && paymentReadRevisionRef.current !== paymentRevision) return;
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        updateTabCache((cache) => cache.set(cacheKey, Date.now()));
        markTabSettled(cacheKey, true, true);
        setLoadedAccessKey(requestAccess.accessKey);
      } catch (err) {
        if (!isCurrentRequest(requestId, requestAccess)) return;
        if (isSubscriptionRequiredError(err)) {
          resetBillingData();
          onSubscriptionRequired();
          return;
        }
        if (activeTab === "reports" && paymentReadRevisionRef.current !== paymentRevision) return;
        showTabError(cacheKey, err instanceof Error ? err.message : "Billing could not be loaded.");
      } finally {
        if (isCurrentRequest(requestId, requestAccess)) {
          markTabSettled(cacheKey, true);
        }
      }
    },
    [
      activeAccessKey,
      activeTab,
      clearFinancialData,
      isCurrentRequest,
      markTabSettled,
      onSubscriptionRequired,
      resetBillingData,
      showTabError,
      setBillingSystemStatus,
      setEnrollmentCursor,
      setEnrollments,
      setInvoiceCursor,
      setInvoices,
      setLanding,
      setLoadedAccessKey,
      setPayers,
      setPaymentAccount,
      setPaymentCohortSummary,
      setPaymentCursor,
      setPayments,
      setPlans,
      setPlatformBilling,
      updateTabCache,
    ],
  );
  const refreshBilling = useCallback(() => loadBilling(true), [loadBilling]);
  const ensureBilling = useCallback(() => loadBilling(false), [loadBilling]);

  const loadMoreHistory = useCallback(async () => {
    const currentToken = tokenRef.current;
    if (!activeAccessKey || !currentToken || loadMoreInFlightRef.current) return;
    const operation = Symbol("history-page");
    loadMoreInFlightRef.current = operation;
    const requestId = requestSequenceRef.current;
    const paymentRevision = paymentReadRevisionRef.current;
    const cacheKey = `${activeAccessKey}:${activeTab}`;
    showTabError(cacheKey, "");
    setIsLoadingMore(true);
    try {
      const results = await Promise.allSettled([
        activeTab === "enrollments" && enrollmentCursor
          ? api
              .get<BillingEnrollmentPage>(
                `/billing/enrollments/page?cursor=${encodeURIComponent(enrollmentCursor)}`,
                currentToken,
              )
              .then((page) => {
                if (!isCurrentRequest(requestId, { accessKey: activeAccessKey })) return;
                setEnrollments((current) => [...current, ...page.items]);
                setEnrollmentCursor(page.next_cursor ?? null);
              })
          : Promise.resolve(),
        activeTab === "invoices" && invoiceCursor
          ? api
              .get<BillingInvoicePage>(
                `/billing/invoices/page?cursor=${encodeURIComponent(invoiceCursor)}`,
                currentToken,
              )
              .then((page) => {
                if (!isCurrentRequest(requestId, { accessKey: activeAccessKey })) return;
                setInvoices((current) => [...current, ...page.items]);
                setInvoiceCursor(page.next_cursor ?? null);
              })
          : Promise.resolve(),
        activeTab === "reports" && paymentCursor
          ? api
              .get<BillingPaymentPage>(
                `/billing/payments/page?cursor=${encodeURIComponent(paymentCursor)}`,
                currentToken,
              )
              .then((page) => {
                if (
                  !isCurrentRequest(requestId, { accessKey: activeAccessKey }) ||
                  paymentReadRevisionRef.current !== paymentRevision
                )
                  return;
                setPayments((current) => [...current, ...page.items]);
                setPaymentCursor(page.next_cursor ?? null);
              })
          : Promise.resolve(),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } catch (err) {
      if (
        isCurrentRequest(requestId, { accessKey: activeAccessKey }) &&
        (activeTab !== "reports" || paymentReadRevisionRef.current === paymentRevision)
      )
        showTabError(
          cacheKey,
          err instanceof Error ? err.message : "Older billing history is unavailable.",
        );
    } finally {
      if (loadMoreInFlightRef.current === operation) loadMoreInFlightRef.current = null;
      if (isCurrentRequest(requestId, { accessKey: activeAccessKey })) setIsLoadingMore(false);
    }
  }, [
    activeAccessKey,
    activeTab,
    enrollmentCursor,
    invoiceCursor,
    paymentCursor,
    isCurrentRequest,
    showTabError,
    setEnrollmentCursor,
    setEnrollments,
    setInvoiceCursor,
    setInvoices,
    setPaymentCursor,
    setPayments,
  ]);

  const identityUserId = identity?.userId;
  const identityStudioId = identity?.studioId;
  const refreshPaymentAfterRefund = useCallback(
    async (
      original: BillingPayment,
      expected: RefundIdentity,
    ): Promise<RefundPaymentRefreshResult> => {
      const currentToken = tokenRef.current;
      if (
        !activeAccessKey ||
        latestAccessKeyRef.current !== activeAccessKey ||
        !currentToken ||
        identityUserId !== expected.userId ||
        identityStudioId !== expected.studioId
      )
        return { status: "superseded" };
      const invalidatePaymentReads = () => {
        paymentReadRevisionRef.current += 1;
        updateTabCache((cache) => {
          cache.delete(`${activeAccessKey}:reports`);
          cache.delete(`${activeAccessKey}:landing`);
        });
        setPaymentCohortSummary(null);
      };
      invalidatePaymentReads();
      const revision = paymentReadRevisionRef.current;
      const current = () =>
        latestAccessKeyRef.current === activeAccessKey &&
        paymentReadRevisionRef.current === revision;
      const loseFinancialAccess = (err: unknown) => {
        // A denied read invalidates every older financial read, not only payment pages.
        requestSequenceRef.current += 1;
        resetBillingData();
        markTabSettled(`${activeAccessKey}:${activeTabRef.current}`, true);
        if (isSubscriptionRequiredError(err)) onSubscriptionRequired();
        else
          setError(
            "Billing access could not be verified. Reload this page before taking another action.",
          );
      };
      try {
        const path = `/billing/payments/${encodeURIComponent(original.id)}`;
        let payment: unknown;
        try {
          payment = await api.get<unknown>(path, currentToken);
        } catch (err) {
          const renewedToken = tokenRef.current;
          if (!current()) return { status: "superseded" };
          if (
            !(err instanceof ApiError) ||
            err.status !== 401 ||
            !renewedToken ||
            renewedToken === currentToken
          )
            throw err;
          payment = await api.get<unknown>(path, renewedToken);
        }
        if (!current()) return { status: "superseded" };
        if (!isMatchingRefundPayment(payment, original, expected)) return { status: "unavailable" };
        // Reads started before or during this refresh cannot overwrite its confirmed balance.
        invalidatePaymentReads();
        setPayments((rows) => rows.map((row) => (row.id === payment.id ? payment : row)));
        const committedRevision = paymentReadRevisionRef.current;
        const cohortToken = tokenRef.current ?? currentToken;
        // Cohort totals have their own read; failure cannot undo the target payment proof.
        void api
          .get<BillingPaymentCohortSummary>("/billing/payments/current-month-cohort", cohortToken)
          .then((summary) => {
            if (
              latestAccessKeyRef.current === activeAccessKey &&
              paymentReadRevisionRef.current === committedRevision
            )
              setPaymentCohortSummary(summary);
          })
          .catch((err) => {
            if (
              latestAccessKeyRef.current !== activeAccessKey ||
              paymentReadRevisionRef.current !== committedRevision
            )
              return;
            if (isSubscriptionRequiredError(err)) loseFinancialAccess(err);
            else if (
              err instanceof ApiError &&
              (err.status === 403 || (err.status === 401 && tokenRef.current === cohortToken))
            ) {
              loseFinancialAccess(err);
            }
          });
        return { status: "updated", payment };
      } catch (err) {
        if (!current()) return { status: "superseded" };
        if (isSubscriptionRequiredError(err)) {
          loseFinancialAccess(err);
          return { status: "access_lost" };
        }
        if (err instanceof ApiError && [401, 403].includes(err.status)) {
          loseFinancialAccess(err);
          return { status: "access_lost" };
        }
        return { status: "unavailable" };
      }
    },
    [
      activeAccessKey,
      identityStudioId,
      identityUserId,
      markTabSettled,
      onSubscriptionRequired,
      resetBillingData,
      setError,
      setPaymentCohortSummary,
      setPayments,
      updateTabCache,
    ],
  );

  const refreshConnectStatus = useCallback(
    async ({ sync = false }: { sync?: boolean } = {}) => {
      if (!activeAccessKey || !token) {
        resetBillingData();
        return;
      }
      const cacheKey = `${activeAccessKey}:${activeTab}`;
      const requestAccess = { accessKey: activeAccessKey };
      const requestId = (requestSequenceRef.current += 1);
      markTabSettled(cacheKey, false);
      showTabError(cacheKey, "");
      try {
        const account = sync
          ? await api.post<StudioPaymentAccount>("/billing/connect/sync", {}, token, {
              timeoutMs: 35000,
            })
          : await api.get<StudioPaymentAccount>("/billing/connect/status", token);
        if (!isCurrentRequest(requestId, requestAccess)) {
          return;
        }
        setPaymentAccount(account);
        if (sync) {
          setMessage(
            "Stripe account status refreshed. Review every requirement before enabling payments.",
          );
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
        showTabError(
          cacheKey,
          err instanceof Error ? err.message : "Stripe Connect status could not be loaded.",
        );
      } finally {
        if (isCurrentRequest(requestId, requestAccess)) {
          markTabSettled(cacheKey, true);
        }
      }
    },
    [
      activeAccessKey,
      activeTab,
      markTabSettled,
      isCurrentRequest,
      onSubscriptionRequired,
      refreshBilling,
      resetBillingData,
      showTabError,
      setMessage,
      setPaymentAccount,
      token,
    ],
  );

  const hasVisibleBillingData = activeAccessKey !== null && loadedAccessKey === activeAccessKey;
  const activeTabHasSettled =
    activeAccessKey !== null &&
    (settledTabs.has(`${activeAccessKey}:${activeTab}`) ||
      settledAttemptKey === `${activeAccessKey}:${activeTab}`);

  return {
    billingSystemStatus: hasVisibleBillingData ? billingSystemStatus : null,
    verifiedBillingSystemStatus:
      activeAccessKey && verifiedBillingStatus?.accessKey === activeAccessKey
        ? verifiedBillingStatus.status
        : null,
    enrollments: hasVisibleBillingData ? enrollments : [],
    hasVisibleTabData: hasVisibleBillingData && settledTabs.has(`${activeAccessKey}:${activeTab}`),
    hasBillingLoadSettled:
      isPreviewMode || (activeAccessKey ? activeTabHasSettled : shouldSettleWithoutAccess),
    invoices: hasVisibleBillingData ? invoices : [],
    isLoading: activeAccessKey
      ? pendingAttemptKey === `${activeAccessKey}:${activeTab}` || !activeTabHasSettled
      : false,
    payers: hasVisibleBillingData ? payers : [],
    paymentAccount: hasVisibleBillingData ? paymentAccount : null,
    paymentCohortSummary: hasVisibleBillingData ? paymentCohortSummary : null,
    payments: hasVisibleBillingData ? payments : [],
    plans: hasVisibleBillingData ? plans : [],
    platformBilling: hasVisibleBillingData ? platformBilling : null,
    ensureBilling,
    loadMoreHistory,
    hasMoreHistory:
      hasVisibleBillingData &&
      Boolean(
        (activeTab === "enrollments" && enrollmentCursor) ||
        (activeTab === "invoices" && invoiceCursor) ||
        (activeTab === "reports" && paymentCursor),
      ),
    isLoadingMore,
    landing: hasVisibleBillingData ? landing : null,
    refreshBilling,
    refreshPaymentAfterRefund,
    refreshConnectStatus,
  };
}

"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";

type BillingActionRequestOptions = {
  headers?: Record<string, string>;
  networkErrorMessage?: string;
  omitStudioHeader?: boolean;
  signal?: AbortSignal;
  timeoutMessage?: string;
  timeoutMs?: number | null;
};

type BillingActionRuntimeOptions = {
  isPreviewMode: boolean;
  refreshBilling: () => Promise<void>;
  setError: (message: string) => void;
  setMessage: (message: string) => void;
  token: string | null;
};

type PostBillingActionOptions = {
  action?: string;
  body?: Record<string, unknown>;
  errorMessage?: string;
  path: string;
  refresh?: boolean;
  requestOptions?: BillingActionRequestOptions;
  successMessage: string;
};

export function useBillingActionRuntime({
  isPreviewMode,
  refreshBilling,
  setError,
  setMessage,
  token,
}: BillingActionRuntimeOptions) {
  const [activeAction, setActiveActionState] = useState<string | null>(null);
  const activeActionRef = useRef<string | null>(null);

  function setActiveAction(action: string | null) {
    activeActionRef.current = action;
    setActiveActionState(action);
  }

  function claimAction(action: string) {
    if (activeActionRef.current) {
      return false;
    }
    activeActionRef.current = action;
    setActiveActionState(action);
    setError("");
    setMessage("");
    return true;
  }

  function releaseAction(action: string) {
    if (activeActionRef.current === action) {
      setActiveAction(null);
    }
  }

  async function postBillingAction<T>({
    action = "billing-action",
    body = {},
    errorMessage = "Billing action could not be completed.",
    path,
    refresh = true,
    requestOptions,
    successMessage,
  }: PostBillingActionOptions) {
    if (isPreviewMode) {
      setMessage(successMessage);
      return null;
    }
    if (!token || !claimAction(action)) {
      return null;
    }
    try {
      const result = await api.post<T>(path, body, token, requestOptions);
      setMessage(successMessage);
      if (refresh) {
        await refreshBilling();
      }
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : errorMessage);
      return null;
    } finally {
      releaseAction(action);
    }
  }

  return {
    activeAction,
    claimAction,
    isActionLoading: activeAction !== null,
    isLoadingAction: (action: string) => activeAction === action,
    isPreviewMode,
    postBillingAction,
    refreshBilling,
    releaseAction,
    setActiveAction,
    setError,
    setMessage,
    token,
  };
}

export type BillingActionRuntime = ReturnType<typeof useBillingActionRuntime>;

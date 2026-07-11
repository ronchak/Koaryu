export type BillingLoadingState = {
  isPreviewMode: boolean;
  hasPaymentAccount: boolean;
  isLoading: boolean;
  hasBillingLoadSettled: boolean;
  error: string;
};

export function getBillingInitialLoadAction(search: string): "connect-return" | "billing" {
  return new URLSearchParams(search).get("connect") === "return"
    ? "connect-return"
    : "billing";
}

export function resolveBillingAuxiliaryReadiness({
  activeTab,
  initialLoadAction,
  programsLoadError,
  programsLoaded,
  studentsLoadError,
  studentsLoaded,
  studentsMayBePartial,
}: {
  activeTab: "overview" | "plans" | "families" | "enrollments" | "invoices" | "reports";
  initialLoadAction: "connect-return" | "billing";
  programsLoadError: string | null;
  programsLoaded: boolean;
  studentsLoadError: string | null;
  studentsLoaded: boolean;
  studentsMayBePartial: boolean;
}) {
  if (initialLoadAction === "connect-return") {
    return { error: null, status: "ready" as const };
  }
  const requiredDatasets: ReturnType<typeof loadedDataset>[] = [];
  if (activeTab === "plans") {
    requiredDatasets.push(
      loadedDataset({ error: programsLoadError, label: "Programs", loaded: programsLoaded })
    );
  }
  if (["overview", "enrollments", "invoices"].includes(activeTab)) {
    requiredDatasets.push(loadedDataset({
      error: studentsLoadError,
      label: "Student roster",
      loaded: studentsLoaded && !studentsMayBePartial,
    }));
  }
  return resolvePageDatasetReadiness(requiredDatasets);
}

export function shouldSettleBillingLoadEarly({
  isPreviewMode,
  hasKnownRestrictedRole,
}: {
  isPreviewMode: boolean;
  hasKnownRestrictedRole: boolean;
}) {
  return isPreviewMode || hasKnownRestrictedRole;
}

export function shouldShowBillingLoading({
  isPreviewMode,
  hasPaymentAccount,
  isLoading,
  hasBillingLoadSettled,
  error,
}: BillingLoadingState) {
  if (isPreviewMode || hasPaymentAccount || error.trim().length > 0) {
    return false;
  }

  return isLoading || !hasBillingLoadSettled;
}
import { loadedDataset, resolvePageDatasetReadiness } from "./page-dataset-readiness.ts";

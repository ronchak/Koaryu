export type BillingLoadingState = {
  isPreviewMode: boolean;
  isStudioBootstrapSettled: boolean;
  hasPaymentAccount: boolean;
  isLoading: boolean;
  hasBillingLoadSettled: boolean;
  error: string;
};

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
  isStudioBootstrapSettled,
  hasPaymentAccount,
  isLoading,
  hasBillingLoadSettled,
  error,
}: BillingLoadingState) {
  if (isPreviewMode || hasPaymentAccount || error.trim().length > 0) {
    return false;
  }

  if (!isStudioBootstrapSettled) {
    return true;
  }

  return isLoading || !hasBillingLoadSettled;
}

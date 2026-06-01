export type BillingLoadingState = {
  isPreviewMode: boolean;
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

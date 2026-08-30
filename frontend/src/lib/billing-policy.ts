import type { PlatformBillingStatus, StaffRoleName } from "@/types";

export type BillingProviderMode = "test" | "live" | null | undefined;

export type BillingProviderCopy = {
  boundary: string;
  coreSubscription: string;
  connectOnboarding: string;
  connectPayments: string;
};

export function canManageRoutineBilling(
  role: StaffRoleName | null | undefined
): boolean {
  return role === "admin" || role === "front_desk";
}

export function areProviderMutationsEnabled(
  isPreviewMode: boolean,
  serverCapability = false
): boolean {
  return isPreviewMode || serverCapability;
}

export function resolveBillingProviderActionCapabilities({
  enabledWorkflowIds,
  isPreviewMode,
  role,
}: {
  enabledWorkflowIds: ReadonlySet<string>;
  isPreviewMode: boolean;
  role: StaffRoleName | null | undefined;
}) {
  const enabled = (workflowId: string) => role === "admin"
    && areProviderMutationsEnabled(isPreviewMode, enabledWorkflowIds.has(workflowId));
  return {
    connectDashboardEnabled: enabled("connect.dashboard"),
    connectOnboardingEnabled: enabled("connect.onboarding"),
    coreCheckoutEnabled: enabled("core.subscription.checkout"),
    corePortalEnabled: enabled("core.subscription.portal"),
  };
}

export function canStartCoreCheckout(
  billingPlatform: Pick<PlatformBillingStatus, "can_start_checkout"> | null
): boolean {
  return billingPlatform?.can_start_checkout === true;
}

function scopedCopy(
  mode: BillingProviderMode,
  label: string,
  permitted: boolean
): string {
  if (!mode) {
    return `${label} is unavailable until provider mode and studio authorization load.`;
  }
  const modeLabel = mode === "live" ? "Live Stripe" : "Stripe test-mode";
  return permitted
    ? `${modeLabel} ${label.toLowerCase()} is authorized for this studio.`
    : `${modeLabel} ${label.toLowerCase()} is not authorized for this studio.`;
}

export function resolveBillingProviderCopy({
  isPreviewMode,
  providerMode,
  coreSubscription,
  connectOnboarding,
  connectPayments,
}: {
  isPreviewMode: boolean;
  providerMode: BillingProviderMode;
  coreSubscription: boolean;
  connectOnboarding: boolean;
  connectPayments: boolean;
}): BillingProviderCopy {
  if (isPreviewMode) {
    const preview = "Preview mode uses demo-only billing actions and does not change provider state.";
    return {
      boundary: preview,
      coreSubscription: preview,
      connectOnboarding: preview,
      connectPayments: preview,
    };
  }
  const coreCopy = scopedCopy(providerMode, "Koaryu Core mutations", coreSubscription);
  const onboardingCopy = scopedCopy(providerMode, "Connect onboarding", connectOnboarding);
  const paymentsCopy = scopedCopy(providerMode, "Connect payment mutations", connectPayments);
  return {
    boundary: `${coreCopy} ${onboardingCopy} ${paymentsCopy}`,
    coreSubscription: coreCopy,
    connectOnboarding: onboardingCopy,
    connectPayments: paymentsCopy,
  };
}

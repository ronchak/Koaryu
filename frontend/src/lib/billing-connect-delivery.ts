export type ConnectOnboardingPendingLink = {
  pending_url: string;
  delivery_receipt?: string | null;
};

export function createConnectOnboardingRequestKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `connect-onboarding-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function acknowledgeConnectOnboardingBeforeNavigation(
  link: ConnectOnboardingPendingLink,
  acknowledge: (receipt: string) => Promise<void>,
  navigate: (url: string) => void,
) {
  if (!link.pending_url) {
    throw new Error("Stripe onboarding did not return a pending URL.");
  }
  if (link.delivery_receipt) {
    await acknowledge(link.delivery_receipt);
  }
  navigate(link.pending_url);
}

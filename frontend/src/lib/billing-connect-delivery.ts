export type ConnectOnboardingPendingLink = {
  pending_url: string;
  delivery_receipt?: string | null;
};

export type ConnectOnboardingOwner = {
  userId: string;
  studioId: string | null;
};

export function createConnectOnboardingRequestKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `connect-onboarding-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function isSameConnectOnboardingOwner(
  owner: ConnectOnboardingOwner,
  current: ConnectOnboardingOwner | null,
) {
  return current !== null && current.userId === owner.userId && current.studioId === owner.studioId;
}

// Route-level owner: the route must still be mounted for the same user and studio.
export function ownsConnectOnboardingNavigation(
  owner: ConnectOnboardingOwner,
  isMounted: () => boolean,
  readOwner: () => Promise<ConnectOnboardingOwner | null>,
) {
  return async () => {
    if (!isMounted()) {
      return false;
    }
    const current = await readOwner();
    return isMounted() && isSameConnectOnboardingOwner(owner, current);
  };
}

// Action-level owner: leaving, an identity change, or a newer action ends the earlier action.
export function createConnectOnboardingOwnerTracker() {
  let owner: string | null = null;
  let operation: object | null = null;
  return {
    enter(nextOwner: string | null) {
      owner = nextOwner;
      operation = null;
    },
    leave() {
      owner = null;
      operation = null;
    },
    begin() {
      const operationOwner = owner;
      if (operationOwner === null) {
        return null;
      }
      const current = {};
      operation = current;
      return () => owner === operationOwner && operation === current;
    },
  };
}

export async function acknowledgeConnectOnboardingBeforeNavigation(
  link: ConnectOnboardingPendingLink,
  acknowledge: (receipt: string) => Promise<void>,
  navigate: (url: string) => void,
  ownsNavigation: () => boolean | Promise<boolean>,
) {
  if (!link.pending_url) {
    throw new Error("Stripe onboarding did not return a pending URL.");
  }
  if (link.delivery_receipt) {
    await acknowledge(link.delivery_receipt);
  }
  // The acknowledgement stands either way; only a still-current owner may leave for Stripe.
  if (!(await ownsNavigation())) {
    return false;
  }
  navigate(link.pending_url);
  return true;
}

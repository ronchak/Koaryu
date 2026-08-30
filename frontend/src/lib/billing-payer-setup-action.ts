import { clearBillingIdempotencyKeyAfterTerminalError } from "./billing-idempotency-lifecycle.ts";
import {
  buildPayerAutopaySetupRequest,
  clearPersistedPayerSetupAttempt,
  copyPayerAutopaySetupLink,
  getPayerAutopaySetupReturnUrl,
  resolvePersistedPayerSetupRequestKey,
  type PayerOperationIdentity,
  type PayerOperationStorage,
  type PayerSetupAttempt,
  type PayerSetupState,
} from "./billing-payer-setup-model.ts";

type PayerSetupRuntime = {
  canUseWorkflow: (workflowId: string) => boolean;
  claimAction: (action: string) => boolean;
  isPreviewMode: boolean;
  releaseAction: (action: string) => void;
  setError: (message: string) => void;
  setMessage: (message: string) => void;
  token: string | null;
};

type PayerSetupPost = (
  path: string,
  body: unknown,
  token?: string,
  options?: { headers?: Record<string, string> },
) => Promise<{ url: string }>;

export async function executePayerAutopaySetup({
  copyLink = copyPayerAutopaySetupLink,
  createKey,
  attemptsByPayer,
  identity,
  keysByPayer,
  origin,
  payer,
  post,
  runtime,
  storage,
}: {
  copyLink?: typeof copyPayerAutopaySetupLink;
  createKey?: () => string;
  attemptsByPayer: Map<string, PayerSetupAttempt>;
  identity: PayerOperationIdentity | null;
  keysByPayer: Map<string, string>;
  origin: string;
  payer: PayerSetupState & { id: string; updated_at?: string };
  post: PayerSetupPost;
  runtime: PayerSetupRuntime;
  storage?: PayerOperationStorage;
}) {
  const action = `autopay-setup:${payer.id}`;
  if (runtime.isPreviewMode) {
    runtime.setMessage("Stripe autopay setup link created.");
    return null;
  }
  if (!runtime.canUseWorkflow("payer.setup")) {
    runtime.setError("This billing workflow is not available for the current studio and role.");
    return null;
  }
  if (!runtime.token || !runtime.claimAction(action)) return null;
  try {
    const requestKey = resolvePersistedPayerSetupRequestKey({
      attemptsByPayer,
      createKey,
      identity,
      keysByPayer,
      payer,
      storage,
    });
    const request = buildPayerAutopaySetupRequest(
      getPayerAutopaySetupReturnUrl(origin),
      requestKey,
    );
    const link = await post(
      `/billing/payers/${payer.id}/autopay/setup-link`,
      request.body,
      runtime.token,
      { headers: request.headers },
    );
    runtime.setMessage("Stripe autopay setup link created.");
    if (link?.url) {
      const copied = await copyLink(link.url);
      runtime.setMessage(
        copied
          ? "Stripe autopay setup link copied."
          : `Stripe autopay setup link: ${link.url}`,
      );
    }
    return link?.url ?? null;
  } catch (error) {
    let cleanupFailed = false;
    clearBillingIdempotencyKeyAfterTerminalError(error, () => {
      cleanupFailed = !clearPersistedPayerSetupAttempt({
        attemptsByPayer,
        identity,
        keysByPayer,
        payerId: payer.id,
        storage,
      });
    });
    runtime.setError(
      cleanupFailed
        ? "The expired payer setup could not be cleared from this browser. Clear site data or use another browser before creating another setup link."
        : error instanceof Error ? error.message : "Billing action could not be completed.",
    );
    return null;
  } finally {
    runtime.releaseAction(action);
  }
}

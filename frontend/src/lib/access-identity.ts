import type { AuthProfileResponse } from "@/lib/store-bootstrap-model";
import { createClient } from "@/lib/supabase/client";

// Browser-memory authority only. No credentials, downloads, or persisted tasks.
// Equal observations across provider remounts preserve an operation's lifetime.
let identity: string | null = null;
let userId: string | null = null;
let revision = 0;
let active = false;
let scope: { userId: string; studioId: string | null; role: string | null } | null = null;
const listeners = new Set<() => void>();

export function invalidateAccessIdentity() {
  if (typeof window === "undefined") return;
  identity = null;
  userId = null;
  active = false;
  scope = null;
  revision += 1;
  for (const listener of [...listeners]) listener();
}

// Profile-only observations cannot grant subscription access. Only a verified
// workspace may supply accessAllowed; equal profile observations retain it.
export function publishAccessIdentity(profile: AuthProfileResponse, accessAllowed?: boolean) {
  if (typeof window === "undefined") return;
  const next = JSON.stringify([
    profile.user.id,
    profile.studio_id,
    profile.role,
    profile.membership_status,
  ]);
  const nextActive =
    (accessAllowed ?? (next === identity && active)) &&
    profile.membership_status === "active" &&
    Boolean(profile.studio_id && profile.role);
  if (next === identity && nextActive === active) return;
  identity = next;
  userId = profile.user.id;
  scope = {
    userId: profile.user.id,
    studioId: profile.studio_id ?? null,
    role: profile.role ?? null,
  };
  active = nextActive;
  revision += 1;
  for (const listener of [...listeners]) listener();
}

export function captureAccessIdentity(
  expected: { userId: string; studioId: string | null; role: string | null },
  onInvalidated: () => void,
) {
  if (
    !identity ||
    !userId ||
    !active ||
    expected.userId !== scope?.userId ||
    expected.studioId !== scope?.studioId ||
    expected.role !== scope?.role
  )
    throw new Error("Sign in again before exporting CSVs.");
  const capturedRevision = revision;
  const capturedUserId = userId;
  const controller = new AbortController();
  const isCurrent = () => revision === capturedRevision && !controller.signal.aborted;
  const onChange = () => {
    if (isCurrent() || controller.signal.aborted) return;
    controller.abort();
    onInvalidated();
  };
  listeners.add(onChange);
  // This subscription belongs to the operation, not the panel or dashboard layout.
  const { data } = createClient().auth.onAuthStateChange((event, session) => {
    if (!isCurrent()) return;
    if (
      event === "SIGNED_OUT" ||
      event === "USER_UPDATED" ||
      !session ||
      session.user.id !== capturedUserId
    )
      invalidateAccessIdentity();
  });
  return {
    isCurrent,
    signal: controller.signal,
    dispose() {
      listeners.delete(onChange);
      data.subscription.unsubscribe();
    },
  };
}

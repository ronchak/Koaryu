/*
 * Home access shared outside its read. `useHome` orders its reads on this
 * clock; a refusal of another request for the same identity (a preferences
 * save answered 401, 402, 403 or 409) is recorded on it too, so Home hides
 * everything read before the refusal, shown or retained, and re-reads once.
 * No React; a module of its own so `useHome` and the preferences hook share it.
 */

let homeReadOrder = 0;

/** The next position on Home's read clock. */
export function nextHomeReadOrder(): number {
  return ++homeReadOrder;
}

/** The identity a Home read belongs to; a snapshot never serves another. */
export function homeAccessScope(identity: {
  identityGeneration: number;
  userId: string;
  studioId: string;
  role: string;
}): string {
  return `${identity.identityGeneration}:${identity.userId}:${identity.studioId}:${identity.role}`;
}

// Per Home loader (one per StoreProvider) and scope: the latest refusal's order.
const refusals = new WeakMap<object, Map<string, number>>();
const listeners = new Set<() => void>();

/** Another request for this identity was refused: Home must re-verify before showing data. */
export function refuseHomeAccess(loader: object, scope: string): void {
  let byScope = refusals.get(loader);
  if (!byScope) {
    byScope = new Map();
    refusals.set(loader, byScope);
  }
  byScope.set(scope, nextHomeReadOrder());
  for (const listener of [...listeners]) listener();
}

export function latestHomeAccessRefusal(loader: object, scope: string): number {
  return refusals.get(loader)?.get(scope) ?? 0;
}

export function subscribeHomeAccessRefusals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

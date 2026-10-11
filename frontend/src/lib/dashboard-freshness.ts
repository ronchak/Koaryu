const CHANGE_KEY = "koaryu:facts-changed-at";
// Cover an older interactive read finishing late, then its 15-second fact TTL.
const FRESH_AFTER_COMMAND_MS = 60_000;
let changedAt = -Infinity;
const listeners = new Set<() => void>();

export function markDashboardFactsChanged(now = Date.now()) {
  changedAt = now;
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(CHANGE_KEY, String(now));
  } catch {
    /* Local protection still applies. */
  }
  notifyDashboardFactsChanged();
}

export function needsFreshDashboardFacts(now = Date.now()): boolean {
  let shared = -Infinity;
  try {
    const value = typeof window !== "undefined" ? window.localStorage.getItem(CHANGE_KEY) : null;
    if (value !== null && Number.isFinite(Number(value))) shared = Number(value);
  } catch {
    /* Storage is optional. */
  }
  // A future or malformed client timestamp is not authoritative.
  const recent = Math.max(
    changedAt <= now ? changedAt : -Infinity,
    shared <= now ? shared : -Infinity,
  );
  return now - recent < FRESH_AFTER_COMMAND_MS;
}

// The API layer marks facts changed inside its request path, so a listener's
// failure must never fail that request; it is rethrown on its own task instead.
function notifyDashboardFactsChanged() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      setTimeout(() => {
        throw error;
      }, 0);
    }
  }
}

/** Calls `listener` after a fact change in this tab or, through `storage`, in another tab. */
export function subscribeDashboardFactsChanged(listener: () => void): () => void {
  const entry = () => listener();
  listeners.add(entry);
  const onStorage = (event: StorageEvent) => {
    if (event.key === CHANGE_KEY) entry();
  };
  const target = typeof window !== "undefined" ? window : null;
  target?.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(entry);
    target?.removeEventListener("storage", onStorage);
  };
}

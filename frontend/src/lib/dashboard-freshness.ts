const CHANGE_KEY = "koaryu:facts-changed-at";
// Cover an older interactive read finishing late, then its 15-second fact TTL.
const FRESH_AFTER_COMMAND_MS = 60_000;
let changedAt = -Infinity;

export function markDashboardFactsChanged(now = Date.now()) {
  changedAt = now;
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(CHANGE_KEY, String(now));
  } catch {
    /* Local protection still applies. */
  }
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

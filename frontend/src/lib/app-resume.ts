export const APP_RESUME_EVENT = "koaryu:resume";
export const RESUME_STALE_MS = 30_000;

export type AppVersion = { environment: string; commit_sha: string | null };

export function validAppVersion(value: unknown): value is AppVersion {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.service === "koaryu-frontend" && typeof v.environment === "string"
    && typeof v.commit_sha === "string" && /^[0-9a-f]{40}$/.test(v.commit_sha);
}

/** A failed or duplicate check cannot reload the page or discard the workspace. */
export function createResumeCheck({ loaded, readVersion, onCurrent, onUpdate, now = Date.now }: {
  loaded: AppVersion;
  readVersion: () => Promise<unknown>;
  onCurrent: () => void;
  onUpdate: () => void;
  now?: () => number;
}) {
  let lastCheck = -Infinity;
  let pending: Promise<void> | null = null;
  let disposed = false;
  return {
    check(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (pending) return pending;
      if (now() - lastCheck < RESUME_STALE_MS) return Promise.resolve();
      lastCheck = now();
      pending = (async () => {
        if (!loaded.commit_sha) { if (!disposed) onCurrent(); return; }
        try {
          const current = await readVersion();
          if (disposed || !validAppVersion(current) || current.environment !== loaded.environment) return;
          if (current.commit_sha !== loaded.commit_sha) onUpdate();
          else onCurrent();
        } catch {
          // Offline restoration keeps the current workspace and permits a later check.
        }
      })().finally(() => { pending = null; });
      return pending;
    },
    dispose() { disposed = true; },
  };
}

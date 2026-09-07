"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { APP_RESUME_EVENT, createResumeCheck, RESUME_STALE_MS, type AppVersion } from "@/lib/app-resume";
import { pendingCommands, subscribePendingCommands } from "@/lib/pending-commands";

export function AppResumeGuard({ loaded }: { loaded: AppVersion }) {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const pending = useSyncExternalStore(subscribePendingCommands, pendingCommands, () => 0);
  useEffect(() => {
    const controller = new AbortController();
    const checker = createResumeCheck({
      loaded,
      readVersion: async () => {
        const response = await fetch("/api/version", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4_000)]),
          credentials: "omit",
        });
        if (!response.ok) throw new Error("Version check unavailable");
        return response.json();
      },
      onCurrent: () => window.dispatchEvent(new Event(APP_RESUME_EVENT)),
      onUpdate: () => setUpdateAvailable(true),
    });
    let hiddenAt: number | null = document.hidden ? Date.now() : null;
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) void checker.check(); };
    const onVisibility = () => {
      if (document.hidden) hiddenAt = Date.now();
      else {
        if (hiddenAt !== null && Date.now() - hiddenAt >= RESUME_STALE_MS) void checker.check();
        hiddenAt = null;
      }
    };
    const onOnline = () => { if (!document.hidden) void checker.check(); };
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      checker.dispose(); controller.abort();
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [loaded]);

  if (!updateAvailable) return null;
  return (
    <aside role="status" className="fixed bottom-4 left-1/2 z-[80] flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 items-center gap-4 rounded-lg border border-border bg-surface p-4 text-sm text-text-primary shadow-lg">
      <p>Koaryu has been updated. Save your work, then refresh to use the latest version.</p>
      <button type="button" disabled={pending > 0} onClick={() => { if (!pendingCommands()) window.location.reload(); }}
        className="rounded-md bg-accent px-3 py-2 font-medium text-accent-contrast disabled:opacity-50">
        {pending > 0 ? "Saving…" : "Refresh"}
      </button>
    </aside>
  );
}

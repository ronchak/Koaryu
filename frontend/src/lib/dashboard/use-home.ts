"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  needsFreshDashboardFacts,
  subscribeDashboardFactsChanged,
} from "@/lib/dashboard-freshness";
import { homeRoleClass, type HomeRole, type HomeStatus } from "@/lib/dashboard/home-model";
import { pendingCommands } from "@/lib/pending-commands";
import { useRetainedState, useRetainedStore } from "@/lib/retained-state";
import { useConfigStore, useDashboardStore, useStudioStore } from "@/lib/store-contexts";
import type { DashboardHome } from "@/types";

/*
 * The one owner of Home's data. It reads the store's verified identity, asks
 * the store's loader for the payload, keeps the last good payload for instant
 * revisits, and revalidates on mount, focus, a visible minute and fact changes.
 * It never decides "today": the payload's `studio.today` is the authority.
 */

export const HOME_REVALIDATE_INTERVAL_MS = 60_000;
export const HOME_FACTS_DEBOUNCE_MS = 300;
// Focus and visibility often fire together or in bursts; one read covers them.
export const HOME_FOCUS_THROTTLE_MS = 5_000;

export type HomeLoader = (options: { fresh: boolean }) => Promise<DashboardHome>;
/**
 * `scope` is the identity it was read for; a snapshot never serves another identity.
 * `order` is its read's start order on this page; a later-started read supersedes it.
 */
export type HomeSnapshot = {
  payload: DashboardHome;
  receivedAt: number;
  scope: string;
  order: number;
};
export type HomeRevalidationTrigger =
  "mount" | "focus" | "visible" | "interval" | "facts" | "retry";

export type HomeState = {
  status: HomeStatus;
  payload: DashboardHome | null;
  /** The last attempt's failure; the copy shown to owners lives in home-copy. */
  error: string | null;
  /** `generated_at` of the payload being shown. */
  asOf: string | null;
  retry: () => void;
  isRevalidating: boolean;
};

export function homeRetainedKey(scope: {
  userId: string;
  studioId: string;
  role: HomeRole;
  businessDate: string;
}): string {
  return `home:${scope.userId}:${scope.studioId}:${scope.role}:${scope.businessDate}`;
}

/** Session, subscription and membership refusals: shown data may no longer be allowed. */
export function isHomeAccessError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = Number((error as { status: unknown }).status);
  return status === 401 || status === 402 || status === 403;
}

// Single flight per loader (one per StoreProvider), identity scope, business
// date and fact generation. A plain read joins a fresh read already in flight;
// a fresh read never joins a plain one; no read joins one started before the
// latest fact change. Each flight records its start order across the page.
export type HomeFlight = { promise: Promise<DashboardHome>; order: number };
type HomeFlightEntry = HomeFlight & { fresh: boolean; factsGeneration: number };
let homeFlightOrder = 0;
let factsGeneration = 0;
let tracksFactsGeneration = false;
const flightsByLoader = new WeakMap<HomeLoader, Map<string, HomeFlightEntry[]>>();
const flightListeners = new Set<() => void>();

function notifyHomeFlights() {
  for (const listener of [...flightListeners]) listener();
}

function subscribeHomeFlights(listener: () => void) {
  flightListeners.add(listener);
  return () => {
    flightListeners.delete(listener);
  };
}

// Lives for the page, so a command that settles while Home is closed still
// keeps the next visit from joining a read started before it.
function trackFactsGeneration() {
  if (tracksFactsGeneration) return;
  tracksFactsGeneration = true;
  subscribeDashboardFactsChanged(() => {
    factsGeneration += 1;
  });
}

function hasHomeFlight(loader: HomeLoader, flightKey: string): boolean {
  return Boolean(flightsByLoader.get(loader)?.get(flightKey)?.length);
}

export function requestHomePayload(
  loader: HomeLoader,
  flightKey: string,
  fresh: boolean,
): HomeFlight {
  trackFactsGeneration();
  let flights = flightsByLoader.get(loader);
  if (!flights) {
    flights = new Map();
    flightsByLoader.set(loader, flights);
  }
  const inFlight = flights.get(flightKey) ?? [];
  const joinable = inFlight.filter((flight) => flight.factsGeneration === factsGeneration);
  const joined =
    joinable.find((flight) => flight.fresh) ??
    (fresh ? undefined : joinable.find((flight) => !flight.fresh));
  if (joined) return joined;
  const owner = flights;
  const promise = new Promise<DashboardHome>((resolve) => resolve(loader({ fresh }))).finally(
    () => {
      const remaining = (owner.get(flightKey) ?? []).filter((flight) => flight.promise !== promise);
      if (remaining.length > 0) owner.set(flightKey, remaining);
      else owner.delete(flightKey);
      notifyHomeFlights();
    },
  );
  const flight = { promise, order: ++homeFlightOrder, fresh, factsGeneration };
  flights.set(flightKey, [...inFlight, flight]);
  notifyHomeFlights();
  return flight;
}

// Page-wide outcomes per loader and identity scope, by read start order. They
// outlive any one mount, so a read that lands after navigation is judged
// against everything that settled meanwhile.
type HomeOutcomes = { settled: number; refused: number };
const outcomesByLoader = new WeakMap<HomeLoader, Map<string, HomeOutcomes>>();

function latestRefusal(loader: HomeLoader, scope: string): number {
  return outcomesByLoader.get(loader)?.get(scope)?.refused ?? 0;
}

/**
 * Admits a read's success or access refusal before it may touch retained or
 * shown data. Nothing started before a later settled read counts, and no
 * success started before the latest refusal counts: only a read that began
 * after the refusal can show data again. Joined handlers get the same answer.
 */
function admitOutcome(loader: HomeLoader, scope: string, order: number, refusal: boolean) {
  let byScope = outcomesByLoader.get(loader);
  if (!byScope) {
    byScope = new Map();
    outcomesByLoader.set(loader, byScope);
  }
  const outcomes = byScope.get(scope) ?? { settled: 0, refused: 0 };
  if (order < outcomes.settled || (!refusal && order <= outcomes.refused)) return false;
  byScope.set(scope, {
    settled: Math.max(outcomes.settled, order),
    refused: refusal ? Math.max(outcomes.refused, order) : outcomes.refused,
  });
  if (refusal && order > outcomes.refused) notifyHomeFlights();
  return true;
}

/** Whether `next` may replace `current`: another identity's entry, or a read started earlier. */
function supersedes(
  next: { scope: string; order: number },
  current: HomeSnapshot | null | undefined,
) {
  return !current || current.scope !== next.scope || current.order < next.order;
}

function newerSnapshot(a: HomeSnapshot | null, b: HomeSnapshot | null): HomeSnapshot | null {
  if (!a) return b;
  if (!b) return a;
  return b.order > a.order ? b : a;
}

export function useHome(): HomeState {
  const { businessDate, subscriptionRequired } = useConfigStore();
  const { currentUserId, currentStudioId, currentRole, identityGeneration, identityReady } =
    useStudioStore();
  const { loadDashboardHome } = useDashboardStore();
  const retainedStore = useRetainedStore();

  const role = homeRoleClass(currentRole);
  const userId = currentUserId.trim();
  const studioId = currentStudioId?.trim() ?? "";
  const identity =
    identityReady && !subscriptionRequired && userId && studioId && role
      ? { userId, studioId, role }
      : null;
  // The identity scope survives a business-date change; the retained key does not.
  const scope = identity
    ? `${identityGeneration}:${identity.userId}:${identity.studioId}:${identity.role}`
    : null;
  const retainedKey = identity ? homeRetainedKey({ ...identity, businessDate }) : null;
  // A read started under yesterday's date is never joined after the date changes.
  const flightKey = scope === null ? null : `${scope}:${businessDate}`;

  const [retained, setRetained] = useRetainedState<HomeSnapshot | null>(retainedKey, null);
  // The newest payload this mount has shown, so a date-key change keeps it on screen.
  const [held, setHeld] = useState<HomeSnapshot | null>(null);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  const isRevalidating = useSyncExternalStore(
    subscribeHomeFlights,
    () => flightKey !== null && hasHomeFlight(loadDashboardHome, flightKey),
    () => false,
  );
  const refusedAt = useSyncExternalStore(
    subscribeHomeFlights,
    () => (scope === null ? 0 : latestRefusal(loadDashboardHome, scope)),
    () => 0,
  );

  const scopeRef = useRef(scope);
  const retainedKeyRef = useRef(retainedKey);
  const mountedRef = useRef(false);
  const attemptsRef = useRef<{
    latest: number;
    applied: number;
    lastStartedAt: number;
    pending: Promise<DashboardHome> | null;
  }>({ latest: 0, applied: 0, lastStartedAt: -Infinity, pending: null });

  useEffect(() => {
    scopeRef.current = scope;
    retainedKeyRef.current = retainedKey;
  }, [scope, retainedKey]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const revalidate = useCallback(
    (trigger: HomeRevalidationTrigger) => {
      if (scope === null || retainedKey === null || flightKey === null) return;
      const attempts = attemptsRef.current;
      const startedAt = Date.now();
      if (
        (trigger === "focus" || trigger === "visible") &&
        startedAt - attempts.lastStartedAt < HOME_FOCUS_THROTTLE_MS
      ) {
        return;
      }
      attempts.lastStartedAt = startedAt;
      const { promise, order } = requestHomePayload(
        loadDashboardHome,
        flightKey,
        needsFreshDashboardFacts(),
      );
      if (promise === attempts.pending) return;
      attempts.latest = Math.max(attempts.latest, order);
      attempts.pending = promise;
      const key = retainedKey;
      const store = retainedStore;
      // Results apply in read start order, mounted or not: an older read never
      // replaces a newer outcome. Writes go to the key the read was started for.
      const retainUnderKey = (snapshot: HomeSnapshot) => {
        if (mountedRef.current && key === retainedKeyRef.current) {
          setRetained((current) => (supersedes(snapshot, current) ? snapshot : current));
        } else if (store && supersedes(snapshot, store.get<HomeSnapshot | null>(key))) {
          store.set(key, snapshot);
        }
      };
      const forgetUnderKey = () => {
        const refusal = { scope, order };
        if (mountedRef.current && key === retainedKeyRef.current) {
          setRetained((current) => (supersedes(refusal, current) ? null : current));
        } else if (store && supersedes(refusal, store.get<HomeSnapshot | null>(key))) {
          store.delete(key);
        }
      };
      const failureMessage = (error: unknown) =>
        error instanceof Error && error.message ? error.message : "Home could not be loaded.";
      promise.then(
        (payload) => {
          if (attempts.pending === promise) attempts.pending = null;
          const mounted = mountedRef.current;
          if (mounted && (scopeRef.current !== scope || order <= attempts.applied)) return;
          if (!admitOutcome(loadDashboardHome, scope, order, false)) return;
          // A read that lands after navigation still serves the next visit.
          const snapshot = { payload, receivedAt: Date.now(), scope, order };
          retainUnderKey(snapshot);
          if (!mounted) return;
          attempts.applied = order;
          setHeld(snapshot);
          setFailure(null);
        },
        (error: unknown) => {
          if (attempts.pending === promise) attempts.pending = null;
          const mounted = mountedRef.current;
          if (!isHomeAccessError(error)) {
            // A newer read is still in flight; it decides what an ordinary failure means.
            if (!mounted || scopeRef.current !== scope) return;
            if (order <= attempts.applied || order !== attempts.latest) return;
            attempts.applied = order;
            setFailure({ scope, message: failureMessage(error) });
            return;
          }
          // Retained data never outlives a refusal: the viewer may have lost access.
          // An ordinary failure since then proves nothing, so only settled reads win.
          if (!admitOutcome(loadDashboardHome, scope, order, true)) return;
          forgetUnderKey();
          if (!mounted || scopeRef.current !== scope) return;
          attempts.applied = Math.max(attempts.applied, order);
          if (key !== retainedKeyRef.current) {
            setRetained((current) => (supersedes({ scope, order }, current) ? null : current));
          }
          setHeld(null);
          setFailure({ scope, message: failureMessage(error) });
        },
      );
    },
    [flightKey, loadDashboardHome, retainedKey, retainedStore, scope, setRetained],
  );

  // Mount, identity change and business-date change; a date change keeps the payload on screen.
  useEffect(() => {
    revalidate("mount");
  }, [revalidate]);

  const onTrigger = useEffectEvent((trigger: HomeRevalidationTrigger) => revalidate(trigger));
  useEffect(() => {
    let factsTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    // The store advances its business date on these same events. Read one task
    // later, once that has committed, so a read never starts under the old date.
    const afterStore = (trigger: HomeRevalidationTrigger) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        if (!disposed) onTrigger(trigger);
      };
      channel.port2.postMessage(null);
    };
    const onFocus = () => afterStore("focus");
    const onVisibility = () => {
      if (document.visibilityState === "visible") afterStore("visible");
    };
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") onTrigger("interval");
    }, HOME_REVALIDATE_INTERVAL_MS);
    const unsubscribe = subscribeDashboardFactsChanged(() => {
      clearTimeout(factsTimer);
      factsTimer = setTimeout(() => {
        // A command still in flight marks facts again once it settles.
        if (pendingCommands() === 0) onTrigger("facts");
      }, HOME_FACTS_DEBOUNCE_MS);
    });
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      clearTimeout(factsTimer);
      clearInterval(interval);
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const retry = useCallback(() => revalidate("retry"), [revalidate]);

  // Only this identity's data, and only from reads started after its latest refusal.
  const visible = (candidate: HomeSnapshot | null) =>
    candidate !== null && candidate.scope === scope && candidate.order > refusedAt
      ? candidate
      : null;
  const snapshot = scope === null ? null : newerSnapshot(visible(retained), visible(held));
  const payload = snapshot?.payload ?? null;
  const error = scope !== null && failure?.scope === scope ? failure.message : null;
  const status: HomeStatus = error !== null ? "error" : payload !== null ? "ready" : "loading";
  const asOf = payload?.generated_at ?? null;

  return useMemo(
    () => ({ status, payload, error, asOf, retry, isRevalidating }),
    [status, payload, error, asOf, retry, isRevalidating],
  );
}

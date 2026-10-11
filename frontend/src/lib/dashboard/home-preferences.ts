import type { HomeRole } from "./home-model.ts";
import type {
  ApiDashboardHomePreferences,
  ApiDashboardHomePreferencesUpdate,
} from "../../types/generated/api-contracts.ts";

/*
 * Home preferences (brief 4.3, D4, D5): which optional panels Home shows and in
 * what order. One value per user and studio, stored by the backend (the user's
 * Auth metadata, decision 9) and copied to local storage for an instant first
 * paint. Every read is reconciled for the viewer's role with the same rules as
 * the server. No React and only relative imports, so Node tests import it.
 */

export const HOME_PANEL_IDS = ["follow_ups", "ready_to_promote", "recent_students"] as const;
export type HomePanelId = (typeof HOME_PANEL_IDS)[number];
export type HomePanelSize = "compact" | "expanded";

export type HomePreferences = {
  version: 1;
  /** Every panel the role may see, shown or hidden, in Home's order. */
  order: HomePanelId[];
  /** The panels in `order` that are switched off, in `order`'s order. */
  hidden: HomePanelId[];
  /** Sizes, only for panels that declare them; no panel does in version one. */
  size: Partial<Record<HomePanelId, HomePanelSize>>;
};

// The wire shapes are the generated API contracts: GET's `preferences` section and
// PUT's response are `HomePreferencesWire`; a HomePreferences value is the PUT body.
export type HomePreferencesWire = ApiDashboardHomePreferences;
type AssertSendable<T extends ApiDashboardHomePreferencesUpdate> = T;
export type HomePreferencesUpdate = AssertSendable<HomePreferences>;

type HomePanelSpec = {
  roles: readonly HomeRole[];
  defaultHidden: boolean;
  sizes: readonly HomePanelSize[];
};

// D4: who may see each panel, whether it starts switched off, and the sizes it declares.
export const HOME_PANEL_SPECS: Readonly<Record<HomePanelId, HomePanelSpec>> = {
  follow_ups: { roles: ["admin", "front_desk"], defaultHidden: false, sizes: [] },
  ready_to_promote: { roles: ["admin", "instructor"], defaultHidden: false, sizes: [] },
  recent_students: {
    roles: ["admin", "front_desk", "instructor"],
    defaultHidden: true,
    sizes: [],
  },
};

export function isHomePanelId(value: unknown): value is HomePanelId {
  return (HOME_PANEL_IDS as readonly unknown[]).includes(value);
}

/** Whether `role` may see the panel. Without a verified role it may see none. */
export function isHomePanelAllowed(id: HomePanelId, role: HomeRole | null): boolean {
  return role !== null && HOME_PANEL_SPECS[id].roles.includes(role);
}

/** The panels the role may see, in the default order. */
export function homePanelIdsForRole(role: HomeRole | null): HomePanelId[] {
  return HOME_PANEL_IDS.filter((id) => isHomePanelAllowed(id, role));
}

export function defaultHomePreferences(role: HomeRole | null): HomePreferences {
  const order = homePanelIdsForRole(role);
  return {
    version: 1,
    order,
    hidden: order.filter((id) => HOME_PANEL_SPECS[id].defaultHidden),
    size: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniquePanelIds(value: unknown): HomePanelId[] {
  if (!Array.isArray(value)) return [];
  const ids: HomePanelId[] = [];
  for (const item of value) if (isHomePanelId(item) && !ids.includes(item)) ids.push(item);
  return ids;
}

/**
 * A stored or received value reconciled for `role`, or null when it is not a
 * version-one preferences object at all. Drops unknown, duplicate and
 * non-entitled ids; appends newly entitled ids in default order, hidden when
 * their default is hidden or the value already hides them; keeps `hidden` a
 * subset of `order`; clamps `size` to what each panel declares.
 */
export function parseHomePreferences(raw: unknown, role: HomeRole | null): HomePreferences | null {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.order)) return null;
  const order = uniquePanelIds(raw.order).filter((id) => isHomePanelAllowed(id, role));
  const hiddenInput = new Set(uniquePanelIds(raw.hidden));
  for (const id of homePanelIdsForRole(role)) {
    if (order.includes(id)) continue;
    order.push(id);
    if (HOME_PANEL_SPECS[id].defaultHidden) hiddenInput.add(id);
  }
  const size: Partial<Record<HomePanelId, HomePanelSize>> = {};
  const sizes = isRecord(raw.size) ? raw.size : {};
  for (const id of order) {
    const value = sizes[id];
    if ((HOME_PANEL_SPECS[id].sizes as readonly unknown[]).includes(value)) {
      size[id] = value as HomePanelSize;
    }
  }
  return { version: 1, order, hidden: order.filter((id) => hiddenInput.has(id)), size };
}

/** `raw` reconciled for `role`; anything unreadable is the role's defaults. */
export function reconcileHomePreferences(raw: unknown, role: HomeRole | null): HomePreferences {
  return parseHomePreferences(raw, role) ?? defaultHomePreferences(role);
}

/** The panels Home shows, in order. */
export function homeVisiblePanelIds(preferences: HomePreferences): HomePanelId[] {
  return preferences.order.filter((id) => !preferences.hidden.includes(id));
}

/** A canonical string for a reconciled value: equal strings mean the same Home. */
export function homePreferencesKey(preferences: HomePreferences): string {
  const hidden = preferences.order.filter((id) => preferences.hidden.includes(id));
  const size = preferences.order.flatMap((id) =>
    preferences.size[id] ? [[id, preferences.size[id]]] : [],
  );
  return JSON.stringify([preferences.order, hidden, size]);
}

export function sameHomePreferences(a: HomePreferences, b: HomePreferences): boolean {
  return homePreferencesKey(a) === homePreferencesKey(b);
}

export function isDefaultHomePreferences(
  preferences: HomePreferences,
  role: HomeRole | null,
): boolean {
  return sameHomePreferences(
    reconcileHomePreferences(preferences, role),
    defaultHomePreferences(role),
  );
}

/** Moves a panel to `index` in `order` (an insertion index after removing it); hidden panels move too. */
export function moveHomePanelTo(
  preferences: HomePreferences,
  id: HomePanelId,
  index: number,
): HomePreferences {
  const from = preferences.order.indexOf(id);
  if (from < 0 || !Number.isInteger(index)) return preferences;
  const target = Math.min(Math.max(index, 0), preferences.order.length - 1);
  if (target === from) return preferences;
  const order = preferences.order.filter((candidate) => candidate !== id);
  order.splice(target, 0, id);
  return {
    ...preferences,
    order,
    hidden: order.filter((candidate) => preferences.hidden.includes(candidate)),
  };
}

/** Moves a panel by `offset` places (-1 up, 1 down); at either end nothing changes. */
export function moveHomePanel(
  preferences: HomePreferences,
  id: HomePanelId,
  offset: number,
): HomePreferences {
  const from = preferences.order.indexOf(id);
  const target = from + offset;
  if (from < 0 || target < 0 || target >= preferences.order.length) return preferences;
  return moveHomePanelTo(preferences, id, target);
}

/** Shows or hides a panel the value already lists; its place in `order` is kept. */
export function setHomePanelShown(
  preferences: HomePreferences,
  id: HomePanelId,
  shown: boolean,
): HomePreferences {
  if (!preferences.order.includes(id) || preferences.hidden.includes(id) !== shown) {
    return preferences;
  }
  const hidden = shown
    ? preferences.hidden.filter((candidate) => candidate !== id)
    : preferences.order.filter(
        (candidate) => candidate === id || preferences.hidden.includes(candidate),
      );
  return { ...preferences, hidden };
}

/** "Reset to defaults": the role's D4 order with New students off. */
export function resetHomePreferences(role: HomeRole | null): HomePreferences {
  return defaultHomePreferences(role);
}

// ── Local copy ──────────────────────────────────────────────────────────────

export const HOME_PREFERENCES_NAMESPACE = "koaryu:home-preferences:v1:";

export interface HomePreferencesStorage {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
}

/** The local copy: the value Home last showed, and whether the server has not confirmed it. */
export type StoredHomePreferences = { preferences: HomePreferences; unsynced: boolean };

export type HomePreferencesScope = { userId: string; studioId: string };

function safeIdentityPart(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) return null;
  return encodeURIComponent(normalized);
}

/** `koaryu:home-preferences:v1:<user>:<studio>`, each part URI-encoded; null without both. */
export function homePreferencesStorageKey(userId: unknown, studioId: unknown): string | null {
  const user = safeIdentityPart(userId);
  const studio = safeIdentityPart(studioId);
  return user && studio ? `${HOME_PREFERENCES_NAMESPACE}${user}:${studio}` : null;
}

export function getBrowserHomePreferencesStorage(): HomePreferencesStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The local copy reconciled for `role`, or null when absent, malformed or unreadable. */
export function readStoredHomePreferences(
  storage: HomePreferencesStorage | null | undefined,
  scope: HomePreferencesScope,
  role: HomeRole | null,
): StoredHomePreferences | null {
  const key = homePreferencesStorageKey(scope.userId, scope.studioId);
  if (!storage || !key) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const preferences = parseHomePreferences(parsed.preferences, role);
    return preferences ? { preferences, unsynced: parsed.unsynced === true } : null;
  } catch {
    return null;
  }
}

/** Writes the local copy; false when storage is missing, full or refuses. */
export function writeStoredHomePreferences(
  storage: HomePreferencesStorage | null | undefined,
  scope: HomePreferencesScope,
  value: StoredHomePreferences,
): boolean {
  const key = homePreferencesStorageKey(scope.userId, scope.studioId);
  if (!storage || !key) return false;
  try {
    storage.setItem(
      key,
      JSON.stringify({ preferences: value.preferences, unsynced: value.unsynced }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Sign-out purge: removes every local copy in the namespace and forgets the
 * in-memory sync state, so nothing outlives the session on a shared device.
 */
export function purgeHomePreferencesNamespace(
  storage: HomePreferencesStorage | null | undefined = getBrowserHomePreferencesStorage(),
): number {
  forgetHomePreferencesSyncs();
  if (!storage) return 0;
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(HOME_PREFERENCES_NAMESPACE)) keys.push(key);
    }
  } catch {
    return 0;
  }
  let removed = 0;
  for (const key of keys) {
    try {
      storage.removeItem(key);
      removed += 1;
    } catch {
      // Keep purging the other keys.
    }
  }
  return removed;
}

// ── Sync ────────────────────────────────────────────────────────────────────

export const HOME_PREFERENCES_SAVE_DEBOUNCE_MS = 400;

/** Saves for exactly this identity; resolves to the stored, reconciled value. */
export type HomePreferencesSaver = (
  preferences: HomePreferences,
  scope: HomePreferencesScope,
) => Promise<unknown>;

export type HomePreferencesTimers = {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

export type HomePreferencesSync = {
  readonly scope: HomePreferencesScope;
  /** The current value: stable until it changes, reconciled for the last role set. */
  getSnapshot: () => HomePreferences;
  subscribe: (listener: () => void) => () => void;
  setRole: (role: HomeRole) => void;
  /** The store's save loader; a value left unconfirmed by an earlier visit is retried. */
  setSaver: (saver: HomePreferencesSaver) => void;
  /** A local edit: applies at once, writes the local copy and schedules a debounced save. */
  change: (next: HomePreferences) => void;
  /** The `preferences` section of a Home payload; adopted only when no local edit is pending. */
  offerServer: (raw: unknown) => void;
  /** Sends a pending save now (Done, the page being hidden). */
  flush: () => void;
  /** An edit is waiting for its save, being saved, or was not confirmed. */
  isPending: () => boolean;
  dispose: () => void;
};

const DEFAULT_TIMERS: HomePreferencesTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One identity's preferences between Home, its local copy and the server.
 * Every edit applies at once and is saved by one PUT after `debounceMs`; one
 * save is in flight at a time and the newest value always follows it. A failed
 * save keeps the local value and is retried on the next edit or flush. A Home
 * payload never overrides a pending edit, and never brings back a value this
 * tab has edited away from: a read that started before a save lands with the
 * value the save replaced, and must not undo it.
 */
export function createHomePreferencesSync(options: {
  scope: HomePreferencesScope;
  role: HomeRole;
  saver?: HomePreferencesSaver;
  storage?: HomePreferencesStorage | null;
  debounceMs?: number;
  timers?: HomePreferencesTimers;
}): HomePreferencesSync {
  const scope = { userId: options.scope.userId, studioId: options.scope.studioId };
  const storage =
    options.storage === undefined ? getBrowserHomePreferencesStorage() : options.storage;
  const debounceMs = options.debounceMs ?? HOME_PREFERENCES_SAVE_DEBOUNCE_MS;
  const timers = options.timers ?? DEFAULT_TIMERS;
  let role = options.role;
  let saver = options.saver ?? null;
  const stored = readStoredHomePreferences(storage, scope, role);
  let value = stored?.preferences ?? defaultHomePreferences(role);
  let unsynced = stored?.unsynced ?? false;
  let timer: unknown = null;
  let inFlight = false;
  let queued = false;
  let disposed = false;
  // Values this tab edited away from; a late read carrying one of them is stale.
  const replaced = new Set<string>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const persist = () => {
    if (!disposed) writeStoredHomePreferences(storage, scope, { preferences: value, unsynced });
  };
  const cancelTimer = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const schedule = () => {
    cancelTimer();
    timer = timers.set(() => {
      timer = null;
      send();
    }, debounceMs);
  };

  function send() {
    if (disposed || !unsynced || !saver) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    const sending = value;
    const sentKey = homePreferencesKey(sending);
    let request: Promise<unknown>;
    try {
      request = Promise.resolve(saver(sending, scope));
    } catch (error) {
      request = Promise.reject(error);
    }
    const settle = (saved: HomePreferences | null) => {
      inFlight = false;
      const again = queued;
      queued = false;
      if (disposed) return;
      if (saved && homePreferencesKey(value) === sentKey) {
        unsynced = false;
        // The server's reconciled value wins over what was sent.
        if (homePreferencesKey(saved) !== sentKey) {
          replaced.add(sentKey);
          value = saved;
          notify();
        }
        persist();
      }
      // An edit made meanwhile, or a flush during the flight, goes out now
      // unless its own debounce is still waiting.
      if ((again || homePreferencesKey(value) !== sentKey) && timer === null) send();
    };
    request.then(
      (raw) => settle(parseHomePreferences(raw, role) ?? sending),
      () => settle(null),
    );
  }

  return {
    scope,
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setRole(next) {
      if (disposed || next === role) return;
      role = next;
      const reconciled = reconcileHomePreferences(value, role);
      if (homePreferencesKey(reconciled) !== homePreferencesKey(value)) {
        value = reconciled;
        notify();
      }
    },
    setSaver(next) {
      if (disposed) return;
      const first = saver === null;
      saver = next;
      if (first && unsynced && timer === null && !inFlight) schedule();
    },
    change(next) {
      if (disposed) return;
      const reconciled = reconcileHomePreferences(next, role);
      const currentKey = homePreferencesKey(value);
      if (homePreferencesKey(reconciled) === currentKey) return;
      replaced.add(currentKey);
      value = reconciled;
      unsynced = true;
      persist();
      notify();
      schedule();
    },
    offerServer(raw) {
      if (disposed || raw === undefined || raw === null) return;
      if (unsynced || inFlight || timer !== null) return;
      const server = parseHomePreferences(raw, role);
      if (!server) return;
      const key = homePreferencesKey(server);
      if (key === homePreferencesKey(value) || replaced.has(key)) return;
      value = server;
      persist();
      notify();
    },
    flush() {
      if (disposed) return;
      cancelTimer();
      send();
    },
    isPending: () => unsynced || inFlight || timer !== null,
    dispose() {
      disposed = true;
      cancelTimer();
      listeners.clear();
    },
  };
}

// One sync per user and studio for the page's lifetime, so a save debounced or
// in flight when Home unmounts still lands, and a revisit starts from it.
const syncs = new Map<string, HomePreferencesSync>();

export function homePreferencesSync(options: {
  scope: HomePreferencesScope;
  role: HomeRole;
  storage?: HomePreferencesStorage | null;
}): HomePreferencesSync | null {
  const key = homePreferencesStorageKey(options.scope.userId, options.scope.studioId);
  if (!key) return null;
  let sync = syncs.get(key);
  if (!sync) {
    sync = createHomePreferencesSync(options);
    syncs.set(key, sync);
  }
  return sync;
}

/** Disposes every sync (sign-out); a later visit starts again from storage. */
export function forgetHomePreferencesSyncs(): void {
  for (const sync of syncs.values()) sync.dispose();
  syncs.clear();
}

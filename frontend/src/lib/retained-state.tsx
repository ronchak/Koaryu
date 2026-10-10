"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

// Page data that should survive navigation within one signed-in studio session.
// Dashboard routes remount on every pathname change, so data kept in component
// state was thrown away and refetched behind a blocking skeleton on each visit.
// Retained values are scoped to one identity: a new identity generation or
// studio starts an empty store, so one account never sees another's rows.

const MAX_RETAINED_ENTRIES = 400;

export type RetainedStore = {
  readonly scope: string;
  get<T>(key: string): T | undefined;
  has(key: string): boolean;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
};

export function createRetainedStore(scope: string, limit = MAX_RETAINED_ENTRIES): RetainedStore {
  const entries = new Map<string, unknown>();
  return {
    scope,
    get<T>(key: string) {
      return entries.get(key) as T | undefined;
    },
    has(key: string) {
      return entries.has(key);
    },
    set<T>(key: string, value: T) {
      // Re-inserting keeps the most recently written keys at the end for eviction.
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    delete(key: string) {
      entries.delete(key);
    },
  };
}

const RetainedStateContext = createContext<RetainedStore | null>(null);

export function RetainedStateProvider({
  children,
  scope,
}: {
  children: ReactNode;
  scope: string | null;
}) {
  const store = useMemo(() => (scope === null ? null : createRetainedStore(scope)), [scope]);
  return <RetainedStateContext.Provider value={store}>{children}</RetainedStateContext.Provider>;
}

export function useRetainedStore(): RetainedStore | null {
  return useContext(RetainedStateContext);
}

function resolveInitial<T>(initial: T | (() => T)): T {
  return typeof initial === "function" ? (initial as () => T)() : initial;
}

type RetainedCell<T> = { key: string | null; store: RetainedStore | null; value: T };

/**
 * useState whose value outlives the component for the current identity scope.
 * A null key, or no provider (tests, public pages), behaves exactly like useState.
 * Changing the key switches to that key's retained value or the initial value.
 */
export function useRetainedState<T>(
  key: string | null,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const store = useRetainedStore();
  const read = (): T =>
    store !== null && key !== null && store.has(key)
      ? (store.get<T>(key) as T)
      : resolveInitial(initial);
  const [cell, setCell] = useState<RetainedCell<T>>(() => ({ key, store, value: read() }));
  let current = cell;
  if (cell.key !== key || cell.store !== store) {
    current = { key, store, value: read() };
    setCell(current);
  }
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    setCell((previous) => {
      const value =
        typeof update === "function" ? (update as (value: T) => T)(previous.value) : update;
      if (previous.store !== null && previous.key !== null) previous.store.set(previous.key, value);
      return Object.is(value, previous.value) ? previous : { ...previous, value };
    });
  }, []);
  return [current.value, setValue];
}

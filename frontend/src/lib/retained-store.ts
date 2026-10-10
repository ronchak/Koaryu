// Bounded key-value store behind useRetainedState. One instance serves one
// signed-in identity and studio; the provider replaces it when either changes.

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

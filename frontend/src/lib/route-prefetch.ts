import type { useRouter } from "next/navigation";

type AppRouter = ReturnType<typeof useRouter>;
type PrefetchOptions = NonNullable<Parameters<AppRouter["prefetch"]>[1]>;

// Dashboard record routes are dynamic and have no route loading state, so a
// navigation waits for the server unless the route was fetched ahead of time.
// Prefetch the whole route on intent (hover, focus, an opened quick view) so the
// click renders immediately. "full" is Next's PrefetchKind.FULL string value.
const FULL_PREFETCH = { kind: "full" } as unknown as PrefetchOptions;

export function prefetchRecordRoute(router: Pick<AppRouter, "prefetch">, href: string) {
  try {
    router.prefetch(href, FULL_PREFETCH);
  } catch {
    // Prefetching is an optimization; navigation still works without it.
  }
}

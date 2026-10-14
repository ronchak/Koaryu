export type PrefetchConnection = { saveData?: boolean; effectiveType?: string };

export function getPrefetchConnection(): PrefetchConnection | undefined {
  return (navigator as Navigator & { connection?: PrefetchConnection }).connection;
}

export function canPrefetchOnConnection(connection?: PrefetchConnection) {
  return !connection?.saveData && !["slow-2g", "2g"].includes(connection?.effectiveType ?? "");
}

export function createIntentPrefetchPolicy(now = () => performance.now()) {
  const recent = new Map<string, number>();
  let lastRequest = -Infinity;
  return (href: string, connection?: PrefetchConnection) => {
    if (!canPrefetchOnConnection(connection)) return false;
    const time = now();
    if (time - lastRequest < 250 || time - (recent.get(href) ?? -Infinity) < 30_000) return false;
    if (recent.size >= 32) recent.delete(recent.keys().next().value!);
    recent.set(href, time);
    lastRequest = time;
    return true;
  };
}

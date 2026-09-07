export function createIntentPrefetchPolicy(now = Date.now) {
  const recent = new Map<string, number>();
  let lastRequest = -Infinity;
  return (href: string, connection?: { saveData?: boolean; effectiveType?: string }) => {
    if (connection?.saveData || ["slow-2g", "2g"].includes(connection?.effectiveType ?? "")) return false;
    const time = now();
    if (time - lastRequest < 250 || time - (recent.get(href) ?? -Infinity) < 30_000) return false;
    if (recent.size >= 32) recent.delete(recent.keys().next().value!);
    recent.set(href, time); lastRequest = time;
    return true;
  };
}

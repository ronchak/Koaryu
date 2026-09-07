import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseMetricBatch } from "../frontend/src/lib/performance-metrics.ts";

export function summarizePerformance(lines) {
  const groups = new Map();
  for (let line of lines) {
    try {
      if (line.startsWith("{")) line = JSON.parse(line).message ?? "";
      const index = line.indexOf("[koaryu:metrics] ");
      if (index < 0) continue;
      const { environment, release, ...value } = JSON.parse(line.slice(index + "[koaryu:metrics] ".length));
      const batch = parseMetricBatch(value);
      if (environment !== "production" || !batch || (release !== null && !/^[0-9a-f]{40}$/.test(release))) continue;
      for (const event of batch.events) {
        const key = JSON.stringify([batch.version, event.route, event.name, event.navigation, event.outcome]);
        if (!groups.has(key) && groups.size >= 1024) continue;
        const values = groups.get(key) ?? [];
        if (values.length < 100_000) values.push(event.value);
        groups.set(key, values);
      }
    } catch { /* Never echo rejected input, which may contain unrelated private logs. */ }
  }
  return [...groups].map(([key, values]) => {
    values.sort((a, b) => a - b);
    const [version, route, metric, navigation, outcome] = JSON.parse(key);
    return { version, route, metric, navigation, outcome, samples: values.length,
      p50: values[Math.ceil(values.length * 0.5) - 1], p95: values[Math.ceil(values.length * 0.95) - 1],
      p75: values[Math.ceil(values.length * 0.75) - 1],
      sufficient_for_tail_comparison: values.length >= 100,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = [];
  for await (const line of createInterface({ input: process.stdin })) { if (lines.length < 100_000) lines.push(line); }
  console.log(JSON.stringify(summarizePerformance(lines), null, 2));
}

import { parseMetricBatch } from "../../../lib/performance-metrics.ts";
import { getDeploymentMetadata } from "../../../lib/deployment-metadata.ts";

export const runtime = "nodejs";
export const maxDuration = 10;
const MAX_BYTES = 4096;
let windowStarted = 0;
let batches = 0;

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (
    request.headers.get("origin") !== new URL(request.url).origin ||
    request.headers.get("sec-fetch-site") !== "same-origin"
  )
    return new Response(null, { status: 403, headers });
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return new Response(null, { status: 415, headers });
  if (Date.now() - windowStarted > 60_000) {
    windowStarted = Date.now();
    batches = 0;
  }
  // Bound log amplification per function instance, without retaining client identifiers.
  if (++batches > 100) return new Response(null, { status: 429, headers });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400, headers });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 5_000);
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        return new Response(null, { status: 413, headers });
      }
      chunks.push(result.value);
    }
    if (expired) return new Response(null, { status: 408, headers });
    const batch = parseMetricBatch(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!batch) return new Response(null, { status: 400, headers });
    const deployment = getDeploymentMetadata();
    if (
      deployment.environment === "production" &&
      process.env.NEXT_PUBLIC_PREVIEW_MODE !== "true"
    ) {
      console.info(
        `[koaryu:metrics] ${JSON.stringify({ environment: deployment.environment, release: deployment.commit_sha, ...batch })}`,
      );
    }
    return new Response(null, { status: 204, headers });
  } catch {
    return new Response(null, { status: 400, headers });
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

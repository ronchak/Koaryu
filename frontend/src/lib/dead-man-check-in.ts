import { createHash } from "node:crypto";

type WorkerId = "evaluator" | "deletion-worker";

const WORKER_CONFIG = {
  evaluator: {
    url: "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL",
    host: "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_HOST",
    fingerprint: "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL_SHA256",
    bearer: "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_BEARER_SECRET",
  },
  "deletion-worker": {
    url: "OPERATIONAL_ALERT_DELETION_DEADMAN_URL",
    host: "OPERATIONAL_ALERT_DELETION_DEADMAN_HOST",
    fingerprint: "OPERATIONAL_ALERT_DELETION_DEADMAN_URL_SHA256",
    bearer: "OPERATIONAL_ALERT_DELETION_DEADMAN_BEARER_SECRET",
  },
} as const;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const RECEIPT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function configuredDestination(workerId: WorkerId) {
  const names = WORKER_CONFIG[workerId];
  const raw = process.env[names.url] ?? "";
  const expectedHostname = process.env[names.host] ?? "";
  const fingerprint = process.env[names.fingerprint] ?? "";
  const bearer = process.env[names.bearer] ?? "";
  if (!raw || raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || (parsed.port && parsed.port !== "443")
      || parsed.hostname === "localhost"
      || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname)
      || parsed.hostname.startsWith("[")
      || [".localhost", ".local", ".test", ".invalid", ".example"].some(
        (suffix) => parsed.hostname.endsWith(suffix),
      )
      || parsed.hostname !== expectedHostname
    ) return null;
  } catch {
    return null;
  }
  const actual = createHash("sha256").update(raw, "utf8").digest("hex");
  if (!FINGERPRINT_PATTERN.test(fingerprint) || actual !== fingerprint) return null;
  if (bearer.length < 32 || bearer !== bearer.trim()) return null;
  return { url: raw, fingerprint, bearer };
}

export function validateDeadManCheckInConfiguration({
  workerId,
  environment,
  commitSha,
}: {
  workerId: WorkerId;
  environment: "development" | "test" | "staging" | "production";
  commitSha: string;
}) {
  if (!configuredDestination(workerId)) {
    throw new Error("dead-man destination is not safely configured");
  }
  if (!SHA_PATTERN.test(commitSha) || !["development", "test", "staging", "production"].includes(environment)) {
    throw new Error("dead-man identity is invalid");
  }
}

async function boundedBody(response: Response) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 4096) {
      await reader.cancel();
      throw new Error("dead-man receipt exceeded the safe limit");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function sendDeadManCheckIn({
  workerId,
  environment,
  commitSha,
  sequence,
  fetchImpl = globalThis.fetch,
}: {
  workerId: WorkerId;
  environment: "development" | "test" | "staging" | "production";
  commitSha: string;
  sequence: number;
  fetchImpl?: typeof globalThis.fetch;
}) {
  const destination = configuredDestination(workerId);
  validateDeadManCheckInConfiguration({ workerId, environment, commitSha });
  if (!destination || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("dead-man identity is invalid");
  }
  const idempotencyKey = `koaryu:${environment}:${workerId}:${sequence}`;
  const response = await fetchImpl(destination.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${destination.bearer}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "X-Koaryu-Destination-Fingerprint": destination.fingerprint,
    },
    body: JSON.stringify({
      schema_version: 1,
      worker_id: workerId,
      environment,
      commit_sha: commitSha,
      heartbeat_sequence: sequence,
    }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await boundedBody(response);
  if (!response.ok) throw new Error("dead-man destination rejected the check-in");
  if ((response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new Error("dead-man receipt content type is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw new Error("dead-man receipt is invalid");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.keys(parsed).length !== 1
    || !("receipt_id" in parsed)
    || typeof parsed.receipt_id !== "string"
    || !RECEIPT_PATTERN.test(parsed.receipt_id)
  ) {
    throw new Error("dead-man receipt is invalid");
  }
  return parsed.receipt_id;
}

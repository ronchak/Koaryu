import dns from "node:dns";
import https from "node:https";
import type { LookupFunction } from "node:net";

import ipaddr from "ipaddr.js";

export type DnsAnswer = Readonly<{ address: string; family: 4 | 6 }>;
export type ResolveAll = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;
export type HttpsRequest = typeof https.request;

export type PinnedHttpsResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;

type PinnedTarget = Readonly<{
  url: URL;
  hostname: string;
  answers: readonly DnsAnswer[];
}>;

function isPublicAddress(answer: { address: string; family: number }): answer is DnsAnswer {
  if (answer.family !== 4 && answer.family !== 6) return false;
  let parsed;
  try {
    parsed = ipaddr.parse(answer.address);
  } catch {
    return false;
  }
  const kind = parsed.kind();
  if (
    (answer.family === 4 && kind !== "ipv4")
    || (answer.family === 6 && kind !== "ipv6")
    || (kind === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress())
  ) {
    return false;
  }
  return parsed.range() === "unicast";
}

export async function resolvePinnedHttpsTarget(
  rawUrl: string,
  resolveAll: ResolveAll = dns.promises.lookup,
): Promise<PinnedTarget> {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port && url.port !== "443"
  ) {
    throw new Error("pinned HTTPS target is invalid");
  }
  const resolved = await resolveAll(url.hostname, { all: true, verbatim: true });
  if (!resolved.length || !resolved.every(isPublicAddress)) {
    throw new Error("pinned HTTPS target did not resolve only to public addresses");
  }
  const seen = new Set<string>();
  const answers = resolved.flatMap((answer) => {
    const key = `${answer.family}:${answer.address}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [Object.freeze({ address: answer.address, family: answer.family })];
  });
  return Object.freeze({
    url,
    hostname: url.hostname,
    answers: Object.freeze(answers),
  });
}

export function createPinnedLookup(target: PinnedTarget): LookupFunction {
  return (hostname, options, callback) => {
    if (hostname !== target.hostname) {
      callback(new Error("pinned HTTPS lookup hostname changed"), "", 0);
      return;
    }
    const requestedFamily = options.family === "IPv4"
      ? 4
      : options.family === "IPv6" ? 6 : options.family;
    const candidates = requestedFamily === 4 || requestedFamily === 6
      ? target.answers.filter((answer) => answer.family === requestedFamily)
      : target.answers;
    if (!candidates.length) {
      callback(new Error("pinned HTTPS lookup has no address for the requested family"), "", 0);
      return;
    }
    if (typeof options === "object" && options?.all) {
      callback(null, candidates.map((answer) => ({ ...answer })));
      return;
    }
    callback(null, candidates[0].address, candidates[0].family);
  };
}

export async function pinnedHttpsRequest({
  url: rawUrl,
  method = "POST",
  headers,
  body,
  timeoutMs,
  maxResponseBytes,
  resolveAll = dns.promises.lookup,
  requestImpl = https.request,
}: {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs: number;
  maxResponseBytes: number;
  resolveAll?: ResolveAll;
  requestImpl?: HttpsRequest;
}): Promise<PinnedHttpsResponse> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("pinned HTTPS timeout is invalid");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error("pinned HTTPS response bound is invalid");
  }
  const deadline = Date.now() + timeoutMs;
  let resolutionTimer: ReturnType<typeof setTimeout> | undefined;
  const target = await Promise.race([
    resolvePinnedHttpsTarget(rawUrl, resolveAll),
    new Promise<never>((_resolve, reject) => {
      resolutionTimer = setTimeout(
        () => reject(new Error("pinned HTTPS request timed out")),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (resolutionTimer) clearTimeout(resolutionTimer);
  });
  const remainingMs = deadline - Date.now();
  if (remainingMs < 1) {
    throw new Error("pinned HTTPS request timed out");
  }
  const lookup = createPinnedLookup(target);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, response?: PinnedHttpsResponse) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else if (response) resolve(response);
    };
    const request = requestImpl(target.url, {
      method,
      headers,
      agent: false,
      lookup,
      servername: target.hostname,
      rejectUnauthorized: true,
      signal: AbortSignal.timeout(remainingMs),
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer | Uint8Array | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > maxResponseBytes) {
          response.destroy();
          request.destroy();
          finish(new Error("pinned HTTPS response exceeded the safe limit"));
          return;
        }
        chunks.push(bytes);
      });
      response.on("error", (error) => finish(error));
      response.on("end", () => {
        const normalizedHeaders = Object.fromEntries(
          Object.entries(response.headers).flatMap(([name, value]) => (
            value === undefined ? [] : [[name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value)]]
          )),
        );
        finish(undefined, Object.freeze({
          status: response.statusCode ?? 0,
          headers: Object.freeze(normalizedHeaders),
          body: Buffer.concat(chunks),
        }));
      });
    });
    request.on("error", (error) => finish(error));
    request.end(body);
  });
}

export function parsePinnedJson(response: PinnedHttpsResponse): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
  } catch {
    return null;
  }
}

#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setImmediate as delayImmediate } from "node:timers/promises";

import { NextRequest } from "next/server.js";

import { POST } from "../src/app/api/proxy/[...path]/route.ts";
import {
  CSV_IMPORT_MAX_BYTES,
  CSV_IMPORT_PROXY_REQUEST_MAX_BYTES,
  DEFAULT_PROXY_REQUEST_MAX_BYTES,
} from "../src/lib/request-body-limits.ts";

const MIB = 1024 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;
const BOUNDARY = new TextEncoder().encode("koaryu-profile-boundary");
const FILE_PATTERN = new TextEncoder().encode("0123456789abcdef");
const TEXT_PATTERN = new TextEncoder().encode("a");
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
const originalBackendUrl = process.env.BACKEND_API_URL;

function fixed(value) {
  return { pattern: value, length: value.byteLength };
}

function repeated(pattern, length) {
  if (pattern.byteLength === 0 || length < 0) {
    throw new Error("Repeated segments need a pattern and non-negative length.");
  }
  return { pattern, length };
}

function bytes(value) {
  return encoder.encode(value);
}

export function jsonSegments(totalBytes) {
  const prefix = bytes('{"payload":"');
  const suffix = bytes('"}');
  const fillerBytes = totalBytes - prefix.byteLength - suffix.byteLength;
  if (fillerBytes < 0) {
    throw new Error("JSON body is too small.");
  }
  return [fixed(prefix), repeated(TEXT_PATTERN, fillerBytes), fixed(suffix)];
}

export function multipartSegments({ fileBytes, totalBytes = null }) {
  const boundary = new TextDecoder().decode(BOUNDARY);
  const filePrefix = bytes(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="students.csv"\r\n' +
      "Content-Type: text/csv\r\n\r\n"
  );
  const fieldPrefix = bytes(
    `\r\n--${boundary}\r\n` +
      'Content-Disposition: form-data; name="payload"\r\n' +
      "Content-Type: application/json\r\n\r\n"
  );
  const fieldJsonPrefix = bytes('{"mapping":"');
  const fieldJsonSuffix = bytes('"}');
  const closing = bytes(`\r\n--${boundary}--\r\n`);
  const fixedBytes =
    filePrefix.byteLength +
    fileBytes +
    fieldPrefix.byteLength +
    fieldJsonPrefix.byteLength +
    fieldJsonSuffix.byteLength +
    closing.byteLength;
  const targetBytes = totalBytes ?? fixedBytes;
  const fillerBytes = targetBytes - fixedBytes;
  if (fillerBytes < 0) {
    throw new Error("Multipart target is smaller than its framing.");
  }
  return [
    fixed(filePrefix),
    repeated(FILE_PATTERN, fileBytes),
    fixed(fieldPrefix),
    fixed(fieldJsonPrefix),
    repeated(TEXT_PATTERN, fillerBytes),
    fixed(fieldJsonSuffix),
    fixed(closing),
  ];
}

class SegmentedBody {
  constructor(segments) {
    this.segments = segments;
    this.segmentIndex = 0;
    this.segmentOffset = 0;
    this.remaining = segments.reduce((total, segment) => total + segment.length, 0);
    this.produced = 0;
    this.hash = createHash("sha256");
  }

  read(maxBytes) {
    if (this.remaining === 0) {
      return new Uint8Array();
    }

    const output = new Uint8Array(Math.min(maxBytes, this.remaining));
    let outputOffset = 0;
    while (outputOffset < output.byteLength) {
      const segment = this.segments[this.segmentIndex];
      const available = segment.length - this.segmentOffset;
      const take = Math.min(output.byteLength - outputOffset, available);
      for (let index = 0; index < take; index += 1) {
        output[outputOffset + index] =
          segment.pattern[(this.segmentOffset + index) % segment.pattern.byteLength];
      }
      outputOffset += take;
      this.segmentOffset += take;
      this.remaining -= take;
      this.produced += take;
      if (this.segmentOffset === segment.length) {
        this.segmentIndex += 1;
        this.segmentOffset = 0;
      }
    }
    this.hash.update(output);
    return output;
  }

  digest() {
    return this.hash.copy().digest("hex");
  }
}

function bodyBytes(segments) {
  return segments.reduce((total, segment) => total + segment.length, 0);
}

function scenarios(quick) {
  const values = [
    {
      name: "json-64k",
      kind: "json",
      segments: jsonSegments(64 * 1024),
      expectedStatus: 204,
      declaredLength: 64 * 1024,
      path: ["profile"],
    },
    {
      name: "json-512k",
      kind: "json",
      segments: jsonSegments(512 * 1024),
      expectedStatus: 204,
      declaredLength: 512 * 1024,
      path: ["profile"],
    },
    {
      name: "json-1m",
      kind: "json",
      segments: jsonSegments(DEFAULT_PROXY_REQUEST_MAX_BYTES),
      expectedStatus: 204,
      declaredLength: DEFAULT_PROXY_REQUEST_MAX_BYTES,
      path: ["profile"],
    },
    {
      name: "multipart-256k",
      kind: "multipart",
      segments: multipartSegments({ fileBytes: 256 * 1024 }),
      expectedStatus: 204,
      declaredLength: null,
      path: ["students", "import", "parse"],
    },
    {
      name: "multipart-2m",
      kind: "multipart",
      segments: multipartSegments({ fileBytes: 2 * MIB }),
      expectedStatus: 204,
      declaredLength: null,
      path: ["students", "import", "parse"],
    },
    {
      name: "multipart-10m",
      kind: "multipart",
      segments: multipartSegments({ fileBytes: CSV_IMPORT_MAX_BYTES }),
      expectedStatus: 204,
      declaredLength: null,
      path: ["students", "import", "parse"],
    },
    {
      name: "multipart-max-envelope",
      kind: "multipart",
      segments: multipartSegments({
        fileBytes: CSV_IMPORT_MAX_BYTES,
        totalBytes: CSV_IMPORT_PROXY_REQUEST_MAX_BYTES,
      }),
      expectedStatus: 204,
      declaredLength: CSV_IMPORT_PROXY_REQUEST_MAX_BYTES,
      path: ["students", "import", "parse"],
    },
    {
      name: "json-declared-overflow",
      kind: "json",
      segments: jsonSegments(64 * 1024),
      expectedStatus: 413,
      declaredLength: DEFAULT_PROXY_REQUEST_MAX_BYTES + 1,
      path: ["profile"],
    },
    {
      name: "json-streamed-overflow",
      kind: "json",
      segments: jsonSegments(DEFAULT_PROXY_REQUEST_MAX_BYTES + 1),
      expectedStatus: 413,
      declaredLength: null,
      path: ["profile"],
    },
    {
      name: "multipart-streamed-overflow",
      kind: "multipart",
      segments: multipartSegments({
        fileBytes: CSV_IMPORT_MAX_BYTES,
        totalBytes: CSV_IMPORT_PROXY_REQUEST_MAX_BYTES + 1,
      }),
      expectedStatus: 413,
      declaredLength: null,
      path: ["students", "import", "parse"],
    },
  ];
  return quick ? [values[0], values[4], values[7], values[8]] : values;
}

function scenarioByName(name) {
  const scenario = scenarios(false).find((candidate) => candidate.name === name);
  if (!scenario) {
    throw new Error(`Unknown scenario: ${name}`);
  }
  return scenario;
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function maxMemory(left, right) {
  return Object.fromEntries(
    Object.keys(left).map((key) => [key, Math.max(left[key], right[key])])
  );
}

function deltaMib(peak, baseline, key) {
  return Math.max(0, peak[key] - baseline[key]) / MIB;
}

async function runWorker(scenario, concurrency) {
  process.env.BACKEND_API_URL = "https://synthetic-backend.invalid/api/v1";
  if (globalThis.gc) {
    globalThis.gc();
  }
  await delayImmediate();
  const baseline = memorySnapshot();
  let peak = baseline;
  const timer = setInterval(() => {
    peak = maxMemory(peak, memorySnapshot());
  }, 1);
  const sources = new Map();
  const forwarded = new Map();
  let upstreamCalls = 0;

  globalThis.fetch = async (_url, init) => {
    upstreamCalls += 1;
    const id = new Headers(init.headers).get("idempotency-key");
    const body = new Uint8Array(init.body);
    forwarded.set(id, createHash("sha256").update(body).digest("hex"));
    peak = maxMemory(peak, memorySnapshot());
    await delayImmediate();
    return new Response(null, { status: 204 });
  };

  let releaseStart;
  const start = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const tasks = Array.from({ length: concurrency }, (_, index) => {
    const id = `profile-${index}`;
    const source = new SegmentedBody(scenario.segments);
    sources.set(id, source);
    const stream = new ReadableStream({
      async pull(controller) {
        await delayImmediate();
        const chunk = source.read(STREAM_CHUNK_BYTES);
        if (chunk.byteLength > 0) {
          controller.enqueue(chunk);
        }
        if (source.remaining === 0) {
          controller.close();
        }
        peak = maxMemory(peak, memorySnapshot());
      },
    });
    const headers = new Headers({
      "content-type":
        scenario.kind === "json"
          ? "application/json"
          : `multipart/form-data; boundary=${new TextDecoder().decode(BOUNDARY)}`,
      "idempotency-key": id,
    });
    if (scenario.declaredLength !== null) {
      headers.set("content-length", String(scenario.declaredLength));
    }
    const request = new NextRequest(
      `https://app.example.test/api/proxy/${scenario.path.join("/")}`,
      {
        method: "POST",
        headers,
        body: stream,
        duplex: "half",
      }
    );

    return (async () => {
      await start;
      const started = performance.now();
      const response = await POST(request, {
        params: Promise.resolve({ path: scenario.path }),
      });
      await response.arrayBuffer();
      return { status: response.status, latencyMs: performance.now() - started, id };
    })();
  });

  releaseStart();
  const results = await Promise.all(tasks);
  peak = maxMemory(peak, memorySnapshot());
  clearInterval(timer);
  const statuses = results.map((result) => result.status);
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor((latencies.length - 1) / 2)];
  const expectedUpstreamCalls = scenario.expectedStatus === 413 ? 0 : concurrency;
  const integrityOk =
    upstreamCalls === expectedUpstreamCalls &&
    results.every((result) => {
      const source = sources.get(result.id);
      if (scenario.expectedStatus === 413) {
        return !forwarded.has(result.id);
      }
      return (
        source.remaining === 0 &&
        source.produced === bodyBytes(scenario.segments) &&
        forwarded.get(result.id) === source.digest()
      );
    });

  return {
    profile: "next-proxy",
    scenario: scenario.name,
    kind: scenario.kind,
    body_bytes: bodyBytes(scenario.segments),
    concurrency,
    expected_status: scenario.expectedStatus,
    statuses,
    status_ok: statuses.every((status) => status === scenario.expectedStatus),
    byte_integrity_ok: integrityOk,
    source_bytes_consumed: results.map((result) => sources.get(result.id).produced),
    upstream_calls: upstreamCalls,
    baseline_rss_mib: baseline.rss / MIB,
    peak_rss_mib: peak.rss / MIB,
    rss_delta_mib: deltaMib(peak, baseline, "rss"),
    node_allocation_peak_mib:
      deltaMib(peak, baseline, "heapUsed") + deltaMib(peak, baseline, "external"),
    node_array_buffer_peak_mib: deltaMib(peak, baseline, "arrayBuffers"),
    latency_p50_ms: p50,
    latency_max_ms: latencies.at(-1),
  };
}

function workerCommand(scenario, concurrency) {
  return [
    "--experimental-strip-types",
    "--expose-gc",
    fileURLToPath(import.meta.url),
    "--worker",
    "--scenario",
    scenario.name,
    "--concurrency",
    String(concurrency),
  ];
}

function runSubprocessWorker(scenario, concurrency) {
  const completed = spawnSync(process.execPath, workerCommand(scenario, concurrency), {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  if (completed.status !== 0) {
    throw new Error(completed.stderr || `Worker exited ${completed.status}`);
  }
  return JSON.parse(completed.stdout);
}

function renderMarkdown(results) {
  const lines = [
    "| path | body MiB | c | peak RSS Δ MiB | Node alloc peak MiB | array buffers Δ MiB | p50 ms | max ms | status | bytes |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  ];
  for (const result of results) {
    lines.push(
      `| ${result.scenario} | ${(result.body_bytes / MIB).toFixed(3)} | ` +
        `${result.concurrency} | ${result.rss_delta_mib.toFixed(3)} | ` +
        `${result.node_allocation_peak_mib.toFixed(3)} | ` +
        `${result.node_array_buffer_peak_mib.toFixed(3)} | ` +
        `${result.latency_p50_ms.toFixed(3)} | ${result.latency_max_ms.toFixed(3)} | ` +
        `${result.status_ok ? "ok" : "FAIL"} | ` +
        `${result.byte_integrity_ok ? "ok" : "FAIL"} |`
    );
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    quick: argv.includes("--quick"),
    json: argv.includes("--json"),
    worker: argv.includes("--worker"),
    scenario: null,
    concurrency: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--scenario") {
      options.scenario = argv[index + 1];
    }
    if (argv[index] === "--concurrency") {
      options.concurrency = Number(argv[index + 1]);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    if (options.worker) {
      if (!options.scenario || !Number.isInteger(options.concurrency) || options.concurrency < 1) {
        throw new Error("Worker mode requires a scenario and positive concurrency.");
      }
      console.log(JSON.stringify(await runWorker(
        scenarioByName(options.scenario),
        options.concurrency
      )));
      return;
    }

    const results = [];
    const concurrencyValues = options.quick ? [1] : [1, 2, 4];
    for (const scenario of scenarios(options.quick)) {
      let values = concurrencyValues;
      if (scenario.expectedStatus === 413) {
        values = [1];
      } else if (scenario.name === "multipart-max-envelope" && !options.quick) {
        values = [...concurrencyValues, 8];
      }
      for (const concurrency of values) {
        results.push(runSubprocessWorker(scenario, concurrency));
      }
    }
    console.log(options.json ? JSON.stringify(results, null, 2) : renderMarkdown(results));
    if (results.some((result) => !result.status_ok || !result.byte_integrity_ok)) {
      process.exitCode = 1;
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBackendUrl === undefined) {
      delete process.env.BACKEND_API_URL;
    } else {
      process.env.BACKEND_API_URL = originalBackendUrl;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

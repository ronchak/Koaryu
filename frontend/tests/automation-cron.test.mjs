import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  dynamic,
  handleAutomationCron,
  maxDuration,
  runtime,
} from "../src/app/api/cron/automations/process-due/route.ts";

const ENV_KEYS = [
  "AUTOMATION_WORKER_ENABLED",
  "AUTOMATION_WORKER_SECRET",
  "BACKEND_API_URL",
  "CRON_SECRET",
  "NEXT_PUBLIC_API_URL",
  "NODE_ENV",
  "VERCEL_ENV",
  "VERCEL_TARGET_ENV",
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const CRON_PATH = "/api/cron/automations/process-due";
const WORKER_PATH = "/api/v1/internal/automations/missed-class/process-due";
const WORKER_SECRET = "W".repeat(40);
const COUNT_KEYS = [
  "enqueued",
  "processed",
  "accepted",
  "retry_wait",
  "failed",
  "unknown",
  "skipped",
];

function request(authorization = "Bearer cron-secret") {
  return new Request(`https://staging.example.test${CRON_PATH}`, {
    headers: authorization === null ? {} : { authorization },
  });
}

function summary(overrides = {}) {
  return {
    enqueued: 0,
    processed: 0,
    accepted: 0,
    retry_wait: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    has_more: false,
    ...overrides,
  };
}

function pinnedJson(payload, status = 200) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(payload)),
  };
}

async function withoutEnvReads(keys, operation) {
  const original = process.env;
  process.env = new Proxy(
    { ...original },
    {
      get(target, key) {
        assert.ok(!keys.includes(key), `Unexpected environment read: ${String(key)}`);
        return target[key];
      },
    },
  );
  try {
    return await operation();
  } finally {
    process.env = original;
  }
}

describe("missed-class automation cron", () => {
  let calls;
  let elapsed;
  let httpsRequest;
  let localRequest;

  beforeEach(() => {
    process.env.AUTOMATION_WORKER_ENABLED = "true";
    process.env.AUTOMATION_WORKER_SECRET = WORKER_SECRET;
    process.env.BACKEND_API_URL = "https://koaryu-staging.onrender.com/api/v1";
    process.env.CRON_SECRET = "cron-secret";
    process.env.VERCEL_TARGET_ENV = "staging";
    process.env.NODE_ENV = "test";
    delete process.env.NEXT_PUBLIC_API_URL;
    delete process.env.VERCEL_ENV;
    calls = [];
    elapsed = 0;
    httpsRequest = async (options) => {
      calls.push({ transport: "https", ...options });
      return pinnedJson(summary());
    };
    localRequest = async (options) => {
      calls.push({ transport: "local", ...options });
      return pinnedJson(summary());
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const invoke = async (incoming = request(), dependencies = {}) => {
    const result = await handleAutomationCron(incoming, {
      httpsRequest,
      localRequest,
      now: () => elapsed,
      ...dependencies,
    });
    assert.equal(result.headers.get("cache-control"), "no-store, private");
    return result;
  };

  it("authenticates exactly before reading flags, backend configuration, or worker credentials", async () => {
    for (const authorization of [null, "Bearer wrong", "bearer cron-secret", "cron-secret"]) {
      const result = await withoutEnvReads(
        ENV_KEYS.filter((key) => key !== "CRON_SECRET"),
        () => invoke(request(authorization)),
      );
      assert.equal(result.status, 401);
    }
    assert.equal(calls.length, 0);
  });

  it("returns 204 while disabled without any backend, credential, or clock access", async () => {
    for (const flag of [undefined, "false", "TRUE", " true ", "1"]) {
      if (flag === undefined) delete process.env.AUTOMATION_WORKER_ENABLED;
      else process.env.AUTOMATION_WORKER_ENABLED = flag;
      const result = await withoutEnvReads(
        ENV_KEYS.filter((key) => !["CRON_SECRET", "AUTOMATION_WORKER_ENABLED"].includes(key)),
        () => invoke(request(), { now: () => assert.fail("Disabled route accessed clock") }),
      );
      assert.equal(result.status, 204);
      assert.equal(await result.text(), "");
    }
    assert.equal(calls.length, 0);
  });

  it("rejects unsafe cron secrets before network access", async () => {
    for (const secret of [
      undefined,
      "",
      " cron-secret",
      "cron-secret ",
      "cron-secret\n",
      "cron\tsecret",
      "cron-secret\x7f",
    ]) {
      if (secret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = secret;
      assert.equal((await invoke()).status, 401);
    }
    assert.equal(calls.length, 0);
  });

  it("rejects unsafe, short, and placeholder worker secrets without disclosing values", async () => {
    for (const secret of [
      undefined,
      "",
      "W".repeat(31),
      ` ${WORKER_SECRET}`,
      `${WORKER_SECRET} `,
      `${WORKER_SECRET}\t`,
      `${WORKER_SECRET}\r`,
      `${WORKER_SECRET}\n`,
      `${WORKER_SECRET}\x7f`,
      `${WORKER_SECRET} unsafe`,
      `${WORKER_SECRET}é`,
      "long-random-secret-for-missed-class-worker",
      "long-random-secret-for-the-deletion-worker",
      "placeholder-automation-worker-secret-1234",
      "replace-me-with-a-random-automation-secret",
    ]) {
      if (secret === undefined) delete process.env.AUTOMATION_WORKER_SECRET;
      else process.env.AUTOMATION_WORKER_SECRET = secret;
      const result = await invoke();
      assert.equal(result.status, 500);
      assert.deepEqual(await result.json(), {
        detail: "Automation worker configuration is unavailable.",
      });
    }
    assert.equal(calls.length, 0);
  });

  it("binds an exact matching environment and backend before reading the worker secret", async () => {
    for (const [environment, target] of [
      ["production", "https://koaryu-staging.onrender.com/api/v1"],
      ["staging", "https://koaryu.onrender.com/api/v1"],
      ["development", "https://koaryu.onrender.com/api/v1"],
      ["test", "https://koaryu-staging.onrender.com/api/v1"],
      ["preview", "https://koaryu-staging.onrender.com/api/v1"],
      ["unknown", "https://koaryu-staging.onrender.com/api/v1"],
      ["staging", "https://attacker.example.test/api/v1"],
      ["staging", "http://127.0.0.1:8001/api/v1"],
      ["staging", "https://user:password@koaryu-staging.onrender.com/api/v1"],
      ["staging", "https://koaryu-staging.onrender.com/api/v1/"],
      ["staging", "https://koaryu-staging.onrender.com/api/v1?target=evil"],
      ["staging", "https://koaryu-staging.onrender.com/api/v1#fragment"],
      ["staging", " https://koaryu-staging.onrender.com/api/v1"],
      ["staging", "https://koaryu-staging.onrender.com/api/v1\n"],
      ["staging", "https://koaryu-staging.оnrender.com/api/v1"],
    ]) {
      process.env.VERCEL_TARGET_ENV = environment;
      process.env.BACKEND_API_URL = target;
      const result = await withoutEnvReads(["AUTOMATION_WORKER_SECRET"], () => invoke());
      assert.equal(result.status, 500, `${environment}: ${target}`);
      assert.deepEqual(await result.json(), {
        detail: "Automation worker configuration is unavailable.",
      });
    }
    assert.equal(calls.length, 0);
  });

  it("uses the pinned HTTPS helper and only dedicated worker headers and a bounded JSON body", async () => {
    process.env.VERCEL_ENV = "preview";
    const result = await invoke();
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), summary());
    assert.deepEqual(calls, [
      {
        transport: "https",
        url: `https://koaryu-staging.onrender.com${WORKER_PATH}`,
        method: "POST",
        headers: { "X-Internal-Secret": WORKER_SECRET, "Content-Type": "application/json" },
        body: '{"limit":10}',
        timeoutMs: 30_000,
        maxResponseBytes: 64 * 1024,
      },
    ]);
  });

  it("falls back to VERCEL_ENV and the configured public API while retaining production binding", async () => {
    delete process.env.VERCEL_TARGET_ENV;
    delete process.env.BACKEND_API_URL;
    process.env.VERCEL_ENV = "production";
    process.env.NEXT_PUBLIC_API_URL = "https://koaryu.onrender.com/api/v1";
    assert.equal((await invoke()).status, 200);
    assert.equal(calls[0].url, `https://koaryu.onrender.com${WORKER_PATH}`);
  });

  it("uses only the bounded local helper for known development/test environments", async () => {
    delete process.env.VERCEL_TARGET_ENV;
    for (const [environment, host] of [
      ["development", "localhost"],
      ["test", "127.0.0.1"],
    ]) {
      process.env.NODE_ENV = environment;
      process.env.BACKEND_API_URL = `http://${host}:8001/api/v1`;
      assert.equal((await invoke()).status, 200);
      assert.equal(calls.at(-1).transport, "local");
      assert.equal(calls.at(-1).url, `http://${host}:8001${WORKER_PATH}`);
    }
  });

  it("fails closed when every deployment environment is absent", async () => {
    delete process.env.VERCEL_TARGET_ENV;
    delete process.env.NODE_ENV;
    assert.equal((await invoke()).status, 500);
    assert.equal(calls.length, 0);
  });

  it("aggregates at most three sequential successful batches and preserves the last has_more", async () => {
    const batches = [
      summary({
        enqueued: 10,
        processed: 10,
        accepted: 9,
        skipped: 1,
        has_more: true,
      }),
      summary({ enqueued: 0, processed: 10, accepted: 9, skipped: 1, has_more: true }),
      summary({ enqueued: 3, processed: 6, accepted: 6, has_more: true }),
    ];
    let inFlight = false;
    httpsRequest = async (options) => {
      assert.equal(inFlight, false);
      inFlight = true;
      calls.push(options);
      await Promise.resolve();
      elapsed += 8_000;
      inFlight = false;
      return pinnedJson(batches[calls.length - 1]);
    };
    const result = await invoke();
    assert.equal(result.status, 200);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      await result.json(),
      summary({
        enqueued: 13,
        processed: 26,
        accepted: 24,
        skipped: 2,
        has_more: true,
      }),
    );
  });

  it("stops as soon as the backend reports no actionable work", async () => {
    const batches = [
      summary({ enqueued: 10, processed: 10, accepted: 10, has_more: true }),
      summary({ enqueued: 2, processed: 2, accepted: 2 }),
    ];
    httpsRequest = async (options) => {
      calls.push(options);
      return pinnedJson(batches[calls.length - 1]);
    };
    const result = await invoke();
    assert.equal(calls.length, 2);
    assert.deepEqual(await result.json(), summary({ enqueued: 12, processed: 12, accepted: 12 }));
  });

  it("stops after a zero-progress batch while preserving actionable-backlog truth", async () => {
    httpsRequest = async (options) => {
      calls.push(options);
      return pinnedJson(summary({ has_more: true }));
    };
    assert.deepEqual(await (await invoke()).json(), summary({ has_more: true }));
    assert.equal(calls.length, 1);
  });

  it("allows enqueue progress before any rows are processed", async () => {
    httpsRequest = async (options) => {
      calls.push(options);
      return pinnedJson(
        calls.length === 1
          ? summary({ enqueued: 10, has_more: true })
          : summary({ processed: 10, accepted: 10 }),
      );
    };
    assert.deepEqual(
      await (await invoke()).json(),
      summary({ enqueued: 10, processed: 10, accepted: 10 }),
    );
    assert.equal(calls.length, 2);
  });

  it("returns all outcomes truthfully and stops further batches on deferred, failed, or unknown sends", async () => {
    for (const outcome of ["retry_wait", "failed", "unknown"]) {
      calls = [];
      const body = summary({ processed: 3, accepted: 1, skipped: 1, [outcome]: 1, has_more: true });
      httpsRequest = async (options) => {
        calls.push(options);
        return pinnedJson(body);
      };
      const result = await invoke();
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), body);
      assert.equal(calls.length, 1);
    }
  });

  it("does not start another 30-second call with less than 30 seconds left", async () => {
    httpsRequest = async (options) => {
      calls.push(options);
      elapsed = 25_001;
      return pinnedJson(summary({ processed: 1, accepted: 1, has_more: true }));
    };
    assert.deepEqual(
      await (await invoke()).json(),
      summary({ processed: 1, accepted: 1, has_more: true }),
    );
    assert.equal(calls.length, 1);
  });

  it("permits the exact 30-second remaining boundary and stops after that call", async () => {
    httpsRequest = async (options) => {
      calls.push(options);
      elapsed += 25_000;
      return pinnedJson(summary({ processed: 1, accepted: 1, has_more: true }));
    };
    assert.deepEqual(
      await (await invoke()).json(),
      summary({ processed: 2, accepted: 2, has_more: true }),
    );
    assert.equal(calls.length, 2);
  });

  it("does not claim success if setup consumed the budget before any call", async () => {
    let clockReads = 0;
    const result = await invoke(request(), { now: () => (clockReads++ === 0 ? 0 : 26_000) });
    assert.equal(result.status, 503);
    assert.equal(calls.length, 0);
  });

  it("rejects extra private fields, missing keys, wrong types, and incoherent counters", async () => {
    const missing = summary();
    delete missing.skipped;
    const bodies = [
      null,
      [],
      "private@example.test",
      missing,
      { ...summary(), recipient_email: "private@example.test" },
      { ...summary(), provider_request_id: "must-not-leak" },
      summary({ has_more: "false" }),
      summary({ has_more: 0 }),
      summary({ processed: 1 }),
      summary({ accepted: 1 }),
      summary({ processed: 1, accepted: 1, skipped: 1 }),
      summary({ processed: 11, accepted: 10, skipped: 1 }),
    ];
    for (const key of COUNT_KEYS) {
      for (const value of [-1, 1.5, "1", true, null, 11, Number.MAX_SAFE_INTEGER + 1]) {
        bodies.push(summary({ [key]: value }));
      }
    }
    for (const body of bodies) {
      calls = [];
      httpsRequest = async (options) => {
        calls.push(options);
        return pinnedJson(body);
      };
      const result = await invoke();
      assert.equal(result.status, 502, JSON.stringify(body));
      assert.deepEqual(await result.json(), {
        detail: "Automation worker did not return a safe result.",
      });
      assert.equal(calls.length, 1);
    }
  });

  it("does not forward malformed JSON or invalid UTF-8", async () => {
    for (const body of [Buffer.from("{private@example.test"), Buffer.from([0xff])]) {
      httpsRequest = async () => ({ status: 200, headers: {}, body });
      const result = await invoke();
      assert.equal(result.status, 502);
      assert.deepEqual(await result.json(), {
        detail: "Automation worker did not return a safe result.",
      });
    }
  });

  it("rejects every non-200 upstream status without forwarding private body details", async () => {
    for (const status of [201, 202, 204, 301, 401, 429, 500, 503]) {
      calls = [];
      httpsRequest = async (options) => {
        calls.push(options);
        return pinnedJson({ detail: "private@example.test", token: "must-not-leak" }, status);
      };
      const result = await invoke();
      assert.equal(result.status, 502);
      assert.deepEqual(await result.json(), {
        detail: "Automation worker did not return a safe result.",
      });
      assert.equal(calls.length, 1);
    }
  });

  it("never replays a lost second response or returns a false successful aggregate", async () => {
    httpsRequest = async (options) => {
      calls.push(options);
      if (calls.length === 2) throw new Error("private@example.test token=must-not-leak");
      return pinnedJson(summary({ processed: 10, accepted: 10, has_more: true }));
    };
    const result = await invoke();
    assert.equal(result.status, 502);
    assert.equal(calls.length, 2);
    assert.deepEqual(await result.json(), {
      detail: "Automation worker request could not be completed.",
    });
  });

  it("returns a generic failure after an invalid later batch without replaying earlier work", async () => {
    httpsRequest = async (options) => {
      calls.push(options);
      return pinnedJson(
        calls.length === 1
          ? summary({ processed: 10, accepted: 10, has_more: true })
          : { recipient_email: "private@example.test" },
      );
    };
    const result = await invoke();
    assert.equal(result.status, 502);
    assert.equal(calls.length, 2);
    assert.deepEqual(await result.json(), {
      detail: "Automation worker did not return a safe result.",
    });
  });

  it("declares the bounded Node route and preserves the two existing daily cron entries", async () => {
    assert.equal(runtime, "nodejs");
    assert.equal(dynamic, "force-dynamic");
    assert.equal(maxDuration, 60);
    const manifest = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
    assert.deepEqual(manifest.crons, [
      { path: "/api/cron/account-deletions/process-due", schedule: "0 8 * * *" },
      { path: "/api/cron/operational-alerts/evaluate", schedule: "0 9 * * *" },
      { path: CRON_PATH, schedule: "0 18 * * *" },
    ]);
    assert.deepEqual(manifest.git.deploymentEnabled, {
      main: false,
      staging: true,
      "codex/launch-readiness-candidate": false,
      "codex/missed-class-automations-20261004": false,
    });
  });
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { pinnedHttpsRequest } from "../src/lib/pinned-https.ts";

function requestHarness({ status = 200, body = "{}", headers = {}, inspect } = {}) {
  return (url, options, callback) => {
    inspect?.(url, options);
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {
      const response = Readable.from([Buffer.from(body)]);
      response.statusCode = status;
      response.headers = headers;
      queueMicrotask(() => callback(response));
    };
    return request;
  };
}

function lookupAll(lookup, hostname) {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (error, answers) => {
      if (error) reject(error);
      else resolve(answers);
    });
  });
}

describe("resolve-once pinned HTTPS", () => {
  it("validates every answer and gives repeated connection lookups only the frozen set", async () => {
    let resolverCalls = 0;
    const observedLookups = [];
    const response = await pinnedHttpsRequest({
      url: "https://alerts.example.net/check",
      headers: { Authorization: "Bearer synthetic-secret" },
      body: "{}",
      timeoutMs: 1_000,
      maxResponseBytes: 64,
      resolveAll: async () => {
        resolverCalls += 1;
        return resolverCalls === 1
          ? [
              { address: "8.8.8.8", family: 4 },
              { address: "2001:4860:4860::8888", family: 6 },
            ]
          : [{ address: "127.0.0.1", family: 4 }];
      },
      requestImpl: requestHarness({
        headers: { "content-type": "application/json" },
        inspect: (url, options) => {
          assert.equal(url.hostname, "alerts.example.net");
          assert.equal(options.servername, "alerts.example.net");
          assert.equal(options.rejectUnauthorized, true);
          assert.equal(options.agent, false);
          assert.ok(options.signal instanceof AbortSignal);
          observedLookups.push(lookupAll(options.lookup, "alerts.example.net"));
          observedLookups.push(lookupAll(options.lookup, "alerts.example.net"));
        },
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(resolverCalls, 1);
    assert.deepEqual(await Promise.all(observedLookups), [
      [
        { address: "8.8.8.8", family: 4 },
        { address: "2001:4860:4860::8888", family: 6 },
      ],
      [
        { address: "8.8.8.8", family: 4 },
        { address: "2001:4860:4860::8888", family: 6 },
      ],
    ]);
  });

  it("rejects private, reserved, or mixed answers before constructing a request", async (context) => {
    const answerSets = [
      [{ address: "10.0.0.1", family: 4 }],
      [{ address: "::1", family: 6 }],
      [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      [{ address: "2001:db8::1", family: 6 }],
    ];
    for (const answers of answerSets) {
      await context.test(JSON.stringify(answers), async () => {
        let requested = false;
        await assert.rejects(pinnedHttpsRequest({
          url: "https://alerts.example.net/check",
          headers: { Authorization: "Bearer synthetic-secret" },
          timeoutMs: 1_000,
          maxResponseBytes: 64,
          resolveAll: async () => answers,
          requestImpl: (...args) => {
            requested = true;
            return requestHarness()(...args);
          },
        }), /only to public addresses/);
        assert.equal(requested, false);
      });
    }
  });

  it("includes DNS resolution in the total timeout without constructing a request", async () => {
    let requested = false;
    const startedAt = Date.now();
    await assert.rejects(pinnedHttpsRequest({
      url: "https://alerts.example.net/check",
      headers: { Authorization: "Bearer synthetic-secret" },
      timeoutMs: 20,
      maxResponseBytes: 64,
      resolveAll: async () => new Promise(() => {}),
      requestImpl: (...args) => {
        requested = true;
        return requestHarness()(...args);
      },
    }), /timed out/);

    assert.equal(requested, false);
    assert.ok(Date.now() - startedAt < 500);
  });

  it("returns redirects without following them and bounds the response body", async () => {
    let requests = 0;
    const base = {
      url: "https://alerts.example.net/check",
      headers: { Authorization: "Bearer synthetic-secret" },
      timeoutMs: 1_000,
      resolveAll: async () => [{ address: "8.8.8.8", family: 4 }],
    };
    const redirect = await pinnedHttpsRequest({
      ...base,
      maxResponseBytes: 64,
      requestImpl: requestHarness({
        status: 302,
        headers: { location: "https://127.0.0.1/credential-sink" },
        inspect: () => { requests += 1; },
      }),
    });
    assert.equal(redirect.status, 302);
    assert.equal(requests, 1);

    await assert.rejects(pinnedHttpsRequest({
      ...base,
      maxResponseBytes: 4,
      requestImpl: requestHarness({ body: "12345" }),
    }), /exceeded the safe limit/);
  });
});

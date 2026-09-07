import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestAuthProfile, AuthProfileRequestError } from '../src/lib/auth-profile-request.ts';

const profile = { user: { id: 'test-user' }, studio_id: 'test-studio', role: 'admin', membership_status: 'active' };
const success = () => Response.json(profile);
const request = (signal = new AbortController().signal) => requestAuthProfile('https://api.example.test/api/v1', 'synthetic-token', signal);

for (const status of [502, 503, 504]) {
  test(`recovers from a single ${status} without changing the authenticated request`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://api.example.test/api/v1/auth/me');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal instanceof AbortSignal);
      return calls++ === 0 ? new Response(null, { status }) : success();
    });
    assert.deepEqual(await request(), profile);
    assert.equal(calls, 2);
  });
}

for (const status of [401, 403, 404, 429, 500]) {
  test(`does not retry ${status}`, async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status }));
    await assert.rejects(request(), (error) => error instanceof AuthProfileRequestError && error.status === status);
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test('persistent service failure stops after two attempts', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  await assert.rejects(request(), (error) => error.status === 503);
  assert.equal(fetch.mock.callCount(), 2);
});

test('honors a long Retry-After by returning unavailable without an early retry', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503, headers: { 'Retry-After': '30' } }));
  await assert.rejects(request(), (error) => error.status === 503);
  assert.equal(fetch.mock.callCount(), 1);
});

test('retries a network failure once', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (calls++ === 0) throw new TypeError('fetch failed');
    return success();
  });
  assert.deepEqual(await request(), profile);
  assert.equal(calls, 2);
});

test('malformed membership is never accepted or retried', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ user: profile.user }));
  await assert.rejects(request(), /membership_status/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('a response body that stalls is bounded by the attempt timeout', async (t) => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', () => originalTimeout(15));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    if (calls++ > 0) return success();
    return { ok: true, json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) };
  });
  // AbortSignal.timeout is unref'ed; hold the test open while simulating a body.
  const keepAlive = setInterval(() => {}, 100);
  try {
    assert.deepEqual(await request(), profile);
    assert.equal(calls, 2);
  } finally {
    clearInterval(keepAlive);
  }
});

test('cancellation during retry delay stops the second request', async (t) => {
  const controller = new AbortController();
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  const pending = request(controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(fetch.mock.callCount(), 1);
});

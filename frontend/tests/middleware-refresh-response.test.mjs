import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import * as studioCookies from '../src/lib/studio-state-cookie.ts';
import * as billingRoutes from '../src/lib/billing-route-access.ts';
import * as authProfileRequest from '../src/lib/auth-profile-request.ts';
import * as authRoutes from '../src/lib/auth-route-model.ts';
import * as authUserRequest from '../src/lib/auth-user-request.ts';
import * as navigationRecovery from '../src/lib/navigation-recovery.ts';
const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');

function loadMiddleware(user, error = null) {
  const compiled = ts.transpileModule(readFileSync(new URL('../src/lib/supabase/middleware.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const result = { exports: {} };
  const imports = {
    '@supabase/ssr': { createServerClient: (_url, _key, { cookies }) => ({ auth: {
      getSession: async () => ({ data: { session: { access_token: 'synthetic-token' } } }),
      getUser: async () => {
        cookies.setAll([{ name: 'session-part-1', value: 'synthetic-first', options: { path: '/', httpOnly: true } }], {
          'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0', Expires: '0', Pragma: 'no-cache',
        });
        cookies.setAll([{ name: 'session-part-2', value: 'synthetic-second', options: { path: '/' } }], {});
        return { data: { user }, error };
      },
    } }) },
    '@/lib/auth-profile-request': authProfileRequest,
    '@/lib/auth-user-request': authUserRequest,
    '@/lib/navigation-recovery': navigationRecovery,
    '@/lib/studio-state-cookie': studioCookies,
    '@/lib/billing-route-access': billingRoutes,
    '@/lib/auth-route-model': authRoutes,
    '@/lib/store-bootstrap-model': { parseAuthProfileResponse: () => { throw new Error('Unexpected profile request'); } },
  };
  new Function('require', 'module', 'exports', compiled)((name) => imports[name] ?? require(name), result, result.exports);
  return result.exports.updateSession;
}

for (const signedIn of [false, true]) {
  test(`refresh cookies and no-store headers survive ${signedIn ? 'document response' : 'login redirect'}`, async () => {
    const oldPreview = process.env.NEXT_PUBLIC_PREVIEW_MODE;
    process.env.NEXT_PUBLIC_PREVIEW_MODE = 'false';
    try {
      const user = signedIn ? { id: 'synthetic-user' } : null;
      const request = new NextRequest('https://example.test/dashboard');
      if (signedIn) request.cookies.set(studioCookies.STUDIO_STATE_COOKIE,
        studioCookies.serializeStudioStateCookie(user.id, true, 'active'));
      const response = await loadMiddleware(user)(request);
      assert.equal(response.status, signedIn ? 200 : 307);
      if (!signedIn) assert.equal(response.headers.get('location'), 'https://example.test/login');
      assert.equal(response.cookies.get('session-part-1')?.value, 'synthetic-first');
      assert.equal(response.cookies.get('session-part-2')?.value, 'synthetic-second');
      assert.match(response.headers.get('cache-control'), /private.*no-store/);
      assert.equal(response.headers.get('expires'), '0');
      assert.equal(response.headers.get('pragma'), 'no-cache');
    } finally {
      if (oldPreview === undefined) delete process.env.NEXT_PUBLIC_PREVIEW_MODE;
      else process.env.NEXT_PUBLIC_PREVIEW_MODE = oldPreview;
    }
  });
}

for (const pathname of ['/students', '/billing']) {
  test(`navigation to ${pathname} recovers from 503 and preserves refreshed cookies`, async (t) => {
    const previous = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test/api/v1';
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => calls++ === 0
      ? new Response(null, { status: 503 })
      : Response.json({ membership_status: 'active', studio_id: 'studio-one', role: 'admin' }));
    try {
      const response = await loadMiddleware({ id: 'synthetic-user' })(new NextRequest(`https://example.test${pathname}`));
      assert.equal(response.status, 200);
      assert.equal(calls, 2);
      assert.equal(response.cookies.get('session-part-1')?.value, 'synthetic-first');
      assert.match(response.headers.get('cache-control'), /private.*no-store/);
      assert.ok(response.cookies.get(studioCookies.STUDIO_STATE_COOKIE));
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = previous;
    }
  });
}

for (const scenario of [
  { name: 'invalid credentials', status: 401, target: '/login' },
  { name: 'denied credentials', status: 403, target: '/login' },
  { name: 'persistent outage', status: 503, target: '/503' },
  { name: 'staff billing denial', status: 200, target: '/access-denied', role: 'instructor' },
]) {
  test(`billing navigation preserves ${scenario.name} handling`, async (t) => {
    const previous = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test/api/v1';
    const fetch = t.mock.method(globalThis, 'fetch', async () => scenario.status === 200
      ? Response.json({ membership_status: 'active', studio_id: 'studio-one', role: scenario.role })
      : new Response(null, { status: scenario.status, headers: { 'Retry-After': '30' } }));
    t.mock.method(console, 'error', () => {});
    try {
      const request = new NextRequest('https://example.test/billing');
      request.cookies.set(studioCookies.STUDIO_STATE_COOKIE,
        studioCookies.serializeStudioStateCookie('synthetic-user', true, 'active'));
      const response = await loadMiddleware({ id: 'synthetic-user' })(request);
      assert.equal(response.headers.get('location'), `https://example.test${scenario.target}${scenario.target === "/503" ? "?returnTo=%2Fbilling" : ""}`);
      assert.equal(fetch.mock.callCount(), 1);
      assert.equal(response.cookies.get('session-part-1')?.value, 'synthetic-first');
      assert.match(response.headers.get('cache-control'), /private.*no-store/);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = previous;
    }
  });
}

for (const failure of [{ name: 'AuthRetryableFetchError', status: 503 }, { name: 'AuthRetryableFetchError', status: 0 }]) {
  test(`temporary auth failure ${failure.status} preserves studio cookies and recovery destination`, async () => {
    const request = new NextRequest('https://example.test/schedule?view=week');
    request.cookies.set(studioCookies.STUDIO_STATE_COOKIE, studioCookies.serializeStudioStateCookie('synthetic-user', true, 'active'));
    const response = await loadMiddleware(null, failure)(request);
    const destination = new URL(response.headers.get('location'));
    assert.equal(destination.pathname, '/503');
    assert.equal(destination.searchParams.get('returnTo'), '/schedule?view=week');
    assert.equal(response.cookies.get(studioCookies.STUDIO_STATE_COOKIE), undefined);
    assert.equal(response.cookies.get(studioCookies.ACTIVE_STUDIO_COOKIE), undefined);
    assert.match(response.headers.get('cache-control'), /private.*no-store/);
  });
}

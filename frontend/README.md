# Koaryu Frontend

Next.js App Router frontend for Koaryu.

The frontend currently targets the Next.js 16 line. Keep `next` and `eslint-config-next` aligned in `package.json`, and keep the checked-in lockfile updated whenever security or framework dependencies change.

Use Node.js 22.13+ for frontend scripts and tests. The Node test runner command uses type stripping for `.ts` imports, so Node 18 is not a supported frontend test baseline.

## Environment

Create `frontend/.env.local` from the checked-in example:

```bash
cp .env.example .env.local
```

Required variables:

- `NEXT_PUBLIC_SUPABASE_URL`: Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Supabase anon key for browser and SSR auth
- `NEXT_PUBLIC_API_URL`: backend API base URL, typically `http://127.0.0.1:8001/api/v1`
- `NEXT_PUBLIC_SITE_URL`: frontend origin used for auth callback links, typically `http://localhost:4000` locally and `https://koaryu.app` in production
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`: Stripe publishable key for frontend billing flows
- `CRON_SECRET`: server-only Vercel Cron secret for scheduled internal maintenance routes
- `ACCOUNT_DELETION_WORKER_SECRET`: server-only secret used by the Vercel Cron route when it calls the protected Render account-deletion worker
- `NEXT_PUBLIC_USE_API_PROXY` (optional): set to `true` only when browser API calls should go through the Next.js proxy route instead of directly using `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_PREVIEW_MODE` (optional): set to `true` for static preview/demo data instead of live auth and backend bootstrapping
- `NEXT_PUBLIC_STUDENTS_PAGED_ROSTER` (optional): defaults to `true`; set to `false` as a rollback switch for the backend-paginated Students roster
- `NEXT_PUBLIC_KOARYU_PERFORMANCE_DEBUG` (optional): set to `true` temporarily to log Koaryu performance marks and Web Vitals in production

The `NEXT_PUBLIC_` variables are read during `next build`, so they must also be configured on Vercel before production deploys. The server-only cron secrets are read by the deployed route at runtime and must not be exposed as `NEXT_PUBLIC_` values.

Production deploys should be verified after every dependency update with `npm run lint`, `npm run build`, and a Vercel deployment check. A local build proves the static/runtime bundle compiles, but it does not prove Vercel has the right environment values baked into the deployed build.

## Development

```bash
npm install
npm run dev
```

The local dev server runs at [http://localhost:4000](http://localhost:4000).

## Build

```bash
npm run build
```

If the build fails with `@supabase/ssr: Your project's URL and API key are required`, set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in the current environment.

## Stateful E2E Checks

The Playwright belt-ladder check is an opt-in live-stateful smoke test. Run it only against a disposable account and studio name:

```bash
KOARYU_LIVE_STATEFUL_E2E=true \
KOARYU_E2E_LOGIN_EMAIL=... \
KOARYU_E2E_LOGIN_PASSWORD=... \
KOARYU_E2E_STUDIO_NAME="Disposable Belt Ladder Smoke" \
npx playwright test e2e/atomic-belt-ladder.spec.ts
```

Do not point this check at production accounts or reusable customer data. The test intentionally avoids logging account identifiers.

## Bundle Analysis

```bash
npm run analyze
```

This uses Next.js 16's built-in Turbopack analyzer (`next build --experimental-analyze`) so bundle checks do not require an extra dependency.

## Performance Rollout

See [docs/performance-rollout.md](../docs/performance-rollout.md) before enabling the v0.1.1 rendering changes in production. The short version: keep `NEXT_PUBLIC_STUDENTS_PAGED_ROSTER=true`, let the dashboard summary load after bootstrap, and use the documented switches only for rollback or short diagnostic windows.

## Landing Page And Backend Warmup

The `/` landing page is intentionally outside the Supabase auth middleware matcher so it can paint immediately as informational UI. After hydration, `BackendWarmup` calls `/api/proxy/health` in the background. That request wakes the Render backend without blocking the landing page or requiring a logged-in session.

Keep `/login`, `/signup`, `/onboarding`, `/subscription-required`, and dashboard routes in the auth proxy matcher. Those routes still depend on the normal Supabase session and backend profile checks.

## API Proxy And Studio Identity

Studio identity is always derived from the authenticated backend user before data access. The `X-Studio-Id` value is only an active-studio selector, and backend dependencies must validate it against the user's `staff_roles` membership before using it.

When `NEXT_PUBLIC_USE_API_PROXY=true`, browser API requests go through `/api/proxy`. In that mode the browser API wrapper does not send `X-Studio-Id`, and the proxy ignores any caller-supplied studio header. The proxy forwards `X-Studio-Id` upstream only from the `koaryu-active-studio` cookie observed by the Next.js server. Direct browser-to-backend mode still attaches the active-studio header because there is no Next.js server boundary to derive it, but the shared browser API helper strips any caller-supplied studio header before it adds the active selector.

## Vercel

The frontend Vercel project should use this `frontend/` directory as the app root and define these Production environment variables:

```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add NEXT_PUBLIC_API_URL production
vercel env add NEXT_PUBLIC_SITE_URL production
vercel env add NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY production
vercel env add CRON_SECRET production
vercel env add ACCOUNT_DELETION_WORKER_SECRET production
```

Use the Preview environment too if PR or branch deployments need to boot against Supabase and the backend.

For production, `NEXT_PUBLIC_API_URL` should point to the deployed Render API base, for example `https://koaryu.onrender.com/api/v1`. The landing-page warmup route derives its target from that same value.

`CRON_SECRET` cannot contain leading or trailing whitespace. Vercel rejects cron requests with an invalid bearer header if the secret was pasted with an accidental newline. `ACCOUNT_DELETION_WORKER_SECRET` must exactly match the Render backend value.

After Vercel deploys, smoke-test at least login, dashboard load, Settings, Billing, and the Koaryu Core subscription status from the production domain. These routes exercise Supabase SSR auth, the baked API URL, and the Stripe publishable-key path.

## Admin Demo Utilities

Settings includes admin-only demo/data utilities intended for controlled demos and cleanup:

- Demo reset can replace working demo data when the backend allows it.
- Clear studio data uses the exact confirmation prompt `Are you sure this is going to delete everything?` before deleting working studio records.

Both tools are destructive. They are designed to preserve Koaryu Core subscription/platform access rows, but they should still be used only against a disposable demo studio unless data loss is intended.

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

# Koaryu Frontend

Next.js App Router frontend for Koaryu.

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
- `NEXT_PUBLIC_USE_API_PROXY` (optional): set to `true` only when browser API calls should go through the Next.js proxy route instead of directly using `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_PREVIEW_MODE` (optional): set to `true` for static preview/demo data instead of live auth and backend bootstrapping

These variables are read during `next build`, so they must also be configured on Vercel before production deploys.

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

## Landing Page And Backend Warmup

The `/` landing page is intentionally outside the Supabase auth middleware matcher so it can paint immediately as informational UI. After hydration, `BackendWarmup` calls `/api/proxy/health` in the background. That request wakes the Render backend without blocking the landing page or requiring a logged-in session.

Keep `/login`, `/signup`, `/onboarding`, `/subscription-required`, and dashboard routes in the auth proxy matcher. Those routes still depend on the normal Supabase session and backend profile checks.

## Vercel

The frontend Vercel project should use this `frontend/` directory as the app root and define these Production environment variables:

```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add NEXT_PUBLIC_API_URL production
vercel env add NEXT_PUBLIC_SITE_URL production
vercel env add NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY production
```

Use the Preview environment too if PR or branch deployments need to boot against Supabase and the backend.

For production, `NEXT_PUBLIC_API_URL` should point to the deployed Render API base, for example `https://koaryu.onrender.com/api/v1`. The landing-page warmup route derives its target from that same value.

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

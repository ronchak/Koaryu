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

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

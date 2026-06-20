# Frontend Agent Guide

This package is the Koaryu Next.js App Router frontend.

Use this file for work under `frontend/`. Fall back to the repo root `AGENTS.md` for shared rules.

## Path Guide

- `src/app/`: App Router pages, layouts, route handlers, metadata, and page-level loading/error states
- `src/components/`: shared UI, shells, navigation, marketing, dashboard components
- `src/lib/`: stores, constants, Supabase helpers, proxy helpers, CSV/performance utilities
- `src/types/`: shared frontend types
- `tests/`: Node-based frontend tests

## Stack

- Next.js `16`
- React `19`
- TypeScript
- Node.js `22.13+` for local frontend scripts and Node test runner type stripping
- Tailwind CSS `4`
- ESLint `9`

## Core Commands

- Install deps: `cd frontend && npm install`
- Start dev server: `cd frontend && npm run dev`
- Lint: `cd frontend && npm run lint`
- Lint specific files: `cd frontend && npm run lint -- src/path/to/file.tsx`
- Test: `cd frontend && npm run test`
- Build: `cd frontend && npm run build`
- Analyze bundle: `cd frontend && npm run analyze`

The local frontend runs on `http://localhost:4000`.

## Environment

- Copy local env file from the example when needed: `cd frontend && cp .env.example .env.local`
- Required build-time values include `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`, and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.
- Server-only cron secrets such as `CRON_SECRET` and `ACCOUNT_DELETION_WORKER_SECRET` must never be exposed via `NEXT_PUBLIC_` variables.

If `npm run build` fails with missing Supabase URL or anon key errors, check the current shell environment or `.env.local` first.

## Editing Guidance

- Preserve the App Router structure and existing component organization.
- Keep `next` and `eslint-config-next` aligned when changing framework versions.
- Avoid editing `frontend/.next/`.
- Prefer focused fixes over broad UI rewrites unless requested.
- Keep the public landing page behavior intact unless the task is specifically about auth or warmup routing.
- When touching `src/app/api/` or proxy code, verify secrets stay server-side and response headers still match current safety expectations.
- When touching dashboard pages, preserve partial-loading and preview/live-mode behavior unless the task explicitly changes it.

## Common Tasks

- New page or route segment: add the route under `src/app/`, keep metadata and navigation consistency in mind, and update related shared components only if needed.
- Shared UI change: prefer editing the underlying component in `src/components/` instead of duplicating page-local markup.
- Utility or data-shaping change: add or update a focused test in `frontend/tests/` when the code is not purely presentational.
- Proxy or auth-adjacent change: review nearby middleware/proxy behavior and run a full `npm run build` before sign-off.

## Verification

- For targeted UI changes, run lint on the touched files first.
- For utility changes with existing test coverage patterns, run `cd frontend && npm run test`.
- Run `cd frontend && npm run build` before signing off on changes that affect routing, middleware, auth bootstrapping, or environment-dependent pages.
- When changing login, dashboard, settings, billing, or proxy behavior, also review the expectations documented in `frontend/README.md`.

## Done Checklist

- Lint the touched frontend files at minimum.
- Run tests for touched utilities/helpers when applicable.
- Run a full build for routing, auth, proxy, or environment-sensitive changes.
- Keep `frontend/README.md` or related runbooks in sync if the workflow materially changed.

## Important References

- Package overview: `frontend/README.md`
- Performance rollout notes: `docs/performance-rollout.md`
- Deployment expectations: `docs/render-backend-deployment.md`

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
- Format authored files: `cd frontend && npm run format`
- Check authored file formatting: `cd frontend && npm run format:check`
- Test: `cd frontend && npm run test`
- First test setup on a fresh machine: `cd frontend && npx playwright install chromium` for mounted lifecycle tests. Linux CI uses `--with-deps`.
- Live-mode workflow regressions (synthetic auth/I/O, no external data): `cd frontend && node --experimental-strip-types --test tests/workflow-stabilization-mounted.test.mjs`
- Preview smoke e2e: `cd frontend && npm run test:e2e:preview-smoke` against a running preview-mode frontend
- Landing page mobile checks: `cd frontend && npx playwright test e2e/marketing-journey-mobile.spec.ts e2e/marketing-journey-history.spec.ts --workers=1` against a loopback frontend. Covers all 14 chapters on small phones, landscape, tablet, tap-through details, stationary swipe navigation, FAQ, desktop and history behavior.
- Linked marketing-page checks: `cd frontend && npx playwright test e2e/marketing-pages.spec.ts --workers=1` against a loopback frontend. Covers the 11 marketing guides, permanent redirects from Explore/About/the family guide, unknown-slug 404s, useful link and download outcomes, mobile/desktop overflow, touch targets, navigation without JavaScript, local anchors, and landing/document history. Repeat with `--browser=webkit` for WebKit.
- Build: `cd frontend && npm run build`
- Analyze bundle: `cd frontend && npm run analyze`

The local frontend runs on `http://localhost:4000`.

## Environment

- Copy local env file from the example when needed: `cd frontend && cp .env.example .env.local`
- Required build-time values include `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`, and `NEXT_PUBLIC_SITE_URL`.
- Server-only cron secrets such as `CRON_SECRET` and `ACCOUNT_DELETION_WORKER_SECRET` must never be exposed via `NEXT_PUBLIC_` variables.

If `npm run build` fails with missing Supabase URL or anon key errors, check the current shell environment or `.env.local` first.

## Editing Guidance

- Preserve the App Router structure and existing component organization.
- Keep `next` and `eslint-config-next` aligned when changing framework versions.
- Avoid editing `frontend/.next/`.
- Prefer focused fixes over broad UI rewrites unless requested.
- Keep the public landing page behavior intact unless the task is specifically about auth or warmup routing.
- Preserve the landing journey's desktop artwork and sequence. Mobile chapters fit entirely between the header and pager. Use tap-through detail panels instead of internal scrolling or shrinking away copy. The mobile-only document lock must clean up on route exit and desktop resize. After changing SVG material filters, regenerate the matching mobile textures with `node scripts/generate-journey-textures.mjs` from `frontend/`.
- Linked marketing guides use normal document scrolling and server-rendered page-specific layouts in `feature-pages` and `workflow-pages`. Keep their shared document header/footer and baked paper texture scoped to `public-pages`; do not change the landing journey through shared styles. Label illustrative product records and preserve current tuition-activation, export, and staff-access limits.
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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

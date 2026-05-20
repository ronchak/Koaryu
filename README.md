# Koaryu

**CRM for Martial arts studios that doesn't scam you!!**

> **A warrior's flow.** The daily operating system for independent martial arts studios.

Koaryu blends "Koa" (Hawaiian for warrior) with "Ryu" (Japanese for flow / school of martial arts). A flat-rate vertical SaaS that replaces spreadsheets and overpriced legacy tools with purpose-built software for student management, belt progression, scheduling, billing, and retention.

My first paid job in high school was in a martial arts studio, and I saw firsthand just how suffocating CRM software for Martial Arts was, sometimes costing more than $150-$200 a month. In fact, the absolute cheapest purpose built software for martial arts studios I could find was still $49 a month. I think we can do better (or at the very least, way cheaper).

## Architecture

```
koaryu/
├── frontend/           # Next.js App Router (TypeScript, Tailwind)
├── backend/            # FastAPI (Python 3.11+)
├── supabase/           # Database migrations
└── README.md
```

## Environment

Koaryu uses Supabase Auth in the frontend and a FastAPI backend that talks to Supabase with the service role for tenant-scoped CRUD and onboarding writes.

Frontend environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`: your Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: the public anon key used by the browser and SSR middleware
- `NEXT_PUBLIC_API_URL`: backend API base URL, typically `http://localhost:8001/api/v1`
- `NEXT_PUBLIC_SITE_URL`: public frontend origin used for auth callback links, typically `https://koaryu.app` in production
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`: Stripe publishable key used by frontend billing flows
- `CRON_SECRET`: server-only Vercel Cron secret used to authenticate scheduled internal maintenance routes
- `ACCOUNT_DELETION_WORKER_SECRET`: server-only Vercel value that must match the backend worker secret so the scheduled account-deletion route can call the protected backend processor
- `NEXT_PUBLIC_USE_API_PROXY` (optional): set to `true` only when browser API calls must route through the Next.js proxy instead of calling `NEXT_PUBLIC_API_URL` directly
- `NEXT_PUBLIC_PREVIEW_MODE` (optional): when `true`, bypasses live auth/data bootstrapping and serves preview/demo data only

Backend environment variables:

- `SUPABASE_URL`: same Supabase project URL used by the frontend
- `SUPABASE_SERVICE_ROLE_KEY`: required for backend access to studio-scoped CRUD, onboarding, and verification scripts
- `SUPABASE_JWT_SECRET`: used to validate Supabase access tokens
- `FRONTEND_URL`: primary allowed frontend origin, typically `http://localhost:4000`
- `ENVIRONMENT`: environment label such as `development` or `production`
- `DEMO_RESET_ENABLED`: set to `true` only for controlled demo/staging environments where the demo reset endpoint should be available
- `STRIPE_SECRET_KEY`: Stripe secret key used by Koaryu Core billing and connected-account billing operations
- `STRIPE_RESTRICTED_KEY`: optional restricted Stripe key for dashboard/API operations that should not need the full secret key
- `STRIPE_PLATFORM_WEBHOOK_SECRET`: Stripe webhook signing secret for platform billing events
- `STRIPE_CONNECT_WEBHOOK_SECRET`: Stripe webhook signing secret for Connect events; comma-separated values are supported during secret rotation or split endpoint setup
- `STRIPE_KOARYU_CORE_PRICE_ID`: recurring Stripe Price ID for the Koaryu Core subscription
- `STRIPE_CONNECT_CLIENT_ID`: Stripe Connect client ID used for connected-account onboarding
- `BILLING_PLATFORM_FEE_BPS`: Koaryu platform fee in basis points for student billing; defaults to `50`
- `ACCOUNT_DELETION_WORKER_SECRET`: long random secret required by the internal due-account-deletion processor
- `SUPPORT_TRIAGE_SECRET`: long random secret required by the internal support ticket triage endpoint

When `ENVIRONMENT=production`, the backend fails startup if required Supabase, Stripe, or public frontend configuration is missing, blank, placeholder, or pointed at a local frontend origin. This is intentional: a broken deploy should fail loudly rather than booting into a half-live billing state.

Local defaults in this repo assume:

- frontend at `http://localhost:4000`
- backend at `http://localhost:8001`

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.11+
- A Supabase project (free tier works)

### One-command local startup

From the repo root:

```bash
npm run dev:up
```

That starts:

- frontend at `http://localhost:4000`
- backend at `http://127.0.0.1:8001`

If you prefer to run each service manually, use the commands below.

### Frontend

```bash
cd frontend
cp .env.example .env.local
# Fill in NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
# NEXT_PUBLIC_API_URL, NEXT_PUBLIC_SITE_URL, and NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
npm install
npm run dev
```

### Backend

```bash
cd backend
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET,
# FRONTEND_URL, and Stripe billing values if you are testing billing locally
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001
```

### Database

Apply the SQL files in `supabase/migrations/` in timestamp order. For a deployment-ready environment, include the current tenant-hardening migrations, especially:

- `20260421000007_harden_tenant_policies.sql`
- `20260421000008_fix_recursive_staff_roles_policies.sql`

If you are using the Supabase SQL Editor instead of the CLI, run every migration file in order rather than only the initial schema.

## Auth, Onboarding, And Tenant Model

The current Supabase/auth flow is hardened around a strict fresh-account experience:

- unauthenticated users are routed to `/login`
- authenticated users without a studio are routed to `/onboarding`
- authenticated users with a studio are routed away from `/login`, `/signup`, and `/onboarding` to the dashboard
- live mode no longer falls back to `"My Studio"` or preview arrays when `/auth/me` or `/studios/current` shows the user has not completed onboarding
- a brand-new live account should land in an empty real studio after onboarding, with no stray mock/demo data

Studio membership is the tenant boundary. Backend services and RLS policies are intended to scope records by `studio_id`, and the live frontend onboarding gate now relies on the backend auth profile instead of a fragile direct `staff_roles` query.

## Deployment And Demo Notes

- Backend deployment is currently prepared for Render via `render.yaml`. Create a Render Blueprint from this repo, and use `docs/render-backend-deployment.md` plus `backend/.env.render.example` as the setup checklist.
- Render starts the FastAPI backend with a single Uvicorn process in production. Keep the root `render.yaml`, `backend/Procfile`, and `docs/render-backend-deployment.md` start commands aligned.
- Production backend startup validates required Supabase, Stripe, and frontend origin configuration before serving traffic. If Render deploys but the service exits immediately, check the runtime logs for `Production configuration is incomplete`.
- The Vercel frontend project must define the build-time public variables `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`, and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` for Production. Add them in Vercel Project Settings or with:

```bash
cd frontend
vercel link --yes --project koaryu
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add NEXT_PUBLIC_API_URL production
vercel env add NEXT_PUBLIC_SITE_URL production
vercel env add NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY production
```

- Missing Supabase public variables will fail `next build` while prerendering auth pages such as `/login`, because `@supabase/ssr` requires the project URL and anon key when the client is created.
- For preview deployments, add the same variables to the Preview environment. With recent Vercel CLI versions, branch-scoped preview variables may require an explicit branch argument.
- Backend deployments must include `SUPABASE_SERVICE_ROLE_KEY`; the frontend must not receive that key.
- Keep `FRONTEND_URL` and `NEXT_PUBLIC_API_URL` aligned with the deployed origins so auth redirects, CORS, and middleware checks hit the correct backend.
- The informational landing page is intentionally not part of the Supabase auth middleware gate. It paints as static marketing UI, then warms the backend in the background through `/api/proxy/health` so a follow-up visit to login or dashboard has a better chance of finding Render awake.
- Login, signup, onboarding, subscription-required, and dashboard routes still block on the normal auth/session behavior. Do not add `/` back to the frontend proxy matcher unless the landing page should become auth-aware again.
- Preview mode is for demos only. Live mode now starts empty for new studios and should be used for deployment verification.
- The repo does not currently ship seeded example CSV imports or a packaged demo tenant. For demos, prepare a small example CSV and/or a dedicated demo studio ahead of time.
- Repeated public signups against a shared dev Supabase project can hit Supabase email rate limits. For heavy QA loops, use a dedicated project, stagger signups, or create test users through an admin flow instead of repeated public signup attempts.
- The demo reset and clear-studio-data tools are intentionally dangerous admin utilities. They preserve Koaryu Core subscription/platform access rows, but they can replace or delete working studio data and should only be used against a demo or disposable studio after the confirmation prompt is understood.
- A dojo-floor demo should run on a paid/warm Render instance or an equivalent always-on backend. Free-tier cold starts can make a correct billing flow look broken during the first click.

## Account And Support Operations

- Account deletion is a scheduled workflow. The user-facing button creates a 30-day request; deletion can be canceled before the deadline.
- A protected worker endpoint processes due requests: `POST /api/v1/internal/account-deletions/process-due` with `X-Internal-Secret: $ACCOUNT_DELETION_WORKER_SECRET`.
- Vercel Cron calls `/api/cron/account-deletions/process-due` once daily from `frontend/vercel.json`. That route requires Vercel's `Authorization: Bearer $CRON_SECRET` header, then calls the protected Render backend endpoint with `ACCOUNT_DELETION_WORKER_SECRET`.
- The processor removes Koaryu staff-role rows, deletes the Supabase Auth user, and marks the request completed.
- Owner accounts must transfer studio ownership to another active admin before deletion. Account Settings includes the ownership transfer control.
- Support requests are stored as tickets, shown back to the user on the support page, and exposed for operator/GPT triage at `GET /api/v1/internal/support/tickets` with `X-Internal-Secret: $SUPPORT_TRIAGE_SECRET`.
- The internal support endpoint is intentionally read-only for now. Use it for a simple polling task or manual triage queue until outbound notification tooling is added.

## Billing Readiness

Koaryu has two billing surfaces:

- Koaryu Core billing: the studio's subscription to Koaryu.
- Koaryu Payments: a connected studio charging its own students/payers through Stripe Connect.

Before presenting billing live, verify both surfaces after the latest deploy:

- Render and Vercel deployments are green for the same commit.
- `/health` and `/api/v1/health` return `200` from the deployed backend.
- A studio admin can open Koaryu Core checkout or billing portal without creating duplicate active subscriptions.
- `/api/v1/billing/system/status` reports configured Stripe keys, connected-account readiness, Supabase reachability, and healthy platform/Connect webhook processing for the target studio.
- Stripe Dashboard shows successful deliveries for the platform and Connect webhook endpoints.
- The target studio's Stripe Connect account has `charges_enabled`, `payouts_enabled`, `details_submitted`, and no currently due requirements.
- At least one live or test-mode rehearsal has covered payer creation, saved card/autopay authorization, subscription enrollment, invoice payment projection, and cancellation cleanup.

If Stripe has the right object state but Koaryu looks stale, use the authenticated billing reconciliation endpoint documented in `docs/render-backend-deployment.md`.

## Recent Live-Mode Improvements

Recent deployment-readiness work in this repo tightened live-mode persistence and tenant scoping around:

- Supabase auth and onboarding behavior for fresh accounts
- multi-tenant studio isolation
- CSV import in live mode
- lead conversion into students
- reports and student hold data paths
- belt ladder and related live persistence
- Render cold-start behavior by replacing the four-worker Gunicorn command with a single Uvicorn process
- landing-page first paint by removing auth middleware from `/` while keeping a non-blocking backend warmup
- Koaryu Core checkout/portal duplicate-subscription protection and webhook ordering
- Koaryu Payments autopay authorization, Connect webhook projection, invoice reconciliation, and cancellation cleanup
- production startup checks for missing or placeholder Supabase/Stripe/frontend configuration
- admin-only demo reset and clear-studio-data operations that preserve platform subscription access
- frontend polish for dark/light theme support, dashboard route transitions, shared modal transitions, and reduced-motion-friendly UI transitions

## Verification Snapshot

The current dev verification pass included:

- health checks against `/health` and `/api/v1/health`
- local Uvicorn production-command startup against the backend `/health` endpoint
- fresh-account auth and onboarding flow verification
- redirect verification for unauthenticated users, new signed-in users, and fully onboarded users
- multi-user tenant isolation checks across separate studios
- fresh studio behavior checks to confirm empty live state instead of mock/demo fallback
- lint and Python compile checks after the auth/onboarding hardening work
- targeted frontend lint for landing-page warmup, auth middleware, and proxy changes
- full backend pytest coverage for the billing hardening and production config checks
- frontend lint, audit, and production build checks after the current dependency and billing UI changes
- live Stripe verification for Koaryu Core and Koaryu Payments, including a real small-dollar student billing test and webhook/reconciliation checks

The local Supabase-backed verification also surfaced a real `staff_roles` RLS recursion issue, which is now covered by the migration set and avoided in the live frontend gating path.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js, TypeScript, Tailwind CSS, lucide-react |
| Backend | FastAPI, Pydantic v2, Supabase-py |
| Database | PostgreSQL via Supabase (RLS for multi-tenancy) |
| Auth | Supabase Auth (email/password + magic link) |
| Payments | Stripe Billing (Phase 6) |
| Email | Resend (Phase 7) |
| Deployment | Vercel + Render |

## License

Proprietary. All rights reserved.

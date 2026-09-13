# Koaryu

**CRM for Martial arts studios that doesn't scam you!!**

> **A warrior's flow.** The daily operating system for independent martial arts studios.

Koaryu blends "Koa" (Hawaiian for warrior) with "Ryu" (Japanese for flow / school of martial arts). A flat-rate vertical SaaS that replaces spreadsheets and overpriced legacy tools with purpose-built software for student management, belt progression, scheduling, billing, and retention.

My first paid job in high school was in a martial arts studio, and I saw firsthand just how suffocating CRM software for Martial Arts was, sometimes costing more than $150-$200 a month. In fact, the absolute cheapest purpose built software for martial arts studios I could find was still $49 a month. I think we can do better (or at the very least, way cheaper).

Current public positioning uses a flat `$27/month` Koaryu Core studio subscription. The `$49/month` note above is market-comparison context for incumbent alternatives, not Koaryu pricing.

## Changelog

Release notes are tracked in [CHANGELOG.md](CHANGELOG.md). Keep that file as the source of truth for released changes and avoid duplicating unreleased notes here.

Koaryu operators should start with [Koaryu Operations](docs/koaryu-operations.md). The exact supported billing surface and its live-mutation interlock are documented in [Billing Boundary](docs/billing-boundary.md).

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
- `BACKEND_API_URL`: server-only backend API base URL for Next.js API proxy and cron routes; defaults to the public API URL only when this is not set
- `NEXT_PUBLIC_SITE_URL`: public frontend origin used for auth callback links, typically `https://koaryu.app` in production
- `CRON_SECRET`: server-only Vercel Cron secret used to authenticate scheduled internal maintenance routes
- `ACCOUNT_DELETION_WORKER_SECRET`: server-only Vercel value that must match the backend worker secret so the scheduled account-deletion route can call the protected backend processor
- `NEXT_PUBLIC_USE_API_PROXY` (optional): set to `true` only when browser API calls must route through the Next.js proxy instead of calling `NEXT_PUBLIC_API_URL` directly
- `NEXT_PUBLIC_PREVIEW_MODE` (optional): when `true`, bypasses live auth/data bootstrapping and serves preview/demo data only
- `NEXT_PUBLIC_STUDENTS_PAGED_ROSTER` (optional): defaults to `true`; set to `false` as a rollback switch for the backend-paginated Students roster
- `NEXT_PUBLIC_KOARYU_PERFORMANCE_DEBUG` (optional): set to `true` temporarily to log Koaryu performance marks and Web Vitals in production

Backend environment variables:

- `SUPABASE_URL`: same Supabase project URL used by the frontend
- `SUPABASE_DEVELOPMENT_PROJECT_REF`: exact non-production project ref required when `development` deliberately uses a hosted Supabase project; leave blank for local, test, staging, and production
- `SUPABASE_SERVICE_ROLE_KEY`: required for backend access to studio-scoped CRUD, onboarding, and verification scripts
- `SUPABASE_JWT_SECRET`: legacy HS256 validation secret; ignored unless `SUPABASE_ALLOW_LEGACY_HS256=true`
- `SUPABASE_ALLOW_LEGACY_HS256`: defaults to `false`; enable only for a time-bounded legacy-token migration (the local Supabase stack still uses `true`)
- `FRONTEND_URL`: primary allowed frontend origin, typically `http://localhost:4000`
- `ENVIRONMENT`: environment label such as `development` or `production`
- `DEMO_RESET_ENABLED`: set to `true` only for controlled demo/staging environments where demo data tools should be available
- `DEMO_RESET_STUDIO_IDS`: comma-separated studio IDs that demo reset and clear-studio-data may target; keep empty in production
- `STRIPE_MODE`: explicit Stripe environment, `test` or `live`; it must match the secret and optional restricted key prefixes
- `LIVE_BILLING_ENABLED`: defaults to `false`; it is a global prerequisite, not sufficient authorization, for outbound live Stripe mutations
- `STRIPE_SECRET_KEY`: Stripe secret key used by Koaryu Core billing and connected-account billing operations
- `STRIPE_RESTRICTED_KEY`: optional restricted Stripe key for dashboard/API operations that should not need the full secret key
- `STRIPE_PLATFORM_WEBHOOK_SECRET`: Stripe webhook signing secret for platform billing events
- `STRIPE_CONNECT_WEBHOOK_SECRET`: Stripe webhook signing secret for Connect events; comma-separated values are supported during secret rotation or split endpoint setup
- `STRIPE_KOARYU_CORE_PRICE_ID`: recurring Stripe Price ID for the Koaryu Core subscription
- Stripe connected-account onboarding uses Account Links, so it does not require a Connect OAuth client ID.
- `BILLING_PLATFORM_FEE_BPS`: Koaryu platform fee in basis points for student billing; defaults to `50`
- `ACCOUNT_DELETION_WORKER_SECRET`: long random secret required by the internal due-account-deletion processor
- `SUPPORT_TRIAGE_SECRET`: long random secret required by the internal support ticket triage endpoint

The backend validates the Supabase target before readiness and before every shared service-role client is constructed. Production and staging are pinned to their exact Koaryu projects. Test permits only the canonical local URL or shipped placeholders. Development additionally permits an explicitly pinned hosted project that is neither Koaryu production nor staging. The pinned Supabase client cannot disable environment trust across all of its component transports, so service-role clients fail closed when any HTTP proxy or CA-bundle override is active. `NO_PROXY` does not override that refusal.

When `ENVIRONMENT=production`, the backend requires `STRIPE_MODE=live` with matching `sk_live_` and optional `rk_live_` keys, and fails startup if required Supabase, Stripe, or public frontend configuration is missing, blank, placeholder-shaped, malformed, mode-mismatched, or pointed at a local origin. This prevents test Stripe identifiers from being written into production tenant records. For Stripe Connect and tuition mutations, `LIVE_BILLING_ENABLED=true` satisfies only the global environment interlock; each operation still requires the exact studio grant and operation permission. Turning that switch off closes those outbound writes while matching live webhooks and provider reads can still reconcile existing state. Koaryu Core uses its separate `CORE_SELF_CHECKOUT_ENABLED` interlock and exact-operation safeguards.

Local defaults in this repo assume:

- frontend at `http://localhost:4000`
- backend at `http://localhost:8001`

## Getting Started

### Prerequisites

- Node.js 22.13+ for frontend scripts and tests
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

The dev scripts only stop processes that were recorded by this repo's launcher under `.koaryu-dev/`. If port `4000` or `8001` is already owned by another process, `npm run dev:up` exits and asks you to stop that process manually instead of killing it.

If you prefer to run each service manually, use the commands below.

### Frontend

```bash
cd frontend
cp .env.example .env.local
# Fill in NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
# NEXT_PUBLIC_API_URL, BACKEND_API_URL, and NEXT_PUBLIC_SITE_URL
npm install
npm run dev
```

### Backend

```bash
cd backend
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_DEVELOPMENT_PROJECT_REF when hosted,
# SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET,
# FRONTEND_URL, and Stripe billing values if you are testing billing locally
python -m venv venv
source venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8001
```

### Database

For development and SQL review, use the disposable PostgreSQL 17 verifier. It
replays the complete migration chain and all contracts without Docker, a hosted
project, credentials or `.env` files:

```bash
npm run check:supabase-contracts-local
```

When verification needs the assembled local Supabase services, apply unapplied
migrations with `supabase migration up --local`, then use
`supabase db lint --local --fail-on error` and
`SUPABASE_DB_TARGET=local scripts/verify-supabase-contracts.sh` against that
disposable local stack.

Hosted migrations follow [Cutover Gates](docs/cutover-gates.md), including the
human-only production apply. Never run contract SQL against production, even
inside a transaction that rolls back. Linked contracts are only for an explicitly
intended staging verification after staging has the candidate migrations. The SQL
runner accepts only the pinned Koaryu staging connection and rejects routing
overrides. See [Operator Tooling](docs/operator-tooling.md) for connection forms
and private credential handling.

## Auth, Onboarding, And Tenant Model

The current Supabase/auth flow is hardened around a strict fresh-account experience:

- unauthenticated users are routed to `/login`
- authenticated users without a studio are routed to `/onboarding`
- authenticated users with a studio are routed away from `/login`, `/signup`, and `/onboarding` to the dashboard
- live mode no longer falls back to `"My Studio"` or preview arrays when `/auth/me` or `/studios/current` shows the user has not completed onboarding
- a brand-new live account should land in an empty real studio after onboarding, with no stray mock/demo data

Studio membership is the tenant boundary. Backend services and RLS policies are intended to scope records by `studio_id`, and the live frontend onboarding gate now relies on the backend auth profile instead of a fragile direct `staff_roles` query.

Koaryu supports exactly one studio membership per user. Creating or accepting a second active membership is rejected. An unexpected historical multi-membership is preserved but fails closed with a bounded support-remediation message; active multi-studio selection is not a supported workflow.

## Deployment And Demo Notes

- Backend deployment is currently prepared for Render via `render.yaml`. Create a Render Blueprint from this repo, and use `docs/render-backend-deployment.md` plus `backend/.env.render.example` as the setup checklist.
- Render builds `backend/Dockerfile`, preloads jemalloc, verifies the allocator at startup, and starts one Uvicorn process. Keep `render.yaml`, the Docker startup files, and `docs/render-backend-deployment.md` aligned.
- Production backend startup validates required Supabase, Stripe, and frontend origin configuration before serving traffic. If Render deploys but the service exits immediately, check the runtime logs for `Production configuration is incomplete`.
- The Vercel frontend project must define the build-time public variables `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`, and `NEXT_PUBLIC_SITE_URL`, plus the server-only `BACKEND_API_URL` for proxy and cron routes, for Production. Add them in Vercel Project Settings or with:

```bash
cd frontend
vercel link --yes --project koaryu
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add NEXT_PUBLIC_API_URL production
vercel env add BACKEND_API_URL production
vercel env add NEXT_PUBLIC_SITE_URL production
vercel env add CRON_SECRET production
vercel env add ACCOUNT_DELETION_WORKER_SECRET production
```

- Missing Supabase public variables will fail `next build` while prerendering auth pages such as `/login`, because `@supabase/ssr` requires the project URL and anon key when the client is created.
- `CRON_SECRET` must be pasted without leading or trailing whitespace. The Vercel cron route uses it in an HTTP bearer header, so an accidental newline will break the scheduled worker even if the value looks present in the dashboard.
- For preview deployments, add the same variables to the Preview environment. With recent Vercel CLI versions, branch-scoped preview variables may require an explicit branch argument.
- Backend deployments must include `SUPABASE_SERVICE_ROLE_KEY`; the frontend must not receive that key.
- Keep `FRONTEND_URL`, `NEXT_PUBLIC_API_URL`, and `BACKEND_API_URL` aligned with the deployed origins so auth redirects, CORS, proxy routes, and middleware checks hit the correct backend.
- The informational landing page is intentionally not part of the Supabase auth middleware gate. It paints as static marketing UI, then warms the backend in the background through `/api/proxy/health` so a follow-up visit to login or dashboard has a better chance of finding Render awake.
- Login, signup, onboarding, subscription-required, and dashboard routes still block on the normal auth/session behavior. Do not add `/` back to the frontend proxy matcher unless the landing page should become auth-aware again.
- Preview mode is for demos only. Live mode now starts empty for new studios and should be used for deployment verification.
- The repository ships [a sample student CSV](frontend/public/demo-students.csv) for preview-import checks. It does not include a packaged or hosted demo tenant.
- Repeated public signups against a shared dev Supabase project can hit Supabase email rate limits. For heavy QA loops, use a dedicated project, stagger signups, or create test users through an admin flow instead of repeated public signup attempts.
- The demo reset and clear-studio-data tools are intentionally dangerous admin utilities. They preserve Koaryu Core subscription/platform access rows, but they can replace or delete working studio data and now require the target studio ID to be listed in `DEMO_RESET_STUDIO_IDS`.
- A dojo-floor demo should run on the configured Render starter service only after it is warm, or on a larger always-on backend. Cold starts on small Render instances can make a correct billing flow look broken during the first click.
- Rendering/performance changes for v0.1.1 have rollout switches and a smoke checklist in `docs/performance-rollout.md`. Use that runbook before turning the paged Students roster or dashboard summary changes into a production demo dependency.

## Account And Support Operations

- Account deletion is a scheduled workflow. The user-facing button creates a 30-day request; deletion can be canceled before the deadline.
- A protected worker endpoint processes due requests: `POST /api/v1/internal/account-deletions/process-due` with `X-Internal-Secret: $ACCOUNT_DELETION_WORKER_SECRET`.
- Vercel Cron calls `/api/cron/account-deletions/process-due` once daily from `frontend/vercel.json`. That route requires Vercel's `Authorization: Bearer $CRON_SECRET` header, then calls the protected Render backend endpoint with `ACCOUNT_DELETION_WORKER_SECRET`.
- The processor removes Koaryu staff-role rows, deletes the Supabase Auth user, and marks the request completed.
- Owner accounts must transfer studio ownership to another active admin before deletion. Account Settings includes the ownership transfer control.
- Support requests are stored as tickets, shown back to the user on the support page, and exposed for operator triage at `GET /api/v1/internal/support/tickets` with `X-Internal-Secret: $SUPPORT_TRIAGE_SECRET`. The daily GPT digest uses the Supabase connector against the sanitized `support_triage_digest(50)` RPC instead of raw ticket rows.
- Internal support triage actions use `PATCH /api/v1/internal/support/tickets/{ticket_id}`. Status updates and notes are written through a transactional Supabase RPC so the ticket row and event trail stay together.
- See `docs/support-triage.md` for the support queue, privacy rules, status workflow, and daily automation prompt expectations.
- See `docs/email-domain-authentication.md` for the SPF/DMARC/DKIM records that keep `@koaryu.app` from being spoofed, and for the steps required before the domain may ever send mail.

## Billing readiness

Koaryu Core subscription billing and Koaryu Payments tuition workflows have separate controls. The application implements named billing workflows for specific staff roles, but implementation and role permission do not make a workflow commercially available. The environment interlock and an enabled, unexpired exact-studio grant for every required operation must also allow a live provider mutation. Do not assume that any studio has such a grant. See [Billing workflow catalog](docs/billing-workflow-catalog.md) for the maintained workflow classifications and role assignments.

Admin and Front Desk may view existing plans, families, student billing records, invoices, and payments. Instructor access is denied before billing data is fetched. Preview actions are demonstrations only and do not change provider state. Koaryu Payments tuition collection is not generally available unless Koaryu confirms activation for the exact studio.

Before presenting billing behavior, verify Render and Vercel are green for the same exact commit, health/readiness checks pass, Instructor denial discloses no billing data, and each advertised workflow is enabled for the exact studio as described in [Billing Boundary](docs/billing-boundary.md).

## Recent Live-Mode Improvements

Recent deployment-readiness work in this repo tightened live-mode persistence and tenant scoping around:

- Supabase auth and onboarding behavior for fresh accounts
- multi-tenant studio isolation
- CSV import in live mode
- lead conversion into students
- reports and student hold data paths
- belt ladder and related live persistence
- Render memory behavior by running one Uvicorn process under jemalloc and sampling private process RSS every five minutes
- landing-page first paint by removing auth middleware from `/` while keeping a non-blocking backend warmup
- Koaryu Core checkout/portal duplicate-subscription protection and webhook ordering
- Koaryu Payments autopay authorization, Connect webhook projection, invoice reconciliation, and cancellation cleanup
- production startup checks for missing or placeholder Supabase/Stripe/frontend configuration
- admin-only, studio-allowlisted demo reset and clear-studio-data operations that preserve platform subscription access
- frontend polish for dark/light theme support, dashboard route transitions, shared modal transitions, and reduced-motion-friendly UI transitions

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

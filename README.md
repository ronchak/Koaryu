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
- `NEXT_PUBLIC_API_URL`: backend API base URL, typically `http://localhost:8000/api/v1`
- `NEXT_PUBLIC_PREVIEW_MODE` (optional): when `true`, bypasses live auth/data bootstrapping and serves preview/demo data only

Backend environment variables:

- `SUPABASE_URL`: same Supabase project URL used by the frontend
- `SUPABASE_SERVICE_ROLE_KEY`: required for backend access to studio-scoped CRUD, onboarding, and verification scripts
- `SUPABASE_JWT_SECRET`: used to validate Supabase access tokens
- `FRONTEND_URL`: primary allowed frontend origin, typically `http://localhost:4000`
- `ENVIRONMENT`: environment label such as `development` or `production`

Local defaults in this repo assume:

- frontend at `http://localhost:4000`
- backend at `http://localhost:8000`

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.11+
- A Supabase project (free tier works)

### Frontend

```bash
cd frontend
cp .env.example .env.local
# Fill in NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_API_URL
npm install
npm run dev
```

### Backend

```bash
cd backend
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET, FRONTEND_URL
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
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

- Backend deployments must include `SUPABASE_SERVICE_ROLE_KEY`; the frontend must not receive that key.
- Keep `FRONTEND_URL` and `NEXT_PUBLIC_API_URL` aligned with the deployed origins so auth redirects, CORS, and middleware checks hit the correct backend.
- Preview mode is for demos only. Live mode now starts empty for new studios and should be used for deployment verification.
- The repo does not currently ship seeded example CSV imports or a packaged demo tenant. For demos, prepare a small example CSV and/or a dedicated demo studio ahead of time.
- Repeated public signups against a shared dev Supabase project can hit Supabase email rate limits. For heavy QA loops, use a dedicated project, stagger signups, or create test users through an admin flow instead of repeated public signup attempts.

## Recent Live-Mode Improvements

Recent deployment-readiness work in this repo tightened live-mode persistence and tenant scoping around:

- Supabase auth and onboarding behavior for fresh accounts
- multi-tenant studio isolation
- CSV import in live mode
- lead conversion into students
- reports and student hold data paths
- belt ladder and related live persistence

## Verification Snapshot

The current dev verification pass included:

- health checks against `/health` and `/api/v1/health`
- fresh-account auth and onboarding flow verification
- redirect verification for unauthenticated users, new signed-in users, and fully onboarded users
- multi-user tenant isolation checks across separate studios
- fresh studio behavior checks to confirm empty live state instead of mock/demo fallback
- lint and Python compile checks after the auth/onboarding hardening work

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

# Koaryu Services Inventory

Every hosted service Koaryu depends on, and which copy is which. This file exists
because `koaryu-staging` on Render ran for months without being written down
anywhere — it was created in the dashboard, never declared in `render.yaml`, and
nothing noticed when it stopped serving.

**Rule: a hosted service that is not listed here does not exist.** If you create
one, add it here in the same change. If you find one that is not here, either
document it or delete it.

Last verified against live systems: 2026-08-15.

## Quick map

| Layer | Production | Staging |
| --- | --- | --- |
| Frontend | Vercel `koaryu` → `koaryu.app` | Vercel, `staging` branch URL |
| Backend | Render `koaryu` → `koaryu.onrender.com` | Render `koaryu-staging` |
| Database + Auth | Supabase `mimguepumzsgmcaycdsh` | Supabase `nxgsektqsgrtyfhawxbc` |
| Payments | Stripe live mode | Stripe test mode |

Neither production surface auto-deploys. Both are promoted by hand, on purpose —
see [Deployment triggers](#deployment-triggers).

## GitHub

- Repository: `ronchak/Koaryu`
- Default branch: `main`
- Long-lived branches: `main` (production), `staging` (staging frontend)
- CI runs the release-candidate gate on every PR head.

## Vercel — frontend

- Team: `ronakchak2569-8303s-projects` (`team_gLZEwMI0jgTr9zGABNt3Rude`)
- Project: `koaryu` (`prj_ROzEAXoVf0NbUn3jNIKEJPWjF9HU`)
- Production domains: `koaryu.app`, `www.koaryu.app`
- Also attached: `koaryu.vercel.app`, `koaryu-ronakchak2569-8303s-projects.vercel.app`
- Staging URL: `https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app`
  — pinned in `backend/app/core/config.py` as the only frontend origin a staging
  backend will accept.

Configuration lives in `frontend/vercel.json`.

### Vercel cron jobs

Two scheduled jobs run against the production frontend, which forwards them to
the backend. They are declared in `frontend/vercel.json` and their cadence is
enforced by `scripts/check-env-examples.mjs`.

| Path | Schedule (UTC) | Purpose |
| --- | --- | --- |
| `/api/cron/account-deletions/process-due` | `0 8 * * *` | Processes account deletions that have passed their grace period |
| `/api/cron/operational-alerts/evaluate` | `0 9 * * *` | Evaluates operational alert conditions |

## Render — backend

Both services are declared in `render.yaml`. Neither auto-deploys.

| | Production | Staging |
| --- | --- | --- |
| Service name | `koaryu` | `koaryu-staging` |
| Service ID | `srv-d7mogk1kh4rs73aq6hqg` | not currently referenced by tooling |
| URL | `https://koaryu.onrender.com` | `https://koaryu-staging.onrender.com` |
| Plan | `starter` | `free` |
| Region | ohio | ohio |
| Health check | `/health/ready` | `/health/ready` |
| `ENVIRONMENT` | `production` | `staging` |
| Stripe mode | `live` | `test` |

The production service ID is hardcoded in `scripts/merge-release-pr.sh:14`,
which reads live auto-deploy state from `https://api.render.com/v1/services/<id>`
before permitting a release merge. That readback needs `RENDER_API_KEY`.

`/health/ready` fails closed against a database at an unexpected migration. That
is deliberate, and it is why a backend deployed ahead of its migration will sit
unhealthy rather than serve. It is also the most likely reason a Render service
appears to be "down" for no reason.

## Supabase — database, auth, storage

| | Production | Staging |
| --- | --- | --- |
| Project ref | `mimguepumzsgmcaycdsh` | `nxgsektqsgrtyfhawxbc` |
| URL | `https://mimguepumzsgmcaycdsh.supabase.co` | `https://nxgsektqsgrtyfhawxbc.supabase.co` |
| Region | us-west-2 | us-west-1 |
| Postgres | 17 | 17 |

Both refs are pinned in `backend/app/core/config.py`. The backend refuses to boot
if `ENVIRONMENT` and `SUPABASE_URL` disagree, so a staging process cannot be
pointed at production data by editing one variable.

Production is **read-only for agents**. Migrations against production are run by
a human through `scripts/studio-comp-migration-rollout.mjs`.

## Stripe — payments

- Production runs in **live** mode; staging and local run in **test** mode.
- `STRIPE_MODE` must match the secret key prefix (`sk_live_` / `sk_test_`), and
  the backend refuses to start otherwise.
- `LIVE_BILLING_ENABLED` is `false` and gates Connect onboarding and tuition
  payments.
- `CORE_SELF_CHECKOUT_ENABLED` is a separate, narrower production-only switch for
  Core subscription checkout. `config.py` rejects it outside production, so the
  checkout flow cannot be exercised on staging.
- The approved mutation boundary is documented in `docs/billing-boundary.md`.

## Operational alerting

`OPERATIONAL_ALERTS_ENABLED` is `false` in both environments. When enabled it
posts to a primary and backup webhook whose URLs are secrets
(`OPERATIONAL_ALERT_PRIMARY_URL`, `OPERATIONAL_ALERT_BACKUP_URL`), never
committed. See `docs/operational-alerts.md`.

## Deployment triggers

Nothing reaches production automatically. Both gates are enforced by tests, so
neither can be relaxed by accident.

| Surface | Setting | Where | Enforced by |
| --- | --- | --- | --- |
| Backend | `autoDeployTrigger: 'off'` | `render.yaml` | `check-env-examples.mjs` |
| Frontend | `git.deploymentEnabled.main: false` | `frontend/vercel.json` | `check-env-examples.mjs` |

`git.deploymentEnabled.staging` stays `true`: the staging frontend is meant to
track its branch automatically.

**A push to `main` therefore deploys nothing.** Production frontend and backend
are each promoted by hand after the database is migrated. If production looks
stale after a merge, that is the expected behaviour, not a fault.

## Credentials and where they live

Nothing secret belongs in this repository, in agent memory, or in the Obsidian
vault.

| Secret | Where it lives |
| --- | --- |
| Render API key | Render dashboard → Account Settings → API Keys. Not currently on this machine. |
| Supabase service role / JWT secret | Render dashboard env vars, `sync: false` |
| Stripe keys and webhook secrets | Render dashboard env vars, `sync: false` |
| Shared test studio password | macOS Keychain, `Koaryu Shared Core Test - NO BILLING` |
| Non-secret account references | Obsidian vault, `Codex Memory/` |

## Known gaps

- `RENDER_API_KEY` is not available on this machine, so the guarded release merge
  and every Render deploy are director-executed.
- `koaryu-staging` has no service ID recorded here because reading it requires
  that key. Add it once available.
- The staging Render service was created outside the blueprint. It is declared in
  `render.yaml` now, but confirm its dashboard environment variables match that
  declaration — adding it to the blueprint does not retroactively adopt an
  existing service.

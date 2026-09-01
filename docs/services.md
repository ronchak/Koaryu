# Koaryu Services Inventory

Every hosted service Koaryu depends on, and which copy is which. This file exists
because `koaryu-staging` on Render ran for months without being written down
anywhere — it was created in the dashboard, never declared in `render.yaml`, and
nothing noticed when it stopped serving.

**Rule: a hosted service that is not listed here does not exist.** If you create
one, add it here in the same change. If you find one that is not here, either
document it or delete it.

Last verified against live systems: 2026-08-24.

## Quick map

| Layer | Production | Staging |
| --- | --- | --- |
| Frontend | Vercel `koaryu` → `koaryu.app` | Vercel, `staging` branch URL |
| Backend | Render `koaryu` → `koaryu.onrender.com` | Render `koaryu-staging` |
| Database + Auth | Supabase `mimguepumzsgmcaycdsh` | Supabase `nxgsektqsgrtyfhawxbc` |
| Payments | Stripe live mode | Stripe test mode |
| `LIVE_BILLING_ENABLED` | `true` (global interlock only) | `false` |
| `CORE_SELF_CHECKOUT_ENABLED` | `true` (Koaryu Core only) | `false` |
| Period-end billing worker | disabled; production cron awaits approval | Render Cron every 5 minutes |
| `OPERATIONAL_ALERTS_ENABLED` | `false` | `false` |

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

Both web services and the staging billing-transition cron are declared in
`render.yaml`. None auto-deploys.

| | Production | Staging |
| --- | --- | --- |
| Service name | `Koaryu` | `koaryu-staging` |
| Service ID | `srv-d7mogk1kh4rs73aq6hqg` | `srv-d98g4kutrd3s73ek0elg` |
| URL | `https://koaryu.onrender.com` | `https://koaryu-staging.onrender.com` |
| Tracks branch | `main` | `staging` |
| Runtime | Docker, Python 3.11.9 + jemalloc | Docker, Python 3.11.9 + jemalloc |
| Region | Oregon | Oregon |
| Plan | `starter` (paid) | `free` |
| Auto-deploy | off | off |
| Health check | `/health/ready` | `/health/ready` |
| `ENVIRONMENT` | `production` | `staging` |
| Stripe mode | `live` | `test` |

`koaryu-billing-transitions-staging` is a starter Render Cron Job that tracks the
`staging` branch, runs every five minutes, and calls only the protected staging
transition endpoint. It reuses the staging web service's worker secret through a
Render service reference. Each run claims at most 25 transitions and waits up to 130
seconds, beyond the backend bulk lane's 120-second deadline but below the five-minute
cadence. A lost or failed response is safe to retry because the transition intent and
provider mutation keep their durable idempotency identity. Render bills cron execution by runtime with a $1 monthly
minimum for the service. The production web service keeps
`BILLING_TRANSITION_SCHEDULER_ENABLED=false`; no production cron exists in this
release task.

The two web services track **different branches**. Render auto-deploy is off for the
staging web service and cron, so deploy each from the exact reviewed commit and read
back that deployed SHA. Keep the cron suspended until the exact-candidate backend is
deployed and `/health/ready` succeeds against the migrated staging database.

Vercel staging is different: `frontend/vercel.json` enables automatic deployment from
`refs/heads/staging`. Move that ref only after the database, backend readiness, and
manual cron proof are complete, so the frontend is last. As observed on 2026-08-28,
`refs/remotes/origin/staging` is
`ee6137a709e4215efac1319dedd0e55ed2b60e1c`. That is context, not an execution
assumption. The operator must fetch the current old SHA and candidate ref, bind the
update to the observed old SHA with `--force-with-lease`, and read the remote ref back
immediately:

```bash
PR_HEAD_SHA='<PR_HEAD_SHA>'
git fetch origin \
  refs/heads/staging:refs/remotes/origin/staging \
  refs/heads/codex/koaryu-payments-live:refs/remotes/origin/codex/koaryu-payments-live
OLD_STAGING_SHA="$(git rev-parse refs/remotes/origin/staging)"
test "$(git rev-parse refs/remotes/origin/codex/koaryu-payments-live)" = "${PR_HEAD_SHA}"
git push origin \
  "${PR_HEAD_SHA}:refs/heads/staging" \
  --force-with-lease=refs/heads/staging:"${OLD_STAGING_SHA}"
test "$(git ls-remote --heads origin refs/heads/staging | awk '{print $1}')" = "${PR_HEAD_SHA}"
```

Abort if any command fails or the readback differs. Never use unchecked `--force`.
If Render cannot deploy the exact candidate before this move, stop and prove another
safe provider route. Do not move staging early to make Render see the candidate.

The Render API reported both live services in Oregon on 2026-08-24. Render does
not support changing an existing service's region. The Oregon declarations in
`render.yaml` record the existing immutable placement; they do not move or
replace either service.

The staging service is on the free plan, which sleeps after roughly 15 minutes of
inactivity. A slow or absent first response is usually spin-up, not a fault. If it
never comes back, check whether `/health/ready` is failing against a database that
has moved ahead of the deployed commit.

### Not part of Koaryu

`sparse-halo-api` (`srv-d76dl0pr0fns73c85la0`) lives in the same Render account but
builds `ronchak/sparse-halo`, an unrelated repository. It is on the free plan, has
no health check, and is the only service in the account with auto-deploy **on**.
Recorded here so it is not mistaken for Koaryu infrastructure.

The production service ID is hardcoded in `scripts/merge-release-pr.sh:14`,
which reads live auto-deploy state from `https://api.render.com/v1/services/<id>`
before permitting a release merge. That readback needs `RENDER_API_KEY`.

The current candidate's `/health/ready` calls the V17 schema preflight and serves
only at 131/head `20260831054918` with `release-db-attestation-v36`. It fails
closed at every other migration state. That is deliberate, and it is why a
backend deployed ahead of its migration will sit unhealthy rather than serve.

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
- Production intentionally sets `LIVE_BILLING_ENABLED=true`; staging, local, and
  reusable environment examples remain `false`. The production value is only the
  necessary global interlock. It creates no studio scope, reconciliation
  checkpoint, provider authority, or tenant financial permission. Connect and
  tuition mutations additionally require the exact enabled, unexpired studio
  scope and exact-candidate all-clear reconciliation checkpoint.
- `CORE_SELF_CHECKOUT_ENABLED` is a separate, narrower production-only switch for
  Core subscription checkout and the customer portal. `config.py` rejects it
  outside production, so the checkout flow cannot be exercised on staging. The
  2026-08-19 read-only provider check found the live `$27 USD` monthly price active,
  the exact six-event platform endpoint enabled, and one active customer-portal
  configuration.
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
| Render API key | macOS Keychain — service `com.koaryu.render.api-key`, account `koaryu-release-automation` |
| Supabase service role / JWT secret | Render dashboard env vars, `sync: false` |
| Stripe keys and webhook secrets | Render dashboard env vars, `sync: false` |
| Shared test studio password | macOS Keychain, `Koaryu Shared Core Test - NO BILLING` |
| Non-secret account references | Obsidian vault, `Codex Memory/` |

The Render key is account-wide, not per-service, and is what
`scripts/merge-release-pr.sh` needs. Load it into a shell without printing it:

```bash
export RENDER_API_KEY="$(security find-generic-password -s com.koaryu.render.api-key -w)"
```

It is stored under a service name that does not contain the string
`RENDER_API_KEY`, so searching the Keychain for the environment variable's name
finds nothing and wrongly suggests the key is missing.

## Known gaps

- The staging Render service was created outside the blueprint. It is declared in
  `render.yaml` now, but confirm its dashboard environment variables match that
  declaration — adding a service to the blueprint does not retroactively adopt an
  existing one.
- `frontend/vercel.json` pins the staging frontend by branch, but no Vercel
  project ID or service ID is recorded for it separately; it is the same project
  as production, deployed from the `staging` branch.

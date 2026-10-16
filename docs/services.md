# Koaryu Services Inventory

Every hosted service Koaryu depends on, and which copy is which. This file exists
because `koaryu-staging` on Render ran for months without being written down
anywhere — it was created in the dashboard, never declared in `render.yaml`, and
nothing noticed when it stopped serving.

**Rule: a hosted service that is not listed here does not exist.** If you create
one, add it here in the same change. If you find one that is not here, either
document it or delete it.

The [Privacy Policy](https://koaryu.app/privacy#sharing) names every provider that
processes personal information, with what it does and where. When a provider that
touches user, studio or payer data is added, removed or moves region, update the
service-provider table in `frontend/src/app/(legal)/privacy/page.tsx` in the same change and
add a revision in `frontend/src/lib/legal-documents.ts`. The policy currently says
Koaryu sends no email to students, families or leads; before
[Microsoft automation mail](#microsoft-automation-mail) is enabled, update its
Emails section, its provider table and the landing FAQ's limits answer.

This file records what exists and how it is configured, not which release is live.
Read served SHAs, schema versions and effective flags from the providers before
acting, and follow [Cutover Gates](cutover-gates.md).

## Quick map

| Layer | Production | Staging |
| --- | --- | --- |
| Frontend | Vercel `koaryu` → `koaryu.app` | Vercel, `staging` branch URL |
| Backend | Render `koaryu` → `koaryu.onrender.com` | Render `koaryu-staging` |
| Database + Auth | Supabase `mimguepumzsgmcaycdsh` | Supabase `nxgsektqsgrtyfhawxbc` |
| Payments | Stripe live mode | Stripe test mode |
| `LIVE_BILLING_ENABLED` | `true` (global interlock only) | `false` |
| `CORE_SELF_CHECKOUT_ENABLED` | `true` (Koaryu Core only) | `false` |
| Billing-transition timer | Enabled in the web service | Manifest flag `true`; disable it before deploying a timer build ([why](#render--backend)) |
| `OPERATIONAL_ALERTS_ENABLED` | `false` | `false` |

Neither production surface auto-deploys. Both require an explicit owner-authorized release —
see [Deployment triggers](#deployment-triggers).

## Google identity provider

- Google Cloud project: `Koaryu` (`koaryu-auth-20260920`), created September 20, 2026.
- One Web application OAuth client serves the production and staging Supabase
  callback URLs. The client secret belongs in those two Supabase Google-provider
  configurations and owner-only operator storage, never in frontend variables.
- Setup and release verification are tracked in [Google SSO setup](google-sso-setup.md).
  The client is published for external Google accounts and enabled in both
  Supabase projects. Email confirmation remains required and manual linking off.
- Google verified and published the display name `koaryu.app`; the live account
  chooser was checked. Search Console ownership uses the public homepage tag.

## Microsoft identity provider

- Owner account: held in private operator storage.
- Tenant: `Default Directory`, `koaryuoutlook.onmicrosoft.com`
  (`88ec6a60-28f5-4ba8-9419-238d02384c6d`), Microsoft Entra ID Free.
- App display name and verified publisher domain: `koaryu.app`. The separate
  Microsoft verified-publisher badge is not configured.
- Application client ID: `dcc03dac-aac6-4b8f-9dc1-74ac1da30832`.
- Audience: personal Microsoft accounts and accounts in any Entra directory.
  Enabled in both Supabase projects; real personal and school login verified.
  Client secret expires March 20, 2027; rotate using the setup runbook.
- Both exact Supabase Auth callback URLs are registered as Web redirects.
- Client credentials stay in Supabase and private operator storage; no client
  secret belongs in the frontend. Setup and verification status are in
  [Microsoft SSO setup](microsoft-sso-setup.md).
- App registration and basic Microsoft OAuth use the free identity service. No
  Azure compute, storage, premium identity license, or pay-as-you-go upgrade is
  part of this feature. Normal Supabase auth usage limits still apply.

## Microsoft automation mail

- Separate app: `Koaryu Automations Mail`, client ID
  `5b4f5762-7807-4aaf-932a-2a458dc88636`, object ID
  `569a81de-135c-42d8-93e5-c2765621a052`. Existing Microsoft SSO is unchanged.
- Sender and approved test recipient: `koaryu@outlook.com`. Consumer delegated
  permissions are `Mail.Send` and `User.Read`, with `offline_access`; OIDC
  enrollment also uses `openid` and `profile`.
- Enrollment uses confidential Web OAuth with PKCE and the exact callback
  `http://localhost:8400/oauth/callback`. The app secret expires April 2, 2027.
- Runtime credentials are encrypted in a private, service-role-only database
  table after an authorized initial import. Mail app secrets and the encryption
  key stay backend-only. Scheduled work also needs a dedicated shared worker
  secret on the frontend server. The send switch and both worker switches
  default to false; turning them on needs its own owner authorization.
- No Microsoft Business subscription, Teams license, Azure service, or paid
  sending resource is involved. The Outlook sender needs no `koaryu.app` DNS
  changes. Setup, verification and controls are in
  [missed-class automation](missed-class-automation.md).

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

Configuration lives in `frontend/vercel.json`. It pins Vercel Functions
to Portland (`pdx1`), near the existing Oregon backend and database. Deployment
readback must confirm the region; Routing Middleware may have separate placement.

The existing frontend also accepts sampled, same-origin performance measurements
at `/api/performance`. It writes allowlisted numeric metrics and build identities
to existing Vercel runtime logs. There is no separate telemetry service or database;
retention follows the current provider plan. No business data or user identifiers
are included. See `docs/verification/navigation-reliability-followup.md`.

### Vercel cron jobs

Vercel executes scheduled jobs only on production deployments, whose frontend
forwards them to the backend. Their cadence is enforced by
`scripts/check-env-examples.mjs`.

| Path | Schedule (UTC) | Purpose |
| --- | --- | --- |
| `/api/cron/account-deletions/process-due` | `0 8 * * *` | Processes account deletions that have passed their grace period |
| `/api/cron/operational-alerts/evaluate` | `0 9 * * *` | Evaluates operational alert conditions |
| `/api/cron/automations/process-due` | `0 18 * * *` | Daily recovery bridge for the automation scheduler; disabled by default |

The automation bridge backs up a per-process scheduler in each Render web service.
Both are described in
[automation scheduling](missed-class-automation.md#scheduled-work-and-pause-controls).

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
| Shutdown grace | 300 seconds | Render default (30 seconds) |
| Health check | `/health/ready` | `/health/ready` |
| `ENVIRONMENT` | `production` | `staging` |
| Stripe mode | `live` | `test` |

`render.yaml` declares the 300-second shutdown grace for both web services, but
the free staging plan rejects it. See
[the billing-transition timer](render-backend-deployment.md#billing-transition-timer)
for why the grace matters and how to read it back.

With `BILLING_TRANSITION_SCHEDULER_ENABLED=true`, each web process runs due billing
transitions on a five-minute timer. Production runs it; no production cron exists.
The staging manifest also sets the flag true, and suspending the staging cron does
not stop the in-process timer. Before deploying a timer-capable build to staging,
inspect due transition intents, set the hosted staging flag false and read it back.
Re-enabling it is a separate step after exact-candidate deployment is verified. The
sleeping free service cannot keep the timer's cadence anyway.

`koaryu-billing-transitions-staging` is a starter Render Cron Job that tracks the
`staging` branch, runs every five minutes, and calls only the protected staging
transition endpoint with the staging web service's worker secret. It stays
suspended outside a deliberate manual proof. Render bills cron execution by runtime
with a $1 monthly minimum. Details are in
[internal operations](render-backend-deployment.md#internal-operations).

Render service resume can build the current tracked branch even when auto-deploy is
off. Pin and inspect that branch before resuming, then verify the actual deployed
SHA; do not assume resume restores the previously serving artifact.

The two web services track **different branches**. Deploy both web services and
the staging billing cron from the exact reviewed commit and read back each deployed
SHA. Keep the staging cron suspended until the exact-candidate backend is deployed
and `/health/ready` succeeds against the migrated staging database.

Vercel staging is different: `frontend/vercel.json` builds `refs/heads/staging`
automatically, so moving that ref deploys the staging frontend. Move it last, after
the database, backend readiness and manual cron proof. The stable staging alias can
need explicit assignment to the new build, and may intentionally serve an
owner-approved preview; check what it serves before and after. Bind the move to the
observed old SHA and read it back:

```bash
CANDIDATE_BRANCH='<candidate-branch>'
CANDIDATE_SHA='<reviewed-full-sha>'
git fetch origin \
  refs/heads/staging:refs/remotes/origin/staging \
  "refs/heads/${CANDIDATE_BRANCH}:refs/remotes/origin/${CANDIDATE_BRANCH}"
OLD_STAGING_SHA="$(git rev-parse refs/remotes/origin/staging)"
test "$(git rev-parse "refs/remotes/origin/${CANDIDATE_BRANCH}")" = "${CANDIDATE_SHA}"
git push origin \
  "${CANDIDATE_SHA}:refs/heads/staging" \
  --force-with-lease=refs/heads/staging:"${OLD_STAGING_SHA}"
test "$(git ls-remote --heads origin refs/heads/staging | awk '{print $1}')" = "${CANDIDATE_SHA}"
```

Abort if any command fails or the readback differs. Never use unchecked `--force`.
If Render cannot deploy the exact candidate before this move, stop and prove another
safe provider route. Do not move staging early to make Render see the candidate.

Render does not support changing an existing service's region. The Oregon
declarations in `render.yaml` record the existing placement; they do not move or
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

Production database access is read-only except for the guarded rollout and its
temporary backup role, described in [Cutover Gates](cutover-gates.md#database-changes).

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
[Unlisted branches build preview deployments](https://vercel.com/docs/project-configuration/git-configuration#gitdeploymentenabled);
a candidate branch that must not build is listed as `false`.

**A push to `main` therefore deploys nothing.** Production frontend and backend
are each released explicitly after the database is migrated. If production looks
stale after a merge, that is the expected behaviour, not a fault.

## Credentials and where they live

Nothing secret belongs in this repository, in agent memory, or in the Obsidian
vault.

| Secret | Where it lives |
| --- | --- |
| Render API key | Owner-managed file on the OpenClaw Mac: `/Users/openclaw/.config/koaryu/secrets/render-api-key` |
| Supabase service role / JWT secret | Render dashboard env vars, `sync: false` |
| Stripe keys and webhook secrets | Render dashboard env vars, `sync: false` |
| Automation Microsoft enrollment | Private `/Users/openclaw/.config/koaryu/secrets/microsoft-automation-client.json` and `microsoft-automation-token.json`; never a hosted token-file adapter |
| Automation app credential and Fernet key | Backend-only Render variables, `sync: false` |
| Automation runtime refresh/access tokens | Encrypted private database credential table; revision-based compare-and-swap renewal |
| Automation worker secret | Render `sync: false` and a frontend server-only variable, distinct from other worker secrets |
| Studio-user sign-in material | Private owner authentication guidance outside the repository |
| Non-secret account references | Obsidian vault, `Codex Memory/` |

The Render key is account-wide, not per-service. The guarded merge script needs
it in `RENDER_API_KEY`. On the OpenClaw Mac, load the owner-managed file without
printing its value:

```bash
export RENDER_API_KEY="$(</Users/openclaw/.config/koaryu/secrets/render-api-key)"
```

Other machines may use the Keychain entry `com.koaryu.render.api-key` instead. Do
not assume either exists, and never copy credentials into the repository.

## Known gaps

- The staging Render service was created outside the blueprint. It is declared in
  `render.yaml` now, but confirm its dashboard environment variables match that
  declaration — adding a service to the blueprint does not retroactively adopt an
  existing one.
- `render.yaml` declares a 300-second shutdown grace for the free staging service,
  which Render rejects. Manifest, guard and docs parity is an open follow-up.
- `frontend/vercel.json` pins the staging frontend by branch, but no Vercel
  project ID or service ID is recorded for it separately; it is the same project
  as production, deployed from the `staging` branch.

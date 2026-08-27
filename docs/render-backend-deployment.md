# Render Backend Deployment

Koaryu uses Vercel for the Next.js frontend and Render for the FastAPI backend. Render deploys from GitHub, so only committed and pushed files reach production.

## Render Service

Use the root `render.yaml` Blueprint when creating the service.

Expected service settings:

- Service name: `koaryu`
- Type: Web Service
- Runtime: Docker
- Plan: `starter`
- Region: Oregon
- Root directory: `backend`
- Dockerfile path: `./Dockerfile`
- Docker context: `.`
- Start command: the image's `backend/scripts/start-render.sh`
- Health check path: `/health/ready`
- Automatic production deploys: off; deploy one reviewed commit explicitly

The image pins Python `3.11.9` on Debian bookworm. `backend/runtime.txt` and `backend/.python-version` keep non-Docker tools and local development on the same Python line.

The image installs Debian `libjemalloc2=5.3.0-1`, exposes it through `/usr/local/lib/libjemalloc.so.2`, and sets `LD_PRELOAD` before Python starts. The startup wrapper checks `/proc/self/maps` and exits before Uvicorn if jemalloc is absent. This keeps an image or environment regression from silently falling back to glibc. The old `MALLOC_ARENA_MAX` setting is intentionally absent because it has no effect once jemalloc owns allocation.

The configured `starter` Render service runs a single lightweight Uvicorn process. Four Gunicorn workers duplicate the FastAPI/Supabase/Stripe import footprint during cold wakeups, which leaves too little headroom on small instances. Keep `render.yaml`, `backend/Dockerfile`, `backend/scripts/start-render.sh`, and `backend/requirements.txt` aligned with this choice; Gunicorn should not be reintroduced unless the service moves to a larger instance and the memory budget is measured again.

`render.yaml` intentionally sets `autoDeployTrigger: 'off'`. A merge to `main` must not release the backend before the fixed candidate has passed staging. Trigger the production deploy with the exact approved commit SHA, then read the deployed SHA back from Render before recording the release. Do not re-enable commit auto-deploy as a shortcut.

### Native-to-Docker conversion

Render resolves `dockerfilePath` and `dockerContext` from the service's root directory. With `rootDir: backend`, the Dockerfile path is `./Dockerfile` and the context is `.`. Prove both the path and the runtime conversion on `koaryu-staging` before changing production. The first staging build log must show `backend/Dockerfile`, install `libjemalloc2`, and reach `jemalloc preload verified`. Read the staging service afterward and confirm its runtime is Docker, its branch is `staging`, and its health path remains `/health/ready`.

Current Render documentation supports changing an existing non-static service runtime through the API or a Blueprint sync. If Render refuses the in-place change, stop before touching production and use this fallback:

1. Record the existing service ID, branch, plan, root directory, health path, domains, and environment-variable names. Do not print or copy secret values into the repository or deployment logs.
2. Rename the existing service with a `-native-backup` suffix. Do not delete it.
3. Provision a Docker replacement from the exact candidate commit with the original service name and configuration. Re-enter every `sync: false` value through Render's secret controls.
4. Keep automatic deploys off. Require successful startup, `/health/live`, `/health/ready`, exact commit readback, Stripe mode readback, and `jemalloc preload verified` before routing traffic.
5. Update `docs/services.md`, pinned service IDs in operator scripts, and any provider URL references in the same change. Keep the old service until the replacement passes the memory observation window and a separate cleanup explicitly authorizes removal.

This fallback changes service IDs and may change the temporary `onrender.com` URL. Do not reuse the old production URL or remove the old service until the replacement URL and dependent Vercel variables have been verified.

For a live dojo-floor demo, use the configured starter service only after it is warm, or use a larger always-on backend. Cold starts on small Render instances can still make the first authenticated or billing click feel broken even when the service is healthy.

## Config Vars

Render will prompt for values marked `sync: false` in `render.yaml`. Use `backend/.env.render.example` as the checklist. That reusable example intentionally keeps `LIVE_BILLING_ENABLED=false`; production is the explicit exception below.

Fixed values:

```env
FRONTEND_URL=https://koaryu.app
ENVIRONMENT=production
API_V1_PREFIX=/api/v1
DEMO_RESET_ENABLED=false
DEMO_RESET_STUDIO_IDS=
BILLING_PLATFORM_FEE_BPS=50
STRIPE_MODE=live
LIVE_BILLING_ENABLED=true
CORE_SELF_CHECKOUT_ENABLED=true
SUPABASE_URL=https://mimguepumzsgmcaycdsh.supabase.co
SUPABASE_DEVELOPMENT_PROJECT_REF=
SUPABASE_ALLOW_LEGACY_HS256=false
```

Secret values to paste from Supabase or Stripe:

```env
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
STRIPE_SECRET_KEY=
STRIPE_RESTRICTED_KEY=
STRIPE_PLATFORM_WEBHOOK_SECRET=
STRIPE_CONNECT_WEBHOOK_SECRET=
STRIPE_KOARYU_CORE_PRICE_ID=
ACCOUNT_DELETION_WORKER_SECRET=
BILLING_TRANSITION_WORKER_SECRET=
SUPPORT_TRIAGE_SECRET=
OPERATIONAL_ALERT_WORKER_SECRET=
OPERATIONAL_ALERT_PRIMARY_URL=
OPERATIONAL_ALERT_PRIMARY_HOST=
OPERATIONAL_ALERT_PRIMARY_URL_SHA256=
OPERATIONAL_ALERT_PRIMARY_BEARER_SECRET=
OPERATIONAL_ALERT_PRIMARY_ACK_SECRET=
OPERATIONAL_ALERT_BACKUP_URL=
OPERATIONAL_ALERT_BACKUP_HOST=
OPERATIONAL_ALERT_BACKUP_URL_SHA256=
OPERATIONAL_ALERT_BACKUP_BEARER_SECRET=
OPERATIONAL_ALERT_BACKUP_ACK_SECRET=
```

Keep `OPERATIONAL_ALERTS_ENABLED=false` in production until the primary/backup humans, receipt-bearing receiver, exact URL fingerprints, acknowledgement credentials, Vercel scheduler plan, independent dead-man provider, retention, staging rehearsal, and explicit enable approval are complete. The committed evaluator schedule is a `204` no-op while disabled. See [Operational Alerts](operational-alerts.md).

`STRIPE_PLATFORM_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET` each support one or more comma-separated `whsec_...` values. Use platform rotation while replacing a platform signing secret. Use Connect rotation for signing-secret replacement or when Stripe has both a Connect account-lifecycle destination and a Connected accounts resource-event destination pointed at `/api/v1/webhooks/stripe/connect`. Candidates are tried in order and must not be empty or contain surrounding whitespace or control characters.

Koaryu creates connected-account onboarding sessions with Stripe Account Links. Do not add a Connect OAuth client ID to hosted configuration; the OAuth credential is not part of this integration.

Production requires `STRIPE_MODE=live`, an `sk_live_` secret key, and an `rk_live_` restricted key when that optional key is set. Staging separately requires test mode and test-prefixed keys. `CORE_SELF_CHECKOUT_ENABLED=true` authorizes only `customer.create`, `core_checkout_session.create`, and `customer_portal_session.create` for an authenticated studio Admin and explicit studio ID. Production intentionally sets `LIVE_BILLING_ENABLED=true`, but that value is only the necessary global interlock. It creates no studio scope, reconciliation checkpoint, provider authority, or tenant financial permission; every Connect or tuition mutation remains fail-closed without the exact enabled, unexpired studio scope and exact-candidate all-clear reconciliation checkpoint defined in `stripe-live-billing-rollout.md`. Core self-checkout remains a separate bounded path and does not enable Connect onboarding, Connect payments, tuition collection, refunds, or any other live provider mutation. Matching live webhook events continue through signature verification and reconciliation. Wrong-mode or malformed-mode events are rejected before storage. The platform route quarantines account-bearing events as `wrong_route_connect_event`; the Connect route quarantines account-less platform-contract events as `wrong_route_platform_event` and other account-less events as `missing_connect_account_context`. These permanent route failures return `400` and never project product state. A live Connect event with a real but unmapped account remains a distinct transient failure: it is durably marked `unmapped_live_connect_account` and returns `503` so Stripe retries after the mapping exists. Unexpected projector failures store a stable `error_reference` and emit an event-linked log containing only sanitized identifiers, the failure class, and that reference.

### Hosted Runtime Guard

FastAPI validates the Supabase service-role target and ambient proxy state in
every environment during import and readiness checks. The shared client factory
repeats the validation immediately before calling the SDK, so standalone Python
operator tools cannot bypass startup. Production accepts only
`https://mimguepumzsgmcaycdsh.supabase.co`; staging accepts only
`https://nxgsektqsgrtyfhawxbc.supabase.co`. Development may use the canonical
local URL, a shipped placeholder, or an explicitly pinned non-production hosted
project. Test may use only the local URL or placeholders.

Raw ASCII controls, including TAB, CR, and LF, are rejected before URL parsing.
Hosted URLs must be the canonical lowercase
`https://<project-ref>.supabase.co` form with no credentials, port, path, query,
fragment, whitespace, or trailing slash. Local use is deliberately restricted
to `http://127.0.0.1:54321`.

Service-role use also refuses active `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`
configuration, including lowercase variants and operating-system proxy
settings. `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `SSL_CERT_FILE`, and
`SSL_CERT_DIR` overrides (including lowercase variants) are refused as well;
`NO_PROXY` is not an exception. Supabase-py 2.9.0 constructs separate Auth,
PostgREST, Storage, and Functions HTTPX clients and has no common option for
setting `trust_env=False`, so this release fails closed instead of patching SDK
internals.

When `ENVIRONMENT=production` or `ENVIRONMENT=staging`, the service also refuses to boot if any of the following are blank, placeholder-shaped, too short for a hosted secret, or invalid for that environment:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FRONTEND_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_PLATFORM_WEBHOOK_SECRET`
- `STRIPE_CONNECT_WEBHOOK_SECRET`
- `STRIPE_KOARYU_CORE_PRICE_ID`
- `ACCOUNT_DELETION_WORKER_SECRET`
- `BILLING_TRANSITION_WORKER_SECRET`
- `SUPPORT_TRIAGE_SECRET`

`SUPABASE_URL` must be a public HTTPS URL in production. Production requires the exact canonical `FRONTEND_URL=https://koaryu.app`; paths, query strings, fragments, userinfo, ports, whitespace, and control characters are rejected before CORS or staff-invite redirects use it. Both Stripe webhook-secret settings use the same exact comma-rotation format: nonempty candidates without surrounding whitespace or control characters. Production always requires live Stripe mode and a live secret key; `STRIPE_RESTRICTED_KEY` is optional, but if set it must also be a non-placeholder live key. Production startup rejects test mode and mismatched keys. If `LIVE_BILLING_ENABLED=true` or `CORE_SELF_CHECKOUT_ENABLED=true`, startup additionally requires an exact validated `RENDER_GIT_COMMIT`. The general live-billing flag still requires the matching unexpired checkpoint and studio scope at runtime; the Core flag is limited to the three named self-service operations. If Render shows a successful build followed by a failed runtime start, inspect the deploy logs for the sanitized `<Environment> configuration is incomplete or unsafe` message and fix the named config vars before redeploying.

Staging is production-shaped but test-only. It additionally requires Supabase `nxgsektqsgrtyfhawxbc`, the pinned protected staging frontend origin, `sk_test_`/optional `rk_test_` Stripe keys, `SUPABASE_ALLOW_LEGACY_HS256=false`, `LIVE_BILLING_ENABLED=false`, `CORE_SELF_CHECKOUT_ENABLED=false`, `DEMO_RESET_ENABLED=false`, and an empty `DEMO_RESET_STUDIO_IDS`. An unknown or misspelled `ENVIRONMENT` fails closed.

Production access tokens should use the asymmetric key advertised by Supabase JWKS. Keep `SUPABASE_ALLOW_LEGACY_HS256=false`; when a documented migration window requires legacy HS256, set it to `true` and provide a non-placeholder `SUPABASE_JWT_SECRET`, then remove both trust and secret after the last legacy token expires.

### Auth signing-key and session operations

- The backend caches JWKS for 10 minutes and permits at most one early refresh every 30 seconds after a key miss. A cold-cache or rotation fetch runs off the ASGI event loop as a single-flight refresh. Concurrent requests that need the unavailable/new key fail temporarily with a sanitized `503` and `Retry-After`; requests using a known cached key continue without waiting.
- To purge the in-process JWKS cache during an urgent signing-key revocation, restart/redeploy the Render service. Provider/CDN JWKS caching can still apply, so keep old and new asymmetric keys overlapped for the provider-documented rotation window unless the old key is compromised.
- Production validates signed access tokens locally. Supabase sign-out or session revocation therefore stops refresh-token use but does not invalidate an already issued access token before its `exp`. Before release, record the provider access-token lifetime and explicitly accept or reduce that maximum revocation window; do not describe sign-out as immediate access-token revocation.

### Internal Operations

Account deletion is scheduled from the Vercel frontend project, not as a separate Render Cron service. Vercel Cron calls `/api/cron/account-deletions/process-due` once daily, and that route calls the protected Render backend endpoint with `ACCOUNT_DELETION_WORKER_SECRET`.

Enrollment period transitions expose a separate fail-closed backend worker at
`/api/v1/internal/billing/enrollment-transitions/process-due`, protected by
`BILLING_TRANSITION_WORKER_SECRET`. The repository declares
`koaryu-billing-transitions-staging` as a five-minute Render Cron Job. It reuses the
staging web service secret by Render service reference and posts only to the pinned
staging origin. `BILLING_TRANSITION_SCHEDULER_ENABLED` keeps the public scheduling
route and capability closed unless that environment's worker is intentionally active.
The production value remains `false`, and no production cron may be created in the
staging release task. After separate production approval, mirror the staging cron with
the production origin and production web-service secret, prove one manual run, then
enable the production flag. Never share one environment's secret with another.

For a manual staging verification, call the same protected endpoint directly:

```bash
curl -X POST \
  -H "X-Internal-Secret: $BILLING_TRANSITION_WORKER_SECRET" \
  https://koaryu-staging.onrender.com/api/v1/internal/billing/enrollment-transitions/process-due
```

Support tickets can be polled by an operator:

```bash
curl -H "X-Internal-Secret: $SUPPORT_TRIAGE_SECRET" \
  https://koaryu.onrender.com/api/v1/internal/support/tickets
```

The daily GPT digest should use the Supabase connector to call the sanitized database RPC instead of polling raw backend ticket rows:

```sql
SELECT public.support_triage_digest(50) AS digest;
```

Support tickets can be updated by the internal triage loop:

```bash
curl -X PATCH \
  -H "X-Internal-Secret: $SUPPORT_TRIAGE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"status":"triaging","note":"Investigating the report.","metadata":{"source":"operator"}}' \
  https://koaryu.onrender.com/api/v1/internal/support/tickets/<ticket_id>
```

Use `docs/support-triage.md` as the runbook. Do not post full ticket details, page URLs with query strings, user agents, or browser context into broad notification channels.

## Verify Render

After the first deploy finishes:

```bash
curl https://koaryu.onrender.com/health/live
curl https://koaryu.onrender.com/health/ready
curl https://koaryu.onrender.com/api/v1/health/live
curl https://koaryu.onrender.com/api/v1/health/ready
curl -o /dev/null -w '%{http_code}\n' https://koaryu.onrender.com/openapi.json
```

The schema route must return `404` in hosted staging and production: `/openapi.json`
is gated to `ENVIRONMENT=development` alongside `/docs` and `/redoc`, so a `200` here
means the service is running with a development environment and is publishing its
whole route map. To inspect the deployed route inventory, build the schema from the
release commit instead with `python3 scripts/generate-api-types.py`, which loads the
app in process and never touches the network.

`/health` and `/api/v1/health` remain liveness aliases. Health responses expose only the normalized environment and a validated 40-character `RENDER_GIT_COMMIT`; malformed or absent commit metadata is returned as `null`. In hosted staging and production, readiness rechecks runtime configuration on every probe. A successful service-role-only V12 database preflight is reused for 30 seconds, and concurrent probes share one in-flight check. Failures are never cached. Readiness requires exactly 126 migrations, head `20260826185651`, the exact forty-two-version pending sequence, manifest version `release-db-attestation-v31`, and no required-object/security failure. Earlier, later, hybrid, malformed, or failing states return 503; no pre-V31 application compatibility remains. The V12 contract admits only the canonical or proved restored PostgreSQL 17 operational manifest. Missing RPCs, timeouts, and provider errors fail closed without exposing provider detail. The repository-pinned raw-catalog verifier remains release authority; the database RPC is an operational signal, not proof against a malicious database administrator. Hosted exposed-schema and schema-ACL readback remain separate operator gates. Stripe network health is not part of this route.

Each readiness probe also invokes the private RSS observer. It reads current RSS from `/proc/self/statm` at most once every five minutes and emits a `process_rss_observation` JSON log with the instance ID, commit, byte count, and threshold state. It adds no fields to the public health response. Search Render logs for `jemalloc preload verified` after startup and then for `process_rss_observation` while comparing memory across one instance ID.

Promote the database first. Do not route the new backend to a Supabase project
until the final staging fingerprint and preflight pass. The exact-head manifest
includes the billing, Connect delivery, and alert security surfaces; an application
deploy that reaches schema 84 or any partial 85-110 state remains unhealthy.
No approved application may serve at 110. Exclude `709239`/V16 and every
V2-consuming SHA before verified history boundary
`d63a5116c0a47f1933f15360cd5db7b66237bb80` from the rollback set: older V2
consumers can report ready through the 110/V17 compatibility guard, but they are
not approved recovery artifacts.
Local PostgreSQL does not prove hosted PostgREST exposed schemas or actual schema
ACLs; authenticated operator readback must separately prove `private` is not
exposed and the hosted schema ACL state matches the approved release gate.

If the build succeeds but the live backend still looks old or unreachable, inspect the Render deploy logs under the runtime/startup section after the build phase.

## Connect Vercel

After Render is live, update the Vercel frontend production env var:

```env
NEXT_PUBLIC_API_URL=https://koaryu.onrender.com/api/v1
BACKEND_API_URL=https://koaryu.onrender.com/api/v1
```

Then redeploy the Vercel frontend so Next.js bakes the public URL into the production build and its server routes pick up the backend URL.

The public landing page warms the backend by calling `/api/proxy/health` after the page hydrates. That proxy route forwards to `BACKEND_API_URL` with `NEXT_PUBLIC_API_URL` as a fallback, so verify both Vercel production values include the `/api/v1` suffix and reach the same Render service used by authenticated app routes.

Do not route `/` through frontend auth middleware just to warm Render. The landing page should paint immediately; login, onboarding, subscription-required, and dashboard routes remain responsible for blocking on Supabase and backend auth checks.

## Release Verification

Before tagging or announcing a release:

After both providers report the candidate deployed, run the pinned GET-only verifier before any performance capture:

```bash
npm run verify:deployed-release -- \
  --environment production \
  --expected-sha "$RELEASE_SHA" \
  --frontend-origin https://koaryu.app \
  --backend-api https://koaryu.onrender.com/api/v1
```

The production-shaped startup check must use that same exact deployed 40-character `$RELEASE_SHA` as `RENDER_GIT_COMMIT`; do not substitute a branch or tag.

```bash
cd backend
ENVIRONMENT=production FRONTEND_URL=https://koaryu.app \
  STRIPE_MODE=live LIVE_BILLING_ENABLED=true \
  RENDER_GIT_COMMIT="$RELEASE_SHA" \
  SUPABASE_URL=https://mimguepumzsgmcaycdsh.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  SUPABASE_ALLOW_LEGACY_HS256=false \
  STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" \
  STRIPE_PLATFORM_WEBHOOK_SECRET="$STRIPE_PLATFORM_WEBHOOK_SECRET" \
  STRIPE_CONNECT_WEBHOOK_SECRET="$STRIPE_CONNECT_WEBHOOK_SECRET" \
  STRIPE_KOARYU_CORE_PRICE_ID="$STRIPE_KOARYU_CORE_PRICE_ID" \
  ACCOUNT_DELETION_WORKER_SECRET="$ACCOUNT_DELETION_WORKER_SECRET" \
  SUPPORT_TRIAGE_SECRET="$SUPPORT_TRIAGE_SECRET" \
  venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001
```

In another shell:

```bash
curl -fsS http://127.0.0.1:8001/health/live
curl -fsS http://127.0.0.1:8001/health/ready
curl -fsS http://127.0.0.1:8001/api/v1/health/live
curl -fsS http://127.0.0.1:8001/api/v1/health/ready
```

For frontend changes, run at least the targeted lint pass for the release surface:

```bash
cd frontend
npm run lint -- src/app/page.tsx src/components/backend-warmup.tsx src/lib/supabase/middleware.ts src/proxy.ts
```

For broad launch-readiness changes, use the fuller local verification pass:

```bash
cd backend
venv/bin/python -m pytest tests

cd ../frontend
npm audit --omit=dev
npm run lint
npm run build

cd ..
supabase db lint --linked --fail-on error
SUPABASE_DB_TARGET=linked scripts/verify-supabase-contracts.sh
```

`scripts/verify-supabase-contracts.sh` is the broad database contract check for launch-readiness and defaults to the local database. Use `SUPABASE_DB_TARGET=linked` only after the linked project has received the new migrations. It fails if the support/account controls, direct-client relation read/write lockdown, public-routine EXECUTE lockdown, worker-claim RPCs, promotion RPC, recurring-session soft-delete contract, student program filter contract, atomic import/conversion/profile/clear RPCs, atomic onboarding contract, or belt-ladder sync behavior drift from the current migrations. Apply the worker-claim RPC migrations before deploying backend code that processes Stripe webhooks, account deletions, or CSV imports.

## Stripe Webhooks

After Render is live, configure Stripe webhook endpoints in the mode declared by `STRIPE_MODE`. Prove the full workflow in Stripe test mode first. The already-live global production `LIVE_BILLING_ENABLED=true` interlock may coexist with matching signed live-event ingestion, but it alone authorizes no outbound write; do not activate a studio scope, record a reconciliation checkpoint, repeat test mutations in live mode, or perform a live Connect or tuition mutation without separate approval and the exact runtime authorization.

Treat a Connect delivery that returns `503` because its account mapping is not ready as an operational quarantine, not a successful ignore. Confirm the Stripe account belongs to the intended studio, complete or repair the normal `studio_payment_accounts.stripe_connected_account_id` mapping, and then let Stripe retry or resend the same event from the Dashboard. Confirm the existing `stripe_events` row becomes `processed` with a cleared error. Never add an account mapping from an unverified event payload, and never acknowledge the delivery with `2xx` merely to clear Stripe's retry queue.

```txt
https://koaryu.onrender.com/api/v1/webhooks/stripe/platform
https://koaryu.onrender.com/api/v1/webhooks/stripe/connect
```

Platform endpoint events:

```txt
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
```

Connect endpoint events:

```txt
account.updated
account.application.deauthorized
checkout.session.completed
invoice.created
invoice.finalized
invoice.paid
invoice.payment_failed
invoice.voided
invoice.marked_uncollectible
payment_intent.processing
payment_intent.succeeded
payment_intent.payment_failed
charge.refunded
charge.refund.updated
refund.created
refund.failed
refund.updated
charge.dispute.created
charge.dispute.updated
charge.dispute.closed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
```

The Connect endpoint is the source-of-truth ingestion path for Koaryu Payments. It projects Connect onboarding status, hosted setup completion, invoices, payment intents, refunds, disputes, and payer-level tuition subscriptions back into the local billing tables.

Copy the resulting `whsec_...` values back into Render:

```env
STRIPE_PLATFORM_WEBHOOK_SECRET=
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_connect_platform_scope,whsec_connect_connected_scope
```

Then redeploy the backend so FastAPI verifies signatures with the new secrets.

### Local Connect Webhook Smoke Test

With the backend running on `127.0.0.1:8001`, run:

```bash
npm run dev:stripe-connect-smoke -- --confirm-stateful-target --account acct_...
```

The smoke test signs a synthetic Connect `account.updated` event with `STRIPE_CONNECT_WEBHOOK_SECRET`, posts it to `/api/v1/webhooks/stripe/connect`, and posts the same event again. A passing result returns `processed` first and `already_processed` second, proving the local route, signature validation, projector entrypoint, and `stripe_events` dedupe table.

This script reads `backend/.env` and root `.env`, uses `SUPABASE_SERVICE_ROLE_KEY`, and mutates billing/webhook rows through the running backend. Production environment labels, the production Supabase URL, and all live Stripe keys are permanently denied. `--target local` requires the exact development/local-Supabase/loopback binding; `--target staging` requires the exact staging environment, project, and Connect URL. There is no arbitrary remote URL override. Pass `--confirm-stateful-target` only after verifying the intended disposable target, and pass `--account acct_...` so the smoke cannot silently choose the newest row.

For true Stripe delivery in local development, use the Stripe CLI or a trusted HTTPS tunnel:

```bash
stripe listen --forward-connect-to http://127.0.0.1:8001/api/v1/webhooks/stripe/connect
```

Copy the CLI-provided `whsec_...` into `backend/.env` as `STRIPE_CONNECT_WEBHOOK_SECRET`, restart the backend, then replay a recent test event:

```bash
stripe events resend evt_... --webhook-endpoint we_...
```

### Future Koaryu Payments Test-Mode Rehearsal

This is a future, separately scoped provider-lifecycle rehearsal, not part of the routine Koaryu release checklist. Run it only after explicit narrow test-mode approval against isolated staging and Stripe test mode. It does not authorize a production application deploy, a production migration, or live payments:

- Confirm `/health` and `/api/v1/health` are green on Render.
- Confirm the Stripe Dashboard shows successful deliveries to both platform and Connect endpoints.
- Create or sync a billing plan and verify the connected-account Product and immutable Price.
- Create or sync a payer and verify the connected-account Customer.
- Complete hosted autopay setup and verify `checkout.session.completed` enables payer autopay locally.
- Enroll two students for one payer and verify one Stripe Subscription with the expected subscription item quantity.
- Finalize and pay a hosted invoice; verify `invoice.paid` creates the local payment and reports Koaryu fee basis.
- Trigger a failed invoice payment and verify `invoice.payment_failed` plus `payment_intent.payment_failed` populate the failed-payment queue.
- Record an external payment and confirm it has no application fee amount.
- Refund a test payment and verify `charge.refunded` projects into `billing_refunds`.
- Use Stripe's `pm_card_createDispute` test PaymentMethod and confirm `charge.dispute.created` projects into `billing_disputes`.
- Run a reconciliation pass for any object whose webhook delivery was missed or delayed.

### Koaryu Studio Checklist

Before daily use at a dojo:

- Confirm Render and Vercel both deployed the same intended commit.
- Confirm `/health/live`, `/health/ready`, and their `/api/v1` aliases are green from the studio network or hotspot.
- Open the app on the actual studio device and complete login, dashboard, Students, student detail, Schedule, attendance, Settings, and Help checks.
- Verify Admin and Front Desk can read existing billing state and use only external-only local attachment, payer-level external-payment recording, and read-based reconciliation of an existing Stripe-linked invoice.
- Verify an Instructor receives the billing access-denied page before any billing data is shown or fetched.
- Confirm production reports `LIVE_BILLING_ENABLED=true`, and treat it only as the global interlock. Do not treat that value as evidence that any studio has a scope or checkpoint, and do not connect, sync, charge, refund, retry, void, or otherwise mutate Stripe as part of this checklist.
- Use the preserved production dataset. Do not reset, replace, clean, or reseed production records.
- Keep `DEMO_RESET_STUDIO_IDS` empty in production; in demo/staging, list only disposable studio IDs that demo reset or clear-studio-data may target.

### Billing Readiness and Recovery

The broad authenticated system-status and reconciliation endpoints below are Admin-only support surfaces, not ordinary Koaryu controls. The supported routine invoice action is the invoice-specific read-based reconciliation documented in [Billing Boundary](billing-boundary.md).

Authenticated studio admins can check the broader billing surface with:

```bash
curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "X-Studio-Id: $STUDIO_ID" \
  https://koaryu.onrender.com/api/v1/billing/system/status
```

The response summarizes Stripe env configuration, Connect charge/payout readiness, Supabase reachability, and platform/Connect webhook processing health without returning secrets.

If Stripe has the correct state but Koaryu missed or delayed projection, admins can ask the backend to re-read Stripe and repair the local projection:

```bash
curl -X POST \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "X-Studio-Id: $STUDIO_ID" \
  -H "Content-Type: application/json" \
  -d '{"object_type":"invoice","stripe_object_id":"in_..."}' \
  https://koaryu.onrender.com/api/v1/billing/reconcile
```

Supported `object_type` values are `connect_account`, `payer`, `invoice`, `subscription`, and `payment_intent`. Use `payer_id` instead of `stripe_object_id` for payer reconciliation.

### Rollout Risks

- Do not enable new Stripe billing actions for a studio whose Connect account is `deauthorized` or lacks `charges_enabled`.
- Keep `BILLING_PLATFORM_FEE_BPS=50` unless the fee promise changes. External payments must keep `application_fee_amount_cents=0`.
- Stripe and Supabase writes are not atomic. Local intent rows, deterministic Stripe idempotency keys, webhook projection, and reconciliation are all required to repair partial success.
- Treat plan pricing as immutable. Create a new connected-account Price for amount or interval changes; migrate active subscriptions deliberately.
- Preserve test data until the verification pass is reviewed. Delete or archive Stripe/Supabase test artifacts only after an explicit cleanup approval.
- Production startup intentionally fails closed when required billing configuration is absent. Treat a boot failure as a configuration problem to fix, not as a reason to remove the guard.

### Alerts and post-deploy contact check

Ronak Chakraborty is the current alert owner and recipient; email is the preferred channel. Provider-native Render, Vercel, Supabase, and Stripe alerts are primary. A scheduled or Codex-generated digest is supplemental and must not be the only real-time signal.

After every staging or production application deployment, check once that the expected provider email notification path reaches the owner and record pass, failure, or unverified status in the release evidence. Also inspect immediate provider health/log signals once. Do not claim alert coverage for a provider or event class that has not been read back and exercised.

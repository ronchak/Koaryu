# Render Backend Deployment

Koaryu uses Vercel for the Next.js frontend and Render for the FastAPI backend. Render deploys from GitHub, so only committed and pushed files reach production.

## Render Service

Use the root `render.yaml` Blueprint when creating the service.

Expected service settings:

- Service name: `koaryu`
- Type: Web Service
- Runtime: Python
- Plan: `starter`
- Region: Ohio
- Root directory: `backend`
- Build command: `pip install -r requirements.txt`
- Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Bootstrap health check path: `/health`; switch explicitly to `/health/live` only after the approved artifact containing that endpoint is live
- Automatic production deploys: off; deploy one reviewed commit explicitly

Render should use Python `3.11`. The backend includes both `backend/runtime.txt` (`python-3.11.9`) and `backend/.python-version` (`3.11`) so Render does not default to a newer Python release that lacks compatible wheels for pinned dependencies.

The configured `starter` Render service runs a single lightweight Uvicorn process intentionally. Four Gunicorn workers duplicate the FastAPI/Supabase/Stripe import footprint during cold wakeups, which leaves too little headroom on small instances. Keep `render.yaml`, `backend/Procfile`, and `backend/requirements.txt` aligned with this choice; Gunicorn should not be reintroduced unless the service moves to a larger instance and the memory budget is measured again.

`render.yaml` intentionally sets `autoDeployTrigger: 'off'`. A merge to `main` must not release the backend before the fixed candidate has passed staging. Trigger the production deploy with the exact approved commit SHA, then read the deployed SHA back from Render before recording the release. Do not re-enable commit auto-deploy as a shortcut.

For a live dojo-floor demo, use the configured starter service only after it is warm, or use a larger always-on backend. Cold starts on small Render instances can still make the first authenticated or billing click feel broken even when the service is healthy.

## Config Vars

Render will prompt for values marked `sync: false` in `render.yaml`. Use `backend/.env.render.example` as the checklist.

Fixed values:

```env
FRONTEND_URL=https://koaryu.app
ENVIRONMENT=production
API_V1_PREFIX=/api/v1
DEMO_RESET_ENABLED=false
DEMO_RESET_STUDIO_IDS=
BILLING_PLATFORM_FEE_BPS=50
STRIPE_MODE=live
LIVE_BILLING_ENABLED=false
SUPABASE_URL=https://mimguepumzsgmcaycdsh.supabase.co
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
SUPPORT_TRIAGE_SECRET=
```

`STRIPE_CONNECT_WEBHOOK_SECRET` can contain multiple comma-separated `whsec_...` values. Use this when Stripe has both a Connect account-lifecycle destination and a Connected accounts resource-event destination pointed at `/api/v1/webhooks/stripe/connect`.

Koaryu creates connected-account onboarding sessions with Stripe Account Links. Do not add a Connect OAuth client ID to hosted configuration; the OAuth credential is not part of this integration.

Production requires `STRIPE_MODE=live`, an `sk_live_` secret key, and an `rk_live_` restricted key when that optional key is set. Staging separately requires test mode and test-prefixed keys. Keep `LIVE_BILLING_ENABLED=false`. Matching live webhook events continue through signature verification and reconciliation while outbound live Stripe mutations remain closed. Wrong-mode or malformed-mode events are rejected before storage. Live Connect events for an account not mapped to `studio_payment_accounts` are durably marked `unmapped_live_connect_account` without changing product state and return `503` so Stripe keeps retrying until the mapping exists.

### Hosted Runtime Guard

When `ENVIRONMENT=production` or `ENVIRONMENT=staging`, FastAPI validates critical service configuration during import. The service refuses to boot if any of the following are blank, placeholder-shaped, too short for a hosted secret, or invalid for that environment:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FRONTEND_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_PLATFORM_WEBHOOK_SECRET`
- `STRIPE_CONNECT_WEBHOOK_SECRET`
- `STRIPE_KOARYU_CORE_PRICE_ID`
- `ACCOUNT_DELETION_WORKER_SECRET`
- `SUPPORT_TRIAGE_SECRET`

`SUPABASE_URL` and `FRONTEND_URL` must be public HTTPS URLs in production. Production always requires live Stripe mode and a live secret key; `STRIPE_RESTRICTED_KEY` is optional, but if set it must also be a non-placeholder live key. Production startup rejects test mode, mismatched keys, and `LIVE_BILLING_ENABLED=true` because no durable live mutation authorization source exists yet. If Render shows a successful build followed by a failed runtime start, inspect the deploy logs for the sanitized `<Environment> configuration is incomplete or unsafe` message and fix the named config vars before redeploying.

Staging is production-shaped but test-only. It additionally requires Supabase `nxgsektqsgrtyfhawxbc`, the pinned protected staging frontend origin, `sk_test_`/optional `rk_test_` Stripe keys, `SUPABASE_ALLOW_LEGACY_HS256=false`, `DEMO_RESET_ENABLED=false`, and an empty `DEMO_RESET_STUDIO_IDS`. Development and test remain permissive for local fixtures. An unknown or misspelled `ENVIRONMENT` fails closed.

Production access tokens should use the asymmetric key advertised by Supabase JWKS. Keep `SUPABASE_ALLOW_LEGACY_HS256=false`; when a documented migration window requires legacy HS256, set it to `true` and provide a non-placeholder `SUPABASE_JWT_SECRET`, then remove both trust and secret after the last legacy token expires.

### Auth signing-key and session operations

- The backend caches JWKS for 10 minutes and permits at most one early refresh every 30 seconds after a key miss. A cold-cache or rotation fetch runs off the ASGI event loop as a single-flight refresh. Concurrent requests that need the unavailable/new key fail temporarily with a sanitized `503` and `Retry-After`; requests using a known cached key continue without waiting.
- To purge the in-process JWKS cache during an urgent signing-key revocation, restart/redeploy the Render service. Provider/CDN JWKS caching can still apply, so keep old and new asymmetric keys overlapped for the provider-documented rotation window unless the old key is compromised.
- Production validates signed access tokens locally. Supabase sign-out or session revocation therefore stops refresh-token use but does not invalidate an already issued access token before its `exp`. Before release, record the provider access-token lifetime and explicitly accept or reduce that maximum revocation window; do not describe sign-out as immediate access-token revocation.

### Internal Operations

Account deletion is scheduled from the Vercel frontend project, not as a separate Render Cron service. Vercel Cron calls `/api/cron/account-deletions/process-due` once daily, and that route calls the protected Render backend endpoint with `ACCOUNT_DELETION_WORKER_SECRET`.

If you configure or test the worker manually instead, call the protected endpoint at least daily:

```bash
curl -X POST \
  -H "X-Internal-Secret: $ACCOUNT_DELETION_WORKER_SECRET" \
  https://koaryu.onrender.com/api/v1/internal/account-deletions/process-due
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
curl https://koaryu.onrender.com/openapi.json | python3 -m json.tool | grep '"/'
```

`/health` and `/api/v1/health` remain liveness aliases. Health responses expose only the normalized environment and a validated 40-character `RENDER_GIT_COMMIT`; malformed or absent commit metadata is returned as `null`. Readiness rechecks runtime configuration but does not yet probe Supabase or Stripe network availability.

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

```bash
cd backend
ENVIRONMENT=production FRONTEND_URL=https://koaryu.app \
  STRIPE_MODE=live LIVE_BILLING_ENABLED=false \
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

`scripts/verify-supabase-contracts.sh` is the broad database contract check for launch-readiness and defaults to the local database. Use `SUPABASE_DB_TARGET=linked` only after the linked project has received the new migrations. It fails if the support/account controls, direct-client write lockdown, worker-claim RPCs, promotion RPC, recurring-session soft-delete contract, student program filter contract, atomic import/conversion/profile/clear RPCs, atomic onboarding contract, or belt-ladder sync behavior drift from the current migrations. Apply the worker-claim RPC migrations before deploying backend code that processes Stripe webhooks, account deletions, or CSV imports.

## Stripe Webhooks

After Render is live, configure Stripe webhook endpoints in the mode declared by `STRIPE_MODE`. Prove the full workflow in Stripe test mode first. A separately approved live-mode deployment may ingest matching signed live events with outbound writes still closed; do not repeat test mutations in live mode or enable live billing until durable scoped authorization is implemented and reviewed.

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

This script reads `backend/.env` and root `.env`, uses `SUPABASE_SERVICE_ROLE_KEY`, and mutates local billing/webhook rows through the running backend. Pass `--confirm-stateful-target` only after confirming those env files and the backend are pointed at the intended disposable/local target. Pass `--account acct_...` so the smoke cannot silently choose whichever connected account row happens to be newest. Non-loopback webhook endpoints are blocked unless `--allow-remote-endpoint` is supplied for an explicitly intended remote smoke.

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
- Confirm `LIVE_BILLING_ENABLED=false`; do not connect, sync, charge, refund, retry, void, or otherwise mutate Stripe as part of this checklist.
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

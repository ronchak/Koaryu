# Render Backend Deployment

Koaryu uses Vercel for the Next.js frontend and Render for the FastAPI backend. Render deploys from GitHub, so only committed and pushed files reach production.

## Render Service

Use the root `render.yaml` Blueprint when creating the service.

Expected service settings:

- Service name: `koaryu`
- Type: Web Service
- Runtime: Python
- Region: Ohio
- Root directory: `backend`
- Build command: `pip install -r requirements.txt`
- Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Health check path: `/health`

Render should use Python `3.11`. The backend includes both `backend/runtime.txt` (`python-3.11.9`) and `backend/.python-version` (`3.11`) so Render does not default to a newer Python release that lacks compatible wheels for pinned dependencies.

The free Render service runs a single lightweight Uvicorn process intentionally. Four Gunicorn workers duplicate the FastAPI/Supabase/Stripe import footprint during cold wakeups, which leaves too little headroom on small instances. Keep `render.yaml`, `backend/Procfile`, and `backend/requirements.txt` aligned with this choice; Gunicorn should not be reintroduced unless the service moves to a larger instance and the memory budget is measured again.

## Config Vars

Render will prompt for values marked `sync: false` in `render.yaml`. Use `backend/.env.render.example` as the checklist.

Fixed values:

```env
FRONTEND_URL=https://koaryu.app
ENVIRONMENT=production
API_V1_PREFIX=/api/v1
DEMO_RESET_ENABLED=false
BILLING_PLATFORM_FEE_BPS=50
SUPABASE_URL=https://mimguepumzsgmcaycdsh.supabase.co
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
STRIPE_CONNECT_CLIENT_ID=
```

## Verify Render

After the first deploy finishes:

```bash
curl https://koaryu.onrender.com/health
curl https://koaryu.onrender.com/api/v1/health
curl https://koaryu.onrender.com/openapi.json | python3 -m json.tool | grep '"/'
```

If the build succeeds but the live backend still looks old or unreachable, inspect the Render deploy logs under the runtime/startup section after the build phase.

## Connect Vercel

After Render is live, update the Vercel frontend production env var:

```env
NEXT_PUBLIC_API_URL=https://koaryu.onrender.com/api/v1
```

Then redeploy the Vercel frontend so Next.js bakes the new URL into the production build.

The public landing page warms the backend by calling `/api/proxy/health` after the page hydrates. That proxy route forwards to `NEXT_PUBLIC_API_URL`, so verify the Vercel production value includes the `/api/v1` suffix and reaches the same Render service used by authenticated app routes.

Do not route `/` through frontend auth middleware just to warm Render. The landing page should paint immediately; login, onboarding, subscription-required, and dashboard routes remain responsible for blocking on Supabase and backend auth checks.

## Release Verification

Before tagging or announcing a release:

```bash
cd backend
ENVIRONMENT=production FRONTEND_URL=https://koaryu.app \
  venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001
```

In another shell:

```bash
curl -fsS http://127.0.0.1:8001/health
curl -fsS http://127.0.0.1:8001/api/v1/health
```

For frontend changes, run at least the targeted lint pass for the release surface:

```bash
cd frontend
npm run lint -- src/app/page.tsx src/components/backend-warmup.tsx src/lib/supabase/middleware.ts src/proxy.ts
```

## Stripe Webhooks

After Render is live, configure Stripe webhook endpoints. Use Stripe test mode first, then repeat in live mode after the same verification checklist passes.

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
STRIPE_CONNECT_WEBHOOK_SECRET=
```

Then redeploy the backend so FastAPI verifies signatures with the new secrets.

### Local Connect Webhook Smoke Test

With the backend running on `127.0.0.1:8001`, run:

```bash
npm run dev:stripe-connect-smoke
```

The smoke test signs a synthetic Connect `account.updated` event with `STRIPE_CONNECT_WEBHOOK_SECRET`, posts it to `/api/v1/webhooks/stripe/connect`, and posts the same event again. A passing result returns `processed` first and `already_processed` second, proving the local route, signature validation, projector entrypoint, and `stripe_events` dedupe table.

For true Stripe delivery in local development, use the Stripe CLI or a trusted HTTPS tunnel:

```bash
stripe listen --forward-connect-to http://127.0.0.1:8001/api/v1/webhooks/stripe/connect
```

Copy the CLI-provided `whsec_...` into `backend/.env` as `STRIPE_CONNECT_WEBHOOK_SECRET`, restart the backend, then replay a recent test event:

```bash
stripe events resend evt_... --webhook-endpoint we_...
```

### Koaryu Payments Rollout Checks

Before enabling live Koaryu Payments for a studio:

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

### Rollout Risks

- Do not enable new Stripe billing actions for a studio whose Connect account is `deauthorized` or lacks `charges_enabled`.
- Keep `BILLING_PLATFORM_FEE_BPS=50` unless the fee promise changes. External payments must keep `application_fee_amount_cents=0`.
- Stripe and Supabase writes are not atomic. Local intent rows, deterministic Stripe idempotency keys, webhook projection, and reconciliation are all required to repair partial success.
- Treat plan pricing as immutable. Create a new connected-account Price for amount or interval changes; migrate active subscriptions deliberately.
- Preserve test data until the verification pass is reviewed. Delete or archive Stripe/Supabase test artifacts only after an explicit cleanup approval.

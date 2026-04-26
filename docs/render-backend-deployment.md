# Render Backend Deployment

Koaryu uses Vercel for the Next.js frontend and Render for the FastAPI backend. Render deploys from GitHub, so only committed and pushed files reach production.

## Render Service

Use the root `render.yaml` Blueprint when creating the service.

Expected service settings:

- Service name: `koaryu-api`
- Type: Web Service
- Runtime: Python
- Region: Ohio
- Root directory: `backend`
- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn -w 4 -k uvicorn.workers.UvicornWorker app.main:app --bind 0.0.0.0:$PORT`
- Health check path: `/health`

Render should use Python `3.11`. The backend includes both `backend/runtime.txt` (`python-3.11.9`) and `backend/.python-version` (`3.11`) so Render does not default to a newer Python release that lacks compatible wheels for pinned dependencies.

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
curl https://koaryu-api.onrender.com/health
curl https://koaryu-api.onrender.com/api/v1/health
curl https://koaryu-api.onrender.com/openapi.json | python3 -m json.tool | grep '"/'
```

If the build succeeds but the live backend still looks old or unreachable, inspect the Render deploy logs under the runtime/startup section after the build phase.

## Connect Vercel

After Render is live, update the Vercel frontend production env var:

```env
NEXT_PUBLIC_API_URL=https://koaryu-api.onrender.com/api/v1
```

Then redeploy the Vercel frontend so Next.js bakes the new URL into the production build.

## Stripe Webhooks

After Render is live, configure Stripe webhook endpoints:

```txt
https://koaryu-api.onrender.com/api/v1/webhooks/stripe/platform
https://koaryu-api.onrender.com/api/v1/webhooks/stripe/connect
```

Copy the resulting `whsec_...` values back into Render:

```env
STRIPE_PLATFORM_WEBHOOK_SECRET=
STRIPE_CONNECT_WEBHOOK_SECRET=
```

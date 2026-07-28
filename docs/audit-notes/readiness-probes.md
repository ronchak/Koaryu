# Runtime readiness contract

## Endpoint meanings

`GET` or `HEAD /health` and `/health/live`, including their `/api/v1`
aliases, are process-liveness checks. A successful response proves that the
FastAPI process can answer HTTP and returns only safe deployment identity
metadata. These endpoints do not contact Supabase or any other provider.

`GET` or `HEAD /health/ready`, including `/api/v1/health/ready`, proves both:

1. the existing hosted runtime-configuration validation passes; and
2. the backend can create an isolated service-role Supabase client and complete
   `SELECT id FROM public.studios LIMIT 1` through the Data API.

The query is deliberately bounded and read-only. It succeeds even when the
table has no rows. It proves Data API reachability, service-role authorization,
and availability of the required `public.studios` table and `id` column. The
response never includes query results or provider error details.

## Timeout and failure behavior

The isolated Supabase client has a 1.5-second PostgREST request timeout. Because
the pinned client is synchronous, the whole client creation and query run in a
worker thread rather than on the event loop. The readiness endpoint also
enforces a 2.0-second outer deadline.

Invalid runtime configuration, client-construction errors, query failures, and
timeouts all return the same `503` response:

```json
{"detail":"Service is not ready."}
```

The response is marked `Cache-Control: no-store, max-age=0`. Dependency failure
does not change `/health` or `/health/live`; they continue to report process
liveness.

## Intentional exclusions

Readiness does not create or update records, invoke RPCs, inspect tenant data,
repair subscriptions, or call Stripe, Auth, Storage, Realtime, email, or other
optional integrations. It does not prove that the database is nonempty, every
migration is installed, every tenant operation works, or downstream providers
are healthy. Those broader contracts remain release-verification and
observability responsibilities.

## Provider-routing follow-up

`render.yaml` intentionally remains on `healthCheckPath: /health`. Before
considering `/health/ready` for provider routing, validate the new failure and
recovery behavior in staging and determine how Render treats dependency
timeouts during deploys, cold starts, and transient outages. That routing
decision is separate from this endpoint implementation.

# Runtime readiness investigation brief

> Planning-only draft. No readiness behavior is changed here. This note reflects static review of `main` at `0dbf7c0` and should be treated as a hypothesis to verify against the deployed environments. The implementing agent should prefer measured evidence over this suggested framing.

## Executive summary

Koaryu exposes liveness and readiness endpoints, but the current readiness implementation appears to revalidate configuration only. It does not verify that Supabase is reachable or that a minimal application dependency can complete successfully. Render is configured to check `/health`, which is the process-liveness alias rather than `/health/ready`.

The practical concern is a false-positive readiness signal. A process with valid environment variables but an unavailable database can still report ready and continue receiving user traffic.

## What the suspected bug is

`backend/app/api/v1/endpoints/health.py` returns liveness metadata for `/health` and `/health/live`. `/health/ready` calls `validate_runtime_configuration()`, which checks environment shape and safety. It does not appear to perform a bounded Supabase connectivity or query probe.

`render.yaml` points the provider health check at `/health`. That endpoint proves the process can answer HTTP and exposes safe deployment identity, but it does not prove that the application can serve authenticated tenant requests.

## Why this matters

A useful readiness check should remove an instance from service when required runtime dependencies are unavailable. Configuration validation is valuable at startup, but it answers a different question. Without a dependency-aware readiness signal:

- provider routing can continue to send traffic to an unusable instance
- deployment dashboards can look healthy during a database outage
- operators may lose time distinguishing process health from service health
- automated rollback or promotion logic may rely on an overly optimistic signal

The check must remain shallow and safe. Readiness should not create records, trigger billing repair, or make Stripe availability a prerequisite for general application health.

## Current impact

The mismatch exists today. No outage was reproduced during the review, so there is no verified customer-facing incident to attribute to it. The current impact is that operational evidence from `/health/ready` and Render’s configured health check is weaker than their names imply.

## Root cause hypothesis

The readiness endpoint was introduced primarily to recheck hosted configuration and expose exact deployment metadata. That was a meaningful improvement over liveness alone. The implementation stopped at configuration because adding provider probes can create latency, cost, and cascading-failure risks if done carelessly.

## Suggested reproducibility and verification

In an isolated environment, start the backend with valid configuration and then make Supabase unreachable without terminating the process. Call `/health`, `/health/live`, and `/health/ready`. Confirm which endpoints remain successful. Repeat with a database that is reachable but lacks an expected migration or required RPC if a safe disposable environment is available.

Inspect Render behavior separately. Verify which path it polls, the polling timeout, and whether a failing readiness endpoint actually removes the instance from service or merely marks the deployment unhealthy.

## Suggested plan of action

This is suggested guidance, not an implementation specification.

Define the exact readiness contract first. A likely minimum is process health, valid hosted configuration, and one bounded read-only Supabase operation that proves the application’s required database path is usable. Consider whether migration-contract identity can be checked cheaply, or whether that belongs exclusively in release verification.

Use strict timeouts and avoid deep dependency chains. Stripe, email providers, and optional reporting surfaces probably should not be part of core readiness. Reevaluate Render’s health-check path only after the new contract has been proven stable.

## Scope guard

Do not turn readiness into a full synthetic test, perform tenant writes, call payment mutations, or make every optional integration a hard dependency. Do not change provider routing until the new endpoint behavior is understood in staging.

## Evidence expected before merge

The eventual implementation should show failing and passing dependency cases, confirm that liveness remains available during dependency failure, include targeted tests, and document the provider-health behavior. The release record should state exactly what readiness proves and what it intentionally does not prove.

## Future-work note

This draft PR contains only this investigation note. The actual readiness change will be implemented later.
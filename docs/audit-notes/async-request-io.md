# Async request I/O investigation brief

> Planning-only draft. This note does not implement a fix. It records a working hypothesis from a static review of `main` at `0dbf7c0`. The future implementing agent should reproduce the behavior, challenge the assumptions below, and choose the smallest safe design. No deployment, migration, provider configuration, or production-data change is proposed here.

## Executive summary

Several FastAPI request paths are declared `async`, but still call the synchronous Supabase and Stripe clients directly. Koaryu currently runs a single Uvicorn process in production. If one of those synchronous network calls is slow, it may occupy the event-loop thread and delay unrelated requests that would otherwise be able to make progress concurrently.

This is not a claim that Koaryu is currently experiencing an outage or unacceptable latency. The current user load may be low enough that the effect is rarely visible. The concern is that the request architecture can convert ordinary provider latency into cross-request latency, which becomes harder to reason about as traffic or provider variance increases.

## What the suspected bug is

Representative paths include:

- async dependencies in `backend/app/core/deps.py` that call synchronous membership and subscription-resolution code
- `backend/app/services/studio_scope.py`, which performs synchronous Supabase and possible Stripe-backed entitlement work
- student listing and response construction through `student_service.py`, `student_list_query.py`, and `student_response_builder.py`
- platform billing repair paths that use the synchronous Stripe SDK

Some newer code correctly uses `asyncio.to_thread` or `run_in_threadpool`, especially authentication. That makes the inconsistency more visible rather than resolving it globally.

## Why this matters

A blocked event loop affects more than the slow request. It can delay health responses, authentication, roster reads, attendance, and other unrelated work handled by the same process. Tail latency can therefore rise sharply before average latency looks obviously bad. A single-worker deployment increases that sensitivity.

The long-term importance is reliability, not premature scale optimization. The goal should be to make blocking boundaries explicit so future agents do not have to guess which service methods are safe to call from async code.

## Current impact

No production incident was verified during the review. The current impact is architectural risk and potentially avoidable latency coupling. It may already appear as occasional pages that wait behind a slow database or provider call, but that must be measured rather than assumed.

## Root cause hypothesis

The likely root cause is a mixed concurrency model. FastAPI routes were written as async while the primary database and payment SDKs remained synchronous. Over time, selected hot paths were moved into worker threads, but no repository-wide rule or adapter boundary was established. The result is locally reasonable code with globally inconsistent execution semantics.

## Suggested reproducibility and verification

The implementing agent should first prove or reject the hypothesis. A useful experiment would introduce controlled latency in a representative synchronous Supabase call, then issue concurrent requests against the same application process. Compare event-loop lag and latency for unrelated endpoints with and without threadpool isolation. Repeat against a student-list path and a subscription-access path.

The test should distinguish direct backend traffic from requests routed through the Next.js proxy. It should also capture the configured worker count and avoid treating local development reload behavior as production behavior.

## Suggested plan of action

The direction below is guidance, not a mandated implementation.

First inventory synchronous external I/O reachable from async routes and dependencies. Then choose a coherent boundary. Plausible approaches include moving blocking service calls through a shared threadpool adapter, converting selected route handlers to synchronous FastAPI functions so Starlette handles them in its worker pool, or adopting async clients only where they are mature and materially useful.

Prefer a small, explicit convention over a broad rewrite. Add one concurrency regression test that would fail if a representative slow provider call again blocks unrelated requests. Recheck threadpool sizing and failure behavior after the change.

## Scope guard

This future PR should not rewrite the full backend, replace Supabase, enable multiple production workers without understanding state and deployment implications, or mix in unrelated performance work. The first objective is to make blocking I/O boundaries correct and observable.

## Evidence expected before merge

The implementation should include a measured reproduction, an explanation of the chosen concurrency model, targeted tests, full backend verification, and a brief note on deployment-worker assumptions. A result that proves the original concern immaterial is also acceptable if supported by evidence.

## Future-work note

This draft exists so the finding can be implemented later in a dedicated pass. The branch currently contains only this investigation note.
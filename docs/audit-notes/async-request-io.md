# Async request I/O investigation

## Result

The blocking-I/O hypothesis was confirmed against `origin/main` at
`a615bdf`. Representative async request paths called the synchronous Supabase
and Stripe clients on the event-loop thread.

The controlled regression in `backend/tests/test_async_request_io.py` gives a
synchronous fake provider an event that only the event loop can release. Before
the fix, both the student-list Supabase path and the platform-billing Stripe
path held the loop until the provider's 500 ms safety timeout expired. With the
blocking boundary in place, the loop released both providers after about
20 ms. The test asserts the causal event ordering rather than a broad latency
benchmark.

The Next.js proxy was not part of the controlled test. It can add transit time,
but it cannot allow a blocked backend event loop to schedule another backend
request, so it does not change the concurrency failure or the chosen boundary.

## Implemented boundary

The backend keeps the synchronous Supabase and Stripe SDKs and uses the
existing `starlette.concurrency.run_in_threadpool` convention at these
high-value async entry points:

- isolated Supabase-client construction and the shared studio membership,
  permission, and subscription dependencies in `app/core/deps.py`
- the student-list query and response-build operation
- platform-billing status, email usage, checkout, and portal operations,
  including their admin membership resolution

This is deliberately not an async-client migration or a mechanical rewrite of
every service. It removes provider waits from the event loop at the common
authorization boundary and the two measured request surfaces while preserving
the existing synchronous domain functions and HTTP behavior.

Moving strict subscription repair into the worker pool makes requests for one
studio concurrent. The process-local repair throttle previously relied on
event-loop serialization, so strict repair now also takes a per-studio
process-local lock across the read, provider repair, and outcome record. That
keeps one provider repair in flight per studio without serializing unrelated
tenants.

## Failure and cancellation semantics

Exceptions raised by Supabase, Stripe, or the synchronous domain code propagate
through `run_in_threadpool` unchanged. Existing FastAPI exception handling
therefore keeps the same response behavior.

Cancellation stops the awaiting coroutine but cannot stop Python code already
running in a worker thread. A provider call or persistence sequence may finish
after its requester disconnects or is cancelled. The regression pins that
behavior so later changes do not mistake task cancellation for provider
cancellation. Blocking calls must retain bounded client timeouts, and mutations
must retain their existing idempotency and replay protections.

## Production worker assumptions

Render still starts one Uvicorn process:

```text
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

The change adds worker-thread isolation inside that process; it does not add
Uvicorn or Gunicorn processes and does not change the deployment memory model.
Starlette delegates to AnyIO's bounded default threadpool, with no Koaryu
override.

The subscription repair lock and retry windows are process-local. That matches
the current single-process deployment. If multiple Uvicorn workers are added
later, each worker will have its own single-flight lock and retry window, so a
burst can perform one repair per process. Cross-process coordination should be
designed only alongside a measured worker-count change.

## Scope guard

This change does not replace Supabase or Stripe clients, alter provider
configuration, add production workers, or claim that all backend synchronous
I/O has been audited. New async request entry points that call synchronous
provider code should use the same Starlette threadpool boundary and preserve
any process-local concurrency invariants they expose.

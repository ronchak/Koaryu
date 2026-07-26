# Request body buffering investigation brief

> Planning-only draft. This note does not change upload or proxy behavior. The original review described possible double buffering, but static inspection alone cannot prove the actual peak-memory profile because Starlette may spool multipart files and the existing middleware preserves original ASGI chunks. The future agent should measure first and is expected to correct this hypothesis if the evidence disagrees.

## Executive summary

Koaryu correctly enforces bounded request sizes before FastAPI parses write requests. The backend middleware reads and retains incoming ASGI messages so it can reject overflow and replay the original body downstream. The Next.js proxy also reads a bounded body before forwarding it.

The suspected weakness is memory pressure under concurrent large uploads, particularly CSV imports with an allowed multipart envelope of roughly 31 MB. The important question is not whether requests are bounded. They are. The question is how many request-sized copies exist at each layer, when multipart content spills to disk, and whether the single-process backend can tolerate several concurrent maximum-size requests.

## What the suspected bug is

Relevant code includes:

- `backend/app/core/request_body_limits.py`
- `backend/app/core/upload_limits.py`
- the student CSV upload endpoints
- `frontend/src/app/api/proxy/[...path]/route.ts`
- proxy request-body helpers

The backend middleware stores each ASGI message in a deque until the full body has been received, then replays those messages to the application. FastAPI and Starlette subsequently parse multipart content. The exact memory behavior depends on chunk size, object overhead, parser behavior, and `SpooledTemporaryFile` thresholds.

The original phrase “buffered twice” should therefore be treated as a testable concern, not a fact.

## Why this matters

A bounded 31 MB request can still be operationally expensive on a small Render instance. Several concurrent imports may create substantial transient memory pressure, garbage-collection work, and latency. If the Next.js proxy is enabled, the request may also consume meaningful memory in the frontend runtime before reaching the backend.

The risk is denial of service through legitimate or abusive concurrency rather than unbounded single-request growth. Any optimization must preserve the existing pre-parser enforcement and byte-for-byte webhook and multipart behavior.

## Current impact

No out-of-memory event or production degradation was verified. The current impact is uncertainty about peak memory and concurrency safety. PR #43 materially reduced risk by adding strict limits and preserving original chunks rather than creating an obvious second contiguous backend buffer. This investigation should not discard that safety work.

## Root cause hypothesis

The application needed to reject oversized multipart bodies before Starlette parsed them. ASGI does not provide a free, portable way to inspect the whole body and then let downstream code read it again. Retaining and replaying messages is a reasonable design, but it trades memory for early enforcement.

## Suggested reproducibility and verification

Measure resident memory, Python allocation data, request latency, and failure behavior for direct-backend and proxied uploads at several sizes up to the configured maximum. Repeat with one, two, and several concurrent requests. Include both multipart CSV and ordinary JSON bodies.

Determine when Starlette spools uploaded files to disk and whether the middleware’s deque retains only references to original byte chunks or causes copies. Inspect frontend runtime memory separately. Perform tests only with synthetic data in a disposable environment.

## Suggested plan of action

Measurement should decide whether a change is warranted. If peak memory is acceptable for the approved instance size and concurrency, the correct outcome may be documentation plus explicit concurrency assumptions.

If material pressure is proven, explore narrowly scoped options such as lower envelopes grounded in real import needs, concurrency limiting for large uploads, direct-to-temporary-file streaming with a replayable receive abstraction, or bypassing the Next proxy for large files when the direct backend path is safe. Preserve signature validation and exact bytes for Stripe webhooks.

## Scope guard

Do not remove request limits, allow parsing before limits are enforced, alter CSV semantic limits without product evidence, or introduce an upload service merely for architectural neatness. Do not claim memory improvement without measured before-and-after results.

## Evidence expected before merge

The eventual implementation should include a reproducible memory profile, concurrent-load results, unchanged overflow and byte-integrity tests, and a clear statement of supported maximum request concurrency for the deployed instance class.

## Future-work note

This branch contains only the investigation note. No request-body behavior has changed.
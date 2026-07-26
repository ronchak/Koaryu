# Unhandled exception observability investigation brief

> Planning-only draft. This note proposes no logging or alerting change. It is based on static review of `main` at `0dbf7c0`. The future implementing agent must verify current hosted logging, provider behavior, and privacy constraints before deciding what to change.

## Executive summary

Koaryu’s global exception handler correctly returns a generic, user-safe `500` response, but it appears to discard the underlying exception without recording a stack trace, request correlation value, or safe diagnostic reference. That protects users from internal detail leakage, yet it can also make unexpected production failures difficult to diagnose.

The suspected bug is not the generic client response. That behavior should remain. The issue is the absence of a dependable server-side observability boundary for exceptions that escape service-level handling.

## What the suspected bug is

`backend/app/core/error_handlers.py` defines `unhandled_exception_handler(request, _exc)`. The handler produces a normalized error payload and adds CORS headers for approved origins. The exception argument is intentionally unused. No logger call or support reference is visible in that handler.

Some services have their own carefully redacted logs. Those are useful but do not guarantee that every unexpected failure is captured. Any error that bypasses those local paths can reach the global handler and become a generic `500` with no durable diagnostic evidence.

## Why this matters

A production-safe application needs both non-disclosing client responses and actionable server evidence. Without a global boundary:

- operators may know that a user saw a `500` but not why
- intermittent failures become difficult to correlate across frontend, proxy, backend, Supabase, and Stripe
- alerting cannot include a stable support reference
- the same failure may be investigated repeatedly from incomplete user reports
- incident response depends on scattered service logs rather than one reliable fallback

The solution must not reverse the repository’s prior work on billing-log redaction. Raw provider messages, secrets, tenant identifiers, and PII should not be sprayed into broad logs.

## Current impact

The missing fallback logging is present in current source. No specific production incident was verified. The immediate impact is reduced diagnostic capability for any uncaught exception. The severity depends on the external logging and tracing configuration, which was not inspected through this repository review.

## Root cause hypothesis

The global handler was likely designed primarily to normalize response shape and prevent exception leakage. Earlier security work correctly emphasized safe output and redaction. The implementation may have intentionally avoided logging because exception text can contain provider identifiers or secret-shaped material. The remaining gap is a safe logging policy rather than simple omission.

## Suggested reproducibility and verification

In a controlled test app using the real handler, raise an unexpected exception containing an obvious secret-shaped marker. Capture application logs and the HTTP response. Confirm that the client sees only the generic payload and determine whether any server log or provider trace contains a safe record of the failure.

Repeat through the production application stack if staging observability is available. Check whether Vercel proxy logs, Render logs, or another provider already assigns request IDs that can be reused. Verify CORS behavior and avoid printing real secrets or production PII during testing.

## Suggested plan of action

The following is guidance, not a required design.

Define a small structured event for uncaught exceptions. It might include a generated correlation reference, exception class, route template or normalized path, HTTP method, deployment SHA, environment, and a server-side stack trace sent only to an approved sink. Redaction rules should be explicit. The client response may optionally include a nonsensitive support reference, but that should be decided with the support workflow rather than assumed.

Add tests proving both sides of the contract. Internal detail must not appear in the response, while a safe diagnostic event must be emitted. Coordinate with the separate alert-delivery work so logging and paging are not conflated.

## Scope guard

Do not add raw request bodies, authorization headers, cookies, full query strings, provider exception messages, student information, or billing identifiers to broad logs. Do not introduce a large observability platform unless it is justified separately.

## Evidence expected before merge

The eventual implementation should include redaction-focused tests, a demonstrated correlation flow, documentation of retained fields and sinks, and staging evidence that an unexpected exception can be found without exposing sensitive data.

## Future-work note

This branch records the investigation only. The implementation will be handled in a later pass.
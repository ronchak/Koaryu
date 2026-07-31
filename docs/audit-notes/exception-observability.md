# Unhandled exception observability implementation

> Implementation status: the global FastAPI exception boundary now emits a deliberately restricted structured event and returns an opaque correlation reference. Alert delivery and a privileged traceback sink remain separate concerns.

## Executive summary

Koaryu’s global exception handler continues to return the existing generic, user-safe `500` response. It now also emits one searchable server-side event and returns the same opaque error reference in `X-Koaryu-Error-Reference`.

The event intentionally does not include an exception message or traceback. Those values can contain raw provider errors, secrets, tenant or student identifiers, billing data, or other personally identifiable information.

## Implemented boundary

`backend/app/core/error_handlers.py` defines the event and response contract. Every exception that reaches `unhandled_exception_handler` receives a newly generated `err_` reference. The handler logs a one-line JSON object containing only:

- `event`: the fixed value `backend.uncaught_exception`
- `error_reference`: the opaque reference returned to the client
- `exception_type`: the exception class name, never its message or arguments
- `http_method`: a recognized HTTP method or `OTHER`
- `route_template`: the code-defined route template, never the requested path or query string

## Why this matters

A production-safe application needs both non-disclosing client responses and actionable server evidence. This boundary lets:

- support pass an opaque reference to operators without copying sensitive context
- operators find the corresponding Render log event
- repeated exception classes and normalized routes be grouped without tenant data
- future alerting key off one stable event name

This does not replace narrow service-specific evidence or authorize additional fields in broad logs.

## Client contract

The response body remains:

```json
{
  "detail": "Internal server error.",
  "error": {
    "code": "internal_server_error",
    "status_code": 500
  }
}
```

`X-Koaryu-Error-Reference` is opaque and contains no user, studio, student, billing, provider, or request data. Approved browser origins may read it through CORS.

## Redaction contract

The global event must never include request bodies, authorization headers, cookies, the requested path, full query strings, exception messages or arguments, tracebacks, raw provider errors, PII, or tenant, studio, student, payer, invoice, subscription, or other billing identifiers. An unmatched or unsafe route template is logged as `<unmatched>`.

Tests exercise the real handler with secret-shaped headers, cookies, bodies, queries, path identifiers, and exception messages. They assert that the client response remains generic, the event contains exactly the approved fields, and the response header matches the logged reference.

## Operations

Search Render runtime logs for the exact `err_...` value supplied by support. The matched JSON event identifies the normalized route and exception class without exposing request context. See [Render Backend Deployment](../render-backend-deployment.md#uncaught-exception-correlation).

## Deferred work

Paging, retention policy, privileged trace capture, and a third-party monitoring platform require separate review. A future trace sink must be access-controlled and must apply its own redaction policy; the broad event must not be expanded as a shortcut.

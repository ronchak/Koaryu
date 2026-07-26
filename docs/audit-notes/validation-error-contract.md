# Validation error contract investigation brief

> Planning-only draft. This note does not change response behavior. It records a static-review finding from `main` at `0dbf7c0` that must be reproduced before implementation. The suggested direction is not authoritative.

## Executive summary

Koaryu’s OpenAPI customization removes Pydantic validation fields such as `input` and `ctx` from the documented `ValidationError` schema. The runtime `422` handler, however, appears to return `exc.errors()` without applying the same normalization. The API may therefore return fields that its generated contract says are absent.

This creates a contract mismatch and can unnecessarily echo rejected user input into client responses. The issue is narrow and should be solved at the error-normalization boundary rather than by redesigning endpoint schemas.

## What the suspected bug is

In `backend/app/core/error_handlers.py`:

- `request_validation_exception_handler` serializes `exc.errors()` directly into `detail`
- `_install_error_openapi_contract` removes `input` and `ctx` from the documented validation-detail schema

The existing tests verify the cleaned OpenAPI schema and the presence of error metadata, but they do not appear to assert that runtime validation responses omit the same fields.

Pydantic and FastAPI versions can affect the exact shape, so the future agent should inspect actual runtime responses rather than rely only on static expectations.

## Why this matters

The primary issue is contract integrity. Generated frontend types and API documentation should describe what clients actually receive. A mismatch makes client behavior harder to reason about and can conceal breaking changes during dependency upgrades.

There is also a privacy consideration. Rejected input belongs to the caller, so this is not automatically a cross-tenant leak. Still, returning full invalid values can cause passwords, free-form notes, contact details, or other sensitive fields to appear in browser telemetry, screenshots, proxy captures, or support reports when the client logs validation responses.

## Current impact

The code paths currently differ. The exact runtime payload and whether sensitive values are exposed for Koaryu’s active schemas were not experimentally verified during the review. The current impact is therefore a confirmed documentation/runtime divergence with a probable, but unmeasured, data-echo surface.

## Root cause hypothesis

The OpenAPI contract was deliberately normalized after a framework upgrade, while the runtime handler retained FastAPI’s native error list. These two concerns were handled independently. The tests reinforced the documentation shape but did not establish one shared normalization function used by both runtime and schema generation.

## Suggested reproducibility and verification

Create representative invalid requests against the real application and inspect the `422` JSON. Include missing fields, wrong types, overlong strings, malformed structured input, and at least one secret-shaped value in a disposable test. Compare the runtime keys with the generated OpenAPI `ValidationError` definition and generated frontend contract.

Confirm whether `ctx` contains non-JSON-safe objects in any active validation path. Verify that changes do not remove useful `loc`, `msg`, and `type` data required by the frontend.

## Suggested plan of action

The future agent should first define the intended public validation-error shape. A likely direction is one shared sanitizer that preserves stable location, message, and error-type information while removing raw input and unsafe context. The runtime handler and OpenAPI contract should derive from the same decision.

Avoid hand-editing generated frontend types without changing the source contract. Add response-level tests using the actual app and rerun API type generation. If the agent concludes that `input` or selected context is intentionally public, the documentation should instead be corrected and the privacy implications documented.

## Scope guard

Do not redesign all error responses, change endpoint status codes, or rewrite Pydantic schemas as part of this work. Keep the change limited to validation-error normalization and contract parity.

## Evidence expected before merge

The eventual PR should include before-and-after runtime examples, contract-generation checks, tests proving sensitive input is not echoed unexpectedly, and frontend compatibility verification.

## Future-work note

This branch contains only the investigation note. No runtime or generated-contract change has been made.
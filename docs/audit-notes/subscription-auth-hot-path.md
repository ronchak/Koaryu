# Subscription authorization hot-path investigation brief

> Planning-only draft. This note does not implement a fix. It records a working interpretation of `main` at `0dbf7c0`, based on static source review. The future implementing agent should verify every claim against current behavior and may reject the suggested direction if better evidence supports another design. No live billing, provider, deployment, migration, or production-data action is authorized here.

## Executive summary

Ordinary tenant access can currently trigger platform-subscription repair work. A request for roster, schedule, attendance, or another non-billing surface resolves the user’s studio with `require_platform_subscription=True`. That path can call `PlatformBillingService.get_access_status_row(..., strict_repairs=True)`, which may retrieve or list Stripe subscriptions and then update local subscription state before the application decides whether the user may proceed.

The suspected defect is not that subscription enforcement exists. It is that entitlement evaluation, remote repair, and local persistence are coupled inside the authorization hot path. This can make operational product availability depend on Stripe latency or availability even when the user is not performing a billing operation.

## What the suspected bug is

The relevant flow appears to span:

- `backend/app/core/deps.py`
- `backend/app/services/studio_scope.py`
- `backend/app/services/platform_billing_service.py`

A tenant-scoped request resolves membership, requires platform access, loads the local subscription row, and attempts repairs for missing subscription identifiers, stale status, or missing period fields. Repair may call Stripe synchronously and write the repaired projection back to Supabase.

Some terminal or incomplete states may remain eligible for repair on subsequent requests. Whether that causes repeated provider calls in practice should be verified with actual row shapes and Stripe responses.

## Why this matters

Authorization should generally be fast, deterministic, and available from local authoritative state. Provider reconciliation has different latency, retry, failure, and observability requirements. Combining them creates several risks:

- unrelated operational requests can fail because Stripe is slow or unavailable
- a read-like request can perform repair writes
- repeated requests may repeat expensive provider lookups
- authorization behavior becomes difficult to test without simulating Stripe
- a payment-provider degradation can look like a general product outage

The system should still fail safely when subscription state cannot be trusted. The question is where and when remote reconciliation belongs, not whether payment access rules should be weakened.

## Current impact

No confirmed production incident was found. The current impact is a real dependency coupling in the request path, plus possible latency and availability amplification. It may be invisible at current traffic levels. It is still important because nearly every tenant request passes through the entitlement boundary.

## Root cause hypothesis

The likely root cause is an understandable effort to repair eventual consistency before making an access decision. Local subscription projections can become stale when webhooks are delayed or incomplete, so the access resolver was given responsibility for repairing them. That improved correctness for individual requests but blurred the boundary between authorization and reconciliation.

## Suggested reproducibility and verification

Create controlled local subscription rows representing at least active, expired trial, canceled, incomplete, missing subscription ID, and malformed period states. Instrument or stub Stripe calls. Request a non-billing endpoint such as the students list and record whether Stripe is called, whether Supabase is mutated, and what status is returned when Stripe times out.

Repeat the same request to determine whether repair attempts recur. Verify behavior in development, staging, and production configuration because degradation rules differ by environment.

## Suggested plan of action

The following is a direction, not a prescribed patch.

Define which local fields are authoritative enough for an access decision and the maximum acceptable staleness. Separate entitlement evaluation from provider repair. Repair could be handled by webhook projection, a bounded scheduled reconciliation process, an explicit operator action, or a controlled refresh that does not sit inside every application request.

The implementation should preserve fail-closed behavior for genuinely unknown or unsafe states while avoiding unnecessary Stripe calls for stable local states. It should also establish a clear policy for provider outages and stale-but-recent local projections.

## Scope guard

Do not use this PR to enable live billing, redesign Koaryu pricing, rewrite the Stripe integration, or weaken tenant authorization. Keep the work focused on the placement and semantics of subscription repair relative to routine access checks.

## Evidence expected before merge

The future implementation should include a call-path reproduction, a state-transition matrix for the affected subscription states, tests proving ordinary product requests do not perform unexpected provider work, and explicit outage behavior. Staging Stripe-test evidence may be useful, but no real payment or live mutation is part of this scope.

## Future-work note

This branch contains only the investigation note. Implementation will be handled in a later, separately reviewed pass.
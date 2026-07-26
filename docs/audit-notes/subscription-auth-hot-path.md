# Subscription authorization hot-path investigation and remediation

> Implemented. This note began as a planning-only brief written from static review of `main` at `0dbf7c0`. It now records both the investigation and the change that shipped on this branch. Two of the original conclusions were wrong and are corrected below rather than quietly deleted, because the original framing would mislead anyone re-reading it. No live billing, provider, deployment, migration, or production-data action was taken.

## Executive summary

Ordinary tenant access can trigger platform-subscription repair work. A request for roster, schedule, attendance, or another non-billing surface resolves the user's studio with `require_platform_subscription=True`. That path calls `PlatformBillingService.get_access_status_row(..., strict_repairs=True)`, which may retrieve or list Stripe subscriptions and then update local subscription state before the application decides whether the user may proceed.

The defect is not that subscription enforcement exists. It is that entitlement evaluation, remote repair, and local persistence were coupled inside the authorization path in a way that could not converge.

## Corrections to the original brief

**The blast radius was overstated.** The original note implied Stripe sits in front of essentially every tenant request. Measured against the real code, a studio whose local row is entitled and self-consistent makes **zero** Stripe calls. The provider call fires only for degenerate row shapes: `canceled`, `incomplete`, `incomplete_expired`, a live status with missing period fields, or a `trialing` row past its `trial_end`. The authorization *path* is universal; the Stripe *call* is not.

**The coupling was deliberate, not accidental.** The original note attributed it to an unplanned effort to repair eventual consistency. In fact `test_access_does_not_use_no_stripe_fallback_in_production`, its staging counterpart, and `test_access_repairs_stale_incomplete_subscription_before_denial` show a considered decision: do not trust a local row that cannot be verified, and attempt repair before denying a possibly stale-negative row. That decision was kept.

## What actually shipped

The real defect was non-convergence. `_should_repair_subscription_state` fires for any status outside `LIVE_STRIPE_SUBSCRIPTION_STATUSES`; Stripe returns the same non-live status, it is written back unchanged, and the next request re-evaluates identically. A lapsed studio therefore issued a synchronous Stripe call on every authenticated request, indefinitely. During a Stripe degradation each of those requests waits out a provider timeout on the single production Uvicorn worker, so one lapsed studio could slow every other tenant.

Three changes, no migration:

1. **Retry throttle on the authorization path.** `ACCESS_REPAIR_RETRY_INTERVAL_SECONDS` bounds how often a studio that stayed unrepaired re-consults Stripe. Webhook projection and the Admin-only status refresh bypass it, so reconciliation is not delayed where it is explicitly requested.
2. **Honest denial for locally lapsed studios.** A provider fault previously produced `503 BILLING_STATUS_UNAVAILABLE` even when the local row already showed the studio as not entitled. That told a lapsed studio Koaryu was broken. Local state is now consulted on a fault, but only ever to deny: a not-entitled row returns `402 SUBSCRIPTION_REQUIRED`, and an entitled-but-unverifiable row still fails closed with `503`.
3. **Normalized the `comped` guard default.** `_repair_missing_subscription` defaulted to `True` while `_should_repair_subscription_state` and the access decision defaulted to `False`. The column is `NOT NULL` and the row is selected with `*`, so this was latent rather than live, but the two guards disagreed about the same field.

No studio that is denied access before this change is granted access after it.

## Deliberately not done

- **Making local state authoritative and removing Stripe from the path entirely.** This was the original brief's suggestion. It reverses the tested control above and trades a bounded outage for unbounded unpaid access. Rejected by the owner in favour of continuing to fail closed.
- **Threadpool or async conversion.** The eight `async def` dependencies in `backend/app/core/deps.py` still call this resolver synchronously, so the remaining Supabase round-trip runs on the event loop. That belongs to the async request I/O work and is untouched here.
- **A scheduled reconciler.** Would need a cron route, a backend endpoint, and a new shared secret. Webhook projection plus the Admin refresh cover the need today.

## What the suspected bug is

The relevant flow appears to span:

- `backend/app/core/deps.py`
- `backend/app/services/studio_scope.py`
- `backend/app/services/platform_billing_service.py`

A tenant-scoped request resolves membership, requires platform access, loads the local subscription row, and attempts repairs for missing subscription identifiers, stale status, or missing period fields. Repair may call Stripe synchronously and write the repaired projection back to Supabase.

Terminal and incomplete states remain eligible for repair on every subsequent request. This was confirmed by exercising each row shape against a counting Stripe stub, not inferred: five consecutive access checks for a `canceled` studio produced five provider calls before the fix and one after it.

## Why this matters

Authorization should generally be fast, deterministic, and available from local authoritative state. Provider reconciliation has different latency, retry, failure, and observability requirements. Combining them creates several risks:

- unrelated operational requests can fail because Stripe is slow or unavailable
- a read-like request can perform repair writes
- repeated requests may repeat expensive provider lookups
- authorization behavior becomes difficult to test without simulating Stripe
- a payment-provider degradation can look like a general product outage

The system should still fail safely when subscription state cannot be trusted. The question is where and when remote reconciliation belongs, not whether payment access rules should be weakened.

## Impact

No production incident was attributed to this. The impact was a dependency coupling in the request path plus latency and availability amplification for lapsed studios, and a misleading error for those studios during any provider fault.

## Measured behaviour

Each row shape was exercised against a counting Stripe stub with `ENVIRONMENT=production`. Environment matters: `_can_degrade_access_repair` and `_is_noncritical_access_repair_error` both require `development`, so a reproduction run with development settings degrades gracefully and demonstrates nothing about production.

| Local row | Stripe calls | Before | After |
| --- | --- | --- | --- |
| `active` + valid periods | 0 | allowed | allowed |
| `past_due` + valid periods | 0 | denied `402` | denied `402` |
| `comped` / `trialing` (future end) | 0 | allowed | allowed |
| `active`, missing periods | 1 | `503` | `503` (fail-closed, unchanged) |
| `canceled` | 1, throttled | `503` | denied `402` |
| `incomplete` | 1, throttled | `503` | denied `402` |

## Scope guard

This change does not enable live billing, redesign pricing, rewrite the Stripe integration, weaken tenant authorization, or add a migration. It is limited to the placement and semantics of subscription repair relative to routine access checks.

## Verification

- `backend`: full suite, 587 passed.
- `npm run check:api-types`, `npm run check:env-examples`, `git diff --check`: clean.
- Regression anchor: with the retry window disabled to simulate pre-fix behaviour, the throttle tests fail `5 != 1`, confirming they detect a reintroduction rather than merely passing.
- No migration, so no Supabase gate applies.
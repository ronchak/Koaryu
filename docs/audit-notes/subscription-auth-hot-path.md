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

1. **Outcome-based retry throttle on the authorization path.** The two failure shapes are not the same risk, so they are throttled differently:
   - the repair call **failed** → `ACCESS_REPAIR_FAILURE_BACKOFF_SECONDS` (60s). This is the case that stalls the worker, and backing off costs no entitlement latency, because Stripe cannot confirm a payment while it is unreachable.
   - the repair call **succeeded** and the studio is still not entitled → `ACCESS_REPAIR_RECHECK_INTERVAL_SECONDS` (5s). Stripe is healthy, so a recheck is one fast call rather than a timeout, and it is the only thing that notices a payment whose webhook was lost.

   Webhook projection and the Admin-only status refresh bypass both windows.
2. **Honest denial for locally lapsed studios.** A provider fault previously produced `503 BILLING_STATUS_UNAVAILABLE` even when the local row already showed the studio as not entitled. That told a lapsed studio Koaryu was broken. Local state is now consulted on a fault, but only ever to deny: a not-entitled row returns `402 SUBSCRIPTION_REQUIRED`, and an entitled-but-unverifiable row still fails closed with `503`.
3. **Normalized the `comped` guard default.** `_repair_missing_subscription` defaulted to `True` while `_should_repair_subscription_state` and the access decision defaulted to `False`. The column is `NOT NULL` and the row is selected with `*`, so this was latent rather than live, but the two guards disagreed about the same field.

No studio that is denied access before this change is granted access after it.

## Why the throttle is outcome-based

The first version of this throttle used a single fixed window for every outcome. That was wrong in both directions, and the two mistakes cancelled out into something that looked reasonable.

**It did not throttle the outage at all.** The repair raises on provider failure, and the window was only recorded after the repairs returned, so the exception skipped the bookkeeping entirely. Measured with `ENVIRONMENT=production` and Stripe timing out: five consecutive requests produced **five** provider timeouts and **zero** throttle entries. The scenario the throttle was written to contain was the one scenario it never touched.

**It delayed the case that was already cheap.** The only calls it actually suppressed were successful ones — fast calls against a healthy provider — and suppressing those is what locked out a studio that had just paid.

Splitting by outcome fixes both, because the two cases have opposite economics:

| Repair outcome | Cost of retrying | Can a retry let a paid studio in? | Window |
| --- | --- | --- | --- |
| Failed, Stripe unreachable | A full provider timeout on the single worker | No — Stripe cannot confirm a payment while unreachable | 60s |
| Failed, Stripe reachable but erroring | One fast error response | Yes — checkout and webhooks are separate surfaces from the retrieve | 5s |
| Succeeded, still not entitled | One fast API call | Yes — this is the only thing that notices a lost webhook | 5s |

The first two rows were one row until review. Keying every failure to 60s
justified it with "Stripe cannot confirm a payment while unreachable", which is
true only of connection failures and timeouts. A 5xx or a rate limit returns
fast, so it never ties up the worker — the sole thing the long backoff buys —
while still costing a paid studio a minute. A fault in *our* code is not a
provider failure at all: it opens no window, and it is no longer answered from
local state, because a projector or persistence bug is no evidence about a
studio's entitlement and returning `402 SUBSCRIPTION_REQUIRED` presented our
outage as the studio's billing problem.

Measured after the change: five requests during an outage now make **one**
provider call. A studio that pays while its webhook is lost waits **at most 5
seconds** after a successful repair or a fast provider error, and at most 60
seconds while Stripe is genuinely unreachable — during which no payment can be
confirmed anyway.

The lost-webhook delay is the residual cost, and it is bounded rather than eliminated: the normal path updates the row within seconds via webhook projection and is not throttled, and an Admin can force reconciliation from the billing page. `test_a_paid_studio_gets_in_within_the_recheck_window` pins delay-then-recover, `test_provider_outage_is_backed_off_after_the_first_timeout` pins the outage behaviour, and `test_recheck_window_stays_imperceptible` fails if anyone widens the 5s window.

Two review gaps produced this, both now closed. The change was originally checked only for *granting* access that had been denied, never for *denying* access that had been granted. And the throttle's own tests stubbed a Stripe that succeeded, so no test exercised the failure path the feature existed for.

## Test isolation

The throttle is process-local module state, so `backend/tests/conftest.py` clears it around every test. Without that, a test leaving a window open silently suppresses the repair in whichever test runs next — which happened, and surfaced as an unrelated pre-existing test failing for reasons that had nothing to do with what it asserts.

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
| `active`, missing periods | 1, then 5s recheck | `503` | `503` (fail-closed, unchanged) |
| `canceled` | 1, then 5s recheck | `503` | denied `402` |
| `incomplete` | 1, then 5s recheck | `503` | denied `402` |

Every row above is a **first** request. Deciding each shape once is what let an
access widening through review: with the provider unreachable, the first request
for `active` + missing periods failed closed exactly as the table says, and the
*second* request inside the recorded window was allowed. The repair guards
inspect Stripe identifiers and period integrity; the access evaluator inspects
only status, comped and `trial_end`. Those sets overlap, so an unverified
`active` row replayed from the window was admitted on its status alone.

The matrix is now committed as a test with the second-request dimension it was
missing (`test_access_repair_outcome_neutrality.py`), and suppression replays
the outcome recorded when the window opened rather than the bare row. With the
provider unreachable, the first request pays one timeout and every request
inside the window reproduces that same fail-closed answer without calling
Stripe.

A sustained outage therefore costs one stalled request per affected studio per
window — the first one after each expiry. That is the intended residual cost and
the real number.

## Note for the async request I/O work

The throttle is read and written without a lock. The precise invariant is that
no `await` separates the check from the record — not that the calls are
"synchronous". A plain `def` path operation or dependency puts this code in
FastAPI's threadpool today, with no other refactor required, so the hazard is
not gated on the async work landing. Whoever introduces such a boundary should
either make record-and-check atomic or single-flight, or accept and document a
bounded herd of one burst per window. This warning now also lives on the
declaration of `_access_repair_retry_after`, which is the file that work will
actually be editing.

## Scope guard

This change does not enable live billing, redesign pricing, rewrite the Stripe integration, weaken tenant authorization, or add a migration. It is limited to the placement and semantics of subscription repair relative to routine access checks.

## Verification

- `backend`: full suite, 605 passed, and order-independent.
- `npm run check:api-types`, `npm run check:env-examples`, `git diff --check`: clean.
- Access matrix: 22 row shapes × reachable/unreachable Stripe × two consecutive requests, now committed as `backend/tests/test_access_repair_outcome_neutrality.py` rather than run by hand. It was an uncommitted single-request script, which is why it certified a change that widened access on the second request.
- Regression anchors, both verified to fail without the fix rather than merely to pass with it. Suppressing the retry window makes the healthy-provider test fail `5 != 1`; before the outage path recorded a window at all, five requests during an outage made five provider calls and recorded zero entries.
- No migration, so no Supabase gate applies.
# Stripe live-billing reconciliation checkpoint v3

This document is the current contract for producing and recording Koaryu Payments live-billing reconciliation evidence. It does not authorize a studio, enable a live mutation, change Stripe configuration, or approve a financial canary.

## Why v3 exists

The schema-v2 implementation treated the one-time July 13, 2026 migration boundary as a permanent provider-history invariant. Stripe exposes Events API history for a bounded recent period, so the fixed start eventually became older than the provider could return. A healthy provider and a healthy local database could no longer prove exact equality from that date.

V2 also classified webhook endpoints through a response-side `connect` property. Stripe accepts a Connect flag when an endpoint is created but does not return that field on the Webhook Endpoint object. Tests fabricated it, which made the internal contract consistent and the provider contract impossible.

Schema v3 removes both assumptions without reducing the gate.

## Evidence contract

The default provider comparison window begins 29 days before collection and ends at collection time. Stripe retention is treated as 30 days, leaving a one-day safety margin. An explicitly requested start is accepted only when the complete requested window remains inside retention. The reporter never silently truncates an older request.

Every eligible report contains exact provider and local event equality for the bounded window, a global local ingest watermark, exact production candidate readiness, current account mappings and generations, fresh platform delivery, fresh per-account Connect delivery, and exact webhook topology.

The exact production endpoint contract is:

| Surface | URL | Required state |
| --- | --- | --- |
| Platform | `https://koaryu.onrender.com/api/v1/webhooks/stripe/platform` | enabled, live mode, exact six-event platform set, no wildcard |
| Connect | `https://koaryu.onrender.com/api/v1/webhooks/stripe/connect` | enabled, live mode, exact Connect event set, no wildcard, independently corroborated by fresh connected-account event context |

Endpoint classification uses the exact URL and fields Stripe actually returns. Missing, duplicate, disabled, wrong-mode, misrouted, unexpected enabled, wildcard, or event-drifted endpoints fail closed.

## Continuity

A recent-window match does not by itself prove durable ingestion continuity.

The first accepted schema-v3 checkpoint uses the explicit `bootstrap` mode. Bootstrap evidence starts at the reported provider-supported window start. It records `claims_history_before_window=false` and cannot assert inaccessible provider history.

Every later checkpoint uses `rolling` mode and must bind the latest accepted schema-v3 checkpoint. The prior checkpoint must still be unexpired. The windows must overlap by at least 24 hours. The global local ingest watermark must be greater than or equal to the prior watermark. A missing prior checkpoint, expired prior checkpoint, broken overlap, changed prior identity, or regressed watermark fails closed.

Checkpoint expiry remains at most 24 hours. Operators must maintain continuity before the prior checkpoint expires. An expired continuity chain is not silently re-bootstrapped.

## Event and account failure rules

An eligible report and its database writer require all of the following:

- zero provider-only and local-only events in the reviewed window
- zero failed or nonterminal in-scope local events
- zero wrong-mode provider or local events
- zero unresolved provider, mapping, or event accounts
- zero explicit event-generation mismatches
- valid positive mapping generations
- exactly one fresh matched platform delivery
- fresh matched delivery for every mapped Connect account and generation
- a global local ingest watermark equal to current database state

A generation is considered explicitly stale when an event carries `connect_account_generation` evidence and it differs from the current mapping. Older events without that metadata are not retroactively assigned a generation, but the checkpoint and per-account evidence remain bound to the current mapping generation.

After a checkpoint is recorded, any later wrong-mode, nonterminal, failed, unmapped, or explicitly stale-generation event denies the next live mutation. A healthy processed event may advance the global ingest sequence without invalidating an existing grant.

## Candidate and authorization binding

The v3 checkpoint remains bound to:

- Stripe live mode
- the exact deployed 40-character candidate SHA
- the pinned production readiness URL
- a report SHA-256 digest
- a maximum 24-hour checkpoint expiry
- the rolling event window and continuity predecessor
- the global local ingest watermark
- every mapped account and current generation
- exact platform and Connect endpoint contracts
- fresh per-surface delivery evidence

`LIVE_BILLING_ENABLED=true` remains only the environment-wide emergency interlock. It grants no studio and authorizes no operation. Existing enabled grants are disabled by the additive migration and must be deliberately re-granted after a v3 checkpoint exists.

Legacy v2 checkpoints remain readable for audit. The operator CLI accepts only schema-v3 reports, and current grant binding and mutation authorization accept only checkpoints with durable v3 continuity evidence.

## Read-only report commands

Offline fixtures never contact Stripe, Supabase, or a deployment and are permanently checkpoint-ineligible:

```bash
cd backend
venv/bin/python scripts/stripe_reconciliation_report.py \
  --snapshot <sanitized-snapshot.json> \
  --candidate-sha <40-character-candidate-sha>
```

Staging collection is read-only and diagnostic only:

```bash
cd backend
venv/bin/python scripts/stripe_reconciliation_report.py \
  --collect-read-only \
  --probe staging \
  --candidate-sha <40-character-staging-sha>
```

Production collection is also read-only, but it contacts production Stripe, production Supabase, and the pinned production readiness URL. It requires separate operator approval:

```bash
cd backend
venv/bin/python scripts/stripe_reconciliation_report.py \
  --collect-read-only \
  --probe production \
  --candidate-sha <40-character-production-sha> \
  > reconciliation-v3.json
```

An explicit start may be requested only when the full window remains within provider retention:

```bash
cd backend
venv/bin/python scripts/stripe_reconciliation_report.py \
  --collect-read-only \
  --probe production \
  --candidate-sha <40-character-production-sha> \
  --window-start <ISO-8601-timestamp>
```

The command fails instead of truncating an out-of-retention start.

## Recording sequence

Do not execute this sequence as part of repository implementation or CI.

First complete the exact-candidate staging rehearsal in Stripe test mode. Then obtain approval for a production read-only reconciliation. Preserve the exact report bytes and review every failure field. Only an eligible schema-v3 report may proceed to a checkpoint dry run:

```bash
cd backend
venv/bin/python scripts/live_billing_authorizations.py record-checkpoint \
  --report reconciliation-v3.json \
  --expires-at <ISO-8601-within-24-hours> \
  --reason "<bounded reconciliation reason>" \
  --actor <auth-user-id-or-email>
```

The dry run independently re-probes the exact production candidate and prints the schema-v3 RPC, continuity mode, prior checkpoint identity, report digest, and expiry. It writes nothing.

A separately approved operator may add `--expect-project <production-project-ref> --execute` and complete the interactive confirmation. The writer rechecks local counts, current watermark, mappings, generations, topology assertions, continuity, actor, expiry, and exact candidate under database locks before inserting anything.

After checkpoint recording, the remaining launch order is:

1. inspect the recorded checkpoint and drift output
2. grant only the approved studio and operation-bounded scope after the operation-level authorization workstream lands
3. verify the exact account and generation
4. run a separately approved, attended financial canary with a named payer and ceiling
5. revoke immediately on any ambiguity or drift

This workstream does not perform or authorize steps 2 through 5.

## Verification

Repository verification for this contract is:

```bash
cd backend
venv/bin/python -m pytest \
  tests/test_stripe_reconciliation_report.py \
  tests/test_live_billing_authorizations_cli.py \
  tests/test_studio_live_billing_authorizations.py \
  tests/test_stripe_mutation_policy.py

cd ..
npm run check:supabase-contracts-local
npm run check:api-types
npm run check:release-workflow
```

The release candidate workflow additionally runs the complete backend suite, frontend tests, lint and build, database migration and verification suite, dependency audits, performance gate, and static analysis.

## Non-goals

Schema v3 does not expose customer billing controls, alter the 0.5% fee, change enrollment semantics, merge refund and dispute work, broaden a studio grant, configure a Stripe endpoint, access production data during CI, move money, or approve a canary.

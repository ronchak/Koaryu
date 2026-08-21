# Stripe live billing rollout gate

This runbook separates repository readiness from provider and financial authority. Phase A adds fail-closed code, SQL, owner tooling, and evidence validators. It does **not** enable live billing, change a Stripe object, record a production checkpoint, apply a production migration, rotate a secret, or run a financial canary.

## Current production state — verified 2026-08-19

This snapshot is read-only evidence from the exact deployed backend
`0bb07b84e5c0a56180c4f291142c8e77e1b9d31a`, production Supabase, and Stripe live
mode. It records current truth; it does not authorize a mutation or financial canary.

| Surface | Current disposition |
| --- | --- |
| Koaryu Core | **Live, technically active, owner acceptance test still pending.** `CORE_SELF_CHECKOUT_ENABLED=true`; the live recurring price is active at `$27 USD` per month; the exact six-event platform endpoint is enabled; one active customer-portal configuration permits customer information updates, payment-method updates, cancellation, and invoice history. Subscription changes are disabled in the portal. |
| Koaryu Payments | **Closed and safe for demo outreach only when described as unavailable.** `LIVE_BILLING_ENABLED=true` is only the global interlock. There are no `studio_live_billing_authorizations` rows and no recorded reconciliation checkpoint, so live Connect onboarding, tuition collection, autopay, invoice mutation, and refunds remain fail-closed. |

Observed Koaryu Core evidence:

- Stripe has ten live subscription-mode Checkout Sessions: four complete and six
  expired.
- Stripe has four live Core subscriptions: one active, one trialing, and two canceled.
  Production Supabase has the three subscription IDs that still map to local studio
  rows. The remaining provider-only subscription is canceled and lacks a matching
  studio reference; classify it as historical cleanup, but it is not an entitled
  subscription or an outreach blocker.
- Production has processed live `checkout.session.completed`, subscription lifecycle,
  and `invoice.paid` platform events. This proves that provider objects and local
  projection paths have run. It is not a substitute for the owner's controlled
  signup, Checkout, portal, cancellation, and access-transition acceptance test.

Observed Koaryu Payments evidence:

- Stripe lists three connected accounts. Two are mapped to local studios and the
  remaining provider account is explicitly excluded. There are zero unresolved
  accounts, zero unresolved event accounts, and no local mapping absent from Stripe.
- The reviewed local live-event window contains zero failed and zero non-terminal
  events. The earlier statement that six accounts and seven failed events blocked
  checkpointing is obsolete and must not be repeated.
- One connected account is currently charges-, payouts-, details-, and requirements-
  ready. The other two are restricted or incomplete. No studio has an enabled live
  scope, so even the ready account cannot move money through Koaryu.
- Stripe currently reports one historical `invoice.created` event from 2026-08-08
  whose deliveries were not all successful. Review and disposition that event before
  any Koaryu Payments canary; it is not one of the six Koaryu Core platform events.

The current reconciliation report correctly remains `checkpoint_eligible=false`, but
two tooling assumptions now prevent the report from becoming green even after the old
account/event cleanup:

1. The report uses a fixed event start of 2026-07-13. Stripe only guarantees Event API
   access for 30 days, so four valid local records from 2026-07-17 can no longer appear
   in a provider query and are now reported as `local_only` by construction. The
   reviewed window must become a retention-bounded rolling window while preserving a
   durable historical disposition.
2. The report expects the listed Webhook Endpoint object to contain a response-side
   `connect` boolean. Stripe's current Webhook Endpoint object does not expose that
   field. The live account instead returns the enabled 23-event connected endpoint
   with an associated Connect application, and the local database contains processed
   connected-account events. Replace the classifier with a provider-supported,
   test-covered endpoint-scope proof before recording a checkpoint.

References: [Stripe Events are API-retrievable for 30 days](https://docs.stripe.com/api/events)
and [the current Webhook Endpoint response shape](https://docs.stripe.com/api/webhook_endpoints/object).

### Remaining Stripe gates

For Koaryu Core customer use:

1. Run one owner-controlled live acceptance with a fresh studio: signup, Checkout,
   30-day trial, webhook projection, access, portal, payment-method update, cancellation,
   and expected access transition. Use an intentional reversible account and record
   only sanitized IDs and outcomes.
2. Confirm the support and provider-alert path receives any failed Checkout or webhook
   notification.

For Koaryu Payments:

1. Repair and retest the reconciliation reporter assumptions above.
2. Run the complete provider lifecycle in isolated staging and Stripe test mode.
3. Produce a fresh, exact-SHA, all-clear production read-only reconciliation and record
   its checkpoint.
4. Grant only a named studio and scope, then run the separately approved bounded live
   financial canary below.

None of the Koaryu Payments gates block a manually onboarded, comped friendly pilot or
a Koaryu Core-only demo.

## Authorization model

`LIVE_BILLING_ENABLED` is the Koaryu Payments global emergency interlock and is
necessary but insufficient. Every live Koaryu Payments mutation also needs one
enabled, unexpired `studio_live_billing_authorizations` row for the exact studio and
scope. Koaryu Core Checkout, customer portal, and their exact-object compensations are
the separately authorized `CORE_SELF_CHECKOUT_ENABLED` path documented in
`billing-boundary.md`; they do not require a Payments checkpoint or studio scope.

The authorization table supports these scopes:

- `core_subscription`
- `connect_onboarding`
- `connect_payments`

Connect payment grants bind the exact Stripe account and current `connect_account_generation`. Reconnect/reset, revocation, expiry, readiness loss, missing explicit caller scope, a mismatched deployment SHA, an unresolved provider/event account, any relevant event not fully processed, or an absent/failing reconciliation checkpoint denies the mutation. The latest live checkpoint must match the exact `RENDER_GIT_COMMIT`, expire within 24 hours, contain zero unresolved accounts and failures, and include separately fresh matched platform delivery plus matched delivery for every mapped Connect account and generation. The database atomically locks and derives current grant, mapping, generation, readiness, checkpoint, per-account evidence, and current relevant event state; callers supply no eligibility boolean. A new pending, processing, failed, or unresolved-unmapped event denies the next live mutation until its current database disposition is resolved. An explicitly reviewed excluded account stays outside this relevant universe only while it remains unmapped.

Only the service-role CLI calls the atomic grant/revoke/audit RPC. There is no public grant endpoint. Stripe-hosted Account Links remain admin-only, single-use onboarding URLs. Returning from Stripe triggers a read of account state; it never proves KYC or payment readiness.

## Responsibility boundaries

| Work | Authority |
| --- | --- |
| Repository code, migration, contracts, focused tests | Phase A repository change |
| Apply migration and inspect/test staging | Owner 2 plus director-approved staging change window |
| Stripe test-mode objects and webhook delivery rehearsal | Separate test-provider approval |
| Business identity, KYC, bank details, requirements submission | Human studio owner in Stripe-hosted onboarding |
| Production webhook endpoint/config, `LIVE_BILLING_ENABLED`, checkpoint record, grant | Separate director-approved live configuration change |
| One-studio live charge/refund or other money movement | Separate financial-canary approval |
| Secret rotation after proof | Explicit human security gate; never inferred from a green rehearsal |

## Read-only reconciliation

<!-- payments-reconciliation-v3:start -->
### Schema-v3 rolling checkpoint contract

Schema v3 compares one explicit **29-day** provider window. The value is centralized as Stripe's 30-day Events API retention minus a one-day safety margin. A requested start older than that boundary fails explicitly. A shorter operator-supplied start is diagnostic only because checkpoint eligibility requires the complete default window.

A matching current window is necessary but not sufficient. A rolling checkpoint must name the previous accepted schema-v3 checkpoint, prove that it is still unexpired, overlap its accepted window by at least 24 hours, preserve a non-regressing global `live_billing_ingest_sequence` watermark, retain the exact candidate SHA and account generations, and show no failed, nonterminal, unmapped, provider-only, local-only, or wrong-mode event in the relevant surface. The first schema-v3 checkpoint uses a separate bootstrap rule. It requires no enabled live authorization and a clean durable local event history, and records `bootstrap_historical_provider_completeness_claimed=false`; it never claims that provider history outside retention was compared.

Webhook topology no longer reads a fabricated `connect` property. The report pins the exact platform and Connect URLs, `enabled` status, `livemode`, and exact enabled-event sets returned by Stripe. The Connect surface additionally requires fresh matched connected-account event context for every mapped account and current generation. Missing, duplicate, disabled, misrouted, wildcard, unexpected enabled, or event-contract-drifted endpoints fail closed.

Legacy schema-v2 checkpoints remain readable for audit. The v2 writer is no longer callable by `service_role`, and no new live authorization may bind to a checkpoint without its schema-v3 sidecar. Applying the additive migration disables any enabled legacy grant so it must be deliberately reauthorized against v3 evidence.

The production sequence after merge is:

1. Complete the exact-candidate staging rehearsal in Stripe test mode.
2. Collect a production report read-only, using the complete default window and exact deployed SHA.
3. Review the sanitized report and retain its exact bytes and SHA-256 digest.
4. Run `record-checkpoint` without `--execute` and review the schema-v3 RPC plan plus the independent production readiness re-probe.
5. Under a separately approved production change, rerun the same command with exact project confirmation and `--execute` to record the short-lived checkpoint.
6. Only after the remaining Payments workstreams land, create an operation-bounded studio grant under separate approval.
7. Run a separately approved attended canary with its own payer, amount, consent, and financial ceiling.

This PR executes none of those production steps.

```bash
cd backend
venv/bin/python scripts/stripe_reconciliation_report.py   --collect-read-only   --probe production   --candidate-sha <exact-40-character-production-sha>   > <private-schema-v3-report.json>

venv/bin/python scripts/live_billing_authorizations.py record-checkpoint   --report <private-schema-v3-report.json>   --expires-at <future-UTC-timestamp-within-24-hours>   --reason "Exact-candidate schema-v3 production reconciliation"   --actor <auth-user-id-or-email>
```
<!-- payments-reconciliation-v3:end -->

The current reporter inventories every Stripe Connect account visible to the configured
read-capable key, then separately lists events at platform scope and in each
connected-account context. It still reconciles from the fixed 2026-07-13 start using
exact `(event ID, account ID)` equality. As recorded in the dated snapshot above, that
implementation is now outside Stripe's 30-day Event API window and cannot produce an
eligible checkpoint until the window and endpoint-scope classifier are repaired.

The intended contract remains: reconcile the union of provider accounts,
provider-event account IDs, local-event account IDs, and local studio mappings against
explicit exclusions; treat a local mapping absent from the provider inventory as
unresolved; report only sanitized failures; require one exact enabled platform endpoint
and one exact enabled connected-account endpoint with the six- and 23-event sets in
`render-backend-deployment.md`; and reject wildcard subscriptions. Do not record a
checkpoint from the current false-negative report.

Offline fixture validation performs no network access:

```bash
cd backend
venv/bin/python scripts/stripe_reconciliation_report.py \
  --snapshot <sanitized-snapshot.json> \
  --candidate-sha <40-character-candidate-sha>
```

Offline output is diagnostic and permanently has `checkpoint_eligible=false`, regardless of its contents.

Staging collection is a separately labeled diagnostic probe and can never be checkpoint-eligible:

```bash
cd backend
venv/bin/python scripts/stripe_reconciliation_report.py \
  --collect-read-only \
  --probe staging \
  --candidate-sha <40-character-staging-sha>
```

Production collection is read-only, but contacting Stripe, production Supabase, and the pinned production readiness URL still needs director approval:

```bash
cd backend
venv/bin/python scripts/stripe_reconciliation_report.py \
  --collect-read-only \
  --probe production \
  --candidate-sha <40-character-candidate-sha>
```

The collection must receive the exact candidate SHA from `https://koaryu.onrender.com/health/ready`. `record-checkpoint` independently repeats that pinned production readiness probe immediately before it can call the database writer; staging or offline evidence cannot be recorded.

### Historical eight-event route reconciliation

Use this bounded read-only procedure when reviewing the seven historical accountless
invoice/payment deliveries and the deleted-studio subscription update. It is evidence
collection only: do not resend an event, replay a payload, edit an endpoint, change an
account mapping, or record a checkpoint as part of this procedure.

1. Record the expected 40-character backend SHA, then read
   `https://koaryu.onrender.com/health/ready`. Stop if `commit_sha` differs or readiness
   is not healthy.
2. Run the production `--collect-read-only` reconciliation command above with that
   exact SHA. Preserve the sanitized report bytes and its SHA-256 digest.
3. In Stripe live mode, inspect each of the eight event IDs. Record only the event ID,
   type, creation time, top-level account context (present or absent), destination
   endpoint, HTTP delivery result, and latest delivery time. Do not copy payloads,
   customer details, payment methods, or addresses.
4. Confirm the seven invoice/payment events are limited to `invoice.created`,
   `invoice.finalized`, `invoice.paid`, and `payment_intent.succeeded`, have no
   top-level connected-account context, and were delivered to the endpoint shown by
   Stripe. Confirm the subscription event is `customer.subscription.updated` and
   separately record its endpoint and delivery result.
5. Read the matching `stripe_events` rows by exact event ID. For every row, record only
   `stripe_event_id`, `type`, `stripe_account_id`, `livemode`, `processing_status`,
   sanitized `error`, `error_reference`, `created_at`, and `processed_at`. Confirm no
   row acquired a connected-account ID from object metadata.
6. For accountless invoice/payment rows, confirm there is no tenant invoice, payment,
   payer, or subscription projection attributable to the wrong Connect route. For the
   deleted-studio subscription event, confirm the deleted studio still has no studio,
   subscription, or payment-account row and that no other studio was updated.
7. Compare Stripe delivery evidence, the local rows, and the exact deployed SHA. Any
   missing event, unexpected account context, nonterminal local state, tenant write,
   endpoint mismatch, or uncorrelated delivery keeps tuition collection blocked and
   requires a separately approved remediation. A clean comparison proves only this
   bounded webhook history; it does not authorize live billing or money movement.

Treat the reported July 20 explanations as hypotheses. If provider events continued but local receipt stopped, investigate endpoint delivery, routing, and signing-secret verification. If both stopped, provider inactivity, mode mismatch, or incomplete collection remain possible. No replay or backfill is allowed from this report. First confirm the exact event-ID uniqueness/claim path and handler projection are idempotent; then obtain a separate replay approval with an event allowlist.

The historical six-account/seven-failure condition has been cleared as of the dated
snapshot above. Continue to fail closed on any newly unresolved account or failed
event. Never blanket-ignore unmapped accounts. A fresh read-only reconciliation remains
required because a historical cleanup result does not prove current delivery.

## Owner authorization commands

All writes are dry runs unless `--execute` is supplied. Execute also requires a real Auth actor, exact Supabase project confirmation, and an interactive TTY.

```bash
cd backend
venv/bin/python scripts/live_billing_authorizations.py status --slug <studio-slug>
venv/bin/python scripts/live_billing_authorizations.py drift

venv/bin/python scripts/live_billing_authorizations.py grant \
  --slug <studio-slug> \
  --scope connect_payments \
  --stripe-account-id acct_... \
  --expires-at 2026-08-01T12:00:00Z \
  --reason "Bounded one-studio canary" \
  --actor <auth-user-id-or-email>

venv/bin/python scripts/live_billing_authorizations.py revoke \
  --slug <studio-slug> \
  --scope connect_payments \
  --reason "Canary rollback" \
  --actor <auth-user-id-or-email>
```

`account-disposition` is event/account specific. `excluded` means a verified non-Koaryu or retired account; `unresolved` removes that exclusion. The RPC refuses to exclude a currently mapped account.

In live mode, the Connect webhook handler acknowledges events for an explicitly excluded,
unmapped account with `200` and records them as `ignored`. An unknown unmapped account
continues to fail closed with `503` until it is mapped or reviewed and excluded. A mapped
account always follows normal projection even if contradictory disposition data exists.

An all-clear reconciliation JSON may be recorded only through `record-checkpoint`. The CLI hashes the exact report bytes and independently re-probes the pinned production readiness URL. The database binds the exact candidate, bounded event window, local ingest watermark, platform proof, and every account/generation proof, and bounds checkpoint expiry to 24 hours. Runtime compares that candidate to its deployed `RENDER_GIT_COMMIT` and rechecks current database state atomically.

## Exact-candidate test-provider rehearsal

Before opening the browser, run the pinned staging preflight below. Stop on any failure and do not use production:

```bash
npm run verify:deployed-release -- \
  --environment staging \
  --expected-sha <40-character-candidate-sha> \
  --frontend-origin https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app \
  --backend-api https://koaryu-staging.onrender.com/api/v1 \
  --expected-stripe-mode test
```

`--expected-stripe-mode` is **staging-only**: the verifier requires the value be exactly
`test` *and* the environment be `staging`, and refuses otherwise. Omit the flag when
verifying production, and read `configured_stripe_mode` from `/health/ready` instead.
See [cutover gates](cutover-gates.md).

Follow the execution-order capture instructions in [the Stripe test-provider rehearsal worksheet](stripe-test-provider-rehearsal-capture.md). It records only sanitized evidence and remains test mode only.

Do not call the synthetic local Connect smoke provider proof. On a director-approved exact release candidate, first verify `/health/ready` returns the expected SHA and the backend is configured for Stripe test mode. Exercise hosted onboarding and the required test lifecycle through the candidate, capturing only IDs, status, explicit studio/account/scope, idempotency keys, webhook event IDs, and readback outcomes. Then validate the sanitized evidence:

```bash
python3 scripts/verify-stripe-provider-rehearsal.py \
  --evidence <sanitized-evidence.json> \
  --expected-candidate-sha <40-character-candidate-sha> \
  --expected-backend-origin <exact-pinned-staging-origin>
```

Evidence schema version 2 is fail-closed. It pins the exact backend origin and `/health/ready` SHA, one studio, one connected account and generation, and separate `platform` and `connect` webhook delivery records. Each delivery record must name the exact platform or Connect endpoint URL, correct Connect flag, an event type from that endpoint's documented contract, Stripe's delivered/2xx result, and a local `processed` readback of the same event ID. The two surfaces must use different event IDs. Platform proof explicitly has no connected-account context; Connect proof must match the rehearsal account and generation. A nonempty global event-ID list, provider-only delivery, local-only readback, or one surface standing in for the other is invalid. Every recorded mutation—including the initial hosted Account Link—must carry its deterministic idempotency key.

This rehearsal is test mode only. Live money movement remains excluded unless the director separately approves a named payer, amount, consent record, and financial ceiling.

For a mid-flight readiness or authorization flip, never issue a second mutation. Preserve the deterministic idempotency key, read the provider object and matching event ID, allow webhook reconciliation to converge local state, and stop for operator review if the outcome stays unknown. An uncertain initial Account Link call may retry only under its still-live bootstrap with the same stored idempotency key and exact context; it does not receive a new permit. A matching idempotency key does not by itself prove that Stripe returned a still-usable single-use link. An expired, consumed, changed, or otherwise unverifiable response becomes support-required. Branding upload has no automatic retry.

Before the first live Connect request, billing status calls a service-role-only read-only preflight. It can report that the exact studio/generation may begin or resume, but it neither accepts nor stores a token, creates or consumes a permit, nor overrides endpoint authorization. The onboarding endpoint remains authoritative and repeats the exact atomic checks immediately before each provider mutation, so a mapping, candidate, checkpoint, event, readiness, or generation race fails closed. The browser receives only the capability boolean; the stable recovery handle, canonical recovery inputs, payload digests, and idempotency keys never appear in client responses or logs.

The endpoint prepares one database bootstrap row before the first provider call. That row binds one studio and account generation, the exact deployed SHA/readiness checkpoint, canonical account-create and initial-link contexts, payload digests, and both deterministic idempotency keys. Its only evidence exception is the newly created account generation's initial hosted Account Link. Every pre-existing mapping and every later Account Link remains checkpoint-bound. If the account-create response, database bind, or initial Account-Link response is uncertain, a same-request-context retry reloads that same row, rechecks the authenticated studio, exact candidate/checkpoint/generation/current events and stored provider-account mapping, and reuses the original provider idempotency key. It never prepares a second permit or broad authorization. Changed URLs, business/entity context, account mapping, candidate, generation, response identity, or payload are support-required. Recovery expiry or irreconcilable state is also support-required for that generation; operators must reconcile the provider result before any separately reviewed rollover.

The initial Account-Link response uses a two-step delivery boundary. The admin response is `Cache-Control: no-store` and contains `pending_url`, not the ordinary `url` field, plus one high-entropy, short-lived, non-authorizing receipt. The database stores only the receipt and provider-response hashes. The browser must parse the response, acknowledge the exact receipt through the admin-only endpoint, receive acknowledgement success, and only then navigate. The acknowledgement derives studio and admin identity from the authenticated server request and cannot grant provider authority. A lost acknowledgement response may retry only the same receipt; a same-key provider-response retry rotates the pending receipt so a stale response cannot retire the bootstrap. Receipt expiry, mapping/candidate/event drift, or any ambiguous response becomes support-required. `initial_link_delivered_at` means only that the authenticated browser safely received the URL; it does not prove Stripe consumed it, onboarding completed, KYC passed, or the account is ready.

After delivery acknowledgement, that generation's bootstrap is permanently retired. A client crash after retirement never reopens it. A genuinely fresh later Account Link must use ordinary `connect_onboarding_link.create` authorization against a current per-account checkpoint and a distinct caller `Idempotency-Key`; an exact client retry derives the same ordinary Stripe key, while a new intentional request derives a new key. An old client looking for `url` fails closed because the Connect response exposes only `pending_url`.

Every in-scope platform or mapped Connect event in the bounded reconciliation universe must be `processed`. Pending, processing, failed, or ignored relevant events—including `account.application.deauthorized`—deny checkpointing and mutation authorization. A reviewed excluded account that is not locally mapped remains outside that universe; its intentionally ignored rows do not block an otherwise valid studio grant.

## One-studio canary: preregister before enabling

The director must approve the named studio, exact candidate SHA, connected account ID/generation, maximum grant expiry, operator/backup operator, observation window, and financial ceiling before any live configuration change.

Promote only when all are true:

- exact production health SHA matches the checkpoint and approved candidate;
- newest checkpoint is unexpired and all-clear, including current endpoint delivery proof;
- all provider accounts and event accounts are mapped or explicitly excluded;
- zero failed, pending, stale-processing, duplicate, or mode-mismatched canary events;
- the canary Connect account remains charges/payouts/details enabled with no requirements due;
- one and only one intended idempotency key/provider object/event chain exists;
- local invoice, payment, refund/dispute, payer balance, and authoritative remaining balance converge;
- operator and backup operator can revoke the scope and set the global flag false;
- secret rotation has a named human owner and approved window.

Abort immediately on any of these:

- deployment/checkpoint SHA mismatch, authorization expiry/revocation, reconnect generation change, readiness/KYC loss, or endpoint proof expiry;
- an unscoped mutation attempt, automatic retry, duplicate provider object, unexpected charge/fee/payout, or unknown financial outcome;
- any new failed/unmapped/mode-mismatched event, webhook silence, projection divergence, or inability to correlate by event ID;
- loss of operator/backup coverage or inability to execute rollback.

Rollback order is: stop new actions; revoke the studio scopes; set `LIVE_BILLING_ENABLED=false` through the separately approved configuration path; preserve event/object IDs; reconcile already-sent requests by idempotency/event readback without a second mutation; and escalate any financial state to the director. Database migration rollback is not the incident response and must not delete provenance.

Promotion beyond one studio and any financial canary are separate director decisions. Passing this runbook does not authorize either.

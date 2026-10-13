# Stripe live billing rollout gate

V58 replaces manual Payments pilot enrollment with automatic eligibility for all valid
studios. Deploying this policy still follows the named coordinator's exact release gates.
Repository implementation does not itself assert that the production release has happened.

`LIVE_BILLING_ENABLED` is the emergency stop. Turning it off blocks new live Connect
mutations. Grants and checkpoint renewal are no longer routine availability work; their
existing rows and diagnostic writers remain intact. Grant/revoke commands do not enable
or suspend GA Payments; use the global emergency stop to block live mutations.
Current failures must be investigated,
not cleared by manufacturing fresh reconciliation evidence. Before launch, verify a current
end-to-end webhook path and investigate known delivery gaps. Reports retain any unproven
historical gap honestly.

## Historical pilot production snapshot, 2026-08-19

This snapshot is read-only evidence from the exact deployed backend
`0bb07b84e5c0a56180c4f291142c8e77e1b9d31a`, production Supabase, and Stripe live
mode. It records historical truth; it does not authorize a mutation or financial canary.

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

The production snapshot above predates schema v3 and correctly remained
`checkpoint_eligible=false`. Its two tooling blockers were:

1. The report uses a fixed event start of 2026-07-13. Stripe only guarantees Event API
   access for 30 days, so four valid local records from 2026-07-17 can no longer appear
   in a provider query and are now reported as `local_only` by construction. The
   reviewed window needed a retention-bounded rolling window with durable continuity.
2. The report expects the listed Webhook Endpoint object to contain a response-side
   `connect` boolean. Stripe's current Webhook Endpoint object does not expose that
   field. The live account instead returns the enabled 23-event connected endpoint
   with an associated Connect application, and the local database contains processed
   connected-account events. Replace the classifier with a provider-supported,
   test-covered endpoint-scope proof.

The integrated 119/V26 repository candidate replaces both assumptions and adds the
refund/dispute accounting convergence required by the next Payments packet. It uses a
29-day provider window, explicit bootstrap and predecessor-overlap continuity, and URL
plus delivery evidence from fields Stripe returns. This is repository evidence only.
No hosted migration, production checkpoint, grant, or provider change follows from it. See
`docs/stripe-live-billing-reconciliation-v3.md` for the exact contract.

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

1. Merge and deploy the verified 119/V26 reconciliation and adjustment-convergence packet through the normal release gates.
2. Run the complete provider lifecycle in isolated staging and Stripe test mode.
3. Produce a fresh, exact-SHA, all-clear production read-only reconciliation and record
   its checkpoint.
4. Grant only a named studio and scope, then run the separately approved bounded live
   financial canary below.

None of the Koaryu Payments gates block a manually onboarded, comped friendly pilot or
a Koaryu Core-only demo.

## Authorization model

`LIVE_BILLING_ENABLED` is necessary but insufficient. The service-only atomic database
RPC validates the supported scope/operation and exact studio/account relationship, checks
current generation through the owning workflow, and requires current KYC/readiness for
payments. Python retains exact configured Stripe mode and deployed SHA presence checks.
Core self-checkout and unused legacy Core grant paths retain their existing separate policy.

The global event guard denies any retained failed live event, any in-scope live event that
is not processed, and any connected event account that is neither mapped nor explicitly
excluded. A mapped account takes precedence over exclusion. Fully processed known events
and quiet accounts do not need fresh daily evidence. No checkpoint expiry, overlap chain,
deployment binding, total mapping count or all-account freshness grants runtime permission.

New onboarding requests store a null checkpoint as explicit GA provenance and preserve
exact candidate, generation, request context, payload hashes and provider idempotency keys.
Recovery remains bounded to 24 hours, with two-minute response receipts and terminal delivery
or support-required barriers. An old non-null checkpoint request cannot silently resume under
GA and requires support. Account links and dashboard access precede KYC; payment operations
still require charges, payouts, submitted details and no outstanding requirements.

Historical grant/revoke/checkpoint RPCs remain service-only diagnostic tools. Their records
are neither renewed nor deleted by V58. Stripe-hosted Account Links remain admin-only,
single-use onboarding URLs; returning from Stripe never proves KYC or payment readiness.

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

The schema-v3 reporter inventories every Stripe Connect account visible to the
configured read-capable key, then separately lists events at platform scope and in
each connected-account context. It compares exact `(event ID, account ID)` equality
inside a complete 29-day provider window. The first v3 report must pass an explicit
local-history bootstrap. Later reports must bind the latest unexpired v3 checkpoint,
overlap its window by at least 24 hours, and preserve the local ingest watermark.

The contract reconciles the union of provider accounts,
provider-event account IDs, local-event account IDs, and local studio mappings against
explicit exclusions; treat a local mapping absent from the provider inventory as
unresolved; report only sanitized failures; require one exact enabled platform endpoint
and one exact enabled connected-account endpoint with the six- and 23-event sets in
`render-backend-deployment.md`; and reject wildcard subscriptions. Endpoint scope is
proved by exact URLs and separate delivery evidence, not a fabricated response-side
`connect` field.

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

## Historical pilot authorization and diagnostic commands

All writes are dry runs unless `--execute` is supplied. Execute also requires a real Auth actor, exact Supabase project confirmation, and an interactive TTY.

```bash
cd backend
venv/bin/python scripts/live_billing_authorizations.py status --slug <studio-slug>
venv/bin/python scripts/live_billing_authorizations.py drift

venv/bin/python scripts/live_billing_authorizations.py grant \
  --slug <studio-slug> \
  --scope connect_payments \
  --stripe-account-id acct_... \
  --operation <BYTE-SORTED-APPROVED-OPERATION-1> \
  --operation <BYTE-SORTED-APPROVED-OPERATION-2> \
  --expires-at <FUTURE-ISO-8601-WITHIN-30-DAYS> \
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

An all-clear reconciliation JSON may be recorded only through `record-checkpoint`. The CLI hashes the exact report bytes and independently re-probes the pinned production readiness URL. The database binds the exact candidate, bounded event window, local ingest watermark, platform proof, and every account/generation proof, and bounds checkpoint expiry to 24 hours. This is diagnostic provenance. V58 runtime authorization uses the current GA checks above, while the deployed SHA must still be present and bootstrap requests remain candidate-bound.

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

Provider rehearsal evidence uses schema version 4. It pins the exact backend origin and `/health/ready` SHA, one studio, one connected account and generation, and separate `platform` and `connect` webhook delivery records. Each delivery record must name the exact platform or Connect endpoint URL, correct Connect context, an event type from that endpoint's documented contract, Stripe's delivered/2xx result, and a local `processed` readback of the same event ID. The two surfaces must use different event IDs. Platform proof explicitly has no connected-account context; Connect proof must match the rehearsal account and generation. A nonempty global event-ID list, provider-only delivery, local-only readback, or one surface standing in for the other is invalid. Every recorded mutation, including the initial hosted Account Link, must carry its deterministic idempotency key. The schema-v4 template in the capture worksheet remains the source; do not copy it here. Reconciliation checkpoint reports remain schema v3 and use a different private file.

This rehearsal is test mode only. Live money movement remains excluded unless the director separately approves a named payer, amount, consent record, and financial ceiling.

For a mid-flight readiness or authorization flip, never issue a second mutation. Preserve the deterministic idempotency key, read the provider object and matching event ID, allow webhook reconciliation to converge local state, and stop for operator review if the outcome stays unknown. An uncertain initial Account Link call may retry only under its still-live bootstrap with the same stored idempotency key and exact context; it does not receive a new permit. A matching idempotency key does not by itself prove that Stripe returned a still-usable single-use link. An expired, consumed, changed, or otherwise unverifiable response becomes support-required. Branding upload has no automatic retry.

Before the first live Connect request, billing status calls a service-role-only read-only preflight. It can report that the exact studio/generation may begin or resume, but it neither accepts nor stores a token, creates or consumes a permit, nor overrides endpoint authorization. The onboarding endpoint remains authoritative and repeats the exact atomic checks immediately before each provider mutation, so a mapping, candidate, event, readiness, or generation race fails closed. The browser receives only the capability boolean; the stable recovery handle, canonical recovery inputs, payload digests, and idempotency keys never appear in client responses or logs.

The endpoint prepares one database bootstrap row before the first provider call. That row binds one studio and account generation, the exact deployed SHA and explicit null GA checkpoint provenance, canonical account-create and initial-link contexts, payload digests, and both deterministic idempotency keys. The first hosted Account Link uses its dedicated bootstrap authority before KYC. Later Account Links use ordinary GA operation authority. If the account-create response, database bind, or initial Account-Link response is uncertain, a same-request-context retry reloads that same row, rechecks the authenticated studio, exact candidate/generation/current events and stored provider-account mapping, and reuses the original provider idempotency key. It never prepares a second permit or broad authorization. Changed URLs, business/entity context, account mapping, candidate, generation, response identity, or payload are support-required. Recovery expiry or irreconcilable state is also support-required for that generation; operators must reconcile the provider result before any separately reviewed rollover.

The initial Account-Link response uses a two-step delivery boundary. The admin response is `Cache-Control: no-store` and contains `pending_url`, not the ordinary `url` field, plus one high-entropy, short-lived, non-authorizing receipt. The database stores only the receipt and provider-response hashes. The browser must parse the response, acknowledge the exact receipt through the admin-only endpoint, receive acknowledgement success, and only then navigate. The acknowledgement derives studio and admin identity from the authenticated server request and cannot grant provider authority. A lost acknowledgement response may retry only the same receipt; a same-key provider-response retry rotates the pending receipt so a stale response cannot retire the bootstrap. Receipt expiry, mapping/candidate/event drift, or any ambiguous response becomes support-required. `initial_link_delivered_at` means only that the authenticated browser safely received the URL; it does not prove Stripe consumed it, onboarding completed, KYC passed, or the account is ready.

After delivery acknowledgement, that generation's bootstrap is permanently retired. A client crash after retirement never reopens it. A genuinely fresh later Account Link must use ordinary `connect_onboarding_link.create` authorization against the current exact account/generation and event state and a distinct caller `Idempotency-Key`; an exact client retry derives the same ordinary Stripe key, while a new intentional request derives a new key. An old client looking for `url` fails closed because the Connect response exposes only `pending_url`.

Every in-scope platform or mapped Connect event in the bounded reconciliation universe must be `processed`. Pending, processing, failed, or ignored relevant events—including `account.application.deauthorized`—deny checkpointing and mutation authorization. A reviewed excluded account that is not locally mapped remains outside that universe; its intentionally ignored rows do not block an otherwise eligible studio.

## Attended financial canary: preregister the test

An agent-run financial canary needs separate owner approval for the named studio, exact candidate SHA, connected account ID/generation, named payer, consent, amount, operator coverage and observation window. This limits the attended test; GA availability does not require enrollment or promotion one studio at a time.

Run the approved canary only when all are true:

- exact production health SHA matches the approved candidate;
- current endpoint delivery evidence and reconciliation findings have been reviewed;
- all provider accounts and event accounts are mapped or explicitly excluded;
- zero failed, pending, stale-processing, duplicate, or mode-mismatched canary events;
- the canary Connect account remains charges/payouts/details enabled with no requirements due;
- one and only one intended idempotency key/provider object/event chain exists;
- local invoice, payment, refund/dispute, payer balance, and authoritative remaining balance converge;
- operator and backup operator can set the global flag false;
- secret rotation has a named human owner and approved window.

Abort immediately on any of these:

- deployment SHA mismatch, reconnect generation change, readiness/KYC loss, or failed endpoint delivery;
- an unscoped mutation attempt, automatic retry, duplicate provider object, unexpected charge/fee/payout, or unknown financial outcome;
- any new failed/unmapped/mode-mismatched event, webhook silence, projection divergence, or inability to correlate by event ID;
- loss of operator/backup coverage or inability to execute rollback.

Rollback order is: stop new actions; set `LIVE_BILLING_ENABLED=false` through the separately approved configuration path; preserve event/object IDs; reconcile already-sent requests by idempotency/event readback without a second mutation; and escalate any financial state to the director. Database migration rollback is not the incident response and must not delete provenance.

The GA product decision covers all eligible studios. Passing these checks does not authorize an agent-run financial canary or change production release authority.

Unused Connect accounts can be reset by a current studio admin. The reset RPC checks
billing history and unresolved provider/webhook work under database locks, then clears
the mapping, advances its generation, excludes the retired identity, and writes the
audit in one transaction. Later webhooks from that retired account use the existing
excluded-account ignore path. A concurrent write returns HTTP 409 with `Retry-After: 1`;
retry starts from a fresh account read. History or unresolved work requires completion
or support before reset. Unknown accounts and failed events still block live permits.

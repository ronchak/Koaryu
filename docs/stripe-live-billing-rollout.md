# Stripe live billing rollout gate

This runbook separates repository readiness from provider and financial authority. Phase A adds fail-closed code, SQL, owner tooling, and evidence validators. It does **not** enable live billing, change a Stripe object, record a production checkpoint, apply a production migration, rotate a secret, or run a financial canary.

## Authorization model

`LIVE_BILLING_ENABLED` is the global emergency interlock and is necessary but insufficient. Every live Stripe mutation also needs one enabled, unexpired `studio_live_billing_authorizations` row for the exact studio and scope:

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

The reporter inventories every Stripe Connect account visible to the configured read-capable key, then separately lists events at platform scope and in each connected-account context. It reconciles a bounded, reviewed event universe from 2026-07-13 through collection time using exact `(event ID, account ID)` equality. It also reconciles the union of provider accounts, provider-event account IDs, local-event account IDs, and local studio mappings against explicit exclusions. A local mapping absent from the provider account inventory is unresolved rather than self-validating. It reports current endpoint configuration and sanitized failed-event codes/references, never event payloads, and has no mutation call. A live checkpoint requires exactly one enabled endpoint matching each exact production URL/Connect flag, no other enabled endpoint, and respectively the exact six-event and 23-event sets in `render-backend-deployment.md`. Stripe's wildcard event subscription is deliberately rejected because it expands ingestion beyond the reviewed projector contract.

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

Treat the reported July 20 explanations as hypotheses. If provider events continued but local receipt stopped, investigate endpoint delivery, routing, and signing-secret verification. If both stopped, provider inactivity, mode mismatch, or incomplete collection remain possible. No replay or backfill is allowed from this report. First confirm the exact event-ID uniqueness/claim path and handler projection are idempotent; then obtain a separate replay approval with an event allowlist.

The six currently unmapped live-event accounts and all seven failed live events make `checkpoint_eligible=false`. Do not grant any scope or bind a live authorization until each account is mapped to its rightful studio or explicitly excluded with provenance, and each failed event has an event-specific disposition plus idempotent reconciliation proof. Never blanket-ignore unmapped accounts.

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

An all-clear reconciliation JSON may be recorded only through `record-checkpoint`. The CLI hashes the exact report bytes and independently re-probes the pinned production readiness URL. The database binds the exact candidate, bounded event window, local ingest watermark, platform proof, and every account/generation proof, and bounds checkpoint expiry to 24 hours. Runtime compares that candidate to its deployed `RENDER_GIT_COMMIT` and rechecks current database state atomically.

## Exact-candidate test-provider rehearsal

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

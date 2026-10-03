# Koaryu Payments schema-v3 operator tooling

This is the operator reference for the Payments 1/6 reconciliation and live-authorization checkpoint contract. Commands are dry-run or read-only unless `--execute` is explicitly supplied. Repository work, CI, and review must never supply it.

## Safety boundary

The reconciliation reporter reads Stripe, Supabase, and a pinned readiness endpoint. It does not create, update, replay, refund, cancel, charge, or configure a provider object.

The live-authorization tool defaults to dry-run. Its write commands require a real Auth actor, an exact project confirmation, an interactive terminal, and `--execute`. A green report is evidence, not authority to grant a studio or move money.

## Reconciliation reporter

Default production-shaped collection uses a 29-day window inside the provider's 30-day event retention:

```bash
cd backend
venv/bin/python scripts/stripe_reconciliation_report.py \
  --collect-read-only \
  --probe <staging|production> \
  --candidate-sha <40-character-sha>
```

`--window-start <ISO-8601>` requests an exact older or narrower start. The command refuses starts outside retention. It never substitutes a newer start.

Offline snapshots are fixture-only and permanently ineligible:

```bash
cd backend
venv/bin/python scripts/stripe_reconciliation_report.py \
  --snapshot <sanitized-snapshot.json> \
  --candidate-sha <40-character-sha>
```

The schema-v3 output includes the exact event window, continuity mode, predecessor identity, overlap, global ingest watermark, provider and local gaps, sanitized failures, account-generation evidence, platform delivery, Connect delivery, and exact endpoint topology.

## Authorization inspection

```bash
cd backend
venv/bin/python scripts/live_billing_authorizations.py status --slug <studio-slug>
venv/bin/python scripts/live_billing_authorizations.py drift
```

`status` returns the studio's payment-account mapping, current grants, and the latest schema-v3 continuity state. `drift` reports expired grants, missing checkpoint or watermark bindings, changed accounts, stale generations, and payment-readiness loss.

## Checkpoint recording

Dry run:

```bash
cd backend
venv/bin/python scripts/live_billing_authorizations.py record-checkpoint \
  --report <schema-v3-report.json> \
  --expires-at <ISO-8601-within-24-hours> \
  --reason "<bounded reason>" \
  --actor <auth-user-id-or-email>
```

The tool accepts only an eligible schema-v3 production-live provider-read report with valid bootstrap or rolling continuity. It hashes the exact report bytes and independently re-probes the pinned production SHA before showing the plan.

A separately authorized write adds both `--expect-project` and `--execute`. The database writer then rechecks the full contract under locks. Do not execute from CI, an agent session, or this workstream.

## Studio grants

Dry-run grant and revoke commands remain:

```bash
cd backend
venv/bin/python scripts/live_billing_authorizations.py grant \
  --slug <studio-slug> \
  --scope connect_payments \
  --operation connected_invoice.create \
  --operation connected_invoice.pay \
  --stripe-account-id acct_... \
  --expires-at <ISO-8601> \
  --reason "<bounded operation reason>" \
  --actor <auth-user-id-or-email>

venv/bin/python scripts/live_billing_authorizations.py revoke \
  --slug <studio-slug> \
  --scope connect_payments \
  --reason "<rollback reason>" \
  --actor <auth-user-id-or-email>
```

A grant can bind only the latest unexpired schema-v3 checkpoint. It cannot bind a v2 row. Existing grants are disabled when the v3 migration is applied. `LIVE_BILLING_ENABLED` does not replace this binding.

V30 grants use `set_studio_live_billing_authorization_operations_v1`. Every grant must
name the exact operation array in byte-sorted order. The tool rejects empty, wildcard,
prefix, duplicate, out-of-order, cross-scope, and unknown values before its dry-run
plan. Revocation always writes an empty operation array. The database repeats the same
checks and the unchanged atomic authorization RPC requires the requested operation to
be present immediately before a live provider call.

## Account disposition

```bash
cd backend
venv/bin/python scripts/live_billing_authorizations.py account-disposition \
  --stripe-account-id acct_... \
  --state <excluded|unresolved> \
  --reason "<reviewed disposition>" \
  --actor <auth-user-id-or-email>
```

`excluded` is valid only for a verified non-Koaryu or retired unmapped account. The RPC refuses to exclude a current mapping. An unknown account remains unresolved and blocks checkpointing and authorization.

## Required sequence after merge

The repository change ends after migration and test verification. The operational sequence remains staging test-mode rehearsal, production read-only reconciliation, explicit checkpoint recording, operation-bounded studio grant after its dependency lands, and a separately approved canary.

No step implies the next. A staging pass does not authorize production collection. A production report does not authorize checkpoint recording. A checkpoint does not authorize a grant. A grant does not authorize a canary.

See `docs/stripe-live-billing-reconciliation-v3.md` for the full evidence contract and `docs/stripe-live-billing-rollout.md` for the broader launch gate.

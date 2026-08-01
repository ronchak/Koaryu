# Studio-Comp Migration Rollout

Status: **Phase A tooling only; provider mutation locked**

This packet reconciles the production 84-migration baseline with the immutable
99-migration release candidate. It is specialized to this rollout, not a
generic migration or history-repair framework.

Agents may inspect staging or production read-only when authorized. Agents must
never run migration or contract SQL against production. Only the named human
operator may execute the production `apply` mode after the exact staging and
restore gates below are approved.

## Identity and evidence boundary

Supabase CLI `2.95.4` tracks remote migrations in
`supabase_migrations.schema_migrations` with `version`, `name`, and a parsed
`statements` array. It stores no intrinsic content hash, and the
[CLI migration comparison uses timestamps](https://supabase.com/docs/reference/cli/supabase-projects-create#supabase-migration-list).
Therefore:

- repository SHA-256 values prove the intended files in the immutable Git
  candidate;
- remote version/name history does **not** prove that those exact bytes ran;
- the release authority is the operator-side raw-catalog verifier plus its
  repository-pinned SHA-256 manifests; the database V6 manifest exposed through
  the stable V2-named RPC is an operational drift/readiness signal, not proof
  against a malicious database administrator;
- the mutable parsed `statements` array is not treated as file identity.

Residual risk remains that history was repaired or altered independently and
that the focused object fingerprint does not describe unrelated database state.
Any partial history/object shape, unfamiliar history-table schema, or staging /
production fingerprint mismatch halts the rollout.

The fixed production pre-state is:

```text
84:57ae4269ef4d75c249d59ef297661a3a
```

The only certifiable post-state is migration count 99, head
`20260801123112`, with this exact pending version sequence:

```text
20260727100000
20260727110000
20260801050957
20260801060000
20260801070000
20260801080000
20260801090000
20260801091000
20260801092000
20260801093000
20260801094000
20260801105313
20260801112153
20260801115044
20260801123112
```

The checker derives filenames and source hashes from the final candidate, then
requires this exact sequence and reports `integration_complete=true` only at
99 migrations with these fifteen versions. The 070000/091000/093000/105313
billing and 080000 alert
tables, RLS, exact ACLs and stored function bodies, complete trigger/index
definitions, sequences, columns, and all scoped CHECK/UNIQUE/FK definitions are
included in the semantic manifest. V6 compositionally preserves the complete
V5/V4/V3 surface. That carried surface includes the delivery-state columns,
CHECK constraints, partial unique index, and four changed/new bootstrap RPCs
from migration 96. Table, sequence, and
column ACL evidence are separate. The column ACL manifest includes every
ordinary non-dropped column across the exact fourteen-table scope, including
columns with an empty `pg_attribute.attacl`, and serializes every explicit grant
with grantor, grantee, privilege, and grantability. Table and sequence ACL evidence contains the
complete sorted grantor, grantee (including `PUBLIC` and custom roles),
privilege, and grantability state, so extra grants and `WITH GRANT OPTION` drift
change the pinned proof. This ACL scope explicitly includes the release-critical
`studio_payment_accounts` mapping and `stripe_events` ingestion tables. The
external verifier also attests the stable V2-named public RPC, the V6 helper,
the repaired alert-delivery claim function, and their bodies/configuration/ACLs
without asking V6 to attest its own body. Migration 99 changes only the
ambiguous expired-lease conflict target to the named
`operational_alert_delivery_outcomes_attempt_id_key` UNIQUE constraint; the
primary key remains `operational_alert_delivery_outcomes_pkey` on `id`. Never
certify an earlier head; regenerate the packet from the exact immutable release commit so
all candidate migration hashes and counts remain current. Hosted PostgREST
exposed-schema configuration and actual schema ACL readback are separate
provider/operator evidence and are not certified by local PostgreSQL.

The candidate must descend from both merged studio-comp commits and retain these
exact source files:

- `20260727100000_atomic_studio_comp_management.sql` — SHA-256
  `2cd1e15dbe5a8224a0e4829bc92c6b01aae4699006d603d613d18cb4bc82c5c6`
- `20260727110000_order_billing_events_after_studio_comps.sql` — SHA-256
  `22faa79522ba2018780fb260401cd23830df553ee3faf0546b2af689eb51bfc0`

They must be the first two migrations after baseline migration 84. Every later
candidate migration becomes part of the exact pending set and dry-run assertion.

## Transaction and old-application classification

Both July files contain transaction-compatible PostgreSQL DDL only. The local
PostgreSQL 17 harness applies each file in its own single transaction.

- `20260727100000` replaces/creates two invoker functions, changes function
  privileges, and drops/recreates one `BEFORE UPDATE OF metadata` trigger. It
  performs no table rewrite or product-data update, but trigger replacement can
  take a table-level DDL lock.
- `20260727110000` creates/replaces one invoker function and its privileges. It
  performs no table or product-data update.

The two files are not one atomic unit. A remote failure may leave migration 85
applied while 86 is absent. The runner reports every apply failure as potentially
stateful and requires a new inspection; it never repairs history or drops
objects.

Against reported production application commit `6596cc5`, the database surface
is schema-compatible: no existing table, column, RPC, or privilege used by that
application is removed. The feature behavior is **not fully compatible** with
that old application:

- the old projector and webhook code can still write `comped=false` directly;
- it does not call `clear_studio_comp_for_billing_event`;
- migration 85 preserves `metadata.comp` provenance but cannot stop the old code
  from clearing the flag, while migration 86 is unused by that application.

Do not grant or rely on durable operator comps while `6596cc5` is serving. The
database pair may precede the application upgrade only as additive DDL with the
comp operator surface unused. The launch sequence must deploy an application at
`a615bdfc9755b6c3e611e9f8829fdaf387b4f981` or later before the comp workflow is
considered operational.

## Regenerate the exact candidate packet

Run locally without provider credentials or a target:

```bash
node scripts/studio-comp-migration-rollout.mjs \
  --mode packet \
  --candidate-sha <final-40-character-candidate-sha>
```

Record the exact output. It pins the CLI, fixed pre-history, immutable Git
ancestry, complete pending set, every candidate migration hash, and the source
manifest hash. Any missing migration, unexpected version, or migration after
123112 halts before credentials are used.

## Staging gate: inspect before rehearsal

The first provider action is read-only inspection. Do not skip directly to
`dry-run` or `apply`. The runner refuses credentialed work if `HTTP_PROXY`,
`HTTPS_PROXY`, `ALL_PROXY`, `FTP_PROXY`, their lowercase equivalents, or
`GIT_PROXY_COMMAND` is nonempty. It also rejects ambient TLS trust overrides:
`NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `SSL_CERT_FILE`,
`SSL_CERT_DIR`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `PGSSLROOTCERT`, and
`PGSSLMODE`. Refusal output names variables but never prints their values.
Coordinate final transport wording with the environment-safety owner; never
work around this guard by sourcing `backend/.env`.

```bash
node scripts/studio-comp-migration-rollout.mjs \
  --target staging \
  --candidate-sha <final-candidate-sha>
```

The command is unavailable until the packet reports
`integration_complete=true`. Acceptance then requires `state=pre`, the pinned staging ref
`nxgsektqsgrtyfhawxbc`, the exact 84-row history, no July functions/trigger, and
an `inspection_token`. If staging is behind, ahead, partially applied, or has
manual objects, stop. Rebuild or catch-up needs a separate packet.

Only after recording that inspection may the read-only rehearsal run:

```bash
node scripts/studio-comp-migration-rollout.mjs \
  --target staging \
  --candidate-sha <final-candidate-sha> \
  --mode dry-run \
  --inspection-token <token-from-staging-inspect>
```

The dry-run must report the exact fifteen pending versions above, with their final
candidate filenames and hashes. A missing, extra, reordered, or unparseable
name halts the rollout.

Staging application remains locked until the director approves Phase B. The
approved command will require the same inspection token, exact project ref, a
durable approval record, and `--approve-staging-apply`. After application:

1. require count 99, head 123112, the exact fifteen-version sequence, and the
   derived final history digest;
2. require every table/RLS, policy, grant, function-security/search-path,
   trigger, index, table-ACL, sequence-ACL, and column-ACL identity in the final semantic
   catalog manifest; category counts and sorted identities are deterministic,
   and definitions come from PostgreSQL's catalog representation rather than
   provider UI formatting. The policy inventory is
   exact: extra policies halt, constant-false deny predicates and the guarded
   membership predicate are classified canonically, and arbitrary non-null
   expressions do not pass;
3. invoke the service-role-only V2-named readiness RPC during every apparent-post
   linked inspection and require `ready=true`, exact
   count/head/pending versions, an empty failure list, and manifest version
   `release-db-attestation-v6`; a missing, malformed, stale, or failing result
   halts before `state=post` or a fingerprint can be emitted. Linked scalar
   results are decoded as strict single-column CSV, including standard quoting
   for the comma-delimited pending-version tuple; extra rows, extra columns, or
   malformed quoting halt without reflecting returned data;
4. record the emitted provider fingerprint;
5. run linked lint and approved contracts only on staging;
6. test PostgREST service-role execution and browser-role denial, then capture
   authenticated provider readback proving `private` is absent from the exposed
   schemas and the actual hosted schema ACL state matches the approved gate;
   missing or unexpected exposure/ACL evidence halts even when local checks pass;
7. only in the separately approved provider-smoke phase, create and remove the
   disposable staging Auth actor and synthetic studio data.

No staging provider read, dry-run, migration, contract, or Auth mutation was
performed while authoring this Phase A packet. The latest staging migration-list
attempt returned `INVALID_ARGUMENT`; a prior direct SQL attempt reportedly timed
out. Do not loop retries.

## Human-only production gate

Production inspection and dry-run repeat the exact-target and exact-state checks.
Production apply additionally requires all of these fields:

- durable approval record;
- exact production project confirmation;
- staging provider fingerprint;
- confirmed PITR/restore window or durable restore-readiness record;
- named human restore decision authority;
- interactive human-only confirmation phrase bound to the exact candidate SHA,
  dynamic pending-migration count, source-manifest hash, and production ref.

Template only—agents must never execute it:

```bash
node scripts/studio-comp-migration-rollout.mjs \
  --target production \
  --candidate-sha <final-candidate-sha> \
  --mode apply \
  --inspection-token <token-from-production-inspect> \
  --confirm-project mimguepumzsgmcaycdsh \
  --approval-record <durable-approval-url-or-id> \
  --human-production-operator \
  --expected-provider-fingerprint <staging-provider-fingerprint> \
  --confirmed-restore-window <confirmed-window-or-record> \
  --restore-decision-authority <named-human>
```

The human runs from a private, non-traced shell. No production contract,
synthetic row, comp action, Auth mutation, Storage action, or Realtime action is
authorized.

## Abort and forward-only recovery

Stop on any target, CLI, candidate, ancestry, source hash, history schema,
history sequence, object count, security/ACL, fingerprint, proxy, inspection
token, dry-run set, restore field, or confirmation mismatch.

If apply fails, inspect before doing anything else. Preserve any applied history
and objects. If migration 85 exists without 86, do not deploy application code
that calls the missing RPC. After review, either apply the still-pending immutable
migration or add a new forward corrective migration. Never mark history reverted,
drop the trigger/functions, or use a production restore as ordinary rollback.

If all migrations are recorded but readiness or the provider fingerprint fails,
stop the release and add a reviewed forward migration. Application promotion is
database-first: Render `/health/ready` remains 503 until the exact 99 head and
required-object proof pass. Application rollback is separate and does not roll
back database history.

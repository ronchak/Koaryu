# Studio-Comp Migration Rollout

Status: **staging at exact migration 107; migration 108 rehearsal pending; production human apply locked**

This packet reconciles the production and staging 100-migration V7 baseline
with the immutable 108-migration release candidate. It is specialized to this rollout, not a
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
  repository-pinned SHA-256 manifests; the database V15 readiness signal, backed
  by the V7 semantic/ACL manifest, V9 starting-belt invariant manifest, V11
  student-rank writer body/ACL manifest, V12 writer return-contract manifest,
  V13 retained-membership rank manifest, V14 critical RPC/trigger/FK manifest,
  and V15 checkout-binding/promotion-column manifest, exposed through
  the stable V2-named RPC is an operational drift/readiness signal, not proof
  against a malicious database administrator;
- the mutable parsed `statements` array is not treated as file identity.

Residual risk remains that history was repaired or altered independently and
that the focused object fingerprint does not describe unrelated database state.
Any partial history/object shape, unfamiliar history-table schema, or staging /
production fingerprint mismatch halts the rollout.

The fixed production pre-state is:

```text
100:359058cc127e57a47e429f6271453acf
```

The authorized release migrations are `20260814043325`, `20260814103046`,
`20260814105424`, `20260814114500`, `20260814152000`, `20260814170000`,
`20260814183000`, and `20260814200000`.
The only certifiable post-state is migration count 108 at the latter head. Its
V15 readiness signal retains the complete migration-85-through-108 sequence:

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
20260801131844
20260814043325
20260814103046
20260814105424
20260814114500
20260814152000
20260814170000
20260814183000
20260814200000
```

The checker derives filenames and source hashes from the final candidate, pins
the first 100 identities to the observed V7 baseline, and reports
`integration_complete=true` only when those eight files are the release
pending migrations and the 108-state readiness contract contains the twenty-four
historical versions above. The 070000/091000/093000/105313
billing and 080000 alert
tables, RLS, exact ACLs and stored function bodies, complete trigger/index
definitions, sequences, columns, and all scoped CHECK/UNIQUE/FK definitions are
included in the semantic manifest. V7 recomputes the complete V6/V5/V4/V3
protected surface directly; it does not hash the runtime-divergent V6 or V5
manifest outputs. That carried surface includes the delivery-state columns,
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
external verifier also attests the stable V2-named public RPC, its retired V6
predecessor, the V7 and earlier manifest helpers, the repaired alert-delivery
claim function, and their bodies/configuration/ACLs without asking V7 to attest
its own body. Migration 99 changes only the
ambiguous expired-lease conflict target to the named
`operational_alert_delivery_outcomes_attempt_id_key` UNIQUE constraint; the
primary key remains `operational_alert_delivery_outcomes_pkey` on `id`.
Migration 100 converges `stripe_events` and `studio_payment_accounts` to one
explicit least-privilege ACL and makes definition serialization deterministic
with UTC rendering and C-collated identity ordering. Migration 101 defaults
unassigned active program memberships to the first full
belt and advances the intermediate readiness result to V8. Migration 102 repairs
whole-statement starting-belt replacement and adds the V9 function/trigger
attestation while retaining the V7 billing semantic/ACL manifest. Migration 103
preserves deliberately unranked memberships during one-belt plan edits and
unrelated deletes, reconciles the legacy rank when a student changes primary
programs, converges hosted historical grants on trigger-only functions, and
advances the convergence readiness signal to V10. Migration 104 keeps rankless CSV imports synchronized after
their final student-row write, attests the public/private profile and import RPC
pairs, and advances the attested readiness signal to V11. Migration 105 composes
that proof with normalized `pg_get_function_result()` contracts for all four
public/private student writers and advances readiness to V12. Migration 106
preserves each ranked retained membership when the primary program changes and
advances readiness to V13. Migration 107 preserves replayable checkout acceptance,
enforces one-time trials and tokenized subscription epochs, prelocks secondary-program
rank holders, and advances the exact-head critical-surface readiness signal to V14.
Migration 108 preserves every accepted checkout binding across
later subscription epochs, blocks new checkout until the accepted subscription
has a terminal projection, and advances readiness to V15 with exact type,
nullability, default, identity, and generated-state attestation for the six
promotion rank/snapshot columns. Never certify
an earlier head; regenerate the packet
from the exact immutable release commit so
all candidate migration hashes and counts remain current. Hosted PostgREST
exposed-schema configuration and actual schema ACL readback are separate
provider/operator evidence and are not certified by local PostgreSQL.

The candidate must descend from both merged studio-comp commits and retain these
exact source files:

- `20260727100000_atomic_studio_comp_management.sql` — SHA-256
  `2cd1e15dbe5a8224a0e4829bc92c6b01aae4699006d603d613d18cb4bc82c5c6`
- `20260727110000_order_billing_events_after_studio_comps.sql` — SHA-256
  `22faa79522ba2018780fb260401cd23830df553ee3faf0546b2af689eb51bfc0`

They remain pinned as the first two migrations after historical migration 84.
They are already present in the 100-state baseline. Production must apply
migrations 101 through 108; staging, already at exact migration 107,
must dry-run and apply only migration 108.

Historical intermediate migrations 101 through 103 remain read-only
inspectable, but apply is deliberately disabled from intermediate 101,
recovery 102, and convergence 103. Those readiness versions do not attest the
complete object surface needed for safe forward recovery. Only exact pre-state
100, attested state 104, return-attested state 105, retained state 106, or
critical state 107 may enter apply after a matching inspection token and
dry-run; post-state 108 is inspect-only and has nothing left to apply.

## Transaction and old-application classification

Both July files contain transaction-compatible PostgreSQL DDL only. The local
PostgreSQL 17 harness applies each file in its own single transaction.

- `20260727100000` replaces/creates two invoker functions, changes function
  privileges, and drops/recreates one `BEFORE UPDATE OF metadata` trigger. It
  performs no table rewrite or product-data update, but trigger replacement can
  take a table-level DDL lock.
- `20260727110000` creates/replaces one invoker function and its privileges. It
  performs no table or product-data update.

The August release files have the following operational profile:

| Migration | Locks and data work | Old-application compatibility | Partial failure / recovery |
| --- | --- | --- | --- |
| 101 | Replaces rank/membership functions and three triggers, then updates every active unranked membership whose program has a starting rank. Function/trigger DDL takes catalog and table locks; the backfill takes row locks on matching memberships and may update their primary student rows through the trigger. | Additive schema, but old application reads can immediately observe default starting ranks. | One migration transaction. If committed alone, state 101 is inspect-only; apply is blocked until an operator repairs forward to attested 104. |
| 102 | Replaces the starting-rank backfill, adds one delete trigger and the V9 manifest. No standalone product-data scan. | Additive and compatible with old callers; belt-rank deletion semantics become stricter. | One migration transaction. State 102 is a recovery classification only; automated apply is blocked because its manifest does not attest the later writer surface. |
| 103 | Replaces profile/rank functions and ACLs. No standalone product-data scan, but function and trigger DDL can wait on active writers. | RPC signatures remain stable. Old callers continue to work and receive corrected rank preservation. | One migration transaction. State 103 is inspect-only convergence; repair forward to 104 before any further apply. |
| 104 | Adds stable public/private import wrappers, replaces the readiness RPC, and adds the V11 manifest. No product-data scan. | Additive, signature-compatible wrappers; safe for the old application. | One migration transaction. This is the only accepted partial attested apply origin. |
| 105 | Adds the V12 return-contract manifest and replaces readiness. No table data or trigger changes. | Read-only attestation change; application-compatible. | One migration transaction. Exact V12 state is guarded and may resume with migrations 106-108 after fresh inspection and dry-run. |
| 106 | Replaces the profile writer and rank-delete trigger; wraps the belt-plan writer so assigned-rank deletion is authorized only after its students-first pre-lock; adds atomic membership, bulk, delete, and Core-checkout RPCs; adds four promotion snapshot columns; backfills historical promotion names/colors; replaces two promotion FKs with `ON DELETE SET NULL`; and adds promotion/comp triggers. The promotion `ALTER TABLE` and FK validation can take strong table locks, while the snapshot backfill row-locks matching promotions. | Existing public RPC signatures remain; promotion responses now allow deleted historical rank IDs. Assigned ranks can no longer be deleted directly and must go through `sync_belt_ladder_ranks`. Deploy database-first because new backend membership and checkout flows require the new service-role RPCs. | One migration transaction. Failure rolls back migration 106, but provider timeout is treated as ambiguous: re-inspect catalog/history before retry. If 105 committed first, preserve it and repair forward with immutable 106 or a reviewed migration. |
| 107 | Replaces Core checkout acceptance/reservation functions, records durable one-time trial and accepted-subscription proof, prelocks every target-program membership holder before ladder sync, and adds the V14 critical-surface manifest. | Requires the new backend and remains database-first. Existing completed subscriptions are preserved; old acceptance RPC execution is revoked. | One migration transaction. Exact V13 state is guarded and may resume with immutable 107 after fresh inspection and dry-run. |
| 108 | Replaces Core checkout reservation/acceptance so completed bindings remain terminal until exact terminal projection, archives accepted bindings for later webhook replay, and adds the V15 critical-surface manifest with exact promotion-column state. | Requires the new backend and remains database-first. Returning canceled subscriptions may start a new epoch without receiving a second trial. | One migration transaction. Exact V14 state is guarded and may resume with immutable 108 after fresh inspection and dry-run. |

Before staging apply, record cardinalities for `student_program_memberships`,
active unranked memberships eligible for the 101 backfill, `students`,
`promotions`, and promotion rows missing any applicable rank snapshot. Record
the wall-clock duration of each migration and the longest observed lock wait
from provider logs. The durable release record must contain those counts and
timings; a blank field is a failed gate. Production sizing uses staging timing
plus production read-only cardinalities, never an assumed small-table shortcut.

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
170000 halts before credentials are used.

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
`integration_complete=true`. Acceptance requires the pinned staging ref
`nxgsektqsgrtyfhawxbc`, one exact accepted history (`pre`, `intermediate`,
`recovery`, `convergence`, `attested`, `return-attested`, `retained`, `critical`,
or `post`), its corresponding readiness
result, the complete
historical target sequence, the expected studio-comp objects, and an
`inspection_token`. Any other partial, ahead, or manually altered state stops.
The attested 104 state additionally requires an independent exact readback of
all four writer return contracts before an inspection token is issued.

Only after recording that inspection may the read-only rehearsal run:

```bash
node scripts/studio-comp-migration-rollout.mjs \
  --target staging \
  --candidate-sha <final-candidate-sha> \
  --mode dry-run \
  --inspection-token <token-from-staging-inspect>
```

From the current staging state, the dry-run must report exactly
`20260814200000_preserve_checkout_acceptance_history.sql` with its final candidate hash.
A missing, extra, or unparseable name halts
the rollout.

The exact candidate's staging rehearsal was approved through its durable PR
release record. Any staging apply requires the same inspection token, exact
project ref, durable approval record, and `--approve-staging-apply`. After
application:

1. require count 108, head 200000, the exact twenty-four-version sequence, and the
   derived final history digest;
2. require every table/RLS, policy, grant, function-security/search-path,
   trigger, index, table-ACL, sequence-ACL, and column-ACL identity in the final semantic
   catalog manifest; category counts and sorted identities are deterministic,
   and definitions use UTC rendering plus C-collated identities rather than
   provider UI or database-locale formatting. The policy inventory is
   exact: extra policies halt, constant-false deny predicates and the guarded
   membership predicate are classified canonically, and arbitrary non-null
   expressions do not pass;
3. invoke the service-role-only V2-named readiness RPC during every apparent-post
   linked inspection and require `ready=true`, exact
   count/head/pending versions, an empty failure list, and manifest version
   `release-db-attestation-v15`; a missing, malformed, stale, or failing result
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

Before this release, read-only inspection confirmed staging and production both
at the exact healthy 100-migration V7 baseline. Guarded staging rehearsals then
advanced staging through exact migration 104 while production remained at 100. Record the current release's
staging dry-run, apply, post-state fingerprint, and contract results in the
durable approval record before the human production step.

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
and objects. After review, either apply the still-pending immutable migration or
add a new forward corrective migration. Never mark history reverted, drop the
trigger/functions, or use a production restore as ordinary rollback.

If all migrations are recorded but readiness or the provider fingerprint fails,
stop the release and add a reviewed forward migration. Application promotion is
database-first: Render `/health/ready` remains 503 until the exact 108 head and
required-object proof pass. Application rollback is separate and does not roll
back database history.

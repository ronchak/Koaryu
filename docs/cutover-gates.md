# Cutover Gates

What will stop a release cutover, and what will silently damage it. The mechanics of
each tool are documented elsewhere — `docs/studio-comp-migration-rollout.md` for the
rollout script, `docs/render-backend-deployment.md` for Render. This file covers only
the things those docs do not, all of which were found the hard way during the
2026-08-15 cutover.

The completed production PostgreSQL image-patch packet is historical and
non-executable. Current database backup and disposable restore work belongs only to
the guarded Home Server operator described in
[the current backup section](staging-recovery-runbook.md#current-backup-owner-and-retained-storage-procedure).

Read this before merging a release candidate, migrating a hosted database, or
promoting a frontend.

## Verify live state; do not trust a written plan

Every generated runbook we have used drifted from reality. The 2026-08-15 plan was
wrong on five separate counts: it understated how far the `staging` branch was behind,
its staging apply command omitted two required flags, it promised a health-check string
that the endpoint never prints, its production verification command passed a flag the
script rejects, and it assumed a database backup existed when none did.

None of those are exotic. They are what happens when a document is written once and the
systems keep moving. Before acting, re-derive from the live systems: migration counts
from both databases, `mergeStateStatus` on the PR, `autoDeploy` on both Render services,
and whether a restore path actually exists. Treat any written step as a hypothesis.

## The ordering invariant

Database, then backend, then frontend. Always.

Release migrations are written so the *currently deployed* code keeps working after they
land — that is what makes it safe to migrate before deploying. The reverse is not safe:
new code against an un-migrated database fails readiness and the service will not serve.

`/health/ready` (`backend/app/api/v1/endpoints/health.py`) calls
`assert_hosted_release_schema_ready_cached`, which refuses unless the database reports the exact
manifest in `EXPECTED_RELEASE_MANIFEST_VERSION`. Successful checks are reused for at most
30 seconds; failures are never cached.
The cache lives in `backend/app/services/release_schema_readiness.py`.

The completed V50 release is recorded in [PRODUCTION-RELEASE.md](remediation/PRODUCTION-RELEASE.md) and [verification](remediation/production-release-verification.md). Production and staging are V50, 145 migrations; production serves PR240 candidate `fe2a37bf97bb87897b3f8e03d83611c81d69b9c0`; staging was last verified at Microsoft sign-in candidate `cd2fb0ef0d2655f8f3192e85e93c1c5a95c78225` and was not changed or reverified for PR240, with no migration added. See [Microsoft SSO verification](microsoft-sso-setup.md#september-20-release-verification). The staging billing cron remains suspended. Future releases need a new exact-candidate packet and fresh target evidence. Do not reuse completed inspection tokens or recovery evidence as approval of a new state.

V48 separates stable activation intent from its atomically owned first execution quantity, preserving already-attempted provider recovery. V49 permits unknown subscription currency/cadence without invented defaults. Neither migration rewrites historical rows. After new version-2 receipts or null subscription terms exist, readiness compatibility alone does not authorize an older backend rollback. Use the packet's recovery limits.

V50 makes overdue status a current business-date fact shared by Billing and Dashboard reads. It preserves stored payer enum compatibility and changes no customer rows. The previous V49 application remains schema/readiness-compatible for the database-first window; the new backend requires V50. See the packet for recovery limits.

## Retained migration compatibility

V38 remains an accepted predecessor. Its remainder includes the V39 membership
correction before V40. V39 preserves paused statuses and per-program joining dates
during ordinary profile edits. V42 completes the settled product rule: an overall
joining-date edit no longer changes retained program dates. It keeps the overall date
change and the existing date default, including null, for new memberships. The
frontend preview model follows the same rule. There is no historical membership
backfill. Existing tenant checks, ranks, paused statuses, membership statuses and
student-before-membership locks remain unchanged.

V40 preserves promotion-time rank names/colors and records immutable evidence for
new rank commands. One database transaction owns context resolution, replay and
rank mutation. Existing public promotion/demotion interfaces remain available.
Old receipts with insufficient required identity conflict instead of reporting
success without proof. Intentional history deletion keeps its existing lifecycle.
The old backend's permissive API shortcut disappears only when the new backend is
deployed; applying the database migration alone does not replace that application.

V41 adds a service-role-only payer-balance writer. It locks the scoped payer, then
uses a separate READ COMMITTED MVCC sum with the existing balance formula before
updating that payer. It takes no invoice row lock and performs no automatic or
historical backfill. The database-first step does not fix races in old Python split
read/write callers. The serialization guarantee starts only after every serving
backend and worker uses the RPC and those old operations drain.

V43 adds the service-role-only, SECURITY INVOKER, VOLATILE
`record_external_payment_v1` RPC. It atomically commits a payer-only external payment
and its original-actor audit. Exact same-key/hash replay returns the original payment
and audit, and balance completion remains repeatable after commit. New writes are
USD-only, while confirmed historical non-USD replay remains valid. It performs no
historical audit repair or backfill. Existing invoice-target HTTP rejection and SQL
invoice guards remain; the dead Python invoice path is removed. The guarantee starts
only after every serving backend uses the RPC and old split-write operations drain.

V44 adds the service-role-only, SECURITY INVOKER, VOLATILE
`write_billing_plan_v1` RPC. It commits plan scalars, program links, the
original-actor audit, and the returned snapshot in one transaction. A no-op preserves
status, timestamps, and links. Required fields reject explicit null; omission and
nullable clearing remain distinct. New or financially changed local definitions must
use USD. Historical rows, identical saves, and nonfinancial maintenance keep their
existing currency. New provider price, enrollment-activation and invoice-creation
writes also require USD before their first financial attempt. Existing attempted
financial operations, confirmed results and product-only maintenance retain their original
currency and recovery identity. A confirmed product alone does not authorize an
unattempted non-USD price. An empty invoice header likewise does not authorize new
non-USD line amounts; partial evidence stays in reconciliation. The provider
guard takes effect when all serving writers run the updated application. V49 subsequently corrected
unknown provider-fact recovery. Mixed-currency totals remain intentionally deferred
after the USD-only production query.

Local plan writes take a studio-scoped shared transaction advisory lock first, then
the studio KEY SHARE lock, plan lock, and ordered program locks. Guarded demo clear
takes the matching exclusive advisory lock first and does not take a broad studio
UPDATE lock. Only that clear RPC is synchronized with plan writes. Later demo reset
and reseed requests remain separate operations. The new atomicity guarantee begins
only after old Python plan split-write requests drain. V40 rank, V41 payer balance,
V42 catalog and semantics, and V43 external-payment facts remain unchanged. The old
V41 and V43 split callers must still drain for those guarantees.

The local verifier executes each logical restore continuation from V38 through V50.
Each uses a real synthetic dump and a new local restore database, accepts only the
reviewed PostgreSQL 17 CHECK/default-ACL representation differences, and verifies
business-data preservation and old/new caller continuation. These are local
contract proofs, not production backup evidence. Candidate verification requires the
V47-to-V48, V48-to-V49 and V49-to-V50 canonical and logical restore continuations, all 145 migrations and 54 SQL
contracts, and all 27 cases in `scripts/verify-billing-command-concurrency.py`.
The renamed runner uses the existing concurrency helpers and adds no new framework.
Earlier restore proofs remain in force. The operator's backup helper and
release/image mappings must be updated and verified for the actual candidate
before an authorized hosted rollout. Old V38 approvals and mappings are not reusable.

Exact V31 through V37 remain state-bound forward-recovery points. They may
resume only their immutable suffix through V50; hybrid histories, catalogs or
readiness results are refused. A predecessor before V38 also needs the historical
billing-index migration. Its ordinary index builds hold write locks that can delay
billing and webhook writes until that transaction finishes. Plan that write pause
for a separately authorized rollout; its hosted duration has not been measured.

Migration 119 keeps the historical V24 response. The Payments chain retains its
version-bound compatibility consumers. V47 adds full preflight V28 and makes V27
return the V46 tuple only after the complete new state verifies. The existing chain
retains V45 through V37 responses, including the historical V38/V19 consumer. The
candidate backend requires exact V50, 145 migrations, through full preflight V31. V50 retains V30 compatibility only after verifying the complete V50 state. V48 introduced V29; V49 retains V29 compatibility only after verifying the complete V49 state. Compatibility preserves old
readiness; it does not restore retired import behavior or give old split writers
the new transactional guarantees.
The temporary V22 and
V23 application bridges were removed after production hosted readback. The
rollout tool retains exact historical `restored-v22`, `canonical-v23`, and
`restored-v23-pending-v24` classifications only for diagnosis of a proved
partial restore or replay. They are not application readiness alternatives.

The operational manifest string is **not** echoed in the response body. A runbook that tells you to
look for it is wrong. `"status": "ready"` *is* the proof the attestation matched.

If migration 113 commits and migration 114 does not, stop. No approved
application is eligible to serve at that partially migrated history. During the historical V24 release,
the prior `709239` application required V16 and that release candidate required V24.
The current candidate requires V50. Older V2 consumers from
before verified history boundary
`d63a5116c0a47f1933f15360cd5db7b66237bb80` can report ready through migration
110's exact V17 compatibility guard, but none is an approved recovery artifact.
Exclude both `709239`/V16 and every pre-boundary V2-consuming SHA from the
post-110 rollback set. A database still at exact 110 must classify `state=staff-identity` and use its
state-bound inspection token. The tool must select migrations 111 through 145 in
their immutable order. A separately approved disaster recovery to the proved
restored V22 snapshot must classify exact `state=restored-v22` and select only
migrations 116 through 145. Use the generated remaining-file list and its source
manifest; do not maintain a second manual list. These are hypothetical recovery
cases, not the current live state. Only the authorized operator runs production
apply. Candidate promotion remains blocked until migration 145 produces exact
V50 readiness and the final raw catalog/provider fingerprint. That raw evidence
must independently attest the retained plan RPC and demo-clear facts, import receipts, refund ownership,
the V48 activation, V49 subscription terms and V50 invoice facts, and the V50 release facts. V40 rank-command,
V42 catalog and semantic and V43 external-payment pins remain unchanged. V50 updates the V41 balance function to consume the shared date rule while preserving its serialization.

The V33 retry-hash capture stays enabled throughout the database-first rolling
deploy. Do not call `finalize_billing_invoice_retry_hash_capture_v33` during the
database migration. A later operator may disable capture only after recording the
exact new-backend served SHA and a drain proof, then passing the singleton's current
revision, candidate SHA, and proof SHA-256 to that RPC. Existing ledger rows remain
replayable by canonical base hash after finalization; persisted legacy-hash callers
must fail closed.

The compatibility ledger intentionally has no foreign keys to mutable operation and
resource rows. Existing maintenance and test cleanup can replace or remove those
rows. This does not activate stale ledger data: every claim revalidates the ledger's
operation, alias, resource, invoice, payer, actor, account, generation, and hashes.
Missing or changed live bindings make a dangling row inert.

## Gates that will refuse you

**Unresolved review threads block the merge.** The `Koaryu main release gate` ruleset
sets `required_review_thread_resolution: true`. Any unresolved thread — including ones
deliberately deferred as known issues — makes `mergeStateStatus` `BLOCKED`, and
`scripts/merge-release-pr.sh` refuses because it requires `CLEAN`. Resolve or fix them
before starting, and record *why* on each thread if the finding is being deferred.

**Run the rollout tool from the exact candidate implementation.** For an unmerged
release, invoke the tool from that candidate's worktree and pass its exact 40-character head.
The tool creates a detached worktree at that SHA and verifies the candidate's ordered migration sequence and
source hashes there. Do not run an older `main` copy of the tool and do not merge the PR
to obtain the rollout script.

Production apply also validates the supplied staging fingerprint against the
current complete canonical tuple before any database apply. A merely well-formed
fingerprint from an older candidate cannot pass that check.

**Staging apply needs more than `--approve-staging-apply`.** It also requires
`--confirm-project <ref>` and an exact PR #138 issue-comment URL. The tool reads that
comment through GitHub and requires its complete body to bind the candidate SHA, target,
project ref, inspected state, remaining migration count/set, and remaining manifest. It
also requires the GitHub API record's exact `issue_url` to identify
`ronchak/Koaryu` PR #138, preventing a matching body on another issue or pull request
from serving as the approval. The API record must also identify `ronchak` with GitHub
`author_association=OWNER`; comments from collaborators or outside users are refused.
A stale approval record is rejected after any code, state, or remainder change.

## Owner-authorized release execution

The owner may explicitly authorize a named coordinating agent to apply production migrations, deploy the backend and promote the frontend. This replaces the former human-only terminal rule as of September 14, 2026. Subagents have no production authority. Live billing activation still needs separate authorization.

Production apply requires `--release-authorization ronchak:<candidate-sha>`, `--release-operator <named-executor>` and `--confirmation-phrase <exact-phrase>`. The authorization names the owner and intended release. Production may omit the PR138 comment under explicit operating-session owner authorization. If supplied, the comment is validated in full. Source and target checks, inspection token, dry runs, staging fingerprint and restore evidence requirements remain. It records the owner, executor, release, intended/applied versions, status and timestamps in its output. A terminal is not proof of authorization.

The executor name is caller-reported attribution, not an authenticated process identity. When a comment is supplied, GitHub verifies its approval account and exact release scope. Direct CLI fields are operator assertions; they do not independently authenticate owner permission. A public owner/release label or a second name comparison cannot isolate a malicious process that shares provider credentials. The named-coordinator restriction remains an operating-policy requirement; subagents are not authorized.

Default production bulk apply is refused. For an authorized remaining chain, use `--one-migration` on inspection, dry-run and apply. Each invocation binds the next file to its own token, exact owner/release authorization and confirmation and must verify its exact declared successor. Reinspect before the next invocation; never automate the sequence past a checkpoint. Every attempted provider apply records its actual stdout, stderr and process outcome before the final success or uncertain-failure record. Keep that audit output private.

The exact phrase still binds the candidate, pending migration count, source manifest and production project. Supply it deliberately. Do not generate an automatic answer or fabricate a backup/restore claim to satisfy a field.

Before **each** irreversible or outward-facing release action:

1. Post the exact command, what it changes, whether it is reversible, and the check that follows it.
2. Before each production migration apply, wait at least 30 seconds. Staging and non-migration actions have no mandatory pause. If the owner interrupts, stop and report the current state.
3. Execute that command alone. Never combine two irreversible steps in one announcement or put a mutation inside a compound command.
4. Verify the result before the next action. Retain the command, authorization, timestamps, candidate, provider response and verification evidence outside the repository when it contains operator data.

This applies to each migration apply, the production backup, each backend deployment and each frontend promotion. Database comes first, backend second, frontend last. The owner has allowed the exact recorded old-frontend/new-backend pair only during that planned transition; every unexpected SHA mismatch is a stop. Verify the matching final pair before declaring the release complete.

A fresh pre-apply backup and verified disposable restore are mandatory. Stop on a failed or ambiguous migration, unexpected checkpoint state or change to pre-existing business rows, an unverifiable backup/restore, an unexpected deployed SHA, or the run's applicable budget stop. Use the current operating session's budget, not a previous release's allocation. Estimate completion before starting a production chain; never begin one that cannot finish within the authorized cap. Do not stop an already-started chain on budget; technical failure stops remain. Do not improvise recovery. Keep the safest reachable state, retain evidence and report the options.

Executable changes retain exact-head CI and independent review. Documentation-only closeout uses focused verification and review without a required full-suite wait. Preserve branch protections, the guarded merge and production auto-deploy off readback. Tenant isolation, authorization, payment safety and idempotency remain unchanged. The existing prohibition on running contract or migration SQL against production remains. Only the guarded rollout tool's authorized apply is an exception for migrations; contract SQL is never allowed. No historical financial backfill.

Private operator guidance must agree with this policy. The [proposed operator-policy diff](remediation/operator-governance-proposal.patch) is reviewable; the private runbooks remain unchanged. The owner's explicit authorization governs this run while those notes await alignment.

## Traps that will not refuse you

These are worse than the gates, because nothing fails. You get a green result and a
broken system.

**`--expected-stripe-mode` is staging-only.** `stripeRehearsalExpectation()` in
`scripts/verify-deployed-release.mjs` requires the value be exactly `test` *and* the
environment be `staging`. For production, omit the flag entirely. Verify production's
Stripe mode from `/health/ready`'s `configured_stripe_mode` instead.

**Never promote a Vercel preview deployment to production.** This is the most dangerous
step in the whole cutover.

Vercel inlines `NEXT_PUBLIC_*` at *build* time, and the `koaryu` project defines separate
preview and production values for `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. Promoting
reassigns the production alias to an existing build; it does not rebuild.

The trap is that merging to `main` produces **no Vercel build at all**, because production
auto-deploy is off. So the only build carrying the merged SHA is a preview produced by the
`staging` branch push. It shows the right commit and is the wrong build. Promoting it
points `koaryu.app` at the **staging database with test Stripe keys** — and it fails
silently, because the app loads perfectly while reading the wrong database.

Instead, create a production-target deployment from git, so it builds with production
environment variables: `POST https://api.vercel.com/v13/deployments` with
`target: "production"` and a `gitSource` whose `ref` is the merged SHA.

Then confirm both: `scripts/verify-deployed-release.mjs` reports the frontend as
`environment: production`, and the live app's XHRs go to `koaryu.onrender.com`, not
`koaryu-staging.onrender.com`.

## A verified backup is a precondition, not paperwork

The Supabase organization is on the **free plan**: no scheduled backups, no
point-in-time recovery. There is no managed restore path for production.

`--confirmed-restore-window` is validated only by `assertPlainText` — printable ASCII and
nothing more. It never checks that a backup exists. It will accept a fabricated claim on
an irreversible migration against live customer data. **Never pass a value you have not
personally produced and verified.**

Do not use a copied `pg_dump` recipe from public documentation. The single guarded
Home Server operator owns the complete snapshot, temporary role, encryption,
disposable exact-image restore, comparisons, and cleanup. Its candidate and provider
image mappings must match before use. Existing V38 mappings and snapshots do not attest
a later candidate. Store every private artifact outside the repository with mode
`0600`; it contains customer PII. A database snapshot does not include Storage object
bytes, so retain the separate Storage procedure linked above.


## Completed September 20 release

The single V50 production apply, original-row comparison and application deployments passed under one fresh verified V49 backup/restore. [The verification record](remediation/production-release-verification.md) contains exact SHAs, timestamps and evidence. Do not repeat the completed chain. The helper now has reviewed mappings through V50; future backups still require fresh source/image checks and a new verified restore.

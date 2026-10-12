# Historical release reference

These excerpts are preserved from the previous cutover and release-control guides.
They describe earlier candidates, provider states and recovery constraints. They
are not current instructions, live-state evidence or authorization to execute a
release. Read only when investigating one of these historical versions. Derive
current facts from the candidate declarations and live inspection.

## Earlier cutover compatibility notes

The last completed release verification, October 1, 2026 Pacific, recorded both production and staging frontend/backend pairs at `0cf345be94f31eefbfa80be80bed3a8670680bf2` after PR258. Both databases were exact V55, 150 migrations, head `20260930192626`. Both web services were active with auto-deploy off; the staging billing cron was restored and suspended. The [October 1 release record](remediation/october-1-release-verification.md) distinguishes the completed V54/V55 rollout from the later application-only PR258 release. This documentation refresh did not repeat hosted verification.

The [September 29 V53 release](remediation/everyday-correctness-release.md), earlier [V50 packet](remediation/PRODUCTION-RELEASE.md) and [verification](remediation/production-release-verification.md) are historical. Reinspect live state before any release action. Future releases require fresh exact-candidate, target and recovery evidence; completed tokens and proofs are not approval of a later state.

V48 separates stable activation intent from its atomically owned first execution quantity, preserving already-attempted provider recovery. V49 permits unknown subscription currency/cadence without invented defaults. Neither migration rewrites historical rows. V51 changes only the invoice closeout claim's lock order: an existing-key finalize or void retry now takes the V31 writer's invoice, payer and mutation-owner locks before its alias, resource and operation locks, removing the deadlock with a concurrent new-key claim. It rewrites no rows. After new version-2 receipts or null subscription terms exist, readiness compatibility alone does not authorize an older backend rollback. Use the packet's recovery limits.

V50 makes overdue status a current business-date fact shared by Billing and Dashboard reads. It preserves stored payer enum compatibility and changes no customer rows. The previous V49 application remains schema/readiness-compatible for the database-first window; the V50 backend requires V50. See the packet for recovery limits.

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

The local verifier executes each logical restore continuation from V38 through V56.
Each uses a real synthetic dump and a new local restore database, accepts only the
reviewed PostgreSQL 17 CHECK/default-ACL representation differences, and verifies
business-data preservation and old/new caller continuation. These are local
contract proofs, not production backup evidence. Candidate verification requires the
V55-to-V56 canonical and logical restore continuation in
`scripts/verify-v55-v56-restore-contract.py`, all 151 migrations and 57 SQL
contracts, all 29 cases in `scripts/verify-billing-command-concurrency.py`, and
all 75 cases in `scripts/verify-lead-command-concurrency.py`, and all 37 cases
in `scripts/verify-automation-concurrency.py`. Eight V55 lead
cases cover competing direct restorations, same/new follow-up keys and mixed
restoration callers after an archived-program backward edit, under both commit
and rollback, without another student, membership, guardian or conversion audit.
The renamed runner uses the existing concurrency helpers and adds no new framework.
V54 also proves the intended source-lead minor backfill, preserves adult DOB precedence and
unrelated records, and exercises guardian corrections and future-DOB rejection on both restored
and canonical copies. V55 changes no retained business rows. Its restore proof
preserves converted lead/student/guardian/membership and audit facts, restores
enrollment with archived or null program interest, preserves explicit minor
knowledge without a DOB, and proves exact retries on canonical and logically
restored copies. New candidate declarations do not change any deployed release identity.
Earlier restore proofs remain in force. The operator's backup helper and
release/image mappings must be updated and verified for the actual candidate
before an authorized hosted rollout. Old V38 approvals and mappings are not reusable.

Exact V31 through V37 remain state-bound forward-recovery points. They may
resume only their immutable suffix through V56; hybrid histories, catalogs or
readiness results are refused. A predecessor before V38 also needs the historical
billing-index migration. Its ordinary index builds hold write locks that can delay
billing and webhook writes until that transaction finishes. Plan that write pause
for a separately authorized rollout; its hosted duration has not been measured.

Migration 119 keeps the historical V24 response. The Payments chain retains its
version-bound compatibility consumers. V47 adds full preflight V28 and makes V27
return the V46 tuple only after the complete new state verifies. The existing chain
retains V45 through V37 responses, including the historical V38/V19 consumer. The
candidate backend requires exact V56, 151 migrations, through full preflight V37. V56 retains V36 compatibility only after its complete schema, automation functions and privileges verify, keeping the V55 backend ready during the database-first window. V55 retains V35 compatibility, so a V54 backend stays ready only after verifying the complete V55 state. V54 retains V34 compatibility, so a V53 backend stays ready only after verifying the complete V54 state. V53 retains V33 compatibility, so a V52 backend stays ready only after verifying the complete V53 state. V51 retains V31 compatibility after its complete state verifies. V50 retains V30 compatibility only after verifying the complete V50 state. V48 introduced V29; V49 retains V29 compatibility only after verifying the complete V49 state. Compatibility preserves old
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
The current candidate requires V56. Older V2 consumers from
before verified history boundary
`d63a5116c0a47f1933f15360cd5db7b66237bb80` can report ready through migration
110's exact V17 compatibility guard, but none is an approved recovery artifact.
Exclude both `709239`/V16 and every pre-boundary V2-consuming SHA from the
post-110 rollback set. A database still at exact 110 must classify `state=staff-identity` and use its
state-bound inspection token. The tool must select migrations 111 through 151 in
their immutable order. A separately approved disaster recovery to the proved
restored V22 snapshot must classify exact `state=restored-v22` and select only
migrations 116 through 151. Use the generated remaining-file list and its source
manifest; do not maintain a second manual list. These are hypothetical recovery
cases, not the current live state. Only the authorized operator runs production
apply. Candidate promotion remains blocked until migration 151,
`20261004220435_missed_class_automation_v56.sql`, produces exact V56 readiness
through `koaryu_release_schema_preflight_v37()` and the final raw catalog/provider
fingerprint. Require 151 migrations, head `20261004220435`, and manifest
`release-db-attestation-v56`. That raw evidence must independently attest the
retained plan RPC and demo-clear facts, import receipts, refund ownership,
the V48 activation, V49 subscription terms, V50 invoice facts, V51 closeout lock
order, V52 lead commands with V55 conversion/follow-up definition pins, V53
dashboard definition and the retained V54 student writer/age function/trigger facts.
V40 rank-command and V43 external-payment pins remain unchanged. V54 changed the
student writer catalog function facts; the other V53 business catalog facts remained fixed.
V55 changes the conversion and follow-up function facts and the student inventory pin
covering conversion. V54 student writer/age rules and the other business facts remain fixed. V50 updates the V41 balance function to consume the shared date rule while preserving its serialization.

V56 adds four automation tables and eighteen callable helpers/RPCs without rewriting retained business rows. The new schema binds logged storage, RLS, complete table/column/function ACLs, columns, constraints, indexes and the immutable-delivery trigger. Its three public tables retain the existing restrictive membership guard while client grants remain revoked. The V55-to-V56 restore proof exercises rule revisions, guardian/hold eligibility, accepted and unknown outcomes, suppression and credential CAS. Studio entitlement failures defer that studio for one hour and release only its matching unsent claim, allowing other studios to proceed. The worker rechecks current eligibility before committing a send attempt. These local proofs do not establish hosted deployment, credential import or activation.

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


## Earlier provider and V24 notes

The fixed V24 declarations below describe the completed 2026-08 release. They remain
historical context only and are not active candidate requirements.

Database promotion precedes application promotion. Hosted readiness calls the
service-role-only V4 Supabase preflight and requires the exact final migration count
117, head `20260824190500`, the exact 33-version pending sequence, manifest version
`release-db-attestation-v24`, the exact zero-invalid-count V18 archive-critical
semantic manifest `0:cf1b1a4403e539721172d4a8cfec64540e4f5dcec2aab12eafbcfb51fbd84b3a`, and required-object/security proof. The backend reuses a successful preflight for at most 30 seconds to prevent health-probe client churn. It never caches failures, and concurrent probes share one check.

That manifest covers
`staff_roles.archived_at`, active-only helper bodies/signatures/ACLs, archive-aware
triggers, and every public RLS table's restrictive membership guard.

Staging and production now report ready only at exact 117/V24. The temporary
production V22 and hosted V23 application bridges were removed after the
production V24 hosted readback. Historical V22/V23 states remain represented
only in the guarded operator tool for exact forward-recovery diagnosis.

The post-111 V16 compatibility assertion is pinned to
`0:48995afbdd6519a199db44c6b947bf629a87569530ba73c81c25b00f72944239`. The
V24 preflight accepts exactly the canonical PostgreSQL 17 operational
semantic/ACL manifest
`61c8251b04d170bb4777de6c35570d024d6c97897ef1c524bc1adbcff97b7931`
or the independently proved logical-restore manifest
`f9ce359c0ebf12039e8dfcb5308cd193ac18aa05cea23dad5b9f5208b0c51233`.
The raw PostgreSQL 17 catalog fingerprint is pinned to
`column_acls=205:32ad7f660d40de1c75de0e9d50e4c23f3588124e67f3665159f8f2f027617414:0;columns=43:c2f9560d4d2d9742f22edeeb3386b2fce9def1e90290e7986f406d9f7dd0451b:0;constraints=24:d8ae028684234bb1c69447c97e87fc8561ce18f03b7ec10f81a880ba5d813c5c:0;functions=68:87649166980bfc6164e59482e122793d4b7867bbf360d2f1dbe3021fa151309b:0;indexes=12:c78635a18852d4cbe8be1bc34861848ba904b06639038c292f84d56ca7be50a7:0;policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;scoped_constraints=149:a1555af1e8eacb8f03b04c2109dc6966293705307d737e5601996cf81acc06b9:0;scoped_indexes=33:4d401ee4a7e7f104957cb8cc84ad45164d57938ced0c2609259310aa980895f2:0;sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;table_acls=14:d71f968d375333515659bd0220224c127cee6e7b3878f9ae36427f7c1561c92c:0;tables=12:f56508ae1d3c712e7b239a1fe965adf88cec4e7f41f8d6b6db9ffce95f1bb76b:0;triggers=12:61039a9e58e55b3aba5e7e2a40088fd492352560123bc5df30c7966cfd6d9efc:0`.
The independently read-back restored-production catalog is byte-identical in
every category except the proved logical-restore scoped-constraint digest:
`scoped_constraints=149:47cacc1ce1d31ca8a7d63158aaa66aaf24452c085015c226f40e810995a6cd18:0`.
Read-only 2026-08-24 comparison also confirmed identical narrow function state
`3:421f8574059c8ca45a1a2075ce1e9346:0`, trigger state
`1:e430c825c094352cd460bd15933a3a43:0`, and V18 critical manifest. The rollout
tool derives the exact restored production fingerprint from approved canonical
staging evidence by replacing only that full catalog token; no per-category
mixing is accepted. A schema-84 state, a partial 85-110 state, a missing final
migration manifest, or any
provider/RPC error returns 503, so the new backend cannot be promoted healthy
against an earlier database head.

Migration 116 reasserts the global default that removes PostgreSQL's automatic
PUBLIC function EXECUTE grant, removes the schema-local API-role defaults, and
fails closed if any public routine remains browser-callable. The
fresh PostgreSQL 17 replay produced the same operational manifest and raw
catalog fingerprint pinned above because migration `20260711215000` had already
converged the effective routine ACL state. Migration 116 adds a schema-wide guard and a
behavioral new-function probe; it does not invent a catalog change where none
occurred.

Migration 117 advances readiness to V24 without changing product data or
operational objects. It admits only the two proved zero-failure PostgreSQL 17
manifests above; a third digest, hybrid history, or object failure remains red.

Migration 109 introduced the candidate V2 checkout-reservation path and retains
the deployed `origin/main` predecessor reservation (V1) and V2 readiness
signatures for the mixed-version database-first window. Migration 110 updates
the V2 compatibility guard: its V7-shaped response reports ready only when the
candidate V3 preflight proves exact 110/V17 state. Migration 111 adds active-membership
archive authorization, owner/last-admin archive guards, and service-role-only
staff-role writes; the new backend never uses the compatibility path.
Exact migration 109/head `20260814213000`/V16 is the accepted `trial-locked`
resume state for migrations 110 and 111. Exact migration 110/head
`20260815220402`/V17 is the guarded `staff-identity` resume state for migration
111 only. Each requires a fresh candidate-bound inspection and exact dry-run.
No approved application serves at 110: exclude `709239`/V16 and every
V2-consuming SHA before verified history boundary
`d63a5116c0a47f1933f15360cd5db7b66237bb80` from rollback. Those older V2
consumers can report ready through the 110/V17 compatibility guard, but they are
not approved recovery artifacts.

The local PostgreSQL proof does not certify hosted PostgREST exposed-schema
configuration or actual schema ACL state. Authenticated operator readback must
separately prove that `private` is not exposed and that hosted schema ACLs match
the approved release gate before promotion.

`npm run check:env-examples` fails if either repository provider control drifts or if the account-deletion cron is removed. Repository text cannot prove Render's current service setting: before the bootstrap merge, an authenticated operator must turn production auto-deploy off through Render and capture an authenticated readback. The guarded merge command independently rechecks that live provider state and refuses to merge without it. After the fixed candidate passes staging, deploy or promote that exact SHA explicitly, read back Vercel `/api/version` and Render `/health/ready`, and compare both full SHAs with the release ledger before assigning production traffic.

The exact `codex/launch-readiness-candidate` branch does not auto-deploy to Vercel. GitHub CI performs its production frontend build. The operational-alert evaluator's primary trigger is the director-operated home server's external scheduler at the required five-minute cadence; the committed Vercel cron is a daily 09:00 UTC backup. This resolves the Vercel funded-plan gate by moving the primary trigger source, not by weakening the cadence. Nobody may weaken the five-minute cadence merely to make a preview deploy. Deploy the approved exact SHA through the database-first manual promotion path.

Use `npm run verify:deployed-release -- --environment <staging|production> --expected-sha <full-sha> --frontend-origin <pinned-origin> --backend-api <pinned-api-v1>` for the application-reported readback. It requires both Render readiness routes and Vercel to report one exact full SHA. Run it before browser smoke or performance capture; evidence from a mismatched pair or mutable alias is invalid. Authenticated provider deployment metadata remains a separate required readback.

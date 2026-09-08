# Rank history and command ownership

Proposed ninth remediation PR, from main
`b5ec8fff6ef3b4a7011212e3b942fdf01f6586d2`. This plan precedes production edits.

## Problem and boundary

OPS1-01 and BT1-06 concern an API replay shortcut that validates only operation
ID and transition kind. It can report an earlier student's action as success for
a different command. DM2-03 shows why copying the SQL comparison into Python is
insufficient: history's foreign keys can be cleared while the history survives.
DM2-01 concerns the same retained row: a later update can replace historical belt
names and colors with their current values. These belong to one history and
receipt responsibility. OPS1-14's repeated transition setup can be removed as a
consequence, subject to verification of that finding's full scope.

The database already owns transaction locks, adjacency, rank projections and
history/audit atomicity. Keep those rules. Remove the second Python state machine
and its permissive receipt lookup. Frontend promotion draft/refresh ownership is
a separate pending change. Intentional history deletion, historical repairs,
financial recovery choices and unrelated rank eligibility work stay separate.

## Intended implementation

- Add one forward V40 migration after the 134 immutable migrations. Preserve all
  existing public promotion/demotion RPC signatures. They delegate through their
  existing private V2 entry point to one new private transition core, retaining
  exact expected-from and resolved-context semantics. A new public V3 command
  entry point lets the current API request context resolution under the same
  transaction and operation lock, without supplying a guessed from-rank.
- The core locks studio plus operation ID before checking a receipt. A new
  operation then locks the student and membership in the existing order, resolves
  omitted context, validates explicit context, and runs the existing ladder,
  active/paused membership and adjacency rules once. Primary and secondary rank
  projections, atomic audit insertion and the unique operation index remain.
- New history rows carry a versioned fingerprint plus original resolved program,
  membership and from-rank UUIDs without foreign keys. The fingerprint binds typed
  studio, operation, actor, student, target, kind, effective context and exact
  notes. A small private SQL function defines that encoding for insertion and
  replay. It stores no additional raw actor or free-text note copy. The row's
  existing deletion lifecycle owns this evidence; there is no permanent tombstone.
- The existing snapshot trigger captures facts on INSERT and preserves the old
  four name/color snapshots and receipt fields on UPDATE, including old nulls.
  INSERT computes the fingerprint from actual row values rather than trusting a
  supplied hash. Do not backfill old rows or infer historical names from live ranks.
- A prospective retry compares the fingerprint using the receipt's original
  context for omitted/null inputs. Explicit different context conflicts. The API
  does not assert from-rank; old RPC callers still do. Missing live ranks or cleared
  history foreign keys do not force current-state validation of a proved retry.
- Legacy API receipts compare intact student, actor, target, kind and exact notes.
  Explicit non-null program/membership must match. Omission adds no context
  assertion and does not require reconstructing deleted optional references.
  Missing required identity conflicts. For old V2 callers, an exact null in a
  mutable context/from field needs proof that it was originally null. A narrowly
  matched transaction audit can provide that evidence; otherwise fail closed.
  Do not scan current ladders or manufacture an old fingerprint.
- The Python service sends one RPC and shapes its response. Known replay conflicts
  and unverifiable receipts become HTTP 409. Known business validation remains
  400, missing resources 404; unknown provider failures remain server failures.
  This matters because the existing client searches history after an unknown
  failure and currently matches only operation ID. A known conflict must not enter
  that recovery path. Preserve endpoint actor, tenant, manager and Core guards.

Promotion notes remain exactly nullable, including the distinction between null
and an empty string. Demotion reasons keep existing schema trimming. UUIDs retain
typed identity. Hard student/studio deletion and operational clear still delete
history and its receipt. No retry guarantee is introduced beyond that boundary.

## Attestation and rollback boundary

The snapshot and writer changes affect critical manifests V15 through V18, then
operational manifests V9 through V11 and resource/operational V31 and V12. Derive
actual dependencies and canonical/restored values from disposable PostgreSQL 17;
do not reuse PR158's narrower substitution recipe. Advance the full preflight to
V21 with exact V39 predecessor checks and preserve V20/V19/V18 consumers. New
functions, columns, constraints and privileges need explicit attestation.

Keep historical restore checks pinned to their own version instead of importing
future FINAL values. Add a real seeded V39 logical restore through V40, confirm
business-row preservation and old/new caller behavior, and verify exact canonical
and restored catalogs. Update current version selectors without weakening old
pins. The new backend requires the new readiness contract. A database-first
rollout leaves the old backend usable, though its permissive API shortcut is only
removed when the new backend is deployed. Merging does not deploy or authorize
production migration; the existing human-only apply and release gates remain.

## Required evidence and test reduction

Use real SQL for state-machine behavior: exact and conflicting retries, omitted
versus explicit matching context, initial rank, promotion, demotion, secondary
program projection, inactive/foreign membership refusal, transaction rollback,
FK nulling, frozen snapshots, legacy compatibility and intentional deletion.
Deterministic two-session cases must prove one same-key history/audit result and
conflicts without extra mutations. Preserve existing ladder/rank safety coverage.

Replace fake-database tests that simulate the production rank algorithm with a
small Python RPC/response/error contract suite. Keep one actual HTTP conflict
check with the normal error envelope and meaningful authorization coverage. SQL
provides mutation and replay assurance; Python must not claim its fake writes
prove database atomicity. Do not weaken or delete unrelated tests. Run targeted
checks first, then full backend, API contracts, full local migration/contract and
restore/concurrency checks, release tooling and exact-head CI. Independent plan,
implementation and final-head reviews must pass before guarded merge.

After merge, reassess each affected ledger entry and choose the next change from
updated main. This is not a commitment to a fixed remaining PR sequence.

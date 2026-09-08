# Rank history and replay verification

The rank-history candidate addresses OPS1-01, BT1-06 and DM2-03 together. The API
previously returned a receipt after checking only its operation ID and kind. Six
changed-command variants reproduced that false success on main. Copying the old
SQL comparison into Python would not fix the problem because history's foreign
keys can be cleared. DM2-01 concerns those same rows: updating them after a belt
rename could overwrite the original rank names and colors.

The current backend sends one command to SQL. A shared transaction owns receipt
comparison, context resolution, rank validation, projection updates and audit
insertion. It retains the operation advisory lock, student-before-membership lock
order, adjacency, tenant checks, paused-member behavior and primary/secondary rank
rules. OPS1-14's two Python state machines and their unused delegate are removed
as a consequence of establishing that owner.

New history rows carry a versioned fingerprint and original program, membership
and from-rank IDs. INSERT derives this evidence from the actual transition;
UPDATE preserves it and all four rank-name/color facts. The digest is command
evidence, not encryption or anonymization. It avoids another raw actor/note copy.
Existing public RPC signatures retain their expected-from semantics. The new API
may omit context and replay the original effective command. An explicitly changed
context, actor, target or notes cannot reuse that command's key.

Legacy rows are not backfilled. The API compares intact required identity and
any supplied context. Old V2 calls that assert an exact null additionally need a
single complete transaction audit proving the original null. Missing required
identity or insufficient proof conflicts. Intentional student/history deletion
and operational clear still delete the receipt; this does not add permanent
idempotency tombstones. Authorization remains with the existing API dependencies
and service-only SQL grants.

Known SQL conflicts become HTTP 409, which the existing browser treats as a
rejection. Unknown provider failures retain server-error behavior. This matters
because the browser's current unknown-outcome recovery searches history by
operation ID. Its broader receipt lifetime, identity and refresh ownership still
belongs to pending FSH2-02; this PR does not claim to finish that frontend workflow.

One forward migration adds V40 at 135/head `20260908133504`. Full V21 readiness
must succeed before V20/V19/V18 return their historical V39/V38/V37 tuples. All
134 earlier migrations remain byte-identical. The current backend requires V21;
older rank RPC interfaces remain usable during a database-first rollout. The old
backend's API shortcut remains until that backend is replaced. A merge alone does
not deploy either application or apply hosted SQL.

The release tool keeps historical catalogs/readiness fixed and treats V39 as a
separate predecessor. V40 checks its own catalog, release definitions and direct
rank metadata. It observes all promotion FKs so a new FK cannot quietly turn
immutable receipt evidence into mutable references. The staging fingerprint must
match the complete current tuple before production apply, not only its syntax.
Human-only production apply and existing approval/restore gates remain intact.

Evidence completed locally:

- The old snapshot trigger fails the rename/update regression; the correction
  passes. Real SQL also covers actor deletion and deletion of only one referenced
  rank, with original names/colors preserved in both directions.
- V3 and old V2 share exact receipts. Changed-command, foreign/invalid context,
  ended/paused, secondary-program and first-rank cases execute against PostgreSQL.
  Genuine V39 receipts survive the upgrade without fabricated evidence. Replaying
  an older Yellow command after Orange does not rewind rank or add audit history.
- Five concurrent cases observe the second session blocked by the first before
  allowing commit or rollback. They cover identical, changed, rolled-back,
  different-key and mixed V2/V3 calls, with one correct committed history/audit pair.
- Actual V38-to-V39 and V39-to-V40 dumps/restores pass. Both accept exactly the
  reviewed CHECK/default-ACL representation differences. Sources remain unchanged;
  restored copies preserve old rows and execute old/new commands after upgrade.
- Forced forward-transaction failure restores exact V39 definitions, columns,
  history and expectations. A pre-correction negative control confirmed that an
  added receipt FK escaped readiness; the corrected manifest rejects it through
  all four readiness interfaces. Sixteen independent raw metadata mutations are
  rejected, followed by an exact baseline check after rollback.
- The complete local suite passes 135 migrations and all 50 SQL contracts,
  including historical restore and concurrency checks. The backend passes 1,885
  tests and 5,447 subtests. The frontend passes 923 tests. Four mounted scenarios
  use the real API client to distinguish known 409 rejection from unknown 500
  recovery without repeating a write. These preserve existing frontend behavior.
- Release workflow checks pass 130 tests, including all 68 rollout tests. API
  contract, environment-example and support-privacy checks complete successfully.
  Frontend lint and production build pass. Focused API and mounted client checks
  pass again after the final actionable conflict-message correction. The final
  130-test workflow rerun includes the corrected whole-fingerprint equality check.

Test changes replace seven transition tests and two fake SQL implementations with
small RPC/response/error tests and actual database proof. The remaining belt tests
are preserved. Rollout expectations now use one independent 35-file golden list
and 31 named boundaries instead of repeated suffix arrays. A duplicate V26 test
was removed, while exact hashes, approval identity, invalid states, ordering and
source checks remain. A fixed independent digest and an actual reversed-order
negative strengthen the retained contracts. Test count is not the acceptance goal.

Independent plan, business SQL, forward migration, adapter, local tooling and
restore and final cross-system reviews have completed. Exact-head CI and guarded
merge are still required. Local restore evidence is not production backup evidence;
operator release/image mappings must be prepared for the actual authorized rollout.

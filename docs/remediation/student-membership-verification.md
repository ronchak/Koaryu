# Student membership preservation

Ordinary student profile edits resend the selected programs, overall joining date
and student status. The old private writer treated that as permission to reactivate
paused memberships and replace their individual joining dates. DM2-02 is the
underlying defect. The correction preserves retained membership status and exact
start dates, including NULL, while saving the requested student fields.

The new V39 migration changes the existing private writer. The public retained-rank
wrapper, V2 response wrapper, locks, tenant checks, audit transaction and guardian
rules retain their existing responsibilities. New or rejoined programs start active;
removed programs end as before. Preview updates follow the same preservation rule.
There is no historical data backfill.

An explicit change to the overall joining date retains its existing behavior while
the owner decides the long-term policy. A changed non-null date with a program
replacement propagates; explicit null preserves existing program dates; a date-only
write without program replacement changes only the student date. This PR does not
claim to solve stale full-form edits or unrelated concurrent changes.

## Behavioral proof

The revised preview tests include a case that composes the real
detail-to-form-to-submit helpers before applying the preview update. The others
exercise the preview model directly. Together they cover paused and active programs, distinct
and null dates, program reordering, new/removed programs, retained rank identities,
and the existing explicit-date behavior. All three fail against the old preview
implementation for the intended reasons and pass with the correction.

The existing SQL contract now exercises the actual V2 writer across nine ordinary
and explicit-date cases. It checks persisted and returned membership facts by stable
membership ID. It also checks adding/removing a program and forces the exact audit
failure to prove the student and membership changes roll back together. Existing
rank, tenant, guardian, creation and explicit-clear checks remain. The expanded
contract fails on V38 with `Retained membership facts changed for omitted.` and
passes against the corrected writer.

## Migration and release proof

The forward migration advances 133/V38/V19 to 134/V39/V20. The original 133 files
are unchanged. The affected writer, manifest helper and singleton expectations are
repinned to values derived from an actual PostgreSQL 17 replay. V20 contains the
full readiness check. V19 delegates to V20 and emits its historical tuple only when
the new state is exact; V18 continues through that compatibility path. No readiness
check is replaced by a constant success result.

A disposable transaction probe applied the full new migration and its history row.
A separate forced failure before the history insert rolled back to exact V38 with
no V20 function. Restoring the old writer or old expectation, or removing a required
billing history index, made V20 and both old consumers reject the changed state.
The deployed baseline's V19 Python validator and the V18 rollback validator accepted
the actual post-migration compatibility responses; the new validator rejected the
old tuples.

The permanent local verifier additionally creates a V38 source clone with synthetic
student data, takes a logical backup, restores into another new database and upgrades
only the restored copy. Twelve exact PostgreSQL 17 CHECK representation changes are
allowlisted: six billing definitions are replayed and six operational definitions
retain their already approved restored form. Only equivalent owner-default ACL
representations can be restored. Unknown changes stop before repair; no expected
hash is learned from the restored database. The check compares business rows before
and after restore and migration, then exercises a normal edit as service_role and
verifies retained membership facts and a new audit row. Both source databases must
remain V38. Only successfully created proof databases are cleaned up.

The rollout tool distinguishes exact V38 predecessor evidence from V39 final
evidence. Final certification requires new raw definitions, new semantic values,
V20 readiness and V19/V18 compatibility. Its shared predecessor/count map replaces
repeated state lists and packet-selection conditions while preserving all historical
boundaries. The V38 raw SQL and digest are unchanged after extracting one shared
query builder.

## Test changes and release boundary

Readiness tests consolidate old-version hybrids and duplicate count/head/manifest
cases into one coherent predecessor rejection and independent field mismatches.
Cache, concurrency, cancellation and provider-failure checks remain. One rollout
source-text test is replaced with actual query-routing and state-rejection coverage.
The shell wording test is replaced with syntax validation; real local PostgreSQL
execution covers the workflow. Three small Python tests reject unapproved restore
constraints, privilege changes and unsafe targets before repair.

This verification does not approve a production migration, certify a production
backup, repair historical membership data or deploy an application. A hosted release
needs fresh candidate-bound operator evidence and a human-run migration before the
new backend is deployed.

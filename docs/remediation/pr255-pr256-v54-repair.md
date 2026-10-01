# V54 missing legacy trigger repair

During the September 30, 2026 Pacific / October 1 UTC release attempt, V54's
production apply failed its final installed guard with `student_profile_facts_v54`
alongside the three expected pre-registration history failures. The release
coordinator verified complete rollback to V53, 148 migrations, head
`20260929152445`, with all 70 table hashes, history and eligible-fact hashes
unchanged. Production recovered to frontend/backend SHA
`55a652a6e4f368b07286181ffa8e2401f4b9c467` and exact V53, healthy on a temporary
recovery branch with automatic deployment disabled. Staging remained healthy at
`73f6dea576c1607e01f2e275003af1bb964fd754` and V55. These are coordinator-verified
historical incident facts.

The accepted production V53 catalog lacked both `public.set_student_is_minor()`
and `set_students_is_minor` on `public.students`. V54 created the missing function
but assumed the trigger existed. Its strict catalog fingerprint correctly refused
that result. V54 is deliberately repaired because its installed guard rolls back
before history registration; a later migration cannot run past that blocked step.

After the age function's ACL declarations and before the backfill, V54 creates the
exact `BEFORE INSERT OR UPDATE` row trigger only when its name is absent on
`public.students`. Existing triggers remain untouched, so disabled or wrongly
bound triggers still fail the strict final check. The same-studio source-lead
minor flag and ordinary update timestamp remain the only permitted retained-row
repair. V55 SQL is unchanged.

The V54 source-file and singleton source-packet identity assertions are updated
to the repaired bytes. All catalog, function, trigger, readiness and manifest
expected fact pins remain unchanged. Existing staging V54/V55 history must not
be rewritten or replayed. Reinspect its unchanged catalog and derive fresh
candidate source and packet identities for subsequent release gates.

Focused PostgreSQL 17.11 proofs reproduced the original refusal and rollback,
preserved the canonical and logical restore continuations, and passed missing
legacy-object fixtures through exact V54 and V55. Correct trigger identity was
retained; disabled and wrong-binding fixtures failed with exact rollback. All
fixtures used repository history and synthetic rows, with no production data.

Fresh exact-head CI, independent review and the existing inspection,
backup/restore and deployment gates remain required. These local results do not
establish hosted rollout completion.

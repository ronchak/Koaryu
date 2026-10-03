# Partial student updates preserve tags

Base: `c39e50d59a1bac9d7785c925cd4500cfa192852f`, after PR #153.

StudentUpdate already excludes omitted fields and the atomic SQL writer already preserves omitted tags. The intermediate payload normalizer added an empty tag list to every update lacking the key. A phone-only change could therefore erase existing tags.

The normalizer now applies defaults only for creation or an explicitly supplied tag value. Its internal `for_creation` flag describes both creation defaults and retains the previous boolean values at all CRUD, service and import callers. Explicit replacement, empty-list clearing and null clearing remain supported. No API shape, migration, membership or age-calculation change is included.

The new four-case regression runs the real StudentUpdate, normalizer and CRUD action against a student with populated tags. It checks returned/stored tags, one RPC, no program replacement and omission in the outgoing payload. Before the fix, the phone-only case failed with an empty list. An assertion added to the existing creation test protects creation defaults without adding another fixture.

Validation:

- Baseline `cd backend && venv/bin/python -m pytest tests/test_student_crud_actions.py tests/test_student_import_executor.py -q`: 9 passed.
- The added partial-update case failed before the fix, then the focused command passed 10 tests and all four subtests.
- `npm run check:api-types` passed with no generated changes.
- Independent review of source, callers, tests, SQL delegation and ledger changes received `GREEN LIGHT`.
- Full backend run: 1,847 passed, 5,480 subtests passed; the 50,000-row export timing fixture failed its existing 15-second budget. That unrelated case also failed in isolation and on an unchanged detached `c39e50d` worktree using the same interpreter. No timing limit or export code was changed. Exact-head CI remains required before merge.

The existing student CRUD tests cover distinct transaction routing, missing-record, photo-signing and rank-response behavior. They remain. The new regression fills a data-preservation gap; it does not duplicate the SQL implementation or replace tenant/transaction verification. DM2-02's retained membership reset remains pending and is not fixed by this change.

OPS2-01 and its supporting BT5-01 are addressed by this source change and regression. Reverting the patch needs no data rollback but restores the omitted-tags defect. No customer-data or hosted write is part of verification. Production deployment is separate from merge.

# Batch 05: backend dead code and fixtures

IDs: `OPS2-10`, `BT5-03`, `BT1-05`, `BT1-09`, `BT2-08`, `BT4-02`, `BT5-04`, `BT5-08`

Implementation: PR171; see [verification](../backend-maintenance-verification.md).

Prerequisites: none. Astra retains ownership of all financial, tenant, authorization, provider, concurrency, and atomic-write behavior. This batch may delete only proven dead interfaces and simplify test ownership without changing scenarios.

## Change

- Search repository and documented private operator entrypoints, then remove unused guardian and membership writers from `backend/app/services/student_import_guardians.py` and `backend/app/services/student_program_memberships.py`, plus helpers used exclusively by the removed methods. Treat the active executor and membership-action RPC adapters as read-only references. Remove only their exclusive tests and fixtures from `backend/tests/test_student_import_guardians.py` and `backend/tests/test_student_program_memberships.py`. Keep `normalize_program_ids_for_write`, `membership_write_payload`, live RPC ownership, and atomic tests.
- In `backend/tests/test_billing_autopay_lifecycle.py`, replace duplicate generic-operation rejection cases with one clearly named parameterized test. Rename the valid no-subscription disable case to say it disables without subscription rewiring. Keep named workflow lifecycle and zero-provider-mutation assertions.
- In `backend/tests/test_billing_autopay_lifecycle.py` and `backend/tests/test_billing_connect_lifecycle.py`, import standard-library and production names from their owners. Limit `backend/tests/billing_lifecycle_helpers.py` to intentional bases, fakes, and factories.
- Move only shared builders and fake classes used by `backend/tests/test_billing_enrollment_transitions.py`, `backend/tests/test_billing_enrollment_transition_reload.py`, and `backend/tests/test_billing_landing_runtime.py` into a narrowly named helper under `backend/tests/`. Remove the cross-test imports among those three modules; do not create a fixture framework.
- Delete the two-string factory-classification pseudo-test in `backend/tests/test_provider_request_boundary.py`. Retain lifespan, lane, scope, cleanup, and structural boundary tests.
- In `backend/tests/test_stripe_provider_rehearsal_collector.py`, remove the unused query fake. Format the existing collector and `backend/tests/test_stripe_provider_rehearsal_validator.py` fixtures; add a small named repeated-group builder only where values are exact duplicates. Preserve independent expected evidence and all negative matrices.

## Verify and deliver

```sh
rg -n "student_import_guardians|student_program_memberships|tests\.test_|Fake.*Query" backend docs scripts
(cd backend && venv/bin/python -m pytest tests/test_student_import_executor.py tests/test_student_membership_actions.py tests/test_billing_autopay_lifecycle.py tests/test_billing_connect_lifecycle.py tests/test_billing_enrollment_transitions.py tests/test_billing_enrollment_transition_reload.py tests/test_billing_landing_runtime.py tests/test_provider_request_boundary.py tests/test_stripe_provider_rehearsal_collector.py tests/test_stripe_provider_rehearsal_validator.py)
```

Also run each of the three enrollment files independently. Record before/after lines and removed, renamed, parameterized, and retained test cases. Start a short `codex/` branch from current `main`, use a fresh reviewer, and let root integrate. Require the exact-head `Release candidate gate` and guarded merge through `scripts/merge-release-pr.sh`.

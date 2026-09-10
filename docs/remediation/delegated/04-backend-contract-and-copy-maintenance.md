# Batch 04: backend contract and copy maintenance

IDs: `ACS1-03`, `OPS1-11`, `BT4-03`, `BT4-06`, `BT5-05`

Prerequisites: `ACS1-03` is documentation/schema-description only; current runtime payload and cursor semantics stay unchanged. `BT4-06` waits for Astra's `ACS1-04` upload implementation. `BT5-05` waits for Astra's `OPS1-09` selected-ID auth hydration. Hold those chunks until their prerequisites land; do not implement the Astra changes. `OPS1-11` and `BT4-03` may proceed independently.

## Change

- For `ACS1-03`, document the existing runtime detail with the typed 409 cursor-detail envelope in `backend/app/api/v1/endpoints/students.py` and `backend/app/schemas/student.py`, aligned with `backend/app/core/error_handlers.py`. Regenerate `frontend/src/types/generated/api-contracts.ts`. Preserve the runtime payload and existing decoder.
- Replace the shared oversized-export message in `backend/app/services/report_export_budget.py` with the truth that the synchronous limit was exceeded. Check all callers in `backend/app/api/v1/endpoints/reports.py`; retain status 413 and current limits.
- In `backend/tests/test_report_export_data_budget.py`, rename the handwritten source vocabulary inventory and test so they claim only what they inspect. Do not claim physical migration proof or add a schema parser.
- After `ACS1-04`, change only the identity assertions in `backend/tests/test_request_body_limits.py` to assert bytes, termination, disconnect, and downstream response. Valid reconstructed messages must pass; byte loss, malformed termination, and over-limit bodies must fail.
- After `OPS1-09`, update `backend/tests/test_staff_archive_contract.py` to seed the selected Auth users and assert email, name, and sign-in hydration. Add one separately named provider-failure case. Do not alter `backend/app/services/report_export_data.py` unless Astra's landed adapter requires a test fixture adjustment.
- Do not alter roster cursor semantics, tenant checks, production authorization, export limits, endpoint inputs, migration verification, or real user data.

## Verify and deliver

```sh
(cd backend && venv/bin/python -m pytest tests/test_api_contract_schemas.py tests/test_api_type_generation.py tests/test_report_export_contract.py tests/test_report_export_data_budget.py tests/test_request_body_limits.py tests/test_staff_archive_contract.py)
npm run check:api-types
rg -n "cursor|required|413|synchronous|source vocabulary|message is|auth" backend/app backend/tests/test_report_export_data_budget.py backend/tests/test_request_body_limits.py backend/tests/test_staff_archive_contract.py
```

Run only the files for chunks whose prerequisites have landed. Record before/after line counts and each changed test name. Start a short `codex/` branch from current `main`, use a fresh reviewer, and have root coordinate integration. Require the exact-head `Release candidate gate` and guarded merge through `scripts/merge-release-pr.sh`.

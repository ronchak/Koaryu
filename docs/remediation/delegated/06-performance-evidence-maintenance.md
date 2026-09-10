# Batch 06: performance evidence maintenance

IDs: `CTA1-09`, `CTA2-01`, `BT1-07`, `BT3-07`, `BT4-01`, `FT2-09`

Prerequisites: `BT3-07` waits for Astra's `OPS1-06` legacy reference retirement. Hold that chunk. The other work may proceed. Use current code and the private operator entrypoint as authority, but do not call providers or capture production evidence.

## Change

- In `frontend/scripts/capture-dashboard-performance.mjs`, add one shared privacy-safe mapping for the workspace request, used by both outer and browser extraction. Update `frontend/README.md`. Never retain raw URLs, IDs, or query values.
- In `performance/dashboard-summary-budget.json`, `scripts/check-performance-regression.mjs`, `backend/tests/performance/dashboard_summary_fixture.py`, and `backend/tests/performance/test_dashboard_summary_fixture.py`, remove the unreachable slow-stage count from pass/fail authority and retain it as descriptive evidence. Label fixture-process memory honestly. Keep response, query, row, byte, and elapsed-time gates.
- In `backend/tests/test_report_export_spool.py`, remove the cross-platform RSS delta gate unless an existing normalized measurement can make the claim true. Keep spool/output, Python-allocation, row, and query guards. Do not add a profiler.
- After `OPS1-06`, identify `backend/tests/test_dashboard_summary_service.py` as oracle coverage and remove only legacy implementation-specific query count/shape assertions duplicated by `backend/tests/test_dashboard_summary_fact_adapter.py`. Keep billing omission, tenant exclusion, completeness, and active-path query bounds.
- Rename the diagnostic in `frontend/tests/workflow-stabilization-mounted.test.mjs` and `frontend/tests/helpers/store-browser-harness.mjs` to fixture workspace/controller readiness. Do not call it route performance; preserve request selection and identity assertions.

## Verify and deliver

```sh
node --test scripts/check-performance-regression.test.mjs
(cd backend && venv/bin/python -m pytest tests/performance/test_dashboard_summary_fixture.py tests/test_report_export_spool.py tests/test_dashboard_summary_service.py tests/test_dashboard_summary_fact_adapter.py)
(cd frontend && node --experimental-strip-types --test tests/performance-capture-policy.test.mjs tests/performance-evidence.test.mjs tests/workflow-stabilization-mounted.test.mjs)
```

Include an all-slow synthetic case proving the retained regression rule can fail. Record before/after lines and test cases. Start a short `codex/` branch from current `main`, use a fresh reviewer, and let root coordinate integration. Require the exact-head `Release candidate gate` and `scripts/merge-release-pr.sh`. Do not tune to CI speed, rewrite historical evidence, weaken identity checks, or perform deployment/provider work.

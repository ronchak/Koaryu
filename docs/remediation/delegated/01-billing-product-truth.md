# Batch 01: billing product truth

IDs: `CTA1-01`, `BB2-10`, `DOC1-01`, `FT1-05`, `FR1-09`

Prerequisites: none. Astra owns the workflow catalog and all billing capability, role, grant, provider, and money semantics. Treat `backend/app/services/billing_workflow_catalog.py` as read-only authority.

## Change

- Update `docs/billing-boundary.md` to replace the stale active "Contract Only" matrix with a short explanation of five separate facts: implemented workflow, allowed staff role, environment switch, exact-studio grant, and commercial availability. Link `docs/billing-workflow-catalog.md`; do not copy its matrix.
- Align `README.md`, `frontend/src/app/(dashboard)/help/get-started/page.tsx`, `frontend/src/app/about/page.tsx`, and `frontend/src/app/(dashboard)/subscription-required/page.tsx`. Do not claim any studio currently has a live grant. Remove the false statement that production rejects `LIVE_BILLING_ENABLED=true`.
- Update only stale copy assertions in `frontend/tests/marketing-content-contract.test.mjs`, `frontend/tests/marketing-editorial-routes.test.mjs`, `frontend/tests/marketing-public-route-contract.test.mjs`, and `frontend/tests/billing-workflow-capabilities.test.mjs`. Keep rendered route, role denial, capability, and unconditional-promise checks. Delete exact-phrase and source-shape locks rather than replacing each grep.
- Do not change `backend/app/services/billing_workflow_catalog.py`, `backend/.env.render.example`, `render.yaml`, generated contracts, authorization, tenant checks, idempotency, recovery, prices, provider calls, or grants.

Retained behavior: Instructor denial remains non-disclosing; existing role and capability gates remain exact; preview behavior and every payment safety check remain unchanged.

## Verify and deliver

```sh
rg -n "Contract Only|LIVE_BILLING_ENABLED=true|currently unsupported|not currently available" README.md docs/billing-boundary.md frontend/src/app frontend/tests
(cd frontend && node --experimental-strip-types --test tests/marketing-content-contract.test.mjs tests/marketing-editorial-routes.test.mjs tests/marketing-public-route-contract.test.mjs tests/billing-workflow-capabilities.test.mjs)
(cd frontend && npm run lint -- 'src/app/(dashboard)/help/get-started/page.tsx' src/app/about/page.tsx 'src/app/(dashboard)/subscription-required/page.tsx')
```

Before editing and after verification, record `wc -l` for every touched file plus the test cases removed, renamed, or retained. Start a short `codex/` branch from current `main`. Use a fresh reviewer. Root coordinates integration. The PR must pass the exact-head `Release candidate gate`; merge only through `scripts/merge-release-pr.sh` with recorded head and base SHAs.

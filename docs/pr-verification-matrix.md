# PR Verification Matrix

Use this matrix to pick the smallest meaningful checks for a PR. Prefer targeted checks first, then broaden only when the changed surface crosses package boundaries or touches runtime, auth, billing, support, or database contracts.

## Core Rules

- Record every command you ran in the PR body.
- If a command cannot run locally, record the blocker and avoid substituting a weaker check as proof.
- Run `git diff --check` before publishing any PR.
- Run API-contract checks whenever backend response schemas, endpoints, or generated frontend types might change.
- Do not run linked Supabase commands unless the PR explicitly intends to inspect linked project state.

## Matrix

| Changed Area | Minimum Check | Add When Relevant |
| --- | --- | --- |
| Root scripts or repo commands | `git diff --check` and the script's syntax check when available | Exercise the script against a disposable/local target |
| `frontend/src/app/**` route/page | `cd frontend && npm run lint -- <paths>` | `cd frontend && npm run build` for routing, auth, middleware, proxy, or env-sensitive changes |
| `frontend/src/components/**` UI | `cd frontend && npm run lint -- <paths>` | `cd frontend && npm run test` when changing state models or shared behavior |
| `frontend/src/lib/**` helper/store | `cd frontend && npm run test` or a focused Node test | Add/update `frontend/tests/*.test.mjs` for non-trivial data shaping |
| `frontend/src/app/api/**` proxy/route handler | `cd frontend && npm run lint -- <paths>` | `cd frontend && npm run build`; review server-only secret handling |
| Dashboard, billing, settings, import, or auth flows | Focused frontend tests plus lint | Browser smoke or Playwright when the change affects navigation or user-visible workflow |
| `backend/app/api/v1/endpoints/**` | `cd backend && venv/bin/python -m pytest <nearby endpoint tests>` | `npm run check:api-types` when response/request contracts may change |
| `backend/app/services/**` | `cd backend && venv/bin/python -m pytest <nearby service tests>` | Broader backend suite for shared service dependencies |
| `backend/app/schemas/**` | Focused schema tests | `npm run check:api-types`; regenerate with `npm run generate:api-types` when needed |
| Stripe billing or webhooks | Relevant `backend/tests/test_billing_*.py` and `backend/tests/test_webhook_service.py` | `npm run dev:stripe-connect-smoke` only against a confirmed disposable/local target |
| Support/account-deletion behavior | `PYTHONPATH=backend backend/venv/bin/python -m pytest backend/tests/test_support_service.py backend/tests/test_internal_endpoints.py` | `scripts/verify-supabase-account-support.sh` against local Supabase |
| Supabase migrations/RLS/RPCs | `supabase db lint --linked --fail-on error` when intentionally checking linked lint | Relevant SQL in `supabase/verification/`; broad `scripts/verify-supabase-contracts.sh` after local reset |
| Docs-only | `git diff --check` | Run linked commands only if docs claim exact live output |
| Generated API contracts | `npm run check:api-types` | `npm run generate:api-types` and commit generated changes when drift is intentional |

## PR Body Checklist

- Intent: what risk or capability this PR targets.
- Purpose: why this change belongs now.
- Goal: what future agents or maintainers can rely on after merge.
- Validation: exact commands and their outcomes.
- Gaps: commands not run, blocked checks, linked/live state intentionally avoided.

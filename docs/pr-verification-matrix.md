# PR Verification Matrix

Use this matrix to pick the smallest meaningful checks for a PR. Prefer targeted checks first, then broaden only when the changed surface crosses package boundaries or touches runtime, auth, billing, support, or database contracts.

## Core Rules

- Record every command you ran in the PR body.
- If a command cannot run locally, record the blocker and avoid substituting a weaker check as proof.
- Run `git diff --check` before publishing any PR.
- Run API-contract checks whenever backend response schemas, endpoints, or generated frontend types might change.
- Apply pending migrations before local database checks so verification cannot pass against stale schema state.
- Do not run linked Supabase commands unless the PR explicitly intends a release inspection and the linked project already has the migrations under review.

## Matrix

| Changed Area | Minimum Check | Add When Relevant |
| --- | --- | --- |
| Root scripts or repo commands | `git diff --check` and the script's syntax check when available | Exercise the script against a disposable/local target |
| `frontend/src/app/**` route/page | `cd frontend && npm run lint -- <paths>` | `cd frontend && npm run build` for routing, auth, middleware, proxy, or env-sensitive changes |
| `frontend/src/components/**` UI | `cd frontend && npm run lint -- <paths>` | `cd frontend && npm run test` when changing state models or shared behavior |
| `frontend/src/lib/**` helper/store | `cd frontend && npm run lint -- <paths>` plus `cd frontend && npm run test` or a focused Node test | Add/update `frontend/tests/*.test.mjs` for non-trivial data shaping |
| `frontend/src/app/api/**` proxy/route handler | `cd frontend && npm run lint -- <paths>` | `cd frontend && npm run build`; review server-only secret handling |
| Dashboard, billing, settings, import, or auth flows | Focused frontend tests plus lint on every touched frontend file | `cd frontend && npm run build` for auth, routing, proxy, runtime, or environment-sensitive changes; add a browser smoke or Playwright flow for user-visible navigation/workflow changes |
| `backend/app/api/v1/endpoints/**` | `cd backend && venv/bin/python -m pytest <nearby endpoint tests>` | `npm run check:api-types` when response/request contracts may change |
| `backend/app/services/**` | `cd backend && venv/bin/python -m pytest <nearby service tests>` | Broader backend suite for shared service dependencies |
| `backend/app/schemas/**` | Focused schema tests | `npm run check:api-types`; regenerate with `npm run generate:api-types` when needed |
| Backend auth, security, dependencies, or middleware | `PYTHONPATH=backend backend/venv/bin/python -m pytest backend/tests/test_security.py backend/tests/test_auth_deps.py backend/tests/test_config.py` | Run the full backend suite for shared auth/runtime changes; run API-contract checks when the HTTP surface changes |
| Deployment/runtime/config (`render.yaml`, `backend/Procfile`, runtime files, env examples, `backend/app/core/config.py`) | Run `backend/tests/test_config.py` and `backend/tests/test_health_endpoints.py`; statically confirm start commands, runtime versions, and documented variables stay aligned | Run the frontend build when frontend environment/runtime behavior can change; perform a production-config startup smoke only with non-secret test values |
| Stripe billing or webhooks | Relevant `backend/tests/test_billing_*.py` and `backend/tests/test_webhook_service.py` | Run `npm run dev:stripe-connect-smoke -- --confirm-stateful-target --account acct_...` only against a confirmed disposable/local target |
| Support/account-deletion behavior | `PYTHONPATH=backend backend/venv/bin/python -m pytest backend/tests/test_account_service.py backend/tests/test_staff_service_account_deletion.py backend/tests/test_support_service.py backend/tests/test_internal_endpoints.py` | Apply pending local migrations, then run `scripts/verify-supabase-account-support.sh` against local Supabase |
| Supabase migrations/RLS/RPCs | `supabase migration up --local`, then `supabase db lint --local --fail-on error` plus the relevant SQL in `supabase/verification/` against the same local database | Run broad `scripts/verify-supabase-contracts.sh` after migrations; use `supabase db reset --local` only for a confirmed disposable database; linked lint/contracts require explicit release-inspection intent and applied linked migrations |
| Dependency manifests or lockfiles | Reinstall from the lock/requirements files and run the affected package tests | Frontend: `npm audit --omit=dev` and `npm run build`; backend: `python -m pip check` and the broader pytest suite for shared dependency changes |
| Docs-only | `git diff --check`, validate referenced paths, and use non-mutating `--help`/syntax checks for documented commands | Do not run linked/live commands solely to validate documentation without explicit authorization |
| Generated API contracts | `npm run check:api-types` | `npm run generate:api-types` and commit generated changes when drift is intentional |

## PR Body Checklist

- Intent: what risk or capability this PR targets.
- Purpose: why this change belongs now.
- Goal: what future agents or maintainers can rely on after merge.
- Validation: exact commands and their outcomes.
- Gaps: commands not run, blocked checks, linked/live state intentionally avoided.

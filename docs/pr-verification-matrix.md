# PR Verification Matrix

Use this matrix to pick the smallest meaningful checks for a PR. Prefer targeted checks first, then broaden only when the changed surface crosses package boundaries or touches runtime, auth, billing, support, or database contracts.

## Core Rules

- Record every command you ran in the PR body.
- If a command cannot run locally, record the blocker and avoid substituting a weaker check as proof.
- Run `git diff --check` before publishing any PR.
- Run API-contract checks whenever backend response schemas, endpoints, or generated frontend types might change.
- Use `supabase migration up --local` for migrations not yet applied locally. If a changed migration may already be recorded in local history, first confirm the database is disposable and run `supabase db reset --local` so checks exercise the current file contents rather than a stale applied definition.
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
| Deployment/runtime/config (`render.yaml`, `backend/Procfile`, runtime files, env examples, `backend/app/core/config.py`) | `npm run check:env-examples` plus `PYTHONPATH=backend backend/venv/bin/python -m pytest backend/tests/test_config.py backend/tests/test_health_endpoints.py`; statically confirm start commands, runtime versions, and documented variables stay aligned | Run the frontend build when frontend environment/runtime behavior can change; perform a production-config startup smoke only with non-secret test values |
| Stripe billing or webhooks | Relevant `backend/tests/test_billing_*.py` and `backend/tests/test_webhook_service.py` | Run `npm run dev:stripe-connect-smoke -- --confirm-stateful-target --account acct_...` only against a confirmed disposable/local target |
| Support/account-deletion behavior | `npm run audit:support-privacy`, `supabase migration up --local`, `supabase db lint --local --fail-on error`, `SUPABASE_DB_TARGET=local scripts/verify-supabase-account-support.sh`, and `PYTHONPATH=backend backend/venv/bin/python -m pytest backend/tests/test_account_service.py backend/tests/test_staff_service_account_deletion.py backend/tests/test_support_service.py backend/tests/test_internal_endpoints.py` | If a changed migration may already be applied locally, reset only a confirmed disposable local database before rerunning the lint and smoke checks |
| Supabase migrations/RLS/RPCs | Apply unapplied files with `supabase migration up --local`, or reset a confirmed disposable database with `supabase db reset --local` when changed files may already be in local history; then run `supabase db lint --local --fail-on error` plus the relevant local verification SQL and `SUPABASE_DB_TARGET=local scripts/verify-supabase-rls.sh` for table-policy or tenant-isolation changes | Run broad `SUPABASE_DB_TARGET=local scripts/verify-supabase-contracts.sh` after migrations; linked lint/contracts require explicit release-inspection intent and applied linked migrations |
| Dependency manifests or lockfiles | Reinstall from the lock/requirements files and run the affected package tests | Frontend: `cd frontend && npm audit --omit=dev && npm run build`; backend: `backend/venv/bin/python -m pip check` and the broader pytest suite for shared dependency changes |
| Docs-only | `git diff --check`, validate referenced paths, and use non-mutating `--help`/syntax checks for documented commands | Do not run linked/live commands solely to validate documentation without explicit authorization |
| Generated API contracts | `npm run check:api-types` | `npm run generate:api-types` and commit generated changes when drift is intentional |

## PR Body Checklist

- Intent: what risk or capability this PR targets.
- Purpose: why this change belongs now.
- Goal: what future agents or maintainers can rely on after merge.
- Validation: exact commands and their outcomes.
- Gaps: commands not run, blocked checks, linked/live state intentionally avoided.

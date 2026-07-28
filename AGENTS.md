# Koaryu Agent Guide

This repo is a small monorepo with distinct workflows by area:

- `frontend/`: Next.js App Router app on port `4000`
- `backend/`: FastAPI app on port `8001`
- `supabase/`: SQL migrations and verification scripts
- `docs/`: deployment and operations runbooks
- `scripts/`: shared local helpers

Start here for repo-wide rules, then prefer the nearest package-level `AGENTS.md` for task-specific instructions.

## Instruction Precedence

- Follow the closest `AGENTS.md` to the files you are editing.
- When instructions differ, use the more specific file over the repo root file.
- Treat this root file as shared policy, not the place for package-level implementation detail.

## Working Style

- Make the smallest safe change that solves the problem.
- Preserve existing architecture and naming patterns unless the task explicitly asks for a refactor.
- Do not edit generated or build-output folders such as `frontend/.next/`, `backend/.pytest_cache/`, or `supabase/.temp/`.
- Keep secrets out of code, tests, logs, and docs. Never commit real credential values from `.env` files.
- Avoid destructive data or git operations unless the user explicitly asks for them.

## Repo Commands

- Start both apps: `npm run dev:up`
- Stop both apps: `npm run dev:down`
- Basic local health check: `npm run dev:health`
- Check example environment files: `npm run check:env-examples`
- Verify a fully assembled staging environment is isolated: `npm run verify:staging-isolation`
- Audit support triage privacy docs/scripts: `npm run audit:support-privacy`
- Exercise synthetic encrypted backup recovery: `npm run test:backup-recovery`
- Regenerate frontend API contract types: `npm run generate:api-types`
- Check generated frontend API contract types: `npm run check:api-types`
- Check candidate-wide workflow coverage: `npm run check:release-workflow`
- Generate or verify the guarded studio-comp database rollout packet: `node scripts/studio-comp-migration-rollout.mjs --mode packet --candidate-sha <full-sha>`
- Verify a pinned deployed Render/Vercel pair reports one exact SHA: `npm run verify:deployed-release -- --environment <staging|production> --expected-sha <full-sha> --frontend-origin <pinned-origin> --backend-api <pinned-api-v1>`
- Capture privacy-safe dashboard timing evidence only after exact-SHA verification: `npm run capture:dashboard-performance -- <same release args> --storage-state <absolute-private-path>`
- Verify all migrations and contract SQL on ephemeral PostgreSQL 17: `npm run check:supabase-contracts-local`
- Stripe Connect smoke check: `npm run dev:stripe-connect-smoke`

## Monorepo Rules

- Put cross-cutting guidance here; put stack-specific guidance in package `AGENTS.md` files.
- When a package has its own `AGENTS.md`, follow the closest file for commands, constraints, and verification.
- If a task spans multiple areas, verify each touched area with the smallest relevant checks instead of always running the full repo.

## Area Map

- `frontend/src/app/`: routes, layouts, route handlers, middleware-adjacent app behavior
- `frontend/src/components/`: reusable UI and dashboard/public-page components
- `frontend/src/lib/`: client/server helpers, stores, constants, data shaping
- `frontend/tests/`: Node-based frontend tests
- `backend/app/api/v1/endpoints/`: HTTP surface
- `backend/app/services/`: business logic and orchestration
- `backend/app/schemas/`: request/response and internal data contracts
- `supabase/migrations/`: schema, RLS, RPC, trigger, and index history
- `supabase/verification/`: SQL smoke checks and contract checks
- `docs/`: runbooks and release/operations documentation

## Verification Strategy

- For frontend-only changes, prefer `cd frontend && npm run lint -- <paths>` and other narrow checks before full builds.
- For backend-only changes, prefer `cd backend && venv/bin/python -m pytest <tests>`.
- For developing and reviewing contract SQL, default to `npm run check:supabase-contracts-local`. It applies the complete migration chain and every file under `supabase/verification/` to an ephemeral PostgreSQL 17 cluster without Docker, network access, a cloud project, or `.env` files.
- For database changes, apply files not yet in local history with `supabase migration up --local`. If a changed migration may already be applied locally, first confirm the database is disposable and use `supabase db reset --local`; then run `supabase db lint --local --fail-on error` and force local helpers with `SUPABASE_DB_TARGET=local`. Use linked checks only for an explicitly intended release inspection after the linked project has the migrations.
- For release-shaped or cross-cutting changes, combine the relevant frontend, backend, and Supabase checks.
- Every release-candidate PR must also receive the exact-head `Release candidate gate`; use `scripts/merge-release-pr.sh` with recorded head and base SHAs after the strict `main` ruleset is active.
- For backend schema or response-contract changes, run `npm run check:api-types` and regenerate with `npm run generate:api-types` if needed.

Database verification targets are:

| Target | Use |
| --- | --- |
| local ephemeral cluster | Default for developing and reviewing contract SQL. |
| `koaryu-staging` (`nxgsektqsgrtyfhawxbc`) | Cloud verification only when Supabase-specific behavior matters. Active as of 2026-08-15; the backend follows the `staging` branch, not `main`. |
| production (`mimguepumzsgmcaycdsh`) | Read-only inspection only, except the two guarded operations below. Never run contract or migration SQL against it. |

Contract files can create functions and triggers on real tables inside a transaction. A later `ROLLBACK` does not make production an acceptable target: never point contract or migration execution at production.

Exactly two operations may write to production, both human-authorized and both outside the contract/migration-SQL prohibition above:

1. **The guarded rollout tool's production apply** (`scripts/studio-comp-migration-rollout.mjs --target production --mode apply`), which a human runs from an interactive terminal.
2. **The pre-migration backup role** — a temporary `CREATE ROLE` / `ALTER ROLE` / `DROP ROLE` used to take a verified `pg_dump` before an irreversible migration, because the project has no managed restore path.

Nothing else. Both are described in `docs/cutover-gates.md`.

## Safety Boundaries

- Do not rewrite old Supabase migrations unless the task explicitly calls for migration repair. Add a new migration instead.
- Do not change deployment secrets, Vercel config, Render config, or linked Supabase project state unless the task explicitly asks for it.
- Declare every hosted service in its provider manifest (`render.yaml`, `frontend/vercel.json`) and in `docs/services.md`. A service configured only in a provider dashboard drifts silently and stops serving without anything in the repository noticing.
- Do not expose raw support-ticket data in broad summaries. Follow the privacy rules in `docs/support-triage.md`.
- Assume the worktree may already contain unrelated user changes. Do not revert or “clean up” edits you did not make.

## Done Checklist

- Update the smallest relevant `AGENTS.md` guidance when a recurring workflow or command changes.
- Verify the touched area with targeted checks first, then broader checks only when the change surface warrants it.
- If docs and code would drift, update the doc in the same change.

## Important References

- **Hosted services inventory: `docs/services.md`** — every Vercel, Render, Supabase
  and Stripe environment, which copy is production, and where each secret lives.
  Read it before reasoning about any deployed environment, and update it in the
  same change whenever a hosted service is added, renamed, or removed. A hosted
  service that is not listed there does not exist.
- Repo overview and local setup: `README.md`
- Frontend app guidance: `frontend/AGENTS.md`
- Backend app guidance: `backend/AGENTS.md`
- Database guidance: `supabase/AGENTS.md`
- **Release cutover gates and traps: `docs/cutover-gates.md`** — read before merging a
  release candidate, migrating a hosted database, or promoting a frontend. Covers what
  blocks a cutover and what silently breaks one.
- Render deployment runbook: `docs/render-backend-deployment.md`
- Owner-run operator tools: `docs/operator-tooling.md`
- Support triage/privacy runbook: `docs/support-triage.md`
- PR verification matrix: `docs/pr-verification-matrix.md`

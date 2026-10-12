# Koaryu agent guide

Koaryu is a monorepo: `frontend/` is Next.js on port 4000, `backend/` is
FastAPI on port 8001, and `supabase/` holds migrations and SQL checks. Read
the nearest package `AGENTS.md` for implementation details.

## Working rules

- Make the smallest change that solves the request. Preserve existing patterns.
- Leave unrelated changes and generated/build output alone.
- Keep credentials, customer data, dumps and private operator evidence outside Git.
- Update documentation when behavior or a recurring command changes.
- Add migrations rather than rewriting applied history, unless migration repair is
  explicitly requested.

## Verification and review

Test the behavior that changed. Use [the verification matrix](docs/pr-verification-matrix.md)
to choose checks; it applies across packages.

- Copy, documentation and ordinary UI edits need focused checks, not database tests.
- For application logic, run nearby tests and check the affected user flow. Add a
  build or broader suite only for shared behavior, routing, auth or runtime changes.
- For database behavior, check setup first, then affected SQL and relevant
  permissions, tenant boundaries, payment/retry rules and races. Use a disposable
  local database. Historical upgrade/restore sweeps are for changes that affect
  those paths, not routine application edits.
- Run an expensive suite once. Use its CI result instead of also running it locally
  unless there is a specific environment difference or failure to investigate.
  Reuse successful results when their relevant code, dependencies and setup match;
  after a fix, rerun the affected checks.
- Use one focused independent review for material security, financial, data-loss,
  migration or verification-rule changes. Routine edits need a proportionate diff
  review. Add review rounds or agents only for an unresolved risk or an owner request.
- Report what changed, checks and results, and any material gap in a few lines.
  Stop after sufficient evidence and resolved material findings. Optional cleanup
  and style suggestions can be follow-ups.

The actual required GitHub checks still control merging. Do not bypass them or
label unrun checks as passed. See [current CI enforcement](docs/release-candidate-controls.md#current-ci-and-the-transition)
for the documentation-only database fast path and full-suite fallback. While waiting, use a bounded watcher
instead of repeated reasoning or review; report a new result, failure or blocker.
If the client requires updates, keep them brief.

## Local commands

- Start/stop/health: `npm run dev:up`, `npm run dev:down`, `npm run dev:health`.
- Frontend: `cd frontend && npm run lint -- <paths>` and focused tests.
- Backend: `cd backend && venv/bin/python -m pytest <tests>`.
- Changed API contracts: `npm run check:api-types`; regenerate when needed.
- Changed release controls: `npm run check:release-workflow`.
- Changed release declarations: `npm run check:release-attestation`.
- Full database suite when needed: `npm run check:supabase-contracts-local`.

## Hosted work and production safety

Read [services](docs/services.md) before hosted work, and
[cutover gates](docs/cutover-gates.md) before merging a release, migrating or deploying.
For Koaryu release, backup, restore or credential work, also read the private
`RELEASE-RUNBOOK.md` and `AUTHENTICATION.md` under
`/Users/openclaw/.config/koaryu/operator/`. Database work also uses that directory's
`DATABASE-VERIFICATION-POLICY.md`. Explicitly source `release-env.sh` with tracing
disabled before release CLI work. Re-derive live state and the exact candidate;
historical handoffs do not authorize a new release.

- Local disposable databases are the test target. Staging checks are for an
  explicitly intended inspection or Supabase-specific behavior.
- Never run contract SQL on production, even inside a rollback transaction.
  Production database writes are limited to the owner-authorized guarded rollout
  and its temporary pre-migration backup role.
- Production migration/deployment authority belongs to the explicitly authorized
  named coordinator, never subagents. Billing activation and customer sending need
  their own authorization.
- Keep the guarded merge and exact candidate checks enabled.
- Keep production auto-deploy off.
- Before a production migration, require a fresh backup with a verified disposable
  restore, inspection/dry-run evidence and the tool's exact confirmation. Announce
  each release action and verify it; pause 30 seconds before each production apply.
- Build the frontend for production using production settings. Never promote a
  preview build. Verify the final frontend/backend pair serves the intended SHA.
- Do not change hosted configuration, secrets or linked-project state unless asked.
  Declare services in their provider manifests and `docs/services.md`.

Support privacy rules are in [support triage](docs/support-triage.md). Stack setup
is in each package guide and `README.md`; operator mechanics are in
[operator tooling](docs/operator-tooling.md).

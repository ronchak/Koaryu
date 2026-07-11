# Supabase Agent Guide

This directory holds Koaryu database migrations and verification SQL.

Use this file for work under `supabase/`. Fall back to the repo root `AGENTS.md` for shared rules.

## Directory Layout

- `migrations/`: ordered schema and policy changes
- `verification/`: smoke checks and contract verification SQL
- `.temp/`: local CLI state and generated metadata; do not edit manually

## Migration Rules

- Add new migrations instead of rewriting old applied migrations.
- Use timestamped migration filenames that match the existing convention.
- Keep schema, RLS, RPC, trigger, and index changes in migrations, not ad hoc notes.
- When changing behavior that already has a verification SQL file, update or add the matching verification artifact.
- Keep migration intent narrow and readable; split unrelated concerns into separate migrations when practical.

## Common Tasks

- Schema/table change: add a new migration and check whether related RLS, indexes, and backend assumptions also need updates.
- RPC or trigger change: update the migration and add or revise the closest verification SQL smoke test.
- Support/account change: follow the privacy constraints from `docs/support-triage.md` and include the focused account/support verification script in sign-off.
- Belt ladder sync RPC change: the historical `sync_belt_ladder_ranks` migrations include several repair replacements. Treat `supabase/verification/belt_ladder_sync_smoke.sql` and the RPC privilege checks in `supabase/verification/account_support_controls.sql` as the current contract, and update them with any future RPC change instead of relying on migration history alone.

## Safety Boundaries

- Treat linked-project commands as potentially real infrastructure actions. Confirm the command is read-only or explicitly intended before running it.
- Never expose raw support-ticket details, full requester emails, query-string page URLs, user agents, browser context, or student-record content in summaries.
- Do not edit `.temp/` files by hand.

## Verification

- Before verifying a migration, apply files not yet in local history with `supabase migration up --local`. If a changed file may already be applied locally, first confirm the database is disposable and use `supabase db reset --local`; then lint with `supabase db lint --local --fail-on error`.
- Run the focused RLS/security contract checks when changing table policies or tenant isolation: `SUPABASE_DB_TARGET=local scripts/verify-supabase-rls.sh`, or use `SUPABASE_DB_TARGET=linked SUPABASE_DB_URL='<private URL>' scripts/verify-supabase-rls.sh` only for an explicitly intended release inspection after linked migrations are present.
- Run the focused account/support contract check when relevant: `SUPABASE_DB_TARGET=local scripts/verify-supabase-account-support.sh`, or provide the private linked database URL when intentionally checking a linked project.
- Run the broad contract suite for release-shaped database changes: `SUPABASE_DB_TARGET=local scripts/verify-supabase-contracts.sh` after local migrations, or set `SUPABASE_DB_TARGET=linked` plus a private `SUPABASE_DB_URL` after the linked project has received the new migrations.
- The verification helpers use `psql` with `ON_ERROR_STOP=1` so multi-statement transactional contracts are not routed through the Supabase CLI prepared-statement query path.
- Review and run the relevant SQL in `supabase/verification/` when changing RLS, RPCs, billing, support, or belt-ladder behavior.
- Treat a local reset as destructive too: use `supabase db reset --local` only against a confirmed disposable local database. Run linked lint/contracts only for an explicitly intended release inspection after the linked migrations are present.

## Done Checklist

- Add a new migration rather than mutating history.
- Update the nearest verification SQL or helper when behavior changes.
- Confirm linked-project commands are appropriate for the environment before running them.

## Important References

- Support/privacy rules: `docs/support-triage.md`
- Backend deployment and release checks: `docs/render-backend-deployment.md`
- Repo overview: `README.md`

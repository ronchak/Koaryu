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

- Lint database changes: `supabase db lint --linked --fail-on error`
- Run the focused account/support contract check when relevant: `scripts/verify-supabase-account-support.sh`
- Run the broad contract suite for release-shaped database changes: `scripts/verify-supabase-contracts.sh` for linked projects, or `SUPABASE_DB_TARGET=local scripts/verify-supabase-contracts.sh` after a local reset when the linked project intentionally has not received the new migrations yet.
- Review and run the relevant SQL in `supabase/verification/` when changing RLS, RPCs, billing, support, or belt-ladder behavior.

## Done Checklist

- Add a new migration rather than mutating history.
- Update the nearest verification SQL or helper when behavior changes.
- Confirm linked-project commands are appropriate for the environment before running them.

## Important References

- Support/privacy rules: `docs/support-triage.md`
- Backend deployment and release checks: `docs/render-backend-deployment.md`
- Repo overview: `README.md`

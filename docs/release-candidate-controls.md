# Release candidate controls

## Current CI and the transition

The workflow runs for every PR without trigger path filters. Its exact-head
`Release candidate gate` remains required. Repository controls load the selector
from the pinned base commit, then compare that base and the checked-out candidate
with a complete Git diff, including file modes and both sides of renames. A changed
candidate selector cannot approve its own changes. Missing/non-regular base selectors
or failed/invalid output select the full database suite, including initial bootstrap.

The selector picks one database scope, set by the most demanding changed path:

| Scope | Changed paths | Database jobs |
| --- | --- | --- |
| `skip` | Ordinary Markdown under `docs/`, root AGENTS/CLAUDE/README, the frontend AGENTS/CLAUDE/README, backend AGENTS/README and Supabase AGENTS; regular files under `frontend/` and `performance/` | None |
| `current` | Regular files under `backend/app/`, `backend/tests/` and `supabase/verification/`, except the history inputs listed in the selector | Assembled stage, `current` and `drift` parts |
| `full` | Everything else, including migrations, Supabase config, scripts, dependencies, the workflow, history inputs, symlinks and unknown paths | Assembled stage, `current`, `drift` and `history` parts |

Markdown qualifies only as an ordinary non-executable file. Unavailable or
non-ancestor comparisons, empty diffs and manual runs select `full`. Pushes to
`main` upgrade `current` to `full`, so every merged database-relevant change also
gets the historical sweep. The selector records its choice and reason in the job
summary. Do not use `[skip ci]`, labels or manual successful statuses to substitute
for selection.

Selected database checks run as parallel jobs. The assembled job runs Supabase
startup, migrations, lint, contracts and races. The isolated job runs
`npm run check:supabase-contracts-local` once per selected part with
`KOARYU_DB_SUITE_PART`. Each part replays every migration on its own PostgreSQL 17
cluster:

- `history` adds the released-predecessor restore proofs inside the replay
  (through V56).
- `drift` runs the rolled-back catalog, privilege and readiness drift refusals.
  Payment-writer cases prove the V18-V37 compatibility chain once per failure key
  and compare readiness once after the rolled-back batch.
- `current` runs everything else, including the newest upgrade/restore proofs,
  contracts and concurrency.

The gate accepts a database skip only when repository controls emit `skip`.
Otherwise both database jobs must succeed with exactly the parts for the selected
scope; unexpected skipped, failed or canceled jobs fail the gate. Use this CI
result instead of repeating the suite locally.

When a new release adds an upgrade/restore proof, gate the previous newest proof
with `part_enabled history` so `current` keeps only the latest. Add any file a
history proof reads outside `supabase/migrations/` and `scripts/` to the
selector's history inputs; a selector test checks this for the replay loop.

## Required checks

The current workflow covers repository controls; frontend tests/lint/build/audit;
backend tests, dependency/audit/API contracts; database checks; the deterministic
Home performance gate; secret scanning and static analysis. Inspect the workflow
for its exact commands instead of maintaining a second inventory here.

For release-process or workflow edits, run `npm run check:release-workflow`.
Use [the verification matrix](pr-verification-matrix.md) for other local checks and
review. Keep failed or incomplete checks explicit; resolve material findings and
record dispositions for deferred review threads.

## Guarded merge

Keep the active `main` ruleset requiring PRs, strict exact-head `Release candidate gate` success, resolved review threads and blocked force-pushes/deletion. Normal
releases do not use a bypass.

Pin both full SHAs, then use:

```sh
scripts/merge-release-pr.sh <pr> <expected-head-sha> <expected-base-sha>
```

Start the release CLI session by explicitly sourcing the private `release-env.sh`
with tracing disabled. Do not put credentials in command arguments.

The merge script refuses a moved head/base, draft or unclean PR, absent/failed gate,
or pending/failed visible checks. It also rereads the pinned production Render
identity, branch and auto-deploy setting immediately before merge. Strict required
checks provide the server-side base guard. Do not substitute a manual API merge.

One focused independent review is required for material security, financial,
data-loss, migration or verification-acceptance changes. Ordinary changes need a
proportionate diff review. No blanket skeptical review or repeated green-light rounds.

## Deployment and recovery

Merge does not authorize deployment. Keep production Git auto-deploy off in Vercel
and Render, and verify live provider settings before release actions. Follow
[cutover gates](cutover-gates.md) for authorization, database-first schema releases,
backup/restore and production-target frontend builds. Compare provider metadata
and the application-reported full release SHA; a preview build is not production.
Historical catalog/version/provider notes are [reference material](release-history-reference.md),
not candidate requirements.

## Enforcement changes and incidents

The operational-alert evaluator's primary trigger is the director-operated home server's external scheduler at the required five-minute cadence; the committed Vercel cron is a daily 09:00 UTC backup. This resolves the Vercel funded-plan gate by moving the primary trigger source, not by weakening the cadence. Nobody may weaken the five-minute cadence merely to make a preview deploy.

Test material executable workflow/ruleset changes with a disposable PR: a deliberate
failure must block merge, and a new successful head must not reuse the failed head's
status. Record the results; do not repeat this probe for instruction-only edits.

An administrator bypass is only for an active incident with its own authorization.
Record the operator, reason, exact SHA, affected controls and recovery target;
restore enforcement and run the resulting candidate checks afterward. An incident
bypass never counts as a passed release check.

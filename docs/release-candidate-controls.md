# Release candidate controls

## Current CI and the transition

The actual `.github/workflows/release-candidate.yml` runs on every PR without path
filters. Its exact-head `Release candidate gate` remains required. It currently
runs application checks and the complete database job even for documentation or
UI edits. Updating instructions does not shorten that job or authorize bypassing it.

The database job runs assembled Supabase startup, migrations, lint, contracts and
races, stops that disposable stack, then runs the exhaustive PostgreSQL 17 replay,
historical restore and concurrency suite. Both stages must succeed in the current
workflow. Do not rerun the same suite locally just to wait for this CI result.

The intended simpler workflow is to run checks for affected areas, with broad
coverage for shared database/runtime/verification changes or uncertain impact.
Unrelated application/docs edits should not rerun historical database proofs.
Implement that in a reviewed workflow/runner change, keeping the aggregate gate
on the exact candidate and testing that relevant changes cannot evade coverage.
Use conservative dependency/path selection; a general receipt/cache framework is
not a prerequisite. Do not forge a pass, suppress failures or override protections.

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

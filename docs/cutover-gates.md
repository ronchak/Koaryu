# Cutover Gates

What will stop a release cutover, and what will silently damage it. The mechanics of
each tool are documented elsewhere — `docs/studio-comp-migration-rollout.md` for the
rollout script, `docs/render-backend-deployment.md` for Render. This file covers only
the things those docs do not, all of which were found the hard way during the
2026-08-15 cutover.

The production PostgreSQL image patch has a separate backup, exact-image restore,
provider request, and readback packet in
[`production-postgres-image-patch.md`](production-postgres-image-patch.md).

Read this before merging a release candidate, migrating a hosted database, or
promoting a frontend.

## Verify live state; do not trust a written plan

Every generated runbook we have used drifted from reality. The 2026-08-15 plan was
wrong on five separate counts: it understated how far the `staging` branch was behind,
its staging apply command omitted two required flags, it promised a health-check string
that the endpoint never prints, its production verification command passed a flag the
script rejects, and it assumed a database backup existed when none did.

None of those are exotic. They are what happens when a document is written once and the
systems keep moving. Before acting, re-derive from the live systems: migration counts
from both databases, `mergeStateStatus` on the PR, `autoDeploy` on both Render services,
and whether a restore path actually exists. Treat any written step as a hypothesis.

## The ordering invariant

Database, then backend, then frontend. Always.

Release migrations are written so the *currently deployed* code keeps working after they
land — that is what makes it safe to migrate before deploying. The reverse is not safe:
new code against an un-migrated database fails readiness and the service will not serve.

`/health/ready` (`backend/app/api/v1/endpoints/health.py`) calls
`assert_hosted_release_schema_ready_cached`, which refuses unless the database reports the exact
manifest in `EXPECTED_RELEASE_MANIFEST_VERSION`. Successful checks are reused for at most
30 seconds; failures are never cached.
The cache lives in `backend/app/services/release_schema_readiness.py`.

The latest read-only staging inspection found 119/head `20260825043911` at the
schedule-window V25 boundary. This combined candidate advances staging through
exactly seven Payments migrations to 126/head `20260826185651`/V31. The guarded
rollout tool classifies the live starting point as `schedule-v25`, computes the
seven-file remainder and its own manifest, and can resume from exact V25 through
V30 if a transaction boundary leaves a partial forward apply.

Migration 119 keeps `koaryu_release_schema_preflight_v4` returning the historical
V24 shape. The Payments chain preserves the schedule-shaped V5 response and owns
V6 through V12. The candidate backend reads V12 and serves only at exact 126/V31;
older deployed backends retain their corresponding compatibility response during
the database-first cutover.
The temporary V22 and
V23 application bridges were removed after production hosted readback. The
rollout tool retains exact historical `restored-v22`, `canonical-v23`, and
`restored-v23-pending-v24` classifications only for diagnosis of a proved
partial restore or replay. They are not application readiness alternatives.

The operational manifest string is **not** echoed in the response body. A runbook that tells you to
look for it is wrong. `"status": "ready"` *is* the proof the attestation matched.

If migration 113 commits and migration 114 does not, stop. No approved
application is eligible to serve at that V20 head. The prior `709239` application
requires V16, while the release candidate requires V24. Older V2 consumers from
before verified history boundary
`d63a5116c0a47f1933f15360cd5db7b66237bb80` can report ready through migration
110's exact V17 compatibility guard, but none is an approved recovery artifact.
Exclude both `709239`/V16 and every pre-boundary V2-consuming SHA from the
post-110 rollback set. A database still at exact 110 must classify
`state=staff-identity` and use its state-bound token to dry-run:
`20260816012723_archive_staff_access_and_readiness.sql`,
`20260820012533_dashboard_fact_rpc.sql`,
`20260820025759_roster_read_rpc.sql`,
`20260820060216_atomic_bulk_student_archive.sql`,
`20260822193000_revoke_client_read_access.sql`,
`20260823193155_revoke_public_function_execute.sql`, and
`20260824190500_attest_verified_restore_manifest.sql`,
`20260825042838_schedule_window_read_rpc.sql`,
`20260825043911_attest_schedule_window_release.sql`, and the seven Payments
migrations from `20260826030234_live_billing_reconciliation_v3.sql` through
`20260826185651_payment_refund_payer_sync_resource_ownership.sql`. If a future approved
disaster recovery explicitly returns production to the proved restored V22
snapshot, it must classify exact `state=restored-v22` and dry-run only
migrations 116 through 126. These are hypothetical forward-recovery cases, not
the current live state. In either case, only the authorized operator runs the
production apply gate, and promotion remains blocked until migration 126
produces exact V31 readiness and the final raw catalog/provider fingerprint.

## Gates that will refuse you

**Unresolved review threads block the merge.** The `Koaryu main release gate` ruleset
sets `required_review_thread_resolution: true`. Any unresolved thread — including ones
deliberately deferred as known issues — makes `mergeStateStatus` `BLOCKED`, and
`scripts/merge-release-pr.sh` refuses because it requires `CLEAN`. Resolve or fix them
before starting, and record *why* on each thread if the finding is being deferred.

**Run the rollout tool from the exact candidate implementation.** For an unmerged
release, invoke the tool from PR #134's worktree and pass its exact 40-character head.
The tool creates a detached worktree at that SHA and verifies the 126-file sequence and
source hashes there. Do not run an older `main` copy of the tool and do not merge the PR
to obtain the rollout script.

**Staging apply needs more than `--approve-staging-apply`.** It also requires
`--confirm-project <ref>` and an exact PR #134 issue-comment URL. The tool reads that
comment through GitHub and requires its complete body to bind the candidate SHA, target,
project ref, inspected state, remaining migration count/set, and remaining manifest.
A stale approval record is rejected after any code, state, or remainder change.

**Production apply requires a real terminal.** `confirmProductionApply()` throws unless
both `process.stdin.isTTY` and `process.stdout.isTTY`, then prompts for an exact phrase
built by `buildProductionConfirmationPhrase()`.

An agent cannot perform this step, and must not allocate a PTY to get around it.
Faking the terminal and typing the phrase impersonates the human confirmation the control
exists to capture, on an irreversible migration. The correct handoff is to prepare
everything else, then give the operator the fully filled-in command and the exact phrase
to type. Stage long values (the provider fingerprint is ~1000 characters) into a file so
the command stays pasteable.

## Traps that will not refuse you

These are worse than the gates, because nothing fails. You get a green result and a
broken system.

**`--expected-stripe-mode` is staging-only.** `stripeRehearsalExpectation()` in
`scripts/verify-deployed-release.mjs` requires the value be exactly `test` *and* the
environment be `staging`. For production, omit the flag entirely. Verify production's
Stripe mode from `/health/ready`'s `configured_stripe_mode` instead.

**Never promote a Vercel preview deployment to production.** This is the most dangerous
step in the whole cutover.

Vercel inlines `NEXT_PUBLIC_*` at *build* time, and the `koaryu` project defines separate
preview and production values for `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. Promoting
reassigns the production alias to an existing build; it does not rebuild.

The trap is that merging to `main` produces **no Vercel build at all**, because production
auto-deploy is off. So the only build carrying the merged SHA is a preview produced by the
`staging` branch push. It shows the right commit and is the wrong build. Promoting it
points `koaryu.app` at the **staging database with test Stripe keys** — and it fails
silently, because the app loads perfectly while reading the wrong database.

Instead, create a production-target deployment from git, so it builds with production
environment variables: `POST https://api.vercel.com/v13/deployments` with
`target: "production"` and a `gitSource` whose `ref` is the merged SHA.

Then confirm both: `scripts/verify-deployed-release.mjs` reports the frontend as
`environment: production`, and the live app's XHRs go to `koaryu.onrender.com`, not
`koaryu-staging.onrender.com`.

## A verified backup is a precondition, not paperwork

The Supabase organization is on the **free plan**: no scheduled backups, no
point-in-time recovery. There is no managed restore path for production.

`--confirmed-restore-window` is validated only by `assertPlainText` — printable ASCII and
nothing more. It never checks that a backup exists. It will accept a fabricated claim on
an irreversible migration against live customer data. **Never pass a value you have not
personally produced and verified.**

The working recipe, with the parts that bite:

1. The direct host `db.<ref>.supabase.co` is **IPv6-only**, so `supabase db dump` fails
   DNS resolution inside its Docker container. Use `pg_dump` from the host instead.
2. Create a temporary login role with `pg_read_all_data` **and** `BYPASSRLS`. Without
   `BYPASSRLS` the `auth` schema fails to dump partway through.
3. Pass **no** `--schema` filters. Filtering to `public`/`auth`/`storage` silently omits
   the `private` schema and the `supabase_migrations` history — the dump looks fine and is
   not restorable.
4. Verify by restoring into a throwaway `supabase/postgres:17` container and comparing row
   counts against live. Run that restore with the **container's** `psql`: a host `psql`
   under `~/.local/bin` may be broken (`Symbol not found: _PQbackendPID`) and exit
   silently, which makes a no-op restore look like a clean success.
5. Drop the temporary role afterward.

Store dumps outside the repository with `chmod 600`. They contain customer PII, and this
repository is public.

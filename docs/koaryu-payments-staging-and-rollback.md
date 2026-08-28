# Koaryu Payments staging, rollback, and production packet

This runbook is for the single unmerged Koaryu Payments pull request. Replace every
`<PR_HEAD_SHA>` and evidence placeholder with the exact final head before use. The
staging rehearsal is Stripe test mode only. Nothing here authorizes a production write,
Stripe live-mode change, production webhook change, or real-money transaction.

## Release identity

- Source branch: `codex/koaryu-payments-live`
- Base: `main`
- Candidate: `<PR_HEAD_SHA>`
- Staging Supabase: `koaryu-staging` (`nxgsektqsgrtyfhawxbc`)
- Staging backend: `https://koaryu-staging.onrender.com`
- Staging frontend: the branch-scoped Vercel staging deployment
- Provider mode: Stripe test (`sk_test_`, `rk_test_`, `pk_test_`)

This candidate includes the complete schedule-window read change from PR #133 before
the seven Payments migrations. PR #133 must remain unmerged and is superseded by this
single release candidate; do not create or deploy a second migration tail.

## Local release gate

Run against the exact committed candidate:

```text
backend/venv/bin/python -m pytest
cd frontend && npm test
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
npm run check:api-types
npm run check:supabase-contracts-local
node --test scripts/studio-comp-migration-rollout.test.mjs
npm run check:release-workflow
npm run check:performance-regression -- --expected-sha <PR_HEAD_SHA>
git diff --check
```

Record test counts and any environment-only failure separately. A Chrome process that
aborts before page creation is not a browser pass; the deployed browser matrix remains
required.

## Independent review gate

Both reviewers must inspect the same `<PR_HEAD_SHA>`:

1. Comment `@codex review` on the pull request.
2. Use Claude Code with the exact Opus 5 model in a clean checkout of the PR head. The
   review is read-only and must be posted to the pull request.

Any blocker requires a code/test correction on the same branch, a new SHA, green CI, and
fresh reviews from both reviewers. Do not deploy a head that only one reviewer saw.

## Database-first staging apply

Inspect the linked target before writing:

```text
node scripts/studio-comp-migration-rollout.mjs \
  --mode inspect \
  --target staging \
  --candidate-sha <PR_HEAD_SHA>
```

Treat this fresh inspect output as the only authority for the starting state,
`remaining_migrations`, `remaining_manifest_sha256`, and `inspection_token`. Do not copy
a count or set from this runbook into the approval record. The rollout selection logic
maps `schedule-v25` to seven remaining files and `v25` to six. Later accepted partial
states select smaller suffixes. The last coordinator readback on 2026-08-28 found exact
`v25`, migration 120/head `20260826030234`, with six files remaining, but the next fresh
inspect supersedes that observation. Then use the
guarded staging apply with the generated token and a PR #134 issue comment whose exact
body matches the inspect-emitted approval record, including candidate SHA, staging ref,
inspected state, remaining count and set, and remaining manifest. A stale six-file or
seven-file claim is not approval for a different observed state. Do not use direct SQL,
`db reset`, or a production link. After apply, require
the exact candidate readiness version, migration count, migration head, and zero security
failures recorded by the guarded packet. Do not reuse the older V30/125 expectation after
the additive V31 correction. The required post-state is V31, 126 migrations, head
`20260826185651`, and zero security failures.

## Exact-SHA application deploy

After the database apply, deploy the staging backend from `<PR_HEAD_SHA>` and require
its exact-SHA deployment readback plus successful `/health/ready`. Create or update only
`koaryu-billing-transitions-staging`, populate its secret through the staging web-service
reference, and deploy the cron from the same SHA while keeping it suspended. The
Blueprint's `branch: staging` is configuration metadata, not release evidence. Verify
the cron deployment itself reports the candidate SHA before allowing any run.

Before deploying the backend or cron, confirm the staging `koaryu-staging` web service
already owns `BILLING_TRANSITION_WORKER_SECRET`; the candidate intentionally refuses to
boot or run the worker without it. Do not create or rotate the production value in this
task.

After the exact-candidate backend is ready, keep recurring cron execution suspended and
trigger one manual run if the provider controls permit it. Zero-work proof requires this
exact compact stdout line:

```json
{"claimed":0,"completed":0,"reconciliation_required":0,"failed":0}
```

A successful process exit without that line is insufficient. Nonzero `claimed` and
`completed` with both error counters at zero prints only this fixed line:

```text
Billing transition cron completed nonzero work.
```

That line contains no response-derived values. It proves successful nonzero work, never
zero work. Any nonzero `reconciliation_required` or `failed` requires operator attention.
Resume the five-minute schedule only after the exact zero-work proof. If Render cannot
run the job manually while its schedule is suspended, stop and prove a safe provider
route that cannot start recurring execution before the proof. Production keeps
`BILLING_TRANSITION_SCHEDULER_ENABLED=false` and receives no cron in this task.

Deploy the frontend last. `origin/staging` was
`ee6137a709e4215efac1319dedd0e55ed2b60e1c` when this packet was written. That dated SHA
is context, not an execution assumption. Because Vercel automatically deploys
`refs/heads/staging`, do not move it before backend readiness and cron proof. At this
final step, fetch the operator-observed old ref, verify the candidate ref, use a
full-destination-ref guarded update, and read back the remote immediately:

```bash
PR_HEAD_SHA='<PR_HEAD_SHA>'
git fetch origin \
  refs/heads/staging:refs/remotes/origin/staging \
  refs/heads/codex/koaryu-payments-live:refs/remotes/origin/codex/koaryu-payments-live
OLD_STAGING_SHA="$(git rev-parse refs/remotes/origin/staging)"
test "$(git rev-parse refs/remotes/origin/codex/koaryu-payments-live)" = "${PR_HEAD_SHA}"
git push origin \
  "${PR_HEAD_SHA}:refs/heads/staging" \
  --force-with-lease=refs/heads/staging:"${OLD_STAGING_SHA}"
test "$(git ls-remote --heads origin refs/heads/staging | awk '{print $1}')" = "${PR_HEAD_SHA}"
```

Abort on any failure or readback mismatch. Never use unchecked `--force`. Wait for the
resulting Vercel staging deployment, then verify the exact deployed pair before any
provider mutation. If Render cannot deploy the exact candidate before this ref move,
stop and prove a safe provider route. Do not move staging early to unblock Render.

```text
npm run verify:deployed-release -- \
  --environment staging \
  --expected-sha <PR_HEAD_SHA> \
  --frontend-origin <PINNED_STAGING_FRONTEND_ORIGIN> \
  --backend-api https://koaryu-staging.onrender.com/api/v1
```

The readiness evidence must agree on candidate SHA, staging Supabase, Stripe test mode,
frontend origin, backend origin, and the 50-basis-point fee setting.

Before provider rehearsal, prove that finalize, void, and retry cannot hold concurrent
nonterminal ownership for one invoice. Confirm that a failed or reconciliation-required
mutation blocks competing work, while an exact historical terminal key remains replayable.
Also confirm invoice creation rejects a 32-item request and accepts the documented
31-item maximum.

## Stripe test rehearsal

Create or update only the Stripe test objects and the two staging webhook endpoints
needed by the rehearsal. Follow
`docs/stripe-test-provider-rehearsal-capture.md`; keep the completed evidence private and
sanitized. Validate it with:

```text
python3 scripts/check-stripe-provider-rehearsal-worksheet.py
python3 scripts/verify-stripe-provider-rehearsal.py \
  --evidence <PRIVATE_SANITIZED_EVIDENCE_JSON> \
  --expected-candidate-sha <PR_HEAD_SHA> \
  --expected-backend-origin https://koaryu-staging.onrender.com
```

The schema-v4 evidence must finish with zero failed, stuck, unmapped, wrong-mode,
wrong-generation, pending-transition, and reconciliation-required records.
An externally recorded payment must remain a local accounting entry and must not call
Stripe's connected-invoice pay endpoint or change a connected invoice out of band.

## Browser matrix

Use the deployed staging frontend and the staging test accounts. Verify Admin, Front
Desk, and Instructor authorization plus keyboard navigation at:

- desktop;
- 390 by 844;
- 360 by 800.

Exercise Setup, Tuition Plans, Families, Student Billing, Invoices, and Advanced. Raw
Stripe object identifiers must not appear in the primary tables. Unsupported generic
pause, resume, rewire, and cancellation controls must remain absent. Preview mode may
show demo interactions but must issue no provider request.

## Staging rollback

Rollback closes new writes and preserves evidence:

1. Stop the rehearsal and record the last known operation and event state.
2. Set `BILLING_TRANSITION_SCHEDULER_ENABLED=false`, suspend the staging transition
   cron, and prove no due worker run remains active.
3. Preserve the V31 database and its evidence. A pre-V31 staging application SHA is not
   a rollback artifact. Redeploy an application only if separate evidence proves that
   exact SHA compatible with the retained V31 sparse-payment identity contract. Do not
   promote or modify production.
4. Disable only test-mode webhook endpoints introduced for the rehearsal after all
   delivered events have a local terminal readback.
5. Leave the additive V25 through V31 migrations in staging. Do not down-migrate or
   delete provider-operation, consent, transition, event, refund, or dispute evidence.
6. Reconcile every ambiguous test object by provider readback. Never retry merely because
   a response was lost.
7. Require zero active UI/provider workflows before declaring rollback complete.

## Production packet awaiting approval

The production packet is prepared but must not be executed in this task:

1. Merge only after a separate approval and all exact-head gates.
2. Take and verify a private production PostgreSQL backup through the documented guarded
   path.
3. Inspect production migration and provider state read-only.
4. Apply the exact migrations through the guarded production rollout tool after its
   separate interactive confirmation.
5. Create the separately approved production transition cron with its own production
   service-secret reference after confirming the production web service owns the same
   secret, deploy the exact merged SHA, and prove one manual zero-work run. Only then set
   the production scheduler flag true.
6. Deploy the exact merged backend SHA, verify readiness, then deploy a production-target
   Vercel build from the same SHA.
7. Run production reconciliation read-only and record a fresh exact-SHA schema-v3
   checkpoint only after separate approval.
8. Grant one named studio only the exact canary operations, payer, amount, and generation
   approved for the attended canary.
9. Verify the 50-basis-point fee, webhook delivery, local projections, refund, and
   cleanup; revoke the grant immediately.
10. Finish with read-only reconciliation and preserve all evidence.

Commercial copy, consent language, pilot membership, and any ongoing grant remain a
separate production decision.

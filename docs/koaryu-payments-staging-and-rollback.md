# Koaryu Payments staging, rollback, and production packet

This runbook is for the single unmerged Koaryu Payments pull request. Replace every
`<PR_HEAD_SHA>` and evidence placeholder with the exact current PR head before use. The
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

Confirm the exact project ref, inspected state, pending set, and inspection token. Then
use the guarded staging apply with its exact generated arguments and a PR #134 issue
comment whose exact body binds the candidate SHA, staging ref, inspected state, seven
migrations, and remaining manifest emitted by inspect. Do not use direct SQL, `db reset`,
or a production link. After apply, require
the exact candidate readiness version, migration count, migration head, and zero security
failures recorded by the guarded packet. Do not reuse the older V30/125 expectation after
the additive V31 correction. The required post-state is V31, 126 migrations, head
`20260826185651`, and zero security failures.

## Exact-SHA application deploy

Create or update only `koaryu-billing-transitions-staging`, populate its secret through
the staging web-service reference, and deploy the cron from `<PR_HEAD_SHA>`. Manually
trigger one zero-work run and require a successful bounded result. Production keeps
`BILLING_TRANSITION_SCHEDULER_ENABLED=false` and receives no cron in this task.
The Blueprint's `branch: staging` is configuration metadata, not release evidence;
verify the cron deployment itself reports `<PR_HEAD_SHA>` before enabling the route.

Before deploying the backend or cron, confirm the staging `koaryu-staging` web service
already owns `BILLING_TRANSITION_WORKER_SECRET`; the candidate intentionally refuses to
boot or run the worker without it. Do not create or rotate the production value in this
task.

Then deploy the staging backend and frontend from `<PR_HEAD_SHA>`. The backend may expose
period-end scheduling only after the staging cron is active. Verify the exact deployed
pair before any provider mutation:

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

The schema-v3 evidence must finish with zero failed, stuck, unmapped, wrong-mode,
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
3. Redeploy only the prior staging frontend/backend SHA proven compatible with the
   retained V31 sparse-payment identity contract. Do not promote or modify production.
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

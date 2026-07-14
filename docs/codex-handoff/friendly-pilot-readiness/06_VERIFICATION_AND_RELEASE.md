# Verification and Release Rules

## Candidate identity invariant

Release evidence is valid only for the exact candidate to which it applies.

At candidate freeze record:

- commit SHA;
- tree SHA;
- clean worktree;
- diff stat;
- migration filenames and SHA-256;
- billing disposition;
- rollback state.

Any candidate-file change invalidates:

- final-review verdict;
- exact-head CI;
- staging deployment evidence;
- staging smoke evidence.

Create a new candidate and rerun affected gates.

If a PR merge commit differs from the reviewed head, verify tree equality before treating the merge as the same candidate.

## Repository verification

Follow the closest AGENTS.md.

Likely repository checks:

- npm run check:env-examples
- npm run check:api-types
- npm run generate:api-types only if contracts changed
- npm run audit:support-privacy

## Frontend verification

- focused tests for changed behavior;
- touched-file lint;
- TypeScript check;
- production build;
- browser checks at 360, 390, and desktop widths;
- console-error check;
- focused screenshots only when evidence benefits.

## Backend verification

- focused pytest first;
- broader suite after focused success;
- explicit authorization/no-mutation tests;
- cross-tenant non-disclosure tests;
- single-studio membership and invitation tests;
- billing denial before service construction;
- demotion audit-history tests if added.

## Supabase verification

If a migration exists:

1. Confirm the local database is disposable.
2. Replay clean migrations locally.
3. Run local database lint with fail-on-error.
4. Force verification helpers to local.
5. Run focused RLS/contract checks.
6. Verify migration compatibility.
7. Never rewrite an old migration merely to implement this release.

Production inspection is aggregate-only by default.

## Billing verification

For any included mutation:

- Stripe test mode only;
- idempotency;
- duplicate request;
- double-click;
- retry;
- partial provider failure;
- out-of-order webhook;
- duplicate webhook;
- reconciliation;
- honest pending/failure state;
- authorization;
- audit;
- live fail-closed proof without live mutation.

## Regression verification

Protect:

- PR #12 recurring schedule visibility;
- PR #39 attendance correctness;
- PR #40 dataset/loading readiness.

## Full CI rule

Targeted checks may run freely before freeze.

Run one full exact-head CI cycle only after:

- domain reviews are green;
- final review is green;
- candidate is frozen.

One rerun is allowed only if candidate content changes.

Record CI by exact SHA.

## Staging resource isolation

Before staging:

- verify Supabase project identity;
- verify Render service identity;
- verify Vercel deployment/alias identity;
- verify Stripe test mode;
- confirm production resources are not targeted.

Use disposable staging data only.

## Staging matrix

Verify:

- authentication;
- onboarding;
- single-studio membership;
- second-membership rejection;
- Admin permissions;
- Front Desk permissions;
- Instructor editing an existing student;
- Instructor student-create denial;
- Instructor archive/delete denial;
- attendance;
- promotion;
- auditable demotion;
- Instructor billing denial;
- absence of Instructor billing-data fetch;
- Front Desk routine billing access;
- Admin-only dangerous actions;
- recurring-session refresh;
- attendance consistency;
- lead conversion;
- billing behavior included by the locked disposition;
- provider failure/retry behavior if applicable;
- webhook reconciliation if applicable;
- 360-pixel mobile flows;
- 390-pixel mobile flows;
- protected PR #12/#39/#40 behavior;
- live-mutation fail-closed behavior without live mutation.

After staging:

1. Delete disposable Auth identities.
2. Delete disposable business records.
3. Verify cleanup.
4. Record evidence by candidate SHA.

Any code correction returns to candidate freeze.

## Approval package

Before production present:

- candidate SHA;
- tree SHA;
- PR;
- CI;
- reviewer verdict;
- staging evidence;
- migration status;
- migration hash if any;
- schema compatibility;
- application rollback;
- database rollback/recovery;
- billing disposition;
- live Stripe status;
- deferred risks;
- data-preservation statement.

## Separate approvals

The following are independent:

1. application deployment;
2. production migration;
3. live Stripe activation.

None implies another.

No migration means no migration approval is needed.

No live activation means live mutation remains closed.

Do not deploy the application without explicit application approval.

## Production deployment

After approval:

1. Deploy the exact frozen candidate.
2. Apply only an exact separately approved migration.
3. Keep live Stripe closed unless separately approved.
4. Verify Render SHA.
5. Verify Vercel provider SHA.
6. Verify schema state.
7. Run read-only/non-financial smoke.
8. Check Render logs once.
9. Check email alerts once.
10. Preserve production demo data.
11. Preserve production Auth identities.
12. Preserve Stripe objects.
13. Update the checkpoint.
14. Stop.

## Rollback

Document:

- previous frontend deployment;
- previous backend deployment;
- candidate SHA;
- schema compatibility;
- rollback trigger;
- Vercel rollback action;
- Render rollback action;
- database action;
- recovery action if rollback is insufficient.

If no migration exists, database rollback is explicitly no action.

## Mandatory stopping condition

Stop when:

- Friendly Pilot Core is complete;
- single-studio behavior is enforced;
- production data is preserved;
- Instructor permissions match policy;
- Front Desk permissions match policy;
- Admin-only actions remain protected;
- billing inventory and transition contract are complete;
- the selected billing disposition is satisfied;
- live Stripe remains closed unless separately approved;
- mobile critical paths are usable;
- documentation is accurate;
- protected regressions remain fixed;
- all domain reviews are green;
- final review is green;
- exact-head CI passes;
- isolated staging passes;
- disposable fixtures are removed;
- any authorized production deployment matches the candidate;
- immediate logs/email show no new post-success failure;
- worktree is clean;
- checkpoint is current;
- physical flash-drive step remains assigned to the human.

## Final report

Report only:

- candidate and deployed SHA;
- PR;
- migration status;
- Friendly Pilot Core result;
- authorization result;
- single-studio result;
- billing disposition and transition status;
- live Stripe status;
- mobile verification;
- tests and CI;
- staging and production smoke;
- documentation;
- recovery and alerts;
- deferred risks;
- remaining flash-drive step.

Do not begin another release wave.

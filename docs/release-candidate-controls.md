# Release-Candidate CI And Merge Controls

Koaryu release work is accepted only when the exact pull-request head passes the
repository-wide `Release candidate gate`. The workflow runs for every pull
request without path filters, so frontend-only, backend-only, database,
workflow, script, and documentation changes cannot produce a zero-check PR.

## Required Candidate Check

`.github/workflows/release-candidate.yml` checks out the pull-request head SHA
directly and verifies it before running:

- repository workflow, environment-example, and support-privacy controls;
- frontend tests, lint, production build, and high-severity runtime audit;
- backend dependency consistency, hash-lock drift, vulnerability audit, tests,
  and generated API contract verification;
- a fresh local migration replay, database lint, and the broad Supabase contract
  suite;
- an exact SQL-contract inventory check and real concurrent opposite-direction
  Connect mapping/exclusion transactions against the ephemeral database;
- merge-safe full-history and exact-worktree Gitleaks, Bandit, and CodeQL static analysis; and
- an aggregate fail-closed `Release candidate gate` job.

The Supabase contracts run through PostgreSQL `psql` with `ON_ERROR_STOP=1`.
This preserves transaction and multi-statement behavior that the Supabase CLI
prepared-statement query path cannot execute reliably. Local checks resolve the
disposable database URL through `supabase status`. Intentional linked checks
must provide a private `SUPABASE_DB_URL`; never print or commit it.

Run the static workflow guard locally with:

```bash
npm run check:release-workflow
```

## Provider Promotion Controls

Merging `main` does not authorize an automatic production deployment. `frontend/vercel.json` disables Git deployments for `main` while retaining the persistent `staging` branch and ordinary preview deployments. The production Render service likewise declares `autoDeployTrigger: 'off'` and routes provider health to `/health/ready`.

Database promotion precedes application promotion. Hosted readiness calls the
service-role-only V4 Supabase preflight and requires the exact final migration count
117, head `20260824190500`, the exact 33-version pending sequence, manifest version
`release-db-attestation-v24`, the exact zero-invalid-count V18 archive-critical
semantic manifest `0:cf1b1a4403e539721172d4a8cfec64540e4f5dcec2aab12eafbcfb51fbd84b3a`, and required-object/security proof. The backend reuses a successful preflight for at most 30 seconds to prevent health-probe client churn. It never caches failures, and concurrent probes share one check.

That manifest covers
`staff_roles.archived_at`, active-only helper bodies/signatures/ACLs, archive-aware
triggers, and every public RLS table's restrictive membership guard.

Staging and production now report ready only at exact 117/V24. The temporary
production V22 and hosted V23 application bridges were removed after the
production V24 hosted readback. Historical V22/V23 states remain represented
only in the guarded operator tool for exact forward-recovery diagnosis.

The post-111 V16 compatibility assertion is pinned to
`0:48995afbdd6519a199db44c6b947bf629a87569530ba73c81c25b00f72944239`. The
V24 preflight accepts exactly the canonical PostgreSQL 17 operational
semantic/ACL manifest
`61c8251b04d170bb4777de6c35570d024d6c97897ef1c524bc1adbcff97b7931`
or the independently proved logical-restore manifest
`f9ce359c0ebf12039e8dfcb5308cd193ac18aa05cea23dad5b9f5208b0c51233`.
The raw PostgreSQL 17 catalog fingerprint is pinned to
`column_acls=205:32ad7f660d40de1c75de0e9d50e4c23f3588124e67f3665159f8f2f027617414:0;columns=43:c2f9560d4d2d9742f22edeeb3386b2fce9def1e90290e7986f406d9f7dd0451b:0;constraints=24:d8ae028684234bb1c69447c97e87fc8561ce18f03b7ec10f81a880ba5d813c5c:0;functions=68:87649166980bfc6164e59482e122793d4b7867bbf360d2f1dbe3021fa151309b:0;indexes=12:c78635a18852d4cbe8be1bc34861848ba904b06639038c292f84d56ca7be50a7:0;policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;scoped_constraints=149:a1555af1e8eacb8f03b04c2109dc6966293705307d737e5601996cf81acc06b9:0;scoped_indexes=33:4d401ee4a7e7f104957cb8cc84ad45164d57938ced0c2609259310aa980895f2:0;sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;table_acls=14:d71f968d375333515659bd0220224c127cee6e7b3878f9ae36427f7c1561c92c:0;tables=12:f56508ae1d3c712e7b239a1fe965adf88cec4e7f41f8d6b6db9ffce95f1bb76b:0;triggers=12:61039a9e58e55b3aba5e7e2a40088fd492352560123bc5df30c7966cfd6d9efc:0`.
The independently read-back restored-production catalog is byte-identical in
every category except the proved logical-restore scoped-constraint digest:
`scoped_constraints=149:47cacc1ce1d31ca8a7d63158aaa66aaf24452c085015c226f40e810995a6cd18:0`.
Read-only 2026-08-24 comparison also confirmed identical narrow function state
`3:421f8574059c8ca45a1a2075ce1e9346:0`, trigger state
`1:e430c825c094352cd460bd15933a3a43:0`, and V18 critical manifest. The rollout
tool derives the exact restored production fingerprint from approved canonical
staging evidence by replacing only that full catalog token; no per-category
mixing is accepted. A schema-84 state, a partial 85-110 state, a missing final
migration manifest, or any
provider/RPC error returns 503, so the new backend cannot be promoted healthy
against an earlier database head.

Migration 116 reasserts the global default that removes PostgreSQL's automatic
PUBLIC function EXECUTE grant, removes the schema-local API-role defaults, and
fails closed if any public routine remains browser-callable. The
fresh PostgreSQL 17 replay produced the same operational manifest and raw
catalog fingerprint pinned above because migration `20260711215000` had already
converged the effective routine ACL state. Migration 116 adds a schema-wide guard and a
behavioral new-function probe; it does not invent a catalog change where none
occurred.

Migration 117 advances readiness to V24 without changing product data or
operational objects. It admits only the two proved zero-failure PostgreSQL 17
manifests above; a third digest, hybrid history, or object failure remains red.

Migration 109 introduced the candidate V2 checkout-reservation path and retains
the deployed `origin/main` predecessor reservation (V1) and V2 readiness
signatures for the mixed-version database-first window. Migration 110 updates
the V2 compatibility guard: its V7-shaped response reports ready only when the
candidate V3 preflight proves exact 110/V17 state. Migration 111 adds active-membership
archive authorization, owner/last-admin archive guards, and service-role-only
staff-role writes; the new backend never uses the compatibility path.
Exact migration 109/head `20260814213000`/V16 is the accepted `trial-locked`
resume state for migrations 110 and 111. Exact migration 110/head
`20260815220402`/V17 is the guarded `staff-identity` resume state for migration
111 only. Each requires a fresh candidate-bound inspection and exact dry-run.
No approved application serves at 110: exclude `709239`/V16 and every
V2-consuming SHA before verified history boundary
`d63a5116c0a47f1933f15360cd5db7b66237bb80` from rollback. Those older V2
consumers can report ready through the 110/V17 compatibility guard, but they are
not approved recovery artifacts.

The local PostgreSQL proof does not certify hosted PostgREST exposed-schema
configuration or actual schema ACL state. Authenticated operator readback must
separately prove that `private` is not exposed and that hosted schema ACLs match
the approved release gate before promotion.

`npm run check:env-examples` fails if either repository provider control drifts or if the account-deletion cron is removed. Repository text cannot prove Render's current service setting: before the bootstrap merge, an authenticated operator must turn production auto-deploy off through Render and capture an authenticated readback. The guarded merge command independently rechecks that live provider state and refuses to merge without it. After the fixed candidate passes staging, deploy or promote that exact SHA explicitly, read back Vercel `/api/version` and Render `/health/ready`, and compare both full SHAs with the release ledger before assigning production traffic.

The exact `codex/launch-readiness-candidate` branch does not auto-deploy to Vercel. GitHub CI performs its production frontend build. The operational-alert evaluator's primary trigger is the director-operated home server's external scheduler at the required five-minute cadence; the committed Vercel cron is a daily 09:00 UTC backup. This resolves the Vercel funded-plan gate by moving the primary trigger source, not by weakening the cadence. Nobody may weaken the five-minute cadence merely to make a preview deploy. Deploy the approved exact SHA through the database-first manual promotion path.

Use `npm run verify:deployed-release -- --environment <staging|production> --expected-sha <full-sha> --frontend-origin <pinned-origin> --backend-api <pinned-api-v1>` for the application-reported readback. It requires both Render readiness routes and Vercel to report one exact full SHA. Run it before browser smoke or performance capture; evidence from a mismatched pair or mutable alias is invalid. Authenticated provider deployment metadata remains a separate required readback.

## Main-Branch Ruleset

After the workflow exists on `main` and has produced the named check, maintain
an active repository ruleset targeting `main` with all of these controls:

- changes require a pull request;
- `Release candidate gate` is required from GitHub Actions;
- required checks use strict mode, so the branch must be current with `main`;
- force pushes and branch deletion are blocked; and
- bypass is not part of the routine release path.

If the repository plan cannot enforce that ruleset, gate #35 remains open. The
fallback is manual exact-head merging through the guarded script below plus a
release issue recording the current base SHA, but that fallback is not silently
equivalent to server-side enforcement.

## Exact-Head Merge

Record both immutable SHAs immediately before the merge:

```bash
read -r -s -p "Render API key: " RENDER_API_KEY; export RENDER_API_KEY; echo
gh pr view <pr> --json headRefOid,baseRefOid
scripts/merge-release-pr.sh <pr> <expected-head-sha> <expected-base-sha>
unset RENDER_API_KEY
```

The script fails closed when the head or base moved, the PR is a draft, GitHub
does not report a clean merge, the candidate gate is absent or unsuccessful,
or any visible check is pending or failing. It also performs two authenticated,
just-in-time Render service readbacks and refuses the merge unless the repository-pinned
`koaryu` production service ID and its canonical identity are on `main` with auto-deploy off. The sanitized
readback JSON is safe to copy into the release ledger; the API key is never
printed. The script then passes the expected head to GitHub's merge API. Strict
required checks provide the corresponding base-drift guard at merge time.

Repository merges still require the evidence in `docs/pr-verification-matrix.md`:
resolved review findings, skeptical green light, rollback implications, and any
browser, staging, billing, security, or recovery proof required by the changed
surface.

## Enforcement Probe

For the initial rollout and after a material workflow/ruleset change:

1. Push a temporary commit to a test PR that makes
   `scripts/check-release-candidate-workflow.test.mjs` fail.
2. Record the failed exact-head `Release candidate gate` and confirm GitHub
   prevents merge.
3. Revert only the temporary failure in a new commit.
4. Record the successful gate on the new exact head and confirm the stale failed
   head cannot satisfy the PR.

Do not merge the deliberate failure. Store the check URLs and both SHAs in gate
#35 and the release ledger.

## Emergency Handling

An administrator bypass is for an active incident only. Before using it when
practical, open an incident issue that names the operator, reason, exact SHA,
affected controls, and rollback target. Afterward, record the bypass and
post-deploy evidence in the release ledger, restore enforcement immediately,
and run the complete candidate workflow on the resulting `main` head. A bypass
never counts as production-readiness evidence.

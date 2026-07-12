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

Merging `main` does not authorize an automatic production deployment. `frontend/vercel.json` disables Git deployments for `main` while retaining the persistent `staging` branch and ordinary preview deployments. The production Render service likewise declares `autoDeployTrigger: 'off'`. The bootstrap change keeps Render's process health check on the backward-compatible `/health`; switch the provider to `/health/live` only after the approved artifact containing that endpoint is already live.

`npm run check:env-examples` fails if either repository provider control drifts or if the account-deletion cron is removed. Repository text cannot prove Render's current service setting: before the bootstrap merge, an authenticated operator must turn production auto-deploy off through Render and capture an authenticated readback. The guarded merge command independently rechecks that live provider state and refuses to merge without it. After the fixed candidate passes staging, deploy or promote that exact SHA explicitly, read back Vercel `/api/version` and Render `/health/ready`, and compare both full SHAs with the release ledger before assigning production traffic.

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

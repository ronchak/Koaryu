# Koaryu remediation handoff

Paused at the owner's request on September 10, 2026, Pacific time. Finish safely; do not continue feature work in this session. The original remediation program is incomplete. Production release is prepared, not executed.

## Repository and release identity

- Main at preparation, after PR178: `f942dad3509a2e2cc9b55d546c2d22e097f77abe`. This is the pinned implementation/release candidate in [PRODUCTION-RELEASE.md](PRODUCTION-RELEASE.md).
- This handoff will land through a documentation-only PR. Its merge SHA cannot appear inside its own committed contents. Fetch `origin/main` and run `git rev-parse origin/main` for the final documentation-inclusive SHA; the closing task report records it. Do not replace the pinned release candidate silently.
- PR178 merged from `c762a480b0e8f7c198b678c0dfcfb5da04075995`, with all 11 checks green and the fresh reviewer dedicated to PR178 approving that exact head. The guarded merge read Render production auto-deploy off twice. Full local proof: 140 migrations, 52 contracts, retained restores/negative checks, 15 student concurrency cases; combined backend 1,904 tests and 5,471 subtests. SQL/verifier bytes were unchanged through rebase.
- PR179 was already merged as `7113d130a1523d5048cb9cb15529aed6277a4770` before this wind-down. It enforces USD before new tuition financial writes while preserving historical attempts and exact replay.
- Main contains 140 migrations through V45. Read-only inspection from the pinned candidate confirmed production at V38 with exactly seven remaining files. Production frontend/backend both reported `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`; the older private runbook's `69eacb...` application reference is stale.
- No production migration, deployment, historical financial backfill or live billing activation occurred. Render readback returned `autoDeploy=no`, `autoDeployTrigger=off`. Vercel's main-branch deployment setting is false in both the deployed source and candidate; the project API does not expose that source setting as an independent control.

## Exact ledger counts

Original audit only, 278 observations. Tracks describe current execution ownership, not risk or historical authorship.

| Disposition | Astra | Sol | Total |
| --- | ---: | ---: | ---: |
| Fixed | 22 | 56 | 78 |
| Resolved indirectly | 1 | 1 | 2 |
| Pending | 29 | 156 | 185 |
| Deferred intentionally | 4 | 7 | 11 |
| Deferred pending owner action | 0 | 1 | 1 |
| Rejected after verification | 0 | 1 | 1 |
| Total | 56 | 222 | 278 |

Six separate program findings are outside the 278: three fixed, three pending. Fixed: dependency prerequisites, remaining dependency advisories, and the attestation generator. Pending: mixed/unknown-currency reads, the unmapped Program/belt policy, and the activation retry/quantity defect. Program-track totals: Astra 4, Sol 2; pending Astra 3. Mixed findings still require Sol to implement application files.

PR178 closes OPS2-04, OPS2-05, OPS2-06, OPS2-07 and BT5-02. No finding is marked fixed merely because it is included in draft PR180. Historical normalization counts remain dated evidence; `current_counts` and `current_disposition_tracks` in [ledger.json](ledger.json) are the current totals. CTA1-04 remains evidence-missing/rejected after verification: only 1,128 of the 1,129 audit files can be matched, not CHANGELOG.md.

## Delegated batches

| Batch | Status on main | Remaining |
| --- | --- | --- |
| 01 billing product truth | Not started | 5 |
| 02 operator/release documents | Partial documentation work; no full audit closure claimed | 7 |
| 03 customer copy/first-read docs | Not started | 12 |
| 04 backend contracts/copy | Not started | 5 |
| 05 backend dead code/fixtures | Done, PR171 | 0 |
| 06 performance evidence | BT4-01 done, PR174 | 5 |
| 07 frontend fixtures/claims | PR177 removed redundant records tests; umbrella findings remain open | 7 |
| 08 display/dead interfaces | Six-item subset saved in draft PR180; none merged | 9 |
| 09 shared route/UI contracts | Done, PR169 | 0 |
| 10 schedule rendering | Done, PR173 | 0 |
| 11 roster presentation | Three done, PR176 | 5 |
| 12 marketing scene | Done, PR165 | 0 |
| 13 dependency advisories | Done, PR166; outside original audit | 0 |

The remaining original batch assignments total 55. The newly transferred application findings add 101 pending Sol observations; their existing ledger recipes/dependencies remain authoritative, but additional delegated batch files have not been written. Do not assume the original batch index covers all 156 pending Sol findings.

Latest ownership overrides the earlier risk-based recipes: Sol owns all backend/frontend work, including money, authorization and workflow implementation. Astra personally owns all Supabase changes, migrations, SQL contracts, verification and database concurrency proofs. Mixed changes need one coordinated design; never delegate the database portion to Sol. No production execution or extra infrastructure is authorized.

## Saved work and next PR

Draft [PR180](https://github.com/ronchak/Koaryu/pull/180), `codex/remediation-dead-ui-interfaces`, is committed and pushed at `6877268ce2b2fb98ed90ac19e0b68a2eba7f50b6`. Worktree: `/Users/openclaw/Projects/Koaryu-Worktrees/remediation-dead-ui-interfaces`. It is the only paused remediation implementation.

It removes obsolete frontend interfaces, an empty export-history panel and the misleading live belt test. Scope: FT1-01, FT1-02, CTA2-02, FC1-11, FC1-12, FC1-13. Recipe on that branch: `docs/remediation/delegated/14-dead-ui-interface-closeout.md`. Root inspected the frontend diff; 56 targeted tests and the standard frontend build passed with synthetic build-only environment values. Tests/e2e shrink by 157 lines and three obsolete cases. Fresh independent review is still required. CI on a draft is not permission to merge it.

The next PR to finish is #180: it is already bounded, implemented and saved, and finishing it avoids parallel unfinished work. Rebase onto final main, preserve the newer ledger, obtain a fresh reviewer with only its diff/plan, run relevant verification and exact-head CI, then use the guarded merge. Do not expand it into billing, dates or database changes.

After #180, prioritize PROGRAM-ACTIVATION-01 with BB1-06 and BT1-02. A coordinator reproduction produced three active students but provider quantity 2 after a transient pre-provider read was mislabeled as cancellation, another enrollment activated, and the original request retried with a stale quantity. A catch-only fix is insufficient. Separate stable request identity from derived execution facts; preserve already-attempted financial operations. Astra must own any migration/lease contract and Sol the backend. No fix or V46 was started.

Other known high-consequence pending work includes invoice overdue/currency facts, unknown provider facts, family-level attribution, cancellation worker starvation and lock ordering, payer setup locks and invoice closeout locks. These are unresolved, not accepted release risks. Do not claim the product-integrity audit is closed or enable live billing on that basis. The Program-omitted/belt policy is still unanswered; preserve the safe refusal until the owner chooses. All previously settled product decisions in REMEDIATION.md remain in force.

## Traps and follow-ups, log only

- CI is tied to a full SHA. Older green PR178 heads and PR180's pre-rebase green checks are not evidence for another candidate. Require main's own push-triggered Release candidate run after the final documentation merge.
- All program commits must remain pushed. The final sweep checks every Koaryu worktree. Old non-remediation PRs #63–74 were not created or advanced here; some remain non-draft. They are outside this wind-down and must not be mistaken for active remediation work.
- The retired attestation worker had 12 untracked prototype files. They were copied, hash-verified and removed from that obsolete worktree, not merged. Archive: `/Users/openclaw/Koaryu Remediation/2026-09-07/winddown/retired-attestation-prototype/archive-manifest.json`.
- The full import proof's disposable PostgreSQL cluster was removed, as were the currency probes. No partially applied local migration is a continuation point. Fresh SQL work starts with the complete ephemeral verifier. The canonical Supabase link is staging; the guarded rollout creates its own target-specific detached worktree. Never run contracts against production.
- No formatter configuration exists: no ruff/black/prettier/editorconfig. Recommend a pinned formatter gated in CI as separate future work; none was added now.
- `frontend/src/lib/billing-report-actions-model.ts` throws when `crypto.randomUUID` is absent. Plain-HTTP origins lack this secure-context API, so external-payment recording can fail. The reported path remains untested and undocumented; no fix was started.
- Three backend tests are reported wall-clock-sensitive: a 35ms deadline test and two export tests can trip the real 15s budget on a loaded machine. Stabilize them separately without removing the production deadline. Do not weaken CI to hide this.
- The owner reported `import-retry-ownership-verification.md:27` saying 870 when the count was 884. The current rewritten note no longer contains that 870 claim. Preserve this as a documentation-drift warning; do not manufacture a new 884 count or churn code to match it.
- Seven `scripts/verify-v*-restore-contract.py` files are reported 56–65% identical. Review that residual duplication separately. Do not rewrite historical migrations or weaken byte-equivalence checks.
- A symlinked `frontend/node_modules` failed Turbopack's outside-root check in the parked worktree. Physical copied dependencies fixed it. The first build then lacked Supabase build variables; a build using synthetic values passed. No production secrets were used.
- Private evidence: `/Users/openclaw/Koaryu Remediation/2026-09-07/winddown`, `import-ownership`, `activation-readiness`, `currency-intents`, `dead-ui-interfaces`. Do not commit dumps, credentials, inspection tokens or private operator evidence.

## Resume checks

```bash
git fetch origin
git status --short --branch
git rev-parse origin/main
gh pr view 180 --json isDraft,headRefOid,baseRefOid,statusCheckRollup
gh run list --branch main --workflow 'Release candidate' --limit 3
```

Read current AGENTS.md, the private operator guidance and the release packet before any release work. Keep production auto-deploy off. The release packet names missing evidence explicitly; preparing commands does not satisfy those gates.

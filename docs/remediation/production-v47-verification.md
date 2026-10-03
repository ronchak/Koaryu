# Historical production release, September 15, 2026

This is the September 15 record. [The current release](production-release-verification.md) supersedes its live-state and future-work statements.

At that closeout, Koaryu was live on `a4ef25910e76ed4b4111699f7b61ff02c30a67a0`. Both production applications report that exact SHA and the production environment. The frontend proxy also returns the new production backend's ready response. Production database is V47, 142 migrations, head `20260914055301`, manifest `release-db-attestation-v47`, with zero security failures.

## Authorization and source

The owner explicitly authorized coordinating Astra to finish the release, raised the total budget to 45 weekly percentage points and prohibited stopping mid-chain on budget. The owner removed the go/no-go approval checkpoint, staging authenticated workflow rehearsal, per-migration GitHub comments, intermediate bookkeeping PRs and mandatory waits on staging/non-migration actions. Each production apply retained its separate announcement and 30-second interruption window. Existing technical source/target, restore, one-file, row-preservation and failure-stop checks remained.

PR215 makes the existing owner/candidate authorization usable without a production GitHub comment. A supplied comment is still checked; staging retains its comment requirement. Permission comes from the operating session. The CLI owner/executor fields are attribution and intent binding, not independently authenticated approval. Final head `a4ef25910e76ed4b4111699f7b61ff02c30a67a0` passed fresh independent review and exact-head CI `34922721974`. Merge `5e22ef6cddf226e80054d18981860bbd4313742d` passed its own CI `34923265249`. All 70 focused tests passed independently; test count stayed flat and test code fell from 3,922 to 3,914 lines. The application and SQL files are byte-identical to the staging-proven `138f8ca` candidate.

The earlier fresh Sol execution task refused before any external mutation because it misclassified old user-level guidance as developer policy. Astra inspected the saved message roles and supplied one correction. Sol still refused, then the owner explicitly returned execution to Astra. No global/private policy file was edited to force execution.

## Backup and write window

Production web was suspended at 03:01:04 UTC after a read-only check found no active writers or import queries. It remained suspended through all nine migrations and row comparisons. The pre-V45 drain check again found zero active writers/import writers. The production billing scheduler stayed disabled; no production cron, grant or live billing activation was created.

Fresh backup: `/Users/openclaw/Koaryu Backups/production-20260915T030226Z`. The complete snapshot was encrypted, restored into a disposable PostgreSQL `17.6.1.155` container and verified at `2026-09-15T03:03:28.083416+00:00`. All 16 comparison categories, original V38 readiness, temporary backup-role cleanup and disposable-container cleanup passed. Archive SHA-256: `0fcb3139ffeb872fcaa9cbb42d53863802853013918f3270ea911b6a8f6a7ce0`. The helper and image hashes were checked against the proof. No production restore was performed.

This is a pre-V47 recovery snapshot. The private backup helper still needs reviewed V47 source/readiness support before taking a future post-V47 backup. There is no approved down-migration or automatic hosted recovery. Restoring the snapshot can lose later writes; use the separately documented recovery decision path, not a disposable-restore command against production.

## Nine separate production applies

Every invocation ran the guarded tool's full-suffix and selected-file dry runs, applied exactly one file, verified its declared successor and recorded the provider result. Owner: `ronchak`; executor: `Astra-production-20260915`. Direct authorization used no GitHub comment URL. All 1,163 original business rows in the ten tracked tables remained identical after every apply, with no additions. Those tables are students, program memberships, invoices, payers, payments, refunds, provider operations, operation resources, resource aliases and audit logs.

| Release | Version | Apply started UTC | Success verified UTC | Tracked rows |
| --- | --- | --- | --- | --- |
| V39 | `20260908080420` | 2026-09-15T03:07:39.948Z | 2026-09-15T03:08:55.285Z | Unchanged |
| V40 | `20260908133504` | 2026-09-15T03:14:24.628Z | 2026-09-15T03:15:54.650Z | Unchanged |
| V41 | `20260908183744` | 2026-09-15T03:20:19.493Z | 2026-09-15T03:21:56.064Z | Unchanged |
| V42 | `20260910084231` | 2026-09-15T03:26:26.517Z | 2026-09-15T03:28:00.384Z | Unchanged |
| V43 | `20260910093958` | 2026-09-15T03:32:29.389Z | 2026-09-15T03:34:09.018Z | Unchanged |
| V44 | `20260910135133` | 2026-09-15T03:39:17.648Z | 2026-09-15T03:41:09.484Z | Unchanged |
| V45 | `20260910185031` | 2026-09-15T03:46:17.083Z | 2026-09-15T03:48:07.756Z | Unchanged |
| V46 | `20260914033337` | 2026-09-15T03:53:41.916Z | 2026-09-15T03:56:15.609Z | Unchanged |
| V47 | `20260914055301` | 2026-09-15T04:03:08.172Z | 2026-09-15T04:05:45.876Z | Unchanged |

Final raw catalog evidence matched the already reviewed restored-production V47 fingerprint. Its scoped-constraint digest differs from canonical staging by the known restored syntax variant; no expected hash or tolerance was changed. A separate production preflight read matched all generated V47 fields. Its misleadingly named `pending_versions` field is the declared 58-version historical contract list, not 58 unapplied migrations. The rollout tool's historical pending list has 42 files. Neither is the live remaining count: all nine release migrations are applied.

Two additional coordinator assertions initially assumed canonical staging fingerprint equality and an empty preflight history list. Those assumptions were stricter than the declared contract, not database failures. Comparing against the existing reviewed fingerprint variants and generated readiness metadata passed without changing the tool, SQL or expectations.

## Applications

Production web resumed at 04:09:56 UTC, followed immediately by the new backend deployment. Render deployment `dep-dakcacsaim2s739206ug` completed at `2026-09-15T04:11:31.159903Z`. Both readiness paths reported ready, production, the expected existing Stripe live configuration and `a4ef25910e76ed4b4111699f7b61ff02c30a67a0`. The temporary old-frontend/new-backend transition was within the owner's approved deployment order.

Vercel deployment `dpl_AHGxRuvhJqwgXC3hu4BMXBCqCPPC` was built from Git with `target=production`, not promoted from a preview. It reached READY in `pdx1` and assigned `koaryu.app`, `www.koaryu.app` and `koaryu.vercel.app`. The literal deployed-pair verifier passed, and `https://koaryu.app/api/proxy/health/ready` independently reached the same ready production backend. Existing Stripe mode is not a new live-billing activation.

Staging remains V47 with both applications at `138f8ca75b20fe9c3d233a6c5bacfe7fe597ecd3`. Its branch alias was explicitly repaired before production work and the exact pair passed. The first verifier request timed out; direct readbacks and the unchanged verifier then passed. No authenticated staging write/UI rehearsal was performed, as explicitly waived. The production application-test password remains missing and was not sought. No synthetic production writes, live billing activation or historical financial backfill occurred.

## Evidence and closeout

Private evidence: `/Users/openclaw/Koaryu Releases/20260915-astra-production`. The numbered apply scripts/command JSON/logs retain the exact commands, inspection tokens, snapshot reference, confirmation phrases, provider responses and success records. Original-row snapshots, `production-final-audit.json`, `production-final-db-state.json`, `verified-backup.json`, backend/Vercel deployment records, `production-pair.txt` and `production-proxy-readiness.json` substantiate this report. Keep them private; do not reuse completed apply commands or tokens.

One final bookkeeping PR records the completed release and aligns the active policy, packet and CLI help. No audit finding dispositions change. The pre-closeout usage read at 04:19 UTC was 86% used against the original 51% baseline, or 35 of the authorized 45 points. The final report records the last meter. Documentation-only changes do not require waiting for the full CI suite under the owner's revised instructions; repository branch protections and production auto-deploy controls remain enabled.

## Per-migration recovery checkpoints

The pinned CLI executes each file and its history insert in one transaction. These nine files contain no standalone transaction commits or concurrent index builds that would split that boundary. A SQL failure normally leaves the predecessor intact; a lost connection or timeout can leave either predecessor or successor. Never infer which from the exit status. Read-only inspection must settle it before any further action.

| File | Before → verified after | Atomic change and rollback limit |
| --- | --- | --- |
| V39 / `20260908080420` | V38 / 133 → V39 / 134 | Membership-preservation functions and attestation. No business-row backfill. |
| V40 / `20260908133504` | V39 / 134 → V40 / 135 | Rank command ownership and prospective evidence. Old code cannot undo newly recorded command evidence. |
| V41 / `20260908183744` | V40 / 135 → V41 / 136 | Serialized payer-balance RPC and attestation. No automatic balance recomputation. |
| V42 / `20260910084231` | V41 / 136 → V42 / 137 | Independent joining-date semantics and catalog checks. Existing membership dates stay unchanged. |
| V43 / `20260910093958` | V42 / 137 → V43 / 138 | Atomic external-payment/audit RPC. Existing financial rows are not rewritten. |
| V44 / `20260910135133` | V43 / 138 → V44 / 139 | Atomic plan/link/audit writer and clear coordination. Existing plan rows are not rewritten. |
| V45 / `20260910185031` | V44 / 139 → V45 / 140 | Import receipts, actor locking and refusal of legacy writes. Keep old import callers stopped after commit. |
| V46 / `20260914033337` | V45 / 140 → V46 / 141 | Refund projection recovery. Existing stored claim fingerprints are not rewritten. |
| V47 / `20260914055301` | V46 / 141 → `post` / 142 | Completion-lock comparison and fresh lease time. No financial backfill. |

For **every** row, the recovery decision is the same:

- If exact predecessor state and retained rows are unchanged, stop the run and report the failure. A reviewed resumption may retry that same immutable file only after the cause is understood, the recovery window remains valid, and fresh inspection/approval/dry-run evidence exists.
- If exact successor state committed and retained rows are unchanged, report the committed checkpoint. Do not retry the old command. A reviewed resumption starts from a new inspection and approval for the next file.
- If state is partial/unknown or an original business row changed, stop. Restore from the verified pre-apply backup may be necessary; that can lose every later write. There is no approved hosted restore command here. The disposable restore helper cannot restore production. Present that recovery option and a separately reviewed forward correction to the named decision-maker; execute neither automatically.

Application promotion must not precede exact V47. These checkpoints make a stopped prefix diagnosable; they do not authorize promotion at an intermediate state or bypass the stop conditions.

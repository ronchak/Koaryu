# Production release packet: V38 to V45

**Forward-only release. There is no approved down-migration. No fresh pre-apply backup/restore proof exists for this release, and no hosted V45 staging rehearsal has been completed. Do not apply or promote yet.** V40 adds durable command evidence; V45 retires legacy import writes. An application rollback cannot undo those changes or re-enable old imports. A database recovery can lose writes after its snapshot. Production has no verified managed point-in-time restore path.

**Database first, backend second, frontend last. Neither application may be promoted before all seven migrations are applied and independently verified.** The new backend requires RPCs absent from production V38 and fails readiness before V45.

This is a human execution recipe, not approval or evidence that the release happened. No command below was executed in production apply/deploy mode by the remediation task. Keep live billing activation, historical financial backfill, production auto-deploy and unrelated provider changes out of this release. Known financial/concurrency findings remain pending in [HANDOFF.md](HANDOFF.md); production acceptance must explicitly account for affected workflows rather than treating merged CI as acceptance of those risks.

## Pinned candidate and observed state

Implementation candidate: `f942dad3509a2e2cc9b55d546c2d22e097f77abe`, main after PR178. Subsequent wind-down documents do not change its runtime/schema bytes. If choosing another SHA, regenerate every packet, approval, staging proof and deployment request against that SHA. Never edit this variable merely to make a stale approval pass.

Read-only inspection on September 11, 2026 UTC confirmed both staging and production at exact `v38`, 133 migrations, head `20260905022339`. Production image: `17.6.1.155`, status `ACTIVE_HEALTHY`. Frontend and backend both served `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`, environment production, backend Stripe live. Render returned `autoDeploy=no` and `autoDeployTrigger=off`; deployed and candidate `frontend/vercel.json` both disable main auto-deployment. Recheck all of this at execution time.

Expected final state: `post`, 140 migrations, head `20260910185031`, history `140:994d9179efe759ecac8cb7110d8185a5`, full preflight V26, manifest `release-db-attestation-v45`, 56 pending-history versions, zero security failures. HTTP readiness reports `status=ready`; it does not echo the manifest string.

## Exact ordered production remainder

SHA-256 binds the final file bytes, not merely the Git commit where a file first appeared. The guarded tool also verifies ancestry, predecessor definitions, history and the raw catalog. Remote migration history has no intrinsic file content hash.

| Order | Migration | SHA-256 |
| --- | --- | --- |
| 134 / V39 | `20260908080420_student_membership_preservation_v39.sql` | `20a361288b22aa82358619c581adbca3410ffb8714e73ec3e7f729c7b4f0cb23` |
| 135 / V40 | `20260908133504_rank_history_command_ownership_v40.sql` | `e92452b6ae034b6ee1ef5f9ce2db6047f39f25a053cc5604233508ebc2a7dba2` |
| 136 / V41 | `20260908183744_serialize_billing_payer_balance_v41.sql` | `c8471ad12c1f534d0fe216a7f77db4c0dcfab1e1cc8f75075a2d6683fbc65ab7` |
| 137 / V42 | `20260910084231_independent_program_joining_dates_v42.sql` | `33df4f374ec26a8c17814f8d794f5b06a7dcd9a7cdf21d469fc622180f86e0f2` |
| 138 / V43 | `20260910093958_external_payment_command_ownership_v43.sql` | `a1378090e4988eeb372eee8d03038fbbd6aa03020627b0c65257395a9ab5b1ed` |
| 139 / V44 | `20260910135133_local_plan_write_ownership_v44.sql` | `415a81f7f858edcaafbf1c5dd51ec13e19f179298abe636fa8425347889d729b` |
| 140 / V45 | `20260910185031_student_import_retry_ownership_v45.sql` | `98e6da0a9a27165ca3cef349d282c54954608dad15fac918b048d9ceed27ecb7` |

The seven-file remaining manifest is `02e1ae79bf8f4dcdf9fd7e94c018d414c394c94d6d66655c142ce56ff497c3ec`. The full packet's historical pending list is longer and has a different manifest. Apply only the state-derived `remaining_migrations`, never the full historical `pending_migrations` list manually.

All seven are forward corrections, without historical financial backfill. V39/V42 replace student date/membership behavior; V40 adds nullable promotion command fields and immutable prospective evidence; V41 adds serialized payer recomputation; V43 adds atomic external-payment/audit ownership; V44 adds atomic plan/link/audit ownership; V45 adds private receipts and a default-false legacy-run marker. DDL can wait on active writers. V40 alters the promotions table; V45 alters import runs. Measure staging duration and lock waits; do not assume a zero-downtime migration.

## 1. Start the attended terminal and pin sources

Read repository AGENTS.md, supabase/AGENTS.md, docs/services.md, docs/cutover-gates.md and both private operator files first. Use a real interactive Bash terminal. If the terminal starts in zsh, run `bash` first; the `read -p` commands below use Bash syntax. Never pipe a production confirmation or synthesize a PTY.

```bash
set -euo pipefail
set +x
source /Users/openclaw/.config/koaryu/operator/release-env.sh
cd /Users/openclaw/Projects/Koaryu-Repo
export KOARYU_CANDIDATE=f942dad3509a2e2cc9b55d546c2d22e097f77abe
export KOARYU_RELEASE_DIR="/Users/openclaw/Koaryu Releases/V45-$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$KOARYU_RELEASE_DIR"
git fetch origin
test -z "$(git status --porcelain)"
git merge-base --is-ancestor "$KOARYU_CANDIDATE" origin/main
git worktree add --detach "$KOARYU_RELEASE_DIR/candidate" "$KOARYU_CANDIDATE"
cd "$KOARYU_RELEASE_DIR/candidate"
test "$(git rev-parse HEAD)" = "$KOARYU_CANDIDATE"
supabase --version
node scripts/studio-comp-migration-rollout.mjs --mode packet \
  --candidate-sha "$KOARYU_CANDIDATE" > "$KOARYU_RELEASE_DIR/packet.txt"
gh run list --commit "$KOARYU_CANDIDATE" --workflow 'Release candidate' \
  --json databaseId,headSha,status,conclusion > "$KOARYU_RELEASE_DIR/ci.json"
```

Require Supabase CLI `2.95.4`, `integration_complete=true`, the exact candidate SHA, and a successful completed Release candidate run on that SHA. Private credentials/dumps/evidence remain outside Git. Do not source backend `.env`, use Vercel `[SENSITIVE]` exports as real keys, weaken transport guards, or reuse V38 approval files.

Local full verification already passed 140 migrations and 52 contracts, all restore/negative/concurrency checks on byte-identical candidate SQL. A repeat, if needed, is `KOARYU_PG_BIN_DIR=/usr/local/opt/postgresql@17/bin npm run check:supabase-contracts-local`; it creates and removes only disposable local PostgreSQL. It is not production restore evidence.

## 2. Rehearse on staging, then verify its database

These are attended staging actions, not performed by this wind-down. Inspect first:

```bash
node scripts/studio-comp-migration-rollout.mjs --target staging --mode inspect \
  --candidate-sha "$KOARYU_CANDIDATE" > "$KOARYU_RELEASE_DIR/staging-inspect.txt"
export KOARYU_STAGING_TOKEN="$(sed -n 's/^inspection_token=//p' "$KOARYU_RELEASE_DIR/staging-inspect.txt")"
node scripts/studio-comp-migration-rollout.mjs --target staging --mode dry-run \
  --candidate-sha "$KOARYU_CANDIDATE" --inspection-token "$KOARYU_STAGING_TOKEN" \
  > "$KOARYU_RELEASE_DIR/staging-dry-run.txt"
sed -n '/^approval_record_body_begin$/,/^approval_record_body_end$/p' \
  "$KOARYU_RELEASE_DIR/staging-inspect.txt" | sed '1d;$d' \
  > "$KOARYU_RELEASE_DIR/staging-approval.txt"
```

Require `state=v38` and exactly the seven filenames above in both the inspection remainder and dry-run. Any different state requires a newly reviewed state-specific packet. If already `post`, do not dry-run/apply; verify its fingerprint and proceed with the remaining evidence gates.

As GitHub owner `ronchak`, review the exact generated approval body and post it to **PR138**, not PR178. The existing tool pins that approval location and OWNER identity. Preserve its returned URL:

```bash
gh api user --jq .login
gh pr comment 138 --repo ronchak/Koaryu \
  --body-file "$KOARYU_RELEASE_DIR/staging-approval.txt"
read -r -p 'Paste the new PR138 staging approval URL: ' KOARYU_STAGING_APPROVAL
node scripts/studio-comp-migration-rollout.mjs --target staging --mode apply \
  --candidate-sha "$KOARYU_CANDIDATE" --inspection-token "$KOARYU_STAGING_TOKEN" \
  --confirm-project nxgsektqsgrtyfhawxbc --approval-record "$KOARYU_STAGING_APPROVAL" \
  --approve-staging-apply
node scripts/studio-comp-migration-rollout.mjs --target staging --mode inspect \
  --candidate-sha "$KOARYU_CANDIDATE" > "$KOARYU_RELEASE_DIR/staging-post.txt"
```

Require `state=post` and save its complete `provider_fingerprint`. Record per-migration duration, longest observed lock waits and relevant table cardinalities privately. Use current staging credentials to run all 52 contracts and their service/anon/authenticated privilege checks; the runner refuses production:

```bash
python3 - <<'PY'
import os, pathlib, subprocess, urllib.parse
password = pathlib.Path('/Users/openclaw/.config/koaryu/secrets/staging-supabase-db').read_text().strip()
env = dict(os.environ, SUPABASE_DB_TARGET='linked')
env['SUPABASE_DB_URL'] = 'postgresql://postgres.nxgsektqsgrtyfhawxbc:' + urllib.parse.quote(password, safe='') + '@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require'
subprocess.run(['bash', 'scripts/verify-supabase-contracts.sh'], env=env, check=True)
PY
```

The endpoint above is the verified staging session pooler, port5432. Stop on credential or target-validation failure; do not weaken the guard or substitute production. All contract data must be synthetic/rolled back. A real production dump must never be supplied to the synthetic restore/concurrency scripts.

Then deploy the **same candidate** staging backend, keeping the staging cron suspended. Use the existing Render dashboard to confirm that suspension; do not activate any worker in this packet.

```bash
render deploys create srv-d98g4kutrd3s73ek0elg \
  --commit "$KOARYU_CANDIDATE" --wait --output json
```

Require both staging backend `/health/ready` and `/api/v1/health/ready` URLs to report ready, environment staging, Stripe test and the exact candidate. Only after that, move the staging branch with an explicit lease; this triggers its frontend build:

```bash
git fetch origin refs/heads/staging:refs/remotes/origin/staging
KOARYU_OLD_STAGING="$(git rev-parse refs/remotes/origin/staging)"
git push origin "$KOARYU_CANDIDATE:refs/heads/staging" \
  --force-with-lease="refs/heads/staging:$KOARYU_OLD_STAGING"
test "$(git ls-remote --heads origin refs/heads/staging | awk '{print $1}')" = "$KOARYU_CANDIDATE"
```

Wait for its Vercel Git build to be READY, then:

```bash
npm run verify:deployed-release -- --environment staging \
  --expected-sha "$KOARYU_CANDIDATE" \
  --frontend-origin https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app \
  --backend-api https://koaryu-staging.onrender.com/api/v1 --expected-stripe-mode test
```

With the existing attended staging login and synthetic records, record import retry, ordinary student edits, rank history, external-payment replay and unchanged plan saves. Record expected before/after values and any refresh failure distinctly from save failure. Do not create new live grants or rely on the partial sensitive frontend export. A database-only staging proof is not complete application rehearsal.

## 3. Establish the production write window and fresh backup

This gate uses the single current backup owner documented in
[staging-recovery-runbook.md](../staging-recovery-runbook.md#current-backup-owner-and-retained-storage-procedure).
The older public dump recipes and completed image-patch shell program are historical and
must not be used as alternatives.

Arrange an attended maintenance window. Stop new imports and allow all old import requests to finish before V45. Confirm no legacy import writer is still executing; incomplete historical runs without receipts must remain blocked after the upgrade. Stop operator billing mutations and keep production scheduling/activation disabled as already configured. Record the old serving SHA, worker inventory, drain evidence and the time staff stopped writes. If a controlled pause/drain cannot be established, stop here; no new maintenance infrastructure is included in this packet.

Re-read production auto-deploy off and the serving pair. Reinspect production with the pinned candidate; require exact V38. The private backup helper currently supports this **source** state, count133/preflight19, and image `17.6.1.155` with digest `sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b`. Confirm the provider still matches before use. It does not yet support a new V45 backup's readiness mapping; do not describe it as a post-V45 backup tool.

Only the human operator now runs the allowed temporary backup-role workflow:

```bash
/Users/openclaw/Projects/Koaryu-Repo/backend/venv/bin/python -I \
  /Users/openclaw/.config/koaryu/operator/backup-restore.py backup \
  --count 133 --head 20260905022339
read -r -p 'Paste the NEW backup directory printed by the helper: ' KOARYU_BACKUP_DIR
export KOARYU_BACKUP_DIR
/Users/openclaw/Projects/Koaryu-Repo/backend/venv/bin/python -I \
  /Users/openclaw/.config/koaryu/operator/backup-restore.py restore "$KOARYU_BACKUP_DIR"
```

The helper takes a complete snapshot without schema filters, encrypts it, drops the temporary role, restores into a disposable exact-image container and compares all 16 evidence categories. Require a new `restore-proof.json` with `status=VERIFIED`, correct archive/helper/image hashes, `source_role_cleanup=PASS`, `restored_readiness=PASS`, all comparison categories passing and disposable-container cleanup. Record the snapshot time, last verified restore, named recovery decision-maker, and accepted maximum loss window. The September6 V38 backup is historical, not a fresh pre-apply backup. Do not assert `--confirmed-restore-window` until this evidence exists.

The synthetic V38→V45 restore chain has passed, preserving business rows and legacy readiness. That is separate from this new production snapshot restore. Any changed image, source mapping or unknown dump representation requires reviewed helper support and fresh proof before apply. Never normalize production objects or repair migration history to force a pass.

## 4. Inspect, approve and dry-run production again

```bash
node scripts/studio-comp-migration-rollout.mjs --target production --mode inspect \
  --candidate-sha "$KOARYU_CANDIDATE" > "$KOARYU_RELEASE_DIR/production-inspect.txt"
export KOARYU_PRODUCTION_TOKEN="$(sed -n 's/^inspection_token=//p' "$KOARYU_RELEASE_DIR/production-inspect.txt")"
node scripts/studio-comp-migration-rollout.mjs --target production --mode dry-run \
  --candidate-sha "$KOARYU_CANDIDATE" --inspection-token "$KOARYU_PRODUCTION_TOKEN" \
  > "$KOARYU_RELEASE_DIR/production-dry-run.txt"
sed -n '/^approval_record_body_begin$/,/^approval_record_body_end$/p' \
  "$KOARYU_RELEASE_DIR/production-inspect.txt" | sed '1d;$d' \
  > "$KOARYU_RELEASE_DIR/production-approval.txt"
export KOARYU_STAGING_FINGERPRINT="$(sed -n 's/^provider_fingerprint=//p' "$KOARYU_RELEASE_DIR/staging-post.txt")"
```

Compare the new state, ordered seven-file remainder and manifest with this packet. An inspection token from this document's preparation is not supplied or reusable. The tool checks the staging fingerprint against the complete canonical V45 tuple before production apply; it accepts only that tuple or the explicitly proven restored-production variant.

As `ronchak`, post the exact new production approval body to PR138 only after staging rehearsal, backup/restore and the maintenance window are accepted:

```bash
gh pr comment 138 --repo ronchak/Koaryu \
  --body-file "$KOARYU_RELEASE_DIR/production-approval.txt"
read -r -p 'Paste the new PR138 production approval URL: ' KOARYU_PRODUCTION_APPROVAL
read -r -p 'Verified backup/proof path, snapshot time and accepted recovery window: ' KOARYU_RESTORE_RECORD
read -r -p 'Name of the person authorized to decide disaster recovery: ' KOARYU_RESTORE_OWNER
```

## 5. Human-only production apply and database verification

Run directly in the real terminal, with stdin and stdout attached. Do not pipe through `tee`, redirect stdout, or pre-submit the phrase. The tool prints the exact candidate/remainder-bound phrase for the human to type.

```bash
node scripts/studio-comp-migration-rollout.mjs --target production --mode apply \
  --candidate-sha "$KOARYU_CANDIDATE" --inspection-token "$KOARYU_PRODUCTION_TOKEN" \
  --confirm-project mimguepumzsgmcaycdsh --approval-record "$KOARYU_PRODUCTION_APPROVAL" \
  --human-production-operator --expected-provider-fingerprint "$KOARYU_STAGING_FINGERPRINT" \
  --confirmed-restore-window "$KOARYU_RESTORE_RECORD" \
  --restore-decision-authority "$KOARYU_RESTORE_OWNER"
node scripts/studio-comp-migration-rollout.mjs --target production --mode inspect \
  --candidate-sha "$KOARYU_CANDIDATE" \
  --expected-provider-fingerprint "$KOARYU_STAGING_FINGERPRINT" \
  > "$KOARYU_RELEASE_DIR/production-post.txt"
```

The tool applies the ordered suffix, each migration and its history entry transactionally. Each successor checks its predecessor. After each committed file, the expected count/head advances through the table above; record provider timing/lock evidence. On any error, stop and re-inspect before another command that could mutate state. A timeout may have committed. Do not manually apply individual SQL files, run production contracts, use history repair or blindly retry the old packet.

Require final `state=post`, exact140/headV45, matching approved fingerprint and zero failures. The tool independently checks raw function definitions/ACLs and the manifest, including the narrow private Auth-lock helper and receipt ownership. Only then may application promotion begin.

## 6. Deploy the backend, verify it, then build the production frontend

This section is for the separately accepted production release, not this wind-down. Keep production worker activation and new billing grants out of scope. Commands use existing provider logins.

```bash
render deploys create srv-d7mogk1kh4rs73aq6hqg \
  --commit "$KOARYU_CANDIDATE" --wait --output json
```

Require the Render deploy's commit to equal the candidate. Both `https://koaryu.onrender.com/health/ready` and `https://koaryu.onrender.com/api/v1/health/ready` must return `status=ready`, `environment=production`, `configured_stripe_mode=live` and the exact candidate SHA. Inspect serving instances and let old requests drain. The V41/V43/V44 serialization/atomicity guarantees begin only after **all** serving backends/workers use the new RPCs and old split-write requests have finished. Do not call V33 retry-hash finalization during this release.

Create a new production-target Git build, never promote an existing preview:

```bash
python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ['KOARYU_RELEASE_DIR']) / 'vercel-production-request.json'
p.write_text(json.dumps({'name':'koaryu','project':'prj_ROzEAXoVf0NbUn3jNIKEJPWjF9HU','target':'production','gitSource':{'type':'github','repoId':1214065065,'ref':os.environ['KOARYU_CANDIDATE']}}, indent=2)+'\n')
PY
cd /Users/openclaw/Projects/Koaryu-Repo/frontend
vercel api '/v13/deployments?teamId=team_gLZEwMI0jgTr9zGABNt3Rude' \
  --method POST --input "$KOARYU_RELEASE_DIR/vercel-production-request.json"
cd "$KOARYU_RELEASE_DIR/candidate"
```

Wait for the returned deployment to be READY, with production variables and the intended production aliases. Verify Functions region `pdx1`, and that browser API requests go to `koaryu.onrender.com`. Then:

```bash
npm run verify:deployed-release -- --environment production \
  --expected-sha "$KOARYU_CANDIDATE" --frontend-origin https://koaryu.app \
  --backend-api https://koaryu.onrender.com/api/v1
```

Do not pass `--expected-stripe-mode` for production. Check tenant authorization, ordinary reads and retained record values without creating historical financial changes. Re-read auto-deploy controls off and save final provider/deployment identities privately. Reopen affected staff workflows only after the new pair and drain evidence pass. Keep unresolved financial risks and live-billing gates explicit.

## Compatibility and recovery

| Backend | Database-first compatibility | Limit |
| --- | --- | --- |
| Currently served `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`, V38 | Its V19 readiness consumer retains the V38 tuple through the compatibility chain after V45. Existing non-import interfaces are retained. | V45 refuses fresh/incomplete legacy imports. Old Python payer/payment/plan split writers do not gain the new guarantees. Use only with affected workflows paused and no newly activated billing. |
| Earlier remediation V39–V44 backend candidates | V20–V25 readiness consumers retain their original exact tuple through the verified compatibility chain. | This is schema/readiness compatibility, not blanket approval of every historical application. All pre-PR178 import callers have the V45 refusal. Prefer the observed deployed artifact for rollback, not an arbitrary old SHA. |
| PR179 merge `7113d130a1523d5048cb9cb15529aed6277a4770`, V44 | V25 compatibility remains. | Includes tuition USD guards but still has legacy import callers; imports remain blocked. |
| PR178 head `c762a480b0e8f7c198b678c0dfcfb5da04075995` or pinned merge `f942dad3509a2e2cc9b55d546c2d22e097f77abe` | Full V26 requires exact V45. | Cannot serve on V38–V44. Use one exact SHA for both deployed surfaces and all release evidence. |

The local restore suite proves retained readiness and scoped old/new business contracts. It does not execute every old backend build. Do not authorize pre-V38, temporary bridge or untested older artifacts by extrapolation.

- **Before any migration commits:** abort the release; the old application and V38 remain. If writes resumed after the backup, its possible loss window increases and must be reassessed.
- **A prefix commits:** keep the old compatible application and affected workflows paused. Reinspect. Exact accepted V39–V44 states may resume only their immutable suffix with a new state-bound token, dry-run and exact-body PR138 approval. An unknown/partially attested state is a stop, not a reason to repair history.
- **All seven commit but candidate deployment fails:** keep the old artifact or redeploy the recorded `c5742fe...` backend with `render deploys create srv-d7mogk1kh4rs73aq6hqg --commit c5742fe393a8bfb3a1faddb1f488e46a00bd5091 --wait --output json`. Verify its V38 compatibility readiness. Leave imports and affected financial writes paused; this restores application availability, not old database semantics. If a frontend rollback is necessary, create a fresh production-target build from that same old SHA using the request shape above, then verify the pair. Never promote a preview.
- **Database/correctness failure:** prefer a reviewed forward correction. There is no approved automated hosted-restore command in this repository. The named human must decide disaster recovery using the new verified snapshot, reconfirm the restore target and image, and accept loss of every later write. The private helper restores only disposable containers; it cannot restore production. Stop here for a separately reviewed hosted-restore operation. Do not invent a down migration or pipe a dump into production.

The private backup helper still needs reviewed V45 support before taking/attesting a future post-V45 backup. Until then, retain the new pre-apply snapshot and its proof. Human approval, provider retention and tested recovery remain real gates, not fields to fill with plausible text.

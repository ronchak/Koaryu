# Production release packet: V38 to V47

**Forward-only release. There is no approved down-migration. No fresh pre-apply backup/restore proof exists for this release, and no hosted V47 staging rehearsal has been completed. Do not apply or promote yet.** V40 adds durable command evidence; V45 retires legacy import writes. An application rollback cannot undo those changes or re-enable old imports. A database recovery can lose writes after its snapshot. Production has no verified managed point-in-time restore path.

**Database first, backend second, frontend last. Neither application may be promoted before all nine migrations are applied and independently verified.** The new backend requires RPCs absent from production V38 and fails readiness before V47.

The owner has authorized coordinating Astra to execute this release under the [announce-and-pause protocol](../cutover-gates.md#owner-authorized-release-execution). This packet is preparation, not evidence that an apply or deployment happened. The owner approved `--one-migration`. It selects the next reviewed file, binds its own inspection/approval/confirmation, and verifies the exact declared successor. Default production bulk apply remains refused. Do not use bulk apply to bypass the required pause before each migration. Keep live billing activation, historical financial backfill, production auto-deploy and unrelated provider changes out of this release. Known financial/concurrency findings remain pending in [HANDOFF.md](HANDOFF.md); production acceptance must explicitly account for affected workflows rather than treating merged CI as acceptance of those risks.

## Pinned candidate and observed state

Release candidate: **not pinned until the one-migration PR merges and its main SHA passes exact-head CI**. Replace the quoted candidate placeholder below with that reviewed SHA during phase-three preparation, then regenerate every packet, approval, staging proof and deployment request. Do not reuse PR207's inspection token or an older packet merely because the migration files match.

Read-only production inspection during this run confirmed exact V38 with eight remaining migrations against PR207 merge `1c10a193e66861fd3e2a8174251910798199eeca`. No migration was applied. V47 subsequently adds one more immutable file, so the new source packet has nine remaining migrations. The earlier inspection token cannot authorize that candidate.

Read-only inspection on September 11, 2026 UTC confirmed both staging and production at exact `v38`, 133 migrations, head `20260905022339`. Production image: `17.6.1.155`, status `ACTIVE_HEALTHY`. Frontend and backend both served `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`, environment production, backend Stripe live. Render returned `autoDeploy=no` and `autoDeployTrigger=off`; deployed and candidate `frontend/vercel.json` both disable main auto-deployment. Recheck all of this at execution time.

The September14 closeout read freshly verified the production frontend/backend pair still at `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`. Private evidence is `production-pair-closeout.txt` under the current release directory. No deployment occurred. The provider image observation above remains older evidence.

Expected final state: `post`, 142 migrations, head `20260914055301`, history `142:d3bab5f085e1c46ce72ab43046b1ca8b`, full preflight V28, manifest `release-db-attestation-v47`, 58 pending-history versions, zero security failures. HTTP readiness reports `status=ready`; it does not echo the manifest string.

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
| 141 / V46 | `20260914033337_refund_projection_recovery_v46.sql` | `ccb5cac239f2270f9342ffd2ed7aeae1f4505cb296b9df10d286971723544b61` |
| 142 / V47 | `20260914055301_refund_completion_locking_v47.sql` | `57a5d14eb376b9941e01ad2dae718e648619ed406992281925993d4edc43cc02` |

The nine-file remaining manifest at preparation is `f9eebe84299dbe2b226fa569a9259706d05c20590dd26b9e5a0d8c5073f5a704`. The full packet's historical pending list is longer and has a different manifest. Apply only the state-derived `remaining_migrations`, never the full historical `pending_migrations` list manually.

All nine are forward corrections, without historical financial backfill. V39/V42 replace student date/membership behavior; V40 adds nullable promotion command fields and immutable prospective evidence; V41 adds serialized payer recomputation; V43 adds atomic external-payment/audit ownership; V44 adds atomic plan/link/audit ownership; V45 adds private receipts and a default-false legacy-run marker. V46 corrects the refund comparison without rewriting a business row or stored claim fingerprint. V47 refreshes that comparison after the receipt lock when a later request overlaps completion. DDL can wait on active writers. V40 alters the promotions table; V45 alters import runs. Measure staging duration and lock waits; do not assume a zero-downtime migration.

## 1. Load credentials and pin reviewed sources

Read repository AGENTS.md, supabase/AGENTS.md, docs/services.md, docs/cutover-gates.md and both private operator files first. Use Bash for this recipe with tracing disabled. A TTY is not an authorization control. Before each irreversible or outward-facing release action, announce its exact command, effect/reversibility and immediate verification, then wait 60 seconds. Run every mutation as its own command; do not paste the packet as an unattended script. Stop if the owner interrupts. Preserve the authorization and execution evidence.

```bash
set -euo pipefail
set +x
source /Users/openclaw/.config/koaryu/operator/release-env.sh
cd /Users/openclaw/Projects/Koaryu-Repo
export KOARYU_CANDIDATE='<reviewed-one-migration-merge-sha>'
export KOARYU_RELEASE_DIR="/Users/openclaw/Koaryu Releases/V47-$(date -u +%Y%m%dT%H%M%SZ)"
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

Local full verification already passed 142 migrations and 53 contracts, all restore/negative/concurrency checks on byte-identical candidate SQL. A repeat, if needed, is `KOARYU_PG_BIN_DIR=/usr/local/opt/postgresql@17/bin npm run check:supabase-contracts-local`; it creates and removes only disposable local PostgreSQL. It is not production restore evidence.

## 2. Rehearse on staging, then verify its database

These staging actions have not run. Start with `KOARYU_STEP=v38`. For each next file, repeat this block with the freshly observed predecessor, never in an unattended loop. Announce and pause separately before each approval post and migration apply.

```bash
KOARYU_STEP=v38
node scripts/studio-comp-migration-rollout.mjs --target staging --mode inspect --one-migration \
  --candidate-sha "$KOARYU_CANDIDATE" > "$KOARYU_RELEASE_DIR/staging-$KOARYU_STEP-inspect.txt"
KOARYU_STAGING_TOKEN="$(sed -n 's/^inspection_token=//p' "$KOARYU_RELEASE_DIR/staging-$KOARYU_STEP-inspect.txt")"
KOARYU_EXPECTED_AFTER="$(sed -n 's/^expected_after_state=//p' "$KOARYU_RELEASE_DIR/staging-$KOARYU_STEP-inspect.txt")"
node scripts/studio-comp-migration-rollout.mjs --target staging --mode dry-run --one-migration \
  --candidate-sha "$KOARYU_CANDIDATE" --inspection-token "$KOARYU_STAGING_TOKEN" \
  > "$KOARYU_RELEASE_DIR/staging-$KOARYU_STEP-dry-run.txt"
sed -n '/^approval_record_body_begin$/,/^approval_record_body_end$/p' \
  "$KOARYU_RELEASE_DIR/staging-$KOARYU_STEP-inspect.txt" | sed '1d;$d' \
  > "$KOARYU_RELEASE_DIR/staging-$KOARYU_STEP-approval.txt"
```

At the first checkpoint require `state=v38` and the full nine-file remainder. At every checkpoint require the full remainder to equal the corresponding suffix of the table, `selected_migrations` to name only its first file, and `expected_after_state` to name its declared successor. The two dry-runs must respectively show that full suffix and that single file. A different state is a stop. An already-complete `post` inspection has no next apply.

The GitHub account must be `ronchak`. Review and post the exact generated single-file approval to PR138, retaining its URL:

```bash
gh api user --jq .login
gh pr comment 138 --repo ronchak/Koaryu \
  --body-file "$KOARYU_RELEASE_DIR/staging-$KOARYU_STEP-approval.txt"
KOARYU_STAGING_APPROVAL='<URL-returned-by-this-step-approval>'
node scripts/studio-comp-migration-rollout.mjs --target staging --mode apply --one-migration \
  --candidate-sha "$KOARYU_CANDIDATE" --inspection-token "$KOARYU_STAGING_TOKEN" \
  --confirm-project nxgsektqsgrtyfhawxbc --approval-record "$KOARYU_STAGING_APPROVAL" \
  --approve-staging-apply > "$KOARYU_RELEASE_DIR/staging-$KOARYU_STEP-apply.txt" 2>&1
node scripts/studio-comp-migration-rollout.mjs --target staging --mode inspect --one-migration \
  --candidate-sha "$KOARYU_CANDIDATE" > "$KOARYU_RELEASE_DIR/staging-$KOARYU_STEP-post.txt"
test "$(sed -n 's/^state=//p' "$KOARYU_RELEASE_DIR/staging-$KOARYU_STEP-post.txt")" = "$KOARYU_EXPECTED_AFTER"
```

Verify retained business rows and the exact successor after each file. Then start fresh inspection/approval for that successor. Only after the V46-to-V47 invocation reports `post`, retain the final staging fingerprint:

```bash
cp "$KOARYU_RELEASE_DIR/staging-v46-post.txt" "$KOARYU_RELEASE_DIR/staging-post.txt"
```

Record per-migration duration, longest observed lock waits and relevant table cardinalities privately. Use current staging credentials to run all 53 contracts and their service/anon/authenticated privilege checks; the runner refuses production:

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

With the existing approved staging login and synthetic records, record import retry, ordinary student edits, rank history, external-payment replay and unchanged plan saves. Record expected before/after values and any refresh failure distinctly from save failure. Do not create new live grants or rely on the partial sensitive frontend export. A database-only staging proof is not complete application rehearsal.

## 3. Establish the production write window and fresh backup

This gate uses the single current backup owner documented in
[staging-recovery-runbook.md](../staging-recovery-runbook.md#current-backup-owner-and-retained-storage-procedure).
The older public dump recipes and completed image-patch shell program are historical and
must not be used as alternatives.

Establish and record a controlled maintenance window. Stop new imports and allow all old import requests to finish before V45. Confirm no legacy import writer is still executing; incomplete historical runs without receipts must remain blocked after the upgrade. Stop operator billing mutations and keep production scheduling/activation disabled as already configured. Record the old serving SHA, worker inventory, drain evidence and the time staff stopped writes. If a controlled pause/drain cannot be established, stop here; no new maintenance infrastructure is included in this packet.

Re-read production auto-deploy off and the serving pair. Reinspect production with the pinned candidate; require exact V38. The private backup helper currently supports this **source** state, count133/preflight19, and image `17.6.1.155` with digest `sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b`. Confirm the provider still matches before use. It does not yet support a new V47 backup's readiness mapping; do not describe it as a post-V47 backup tool.

The named owner-authorized coordinator runs the existing temporary backup-role workflow only after announcing the exact command and waiting 60 seconds:

```bash
/Users/openclaw/Projects/Koaryu-Repo/backend/venv/bin/python -I \
  /Users/openclaw/.config/koaryu/operator/backup-restore.py backup \
  --count 133 --head 20260905022339
KOARYU_BACKUP_DIR='<NEW-directory-reported-by-the-backup-helper>'
export KOARYU_BACKUP_DIR
/Users/openclaw/Projects/Koaryu-Repo/backend/venv/bin/python -I \
  /Users/openclaw/.config/koaryu/operator/backup-restore.py restore "$KOARYU_BACKUP_DIR"
```

The helper takes a complete snapshot without schema filters, encrypts it, drops the temporary role, restores into a disposable exact-image container and compares all 16 evidence categories. Require a new `restore-proof.json` with `status=VERIFIED`, correct archive/helper/image hashes, `source_role_cleanup=PASS`, `restored_readiness=PASS`, all comparison categories passing and disposable-container cleanup. Record the snapshot time, last verified restore, named recovery decision-maker, and accepted maximum loss window. The September6 V38 backup is historical, not a fresh pre-apply backup. Do not assert `--confirmed-restore-window` until this evidence exists.

The synthetic V38→V47 restore chain has passed, preserving business rows and legacy readiness. That is separate from this new production snapshot restore. Any changed image, source mapping or unknown dump representation requires reviewed helper support and fresh proof before apply. Never normalize production objects or repair migration history to force a pass.

## 4. Inspect, approve and dry-run each production step

Start with `KOARYU_STEP=v38`. Repeat inspection and approval only after the preceding file and retained-row checks pass.

```bash
KOARYU_STEP=v38
node scripts/studio-comp-migration-rollout.mjs --target production --mode inspect --one-migration \
  --candidate-sha "$KOARYU_CANDIDATE" > "$KOARYU_RELEASE_DIR/production-$KOARYU_STEP-inspect.txt"
export KOARYU_PRODUCTION_TOKEN="$(sed -n 's/^inspection_token=//p' "$KOARYU_RELEASE_DIR/production-$KOARYU_STEP-inspect.txt")"
node scripts/studio-comp-migration-rollout.mjs --target production --mode dry-run --one-migration \
  --candidate-sha "$KOARYU_CANDIDATE" --inspection-token "$KOARYU_PRODUCTION_TOKEN" \
  > "$KOARYU_RELEASE_DIR/production-$KOARYU_STEP-dry-run.txt"
sed -n '/^approval_record_body_begin$/,/^approval_record_body_end$/p' \
  "$KOARYU_RELEASE_DIR/production-$KOARYU_STEP-inspect.txt" | sed '1d;$d' \
  > "$KOARYU_RELEASE_DIR/production-$KOARYU_STEP-approval.txt"
export KOARYU_STAGING_FINGERPRINT="$(sed -n 's/^provider_fingerprint=//p' "$KOARYU_RELEASE_DIR/staging-post.txt")"
```

Compare the new state and remaining suffix with this packet. The selected file must be exactly next, and its singleton manifest must bind this step's approval and confirmation. Record `expected_after_state` from the inspection. A token from another step or default bulk mode is invalid. An inspection token from this document's preparation is not supplied or reusable. The tool checks the staging fingerprint against the complete canonical V47 tuple before production apply; it accepts only that tuple or the explicitly proven restored-production variant.

As `ronchak`, post the exact new production approval body to PR138 only after staging rehearsal, backup/restore and the maintenance window are accepted:

```bash
gh pr comment 138 --repo ronchak/Koaryu \
  --body-file "$KOARYU_RELEASE_DIR/production-$KOARYU_STEP-approval.txt"
KOARYU_PRODUCTION_APPROVAL='<URL-returned-by-the-owner-approval-comment>'
KOARYU_RESTORE_RECORD='<verified-proof-path-snapshot-time-and-accepted-recovery-window>'
KOARYU_RESTORE_OWNER='<named-authorized-recovery-decision-maker>'
```

## 5. Owner-authorized production apply and database verification

Production remains blocked until all phase-three evidence is complete. Every invocation below applies exactly one reviewed migration and returns control. Supply the deliberate exact phrase in `--confirmation-phrase`; terminal detection has been removed. The phrase format remains `APPLY <count> MIGRATIONS FROM <candidate> MANIFEST <source-manifest> TO mimguepumzsgmcaycdsh`. Validate it against the exact inspected packet. Capture the tool's structured authorization, provider response and outcome records privately. The executor name is caller-reported; it is not proof of process identity.

```bash
node scripts/studio-comp-migration-rollout.mjs --target production --mode apply --one-migration \
  --candidate-sha "$KOARYU_CANDIDATE" --inspection-token "$KOARYU_PRODUCTION_TOKEN" \
  --confirm-project mimguepumzsgmcaycdsh --approval-record "$KOARYU_PRODUCTION_APPROVAL" \
  --release-authorization "ronchak:$KOARYU_CANDIDATE" --release-operator "Coordinating Astra" \
  --confirmation-phrase "${KOARYU_CONFIRMATION:?Set the deliberately reviewed exact phrase}" \
  --expected-provider-fingerprint "$KOARYU_STAGING_FINGERPRINT" \
  --confirmed-restore-window "$KOARYU_RESTORE_RECORD" \
  --restore-decision-authority "$KOARYU_RESTORE_OWNER" \
  > "$KOARYU_RELEASE_DIR/production-$KOARYU_STEP-apply.txt" 2>&1
node scripts/studio-comp-migration-rollout.mjs --target production --mode inspect --one-migration \
  --candidate-sha "$KOARYU_CANDIDATE" \
  --expected-provider-fingerprint "$KOARYU_STAGING_FINGERPRINT" \
  > "$KOARYU_RELEASE_DIR/production-$KOARYU_STEP-post.txt"
```

The tool verifies the full suffix, limits the CLI to its first file and verifies the declared successor after that one apply. The pinned CLI commits a migration and its history entry transactionally. Each successor checks its predecessor. After each committed file, the expected count/head advances through the table above; record provider timing/lock evidence. On any error, stop and re-inspect before another command that could mutate state. A timeout may have committed. Do not manually apply individual SQL files, run production contracts, use history repair or blindly retry the old packet.

For each invocation require the exact `expected_after_state` and unchanged retained rows. Get a new inspection and approval before the next invocation. After V47 require final `state=post`, exact142/headV47, matching approved fingerprint and zero failures. The tool independently checks raw function definitions/ACLs and the manifest, including the narrow private Auth-lock helper and receipt ownership. Only then may application promotion begin.

## 6. Deploy the backend, verify it, then build the production frontend

This section executes only after the authorized database release is fully verified. Keep production worker activation and new billing grants out of scope. Commands use existing provider logins.

```bash
render deploys create srv-d7mogk1kh4rs73aq6hqg \
  --commit "$KOARYU_CANDIDATE" --wait --output json
```

Require the Render deploy's commit to equal the candidate. Both `https://koaryu.onrender.com/health/ready` and `https://koaryu.onrender.com/api/v1/health/ready` must return `status=ready`, `environment=production`, `configured_stripe_mode=live` and the exact candidate SHA. Inspect serving instances and let old requests drain. The V41/V43/V44 serialization/atomicity guarantees begin only after **all** serving backends/workers use the new RPCs and old split-write requests have finished. Do not call V33 retry-hash finalization during this release.

The recorded old-frontend/new-backend pair is allowed only during this transition. Stop for any unexpected SHA. Create a new production-target Git build, never promote an existing preview:

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

The complete application release remains blocked until exact V47. These checkpoints make a stopped prefix diagnosable; they do not authorize promotion at an intermediate state or bypass the stop conditions.

## Compatibility and recovery

| Backend | Database-first compatibility | Limit |
| --- | --- | --- |
| Currently served `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`, V38 | Its V19 readiness consumer retains the V38 tuple through the compatibility chain after V47. Existing non-import interfaces are retained. | V45 refuses fresh/incomplete legacy imports. Old Python payer/payment/plan split writers do not gain the new guarantees. Use only with affected workflows paused and no newly activated billing. |
| Earlier remediation V39–V44 backend candidates | V20–V25 readiness consumers retain their original exact tuple through the verified compatibility chain. | This is schema/readiness compatibility, not blanket approval of every historical application. All pre-PR178 import callers have the V45 refusal. Prefer the observed deployed artifact for rollback, not an arbitrary old SHA. |
| PR179 merge `7113d130a1523d5048cb9cb15529aed6277a4770`, V44 | V25 compatibility remains. | Includes tuition USD guards but still has legacy import callers; imports remain blocked. |
| V45 application candidates from PR178 through PR206 | Their V26 readiness consumers retain the exact V45 tuple through the V46/V47 compatibility bridges. | This proves schema/readiness compatibility, not every historical application build. Prefer the recorded deployed artifact for a rollback. |
| PR207 | V27 retains its exact V46 tuple after V47. | Schema/readiness compatibility only; prefer the recorded deployed artifact for rollback. |
| PR209 and the governance candidate | Full V28 requires exact V47. | Cannot serve before all nine migrations. Deploy one exact candidate SHA to both surfaces. |

The local restore suite proves retained readiness and scoped old/new business contracts. It does not execute every old backend build. Do not authorize pre-V38, temporary bridge or untested older artifacts by extrapolation.

- **Before any migration commits:** abort the release; the old application and V38 remain. If writes resumed after the backup, its possible loss window increases and must be reassessed.
- **A prefix commits:** keep the old compatible application and affected workflows paused. Reinspect. Exact accepted V39–V46 states may resume only their immutable suffix with a new state-bound token, dry-run and exact-body PR138 approval. An unknown/partially attested state is a stop, not a reason to repair history.
- **All nine commit but candidate deployment fails:** keep the old artifact or redeploy the recorded `c5742fe...` backend with `render deploys create srv-d7mogk1kh4rs73aq6hqg --commit c5742fe393a8bfb3a1faddb1f488e46a00bd5091 --wait --output json`. Verify its V38 compatibility readiness. Leave imports and affected financial writes paused; this restores application availability, not old database semantics. If a frontend rollback is necessary, create a fresh production-target build from that same old SHA using the request shape above, then verify the pair. Never promote a preview.
- **Database/correctness failure:** prefer a reviewed forward correction. There is no approved automated hosted-restore command in this repository. The named authorized decision-maker must decide disaster recovery using the new verified snapshot, reconfirm the restore target and image, and accept loss of every later write. The private helper restores only disposable containers; it cannot restore production. Stop here for a separately reviewed hosted-restore operation. Do not invent a down migration or pipe a dump into production.

The private backup helper still needs reviewed V47 support before taking/attesting a future post-V47 backup. Until then, retain the new pre-apply snapshot and its proof. Owner authorization, provider retention and tested recovery remain real gates, not fields to fill with plausible text.

## Execution record

As of governance preparation, no hosted migration, backup/restore, backend deployment or frontend promotion has executed in this run. Phase-three evidence and exact commands must be completed against the final reviewed one-migration SHA before this packet becomes executable. The [operator-policy proposal](operator-governance-proposal.patch) has passed a dry-run; the private operator files remain unchanged.

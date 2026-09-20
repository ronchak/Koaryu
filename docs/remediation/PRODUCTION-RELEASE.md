# Completed V48–V49 production release

**Completed September 20, 2026. Do not rerun these applies.** Production is V49, 144 migrations, head `20260920052705`; both applications serve `591e6299a5d56dcd2623bdc144f5cd5e1dabc9c5`. [Verification](production-release-verification.md) records the proof. The [older V39–V47 release](production-v47-verification.md) is historical.

**The chain is forward-only. There is no approved down-migration or automated production restore.** Its fresh pre-V48 backup and verified disposable restore exist at `/Users/openclaw/Koaryu Backups/production-20260920T071743Z`. A future release needs its own fresh evidence; this snapshot is not future approval. Restoring it can lose all later writes. The private helper restores only disposable containers, never a hosted database.

## Ordered migration list

| Order | File | SHA-256 |
| --- | --- | --- |
| 1 | `20260920035023_enrollment_activation_execution_v48.sql` | `8051505b38d0cb78bc4480ea9e92caa723b92c62ee05323a83e99f81cf5f5f44` |
| 2 | `20260920052705_subscription_unknown_terms_v49.sql` | `b93c130125d6aa2d3da1c0132dbec65a2b4d4d292145d2c31faa2496af5eba5f` |

The source was reviewed PR220 head `591e6299a5d56dcd2623bdc144f5cd5e1dabc9c5`, merged as `c1e1c27c4a3071556958352207da2a435887276b` with an identical tree. Exact-head CI, independent review, all 144 local migrations, 54 local/hosted SQL contracts and canonical/restored continuations passed. Production auto-deploy remained off.

## Execution order and commands retained

These commands are an execution record, not a recipe for applying the completed chain again. Each mutation ran separately. Release shells disabled tracing and explicitly sourced `/Users/openclaw/.config/koaryu/operator/release-env.sh` through the private `shell-init.sh`. All private files below are under `/Users/openclaw/Koaryu Releases/20260919-live-corrections`.

1. Migrate staging with the exact candidate, then run the existing staging-only `staging-contracts.py` launcher. All 54 contracts passed; the 909 original rows remained unchanged. Deploy the staging backend, then advance the staging ref with its observed old SHA as a lease, assign the staging alias and verify the pair.
2. Run `suspend-production-web.py`. Verify Render reports suspended, auto-deploy off and no in-flight API transactions.
3. Run the complete backup and disposable restore below. Inspect `backup.json`, `restore-proof.json`, the restored V47 readiness result and cleanup evidence before any production apply.
4. Capture `production-before-v48-rows.json` with the read-only `retained-rows.py` helper. Inspect production at the exact candidate with `--one-migration`; require V47 and only V48 selected.
5. Announce and wait 30 seconds, then run `/bin/bash '/Users/openclaw/Koaryu Releases/20260919-live-corrections/apply-production-v48.sh'`. Its recorded arguments bind the candidate, V47 inspection token, one-file source hash, deliberate confirmation phrase, staging fingerprint, owner/executor and actual restore proof. Require verified V48 and compare all original rows.
6. Reinspect V48 for V49. Announce and wait another 30 seconds, then run `/bin/bash '/Users/openclaw/Koaryu Releases/20260919-live-corrections/apply-production-v49.sh'`. Require verified V49, count 144, exact final fingerprint and unchanged original rows. Do not loop past a checkpoint.
7. Run `resume-production-web.py`, then `render deploys create srv-d7mogk1kh4rs73aq6hqg --commit 591e6299a5d56dcd2623bdc144f5cd5e1dabc9c5 --wait --output json --confirm`. Require both backend readiness URLs to report this SHA, production, ready and the existing Stripe live configuration.
8. From `frontend/`, run `vercel api '/v13/deployments?teamId=team_gLZEwMI0jgTr9zGABNt3Rude' --method POST --input '/Users/openclaw/Koaryu Releases/20260919-live-corrections/vercel-production-request.json'`. The body selects the Koaryu project, `target=production` and this exact Git SHA. Require READY, `pdx1`, both production domains and the exact deployed pair. Never promote a preview build.

The private apply scripts contain the complete immutable commands, including their long fingerprints. Their logs retain actual provider stdout/stderr, timestamps and verified successor records. They are historical after completion.

## Backup and restore

For this release the actual source was V47, not the old private runbook's V38 example:

```bash
backend/venv/bin/python -I /Users/openclaw/.config/koaryu/operator/backup-restore.py backup --count 142 --head 20260914055301
```

The reviewed helper mapping supports exact V37, V38, V47, V48 and V49 count/head tuples. This run verified a real V47 snapshot against all 16 source comparisons and original readiness, using PostgreSQL image `17.6.1.155` and digest `sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b`. Encryption and temporary-role/container cleanup passed. A mapping entry alone does not prove a fresh backup or restore.

Follow [the backup-owner and retained Storage procedure](../staging-recovery-runbook.md#current-backup-owner-and-retained-storage-procedure). The database dump does not contain Storage object bytes. Never substitute the retired filtered dump recipe. No backup, restore, migration or deployment is authorized merely by this document.

## Per-migration recovery checkpoints

- V47 before the chain: keep the original application pair serving until the planned write pause. Failure to verify the backup/restore blocks the first apply.
- V48 after the first apply: require exact V48 readiness and unchanged rows, then freshly inspect the single V49 remainder. An apply failure, partial/unknown state or changed/deleted original row is a stop; do not repair history or improvise recovery.
- V49 after the second apply: require exact V49 readiness and unchanged rows before application deployment. No frontend or new backend may be promoted before its required migrations exist.
- After application promotion: require matching frontend/backend SHA and the correct production environment. A mismatch is a stop, not permission to deploy unrelated commits until one works.

The old V47 backend `a4ef25910e76ed4b4111699f7b61ff02c30a67a0` remains readiness-compatible during the database-first window. That is not blanket rollback approval. Once new version-2 activation receipts or null subscription terms are written, older backend behavior is not approved. The old frontend tolerates these responses because it does not consume subscription terms; its brief overlap with the new backend was explicitly authorized.

Recovery choices are a separately reviewed forward correction or owner-directed restoration from the verified pre-chain snapshot, accepting loss of later writes and restoring a compatible application pair. No hosted restore or down-migration command is approved here. Do not use the disposable restore helper as a production recovery tool.

Final pair check used:

```bash
npm run verify:deployed-release -- --environment production --expected-sha 591e6299a5d56dcd2623bdc144f5cd5e1dabc9c5 --frontend-origin https://koaryu.app --backend-api https://koaryu.onrender.com/api/v1
```

Both backend readiness paths and `/api/proxy/health/ready` also passed. No live billing activation or historical financial backfill occurred.

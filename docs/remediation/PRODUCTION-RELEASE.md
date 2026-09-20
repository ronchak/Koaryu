# Completed V50 production release

**Completed September 20, 2026. Do not rerun this apply.** Both application pairs serve `dce52efff1d28358eca421769d00791b60045c6c`; both databases are V50. [Verification](production-release-verification.md) records exact execution and comparisons.

Release candidate: `dce52efff1d28358eca421769d00791b60045c6c`, merged in code main `7d7308afe8c77578094db8ffb81ee0c9a9e37fe2` with an identical tree. [The seven-finding record](queued-findings-verification.md) covers application changes. The completed [V48–V49 packet](production-v48-v49-packet.md) and [verification](production-v48-v49-verification.md) are historical; never repeat their applies.

**Forward-only: there is no approved down-migration or automated production restore. A fresh verified backup is mandatory before apply.** The fresh source V49 snapshot is `/Users/openclaw/Koaryu Backups/production-20260920T193053Z`, with all 16 comparisons and original readiness verified at `2026-09-20T19:31:54.106814+00:00`. Temporary role and disposable container cleanup passed. A previous snapshot or a readiness-mapping entry is not evidence for this release. Restoring a pre-apply snapshot can lose later writes.

## Immutable migration

| Order | File | SHA-256 |
| --- | --- | --- |
| 1 | `20260920154441_billing_due_date_facts_v50.sql` | `76a736cc45ec2ca3c26dec9423d88f30da35daee8236b57a9449b4ba5f870845` |

Source: exact V49, 144 migrations, head `20260920052705`. Successor: V50, 145 migrations, head `20260920154441`, full preflight V31. The selected one-file manifest is `017feb820d9e56ed12bac25501296d60ba38bbc63b5322d5db9c8c7c0f973f29`. V50 updates read functions and a guarded private release checksum; it does not rewrite customer rows.

**Do not deploy the new backend or frontend before V50.** The backend calls RPCs that V49 does not have and requires V50 readiness. Keep production auto-deploy off. Only the exact planned old-frontend/new-backend pair is allowed during deployment; the final pair must match.

## Ordered execution record

The following commands are historical after completion. They are not permission to repeat the migration.

This packet records the owner-authorized coordinating release. It does not independently authorize another run. Private scripts and evidence are under `/Users/openclaw/Koaryu Releases/20260920-queued-findings`. Every release shell disables tracing and explicitly sources `/Users/openclaw/.config/koaryu/operator/release-env.sh`.

1. Inspect staging using the exact candidate and `--one-migration`, then dry-run its state-bound token. Record the exact owner authorization required by the staging tool. Pause the staging web service, capture original rows, and run `apply-staging-v50.sh`. Require verified V50, unchanged original rows, and all 54 staging SQL contracts. Never run contract SQL against production.
2. Resume and deploy the staging backend at the candidate. Advance the staging Git ref using its observed old SHA as a lease, assign the staging frontend alias if needed, then require one exact staging application SHA, correct environment and proxy readiness.
3. Recheck production V49 history and provider image. Pause the production web service and verify no in-flight API transaction. Use the complete backup helper below. Verify all 16 source/restore comparisons, original V49 readiness, encrypted archive, temporary-role cleanup and disposable-container cleanup. Follow the [retained Storage procedure](../staging-recovery-runbook.md#current-backup-owner-and-retained-storage-procedure); the database archive does not contain Storage object bytes.
4. Capture production original-row hashes. Inspect/dry-run production with `--one-migration`; require only V50 selected. Read the actual restore proof before preparing the confirmation. The private apply command binds the exact candidate, current token, one-file manifest, owner/executor, final staging fingerprint and actual backup proof.
5. Announce the standalone command and wait 30 seconds, then run `/bin/bash '/Users/openclaw/Koaryu Releases/20260920-queued-findings/apply-production-v50.sh'`. Require verified V50, exact count/head/raw fingerprint and unchanged original rows before proceeding.
6. Resume production backend, then deploy `dce52efff1d28358eca421769d00791b60045c6c` with `render deploys create srv-d7mogk1kh4rs73aq6hqg --commit dce52efff1d28358eca421769d00791b60045c6c --wait --output json --confirm`. Require both `/health/ready` and `/api/v1/health/ready` to report ready, production, the existing Stripe live configuration and this exact SHA.
7. From `frontend/`, create a new production-target Git deployment with `vercel api '/v13/deployments?teamId=team_gLZEwMI0jgTr9zGABNt3Rude' --method POST --input '/Users/openclaw/Koaryu Releases/20260920-queued-findings/vercel-production-request.json'`. Its body must name project `prj_ROzEAXoVf0NbUn3jNIKEJPWjF9HU`, `target=production` and this exact Git SHA. Require READY, production variables, `pdx1` and the production domains. Never promote a preview build.
8. Run the exact pair verifier below and check frontend proxy readiness. One closeout PR records results; no additional application deployment is needed for documentation.

```bash
backend/venv/bin/python -I /Users/openclaw/.config/koaryu/operator/backup-restore.py backup --count 144 --head 20260920052705
```

The reviewed helper mapping supports V49 and V50, with the same image pin and comparisons. [The V50 mapping patch](operator-backup-v50.patch) adds only the exact new tuple. Provider image and digest must still match at execution.

```bash
npm run verify:deployed-release -- --environment production --expected-sha dce52efff1d28358eca421769d00791b60045c6c --frontend-origin https://koaryu.app --backend-api https://koaryu.onrender.com/api/v1
```

## Stop and recovery

Stop on failed or ambiguous apply, unexpected history/readiness, an unverifiable backup/restore, any changed or deleted original row, or an unexpected/final application SHA mismatch. Retain evidence and attempt no improvised recovery.

The previous V49 application `591e6299a5d56dcd2623bdc144f5cd5e1dabc9c5` remains schema/readiness-compatible during the V50 window: V50 preserves legacy stored statuses and changes no customer-row representation. Earlier applications are not approved after V48 receipts or V49 unknown subscription terms exist. Compatibility is not automatic rollback authorization. Recovery choices are a reviewed forward correction, a specifically reviewed compatible application rollback, or owner-directed restoration from the verified snapshot with an appropriate application pair and acceptance of lost later writes. The backup helper restores only disposable containers, never a hosted database.

No live billing activation, historical financial backfill or currency conversion is part of this release.

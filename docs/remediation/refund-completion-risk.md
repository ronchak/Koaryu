# Refund completion recovery

`PROGRAM-REFUND-01` is corrected by V46 and its V47 completion-overlap follow-up. Deployment is separate: production must receive the forward migration before the candidate applications. No historical financial rows or stored resource fingerprints are rewritten.

The defect was first verified on main `9d99ad53cddcbd03989671ff408e1ac30e47e9e0` and reproduced against the actual database at base `e66a91e1d4188133254608848605a0d988af5963`. A succeeded refund projected 500 cents, completion rolled back, and the receipt remained `projected`. The original-key retry failed because V31 fingerprinted the payment's refunded total, including this operation's own change. Stripe was not called twice, but ordinary completion recovery was blocked.

V46 changes `private.billing_operation_resource_version_v31`. An unfinished resource owner compares the refunded total excluding its own exact, verified succeeded refund. The original fingerprint stays immutable. The existing claim continues to enforce actor, tenant, payer, account, generation, request and lease identity. Another confirmed refund still changes the comparison. Once the receipt completes, the full total becomes the version for a later operation. V47 observes that comparison after locking the completed operation, so a new key that waited for completion does not retain the earlier projected-state comparison.

The application already verifies the saved projection before completing it. Its production refund code is unchanged. The fake and behavioral test now exercise pending and succeeded refunds after completion failure, including lease expiry, one provider attempt, one audit and the unchanged original fingerprint.

The [plan and proof requirements](refund-recovery-plan.md) cover real database rollback/reclaim, identity rejection, concurrent projection/claim/completion, canonical and logical-restore continuation, historical readiness, exact-head CI and independent review. The complete verifier applies 142 migrations and 53 SQL contracts. V46's generated restore case preserves the pre-migration receipt and business rows, then completes that receipt through the service-role RPC.

This correction does not resolve the separate currency, activation, import-policy or audit-backlog findings. Hosted rehearsal, a fresh production backup with verified restore, the recovery plan and the authorized release protocol remain mandatory before production apply. Live billing activation and historical financial backfill remain outside the authorized run.

The [completion-overlap plan](refund-completion-locking-plan.md) records the late PR207 review, real PostgreSQL reproduction, two different-key concurrency cases and forward correction. No stored fingerprint is changed to make a recovery test pass.

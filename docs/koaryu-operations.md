# Koaryu Operations

This guide is the operating contract for the single-studio Koaryu product. It describes currently supported behavior, not the longer-term roadmap. The detailed billing boundary is in [Billing Boundary](billing-boundary.md).

## Supported studio model

- One Koaryu user belongs to exactly one studio at a time.
- Creating or accepting a second active studio membership is rejected.
- An unexpected historical multi-membership fails closed with a non-disclosing remediation message. Do not delete or rewrite either membership. The owner should contact support so the memberships can be reviewed and resolved through a separately approved, record-preserving procedure.
- Multi-studio selection and active multi-studio operation are not supported in Koaryu.

## Staff permission matrix

The backend is authoritative. Hiding a control in the UI is not an authorization boundary.

| Capability | Admin | Front Desk | Instructor |
| --- | --- | --- | --- |
| View/edit existing students | Yes | Yes | Yes |
| Create students | Yes | Yes | No |
| Archive students | Yes | Yes | No |
| Permanently delete students | Policy-reserved; not shipped | No | No |
| Attendance | Yes | Yes | Yes |
| Promote/demote | Yes | No | Yes, through named audited actions |
| Lead management and conversion | Yes | Yes | No |
| Schedule administration | Yes | Yes | Read/attendance only |
| Routine billing | Yes | Yes | No access |
| Refunds, voids, and financial overrides | Admin-only; not shipped | No | No |
| Stripe, payout, tax, and legal settings | Admin-only; not shipped | No | No |
| Staff/studio administration | Yes | No | No |
| Belt-system configuration/deletion | Yes | No | No |

Routine billing currently means only viewing existing billing state, attaching an external-only local student billing record, recording a payer-level external payment, and reconciling an existing Stripe-linked invoice through a provider read. Instructors are denied before billing data is fetched and receive no billing amounts, names, counts, plans, provider metadata, or financial summaries.

## First-day checklist

1. Confirm the studio name and Admin account, then invite only the staff who need access.
2. Assign each staff member the least-privileged role in the matrix above. Verify one Front Desk and one Instructor account before daily use.
3. Import or add the current student roster. Check guardian, emergency, program, rank, and status data for a small sample before continuing.
4. Configure belt ladders and recurring classes, then verify the current week on a phone used at the studio.
5. Take attendance for a test class and confirm the result appears in student history.
6. Review Billing with an Admin or Front Desk account. Use only the three supported routine transitions and confirm `LIVE_BILLING_ENABLED=false` remains unchanged.
7. Confirm that an Instructor receives the billing access-denied page without seeing billing data.
8. Submit a signed-in test request at `/help/contact` and verify the owner receives the expected support notification or digest.
9. Record the deployed application SHA, migration head, smoke results, and rollback target in the release ledger.

## Daily operating checklist

- Review dashboard attention items, leads, and the day's schedule.
- Confirm the correct class before taking or correcting attendance.
- Use named promotion or demotion actions so rank history and actor audit remain intact.
- Archive students only when intended; archive preserves history and is not permanent deletion.
- Have Admin or Front Desk review billing attention. Treat external-payment recording as a local record, never as evidence that Koaryu moved money.
- Use invoice reconciliation only for an existing provider-linked invoice. If the result is ambiguous, refresh before retrying.
- Escalate access denials, unexpected multi-membership, missing data, or provider/local disagreement instead of bypassing a guard.

## Support and incident handling

Signed-in users should use `/help/contact`; if the application route is unavailable, email `support@koaryu.app`. Include the studio name, affected page, approximate time, staff role, steps taken, expected result, and a non-sensitive screenshot when useful. For billing issues, include the payer name and visible invoice identifier, but never send passwords, card data, API keys, webhook secrets, or raw production exports.

The owner is the current incident and provider-alert recipient; email is preferred. Provider-native Vercel, Render, Supabase, and Stripe alerts are the primary signal. Any Codex or scheduled digest is supplemental and is not the sole real-time monitor. After every deployment, confirm the expected provider email alert path once and record the result.

## Recovery posture

- Provisional planning targets are RPO of no more than 24 hours and RTO of no more than 4 hours. Neither target is a verified promise today.
- The five encrypted production backup artifacts were verified on a second machine with matching names, sizes, mode `0600`, and SHA-256 hashes. This is a second-machine copy, not proven geographic or provider-independent off-site recovery.
- The Supabase organization is currently on the Free plan, with no proven native daily-backup or PITR entitlement. The latest encrypted capture exceeded the provisional 24-hour RPO during the Phase 0 audit.
- The hosted restore drill recovered database/Auth structure and validated counts, but an authenticated tenant-safe application read from the restored target remains unproven.
- The encryption key remains in macOS Keychain. Copying the recovery key to a physically controlled flash drive is an outstanding human-only step; do not put it in the repository, cloud notes, or release evidence.

Use [Staging and Recovery Runbook](staging-recovery-runbook.md) for backup and restore procedure and [Release Ledger](release-ledger.md) for the exact application rollback contract. An application rollback redeploys the named prior application SHA. A released additive migration is corrected forward; do not rewrite migration history or restore over production as an ordinary rollback.

## Explicit deferrals

- Active multi-studio product support or destructive cleanup of historical memberships.
- Provider-backed tuition lifecycle changes, including plan/payer synchronization, autopay, pause/resume, cancellation, refunds, voids, exports, and live Stripe activation.
- Permanent student deletion, dangerous bulk deletion, and exceptional financial controls.
- Self-service parent portals, new integrations, custom permission builders, or a broad authorization rewrite.
- New recovery infrastructure, enterprise monitoring, or guarantees beyond the evidence above.

Stop at the current product boundary. Deferred capabilities remain unavailable until they receive their own scope, evidence, review, and approval.

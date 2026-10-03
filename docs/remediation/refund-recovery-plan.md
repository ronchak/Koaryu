# Refund receipt recovery

Phase one of the owner-authorized September 14 release run fixes `PROGRAM-REFUND-01` before any hosted release. Base: `e66a91e1d4188133254608848605a0d988af5963`. The audit backlog is outside this run.

## Boundary and intended result

A succeeded refund can update the payment total before receipt completion commits. V31 then compares the original resource fingerprint with the total changed by that same operation and refuses recovery. The application already verifies and completes a saved projection without another Stripe call.

V46 corrects the private resource-version function. While the resource's current operation is `provider_succeeded` or `projected`, its exact succeeded refund is excluded from the comparison total. The stored fingerprint is never rewritten. The exclusion requires matching studio, payment, payer, account, account generation, provider refund and charge identity, the saved amount, and no reconciliation flag. Other confirmed adjustments still change the comparison. Completed operations use the full total again, allowing a later refund to receive a new version.

This belongs at the database resource-version boundary because every claimant must distinguish its own verified projection from another operation's change. No production application behavior, public RPC signature, table, lease, completion order or permission changes. No financial backfill.

## Proof

- Reproduce the original failure on a complete disposable V45 PostgreSQL replay. Execute the real completion RPC, roll back its transaction, and show that the projected refund's original-key reclaim fails.
- Execute real V46 claims and completion after the same failure. Check both projection checkpoints, competing lease rejection, changed actor/tenant/payer/account/generation/request rejection, unrelated refunds and unverified projections, original receipt replay and a later operation's advanced version. Read stored fingerprint evidence from the table; it is not in the public claim response.
- Extend the existing billing concurrency runner. Observe actual blocking locks across committed/rolled-back own and unrelated projections, competing claims and concurrent completion. A retry must retain one provider attempt and the original resource fingerprint.
- Generate a V45-to-V46 dump/restore continuation with the existing generator. Seed the unfinished receipt before migration, preserve all source rows during upgrade, and complete that same receipt on canonical and logically restored copies. Retain previous backend readiness and all historical attestation bytes.
- Use one application recovery test with pending/succeeded subcases, the existing fake clock, one provider refund and one audit. Remove the redundant generated-constant inventory test; preserve the behavioral predecessor refusal and independent readiness failures.

The coordinator owns SQL, concurrency, attestation, integration and hosted actions. A fresh Sol task owns the application fake/test change. A fresh independent reviewer reviews the final candidate. Full disposable verification, exact-head CI and the guarded merge are required. Hosted staging, production backup/restore and deployment remain later ordered phases, with separate execution evidence.

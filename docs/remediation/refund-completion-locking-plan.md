# Refund completion overlap

A new refund request can begin while the previous receipt's completion transaction is in flight. V46's comparison can still observe `projected`, exclude that refund, and then wait for the operation lock. After completion commits, the existing completed branch receives the old comparison and wrongly reports an unsettled refund or actor conflict.

The coordinator reproduced this on real disposable PostgreSQL. The different-key claimant blocked on the completing transaction, then failed with SQLSTATE `55000` and `billing_provider_operation_resource_prior_refund_unsettled`. PR207's same-key completion proof did not cover this distinct request. The late automated review is accepted; governance PR208 remains a draft until this correction lands.

## Boundary

V47 recomputes the payment resource version inside the existing completed-payment branch, after its operation lock is held. The comparison belongs there because the operation's state determines whether its own refund is excluded. This adds no lock, wrapper, business RPC, table or application workaround. Payer/plan behavior, same-key receipt ownership, actor/tenant/account checks and historical financial rows remain unchanged.

The V46 migration stays immutable. V47 is a forward correction with generated full/compatibility preflights, independent canonical/restored pins and retained backend readiness.

## Proof

The maintained billing concurrency runner now covers a new key from the same actor and from another active admin while completion holds the operation lock. Both must receive a new unattempted operation and advanced resource version; the original key must still return its original completed receipt. Financial rows remain unchanged. These cases extend 21 to 23, without duplicating the state machine in a fixture.

The observer also requires a `Lock` wait event and the matching blocking PID in its returned sample. Development exposed a partial statistics sample with a blocker PID but no wait event. Polling now waits for both facts at the observer boundary; no deadline or sleep was increased.

The generated V46-to-V47 restore continuation preserves pre-migration receipts and business rows, completes the old receipt, verifies a later refund owner and retains the old-key replay. The full disposable suite applies 142 migrations and 53 contracts. Existing obsolete-readiness classification adds the exact V47 count/head, preserving every refusal assertion. Backend readiness tests and rollout fixtures advance their exact versions without adding cases.

Require coordinator verification, a fresh independent reviewer for this PR, completion and evaluation of substantive automated feedback, exact-head CI, guarded merge and main's own CI. Then rebase PR208, update its packet to V47 and verify its new head again. No hosted migration, backup or deployment is part of this correction. The per-migration execution-mode scope decision remains pending.

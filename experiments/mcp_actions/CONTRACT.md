# Guarded actions: isolated alpha contract

This is the design for a synthetic local prototype, not an enabled Koaryu feature. The v1 MCP remains read-only. No production module imports this directory, the backend Docker image does not include it, and no configuration flag turns it on. Public package preparation does not include these tools.

## Two predefined actions

| Action | Exact change | Existing business command to reuse later |
| --- | --- | --- |
| `student_tag_add` | Add one normalized tag to one non-deleted student; preserve every other tag and field | `StudentBulkActions.update_tags` / `mutate_students_bulk_atomic`, with exactly one student |
| `lead_followup_set` | Set or clear one unconverted lead's studio-local `follow_up_date`; preserve stage and every other field | `LeadService.update_lead` / `update_lead_atomic`, with only `follow_up_date` |

Tag normalization preserves Koaryu's case sensitivity, trims outer whitespace and rejects empty/control-character tags or tags over64 characters. A follow-up is an exact ISO calendar date or explicit null, never a relative timestamp. UUID targets are mandatory. The prototype does not accept a table, SQL, command/RPC name, patch object, destination URL or additional target IDs.

Existing commands are the production integration points, not already sufficient approval engines. They currently lack the proposal's expected version and execution identity. Calling either after a separate preview check would create a race. Future activation requires a reviewed atomic database wrapper that checks the proposal and locks the current target, then calls the existing command in the same transaction. Do not add a PostgREST check-then-call adapter.

The selected lead patch cannot change stage, convert/enroll a lead or emit the stage-change workflow capture that `update_lead_atomic` performs for stage edits. Tag addition currently changes the roster and its transactional audit. Before a real alpha, inspect the exact candidate's triggers and workflow effects again; no customer sending, billing, payment/refund operation or bulk deletion is authorized by these actions.

## Separate authority

A future action connection needs a separately approved capability for each predefined action, its required read category, and a distinct resource/purpose. Read-only connection permissions never imply write permission. Current v1 tokens, scopes, hook and grant table are not extended by this prototype.

The local prototype uses a random synthetic assistant bearer key and a separate synthetic owner's password/session. This is a demonstration of separate authorization channels, not native OAuth, SSO, MFA or deployment readiness. Real native OAuth is tested separately by the read-connector harness. Neither an assistant tool, model-produced text nor an `approved:true` argument can approve a proposal.

At preview, owner approval, execution and replay, check the current connection, session/generation, expiry, exact action capability, active studio/subscription eligibility and current admin membership. Studio and actor come from the authenticated connection or owner session; caller-supplied headers/arguments cannot choose them. Every target lookup binds the studio. Wrong-tenant and missing targets share the same refusal.

## Model-callable tools

- `preview_student_tag_add(student_id, tag)`
- `execute_student_tag_add(proposal_id, idempotency_key)`
- `preview_lead_followup_set(lead_id, follow_up_date)`
- `execute_lead_followup_set(proposal_id, idempotency_key)`

There is no generic executor or model-callable approve tool. Execution takes only immutable proposal identity and retry identity; it never accepts replacement mutation arguments. An execute tool must match the proposal's exact action. The prototype transports these four tools over standard MCP with a synthetic bearer gate and no invented OAuth issuer.

Preview creates proposal metadata and therefore has `readOnlyHint:false`, `destructiveHint:false`. Tag execution is additive (`destructiveHint:false`); replacing/clearing a follow-up is an overwrite (`destructiveHint:true`). Every tool has `openWorldHint:false`. These annotations describe the isolated alpha, not the four v1 read tools.

## Immutable preview and owner decision

The proposal expires within five minutes and no later than the connection. Its digest binds a versioned canonical representation of:

- actor, studio, connection and connection session/generation;
- predefined action, exact target and normalized arguments;
- the displayed before/after values and target version;
- the current grant version and expiration.

Names and record values are data, not HTML or instructions. The owner page escapes them, labels the synthetic environment, shows the exact target and field change, and offers Approve or Deny. The owner must confirm the displayed digest through an ordinary owner session with CSRF and exact-origin protection. Only the same active owner/admin and studio can approve that connection's proposal. Denial is terminal. Approval does not extend expiry or revive a revoked connection. In this prototype an approved proposal cannot be withdrawn individually: revoke the connection to stop it before execution, or let it expire. Per-proposal withdrawal is a future alpha decision.

The prototype uses monotonic integer row and grant revisions. A real implementation must establish equivalent database authority across **all** writers. Existing timestamps alone are not a substitute for that requirement. An edit followed by an undo must invalidate a pending proposal. Connection replacement, permission changes and restore/reset epochs also invalidate pending approvals; copied old approvals cannot resume on restored state.

## Atomic execution and retries

One transaction performs current authorization, retry lookup/binding, ownership and approval checks, version/state comparison, the predefined mutation, audit insertion, receipt insertion and proposal consumption. The business effect and receipt commit together. An error after a target update rolls everything back, including the proposal's consumed state.

A retry key is unique within the connection and binds the action and proposal. Retrying the same completed request returns its original receipt **after current authorization succeeds**, without applying the mutation or adding an audit row again. Reusing the key for a different proposal conflicts. Reusing an already consumed proposal with a new key conflicts. A concurrent target edit or stale grant requires a new preview and approval.

If the requested tag/date is already present, the approved execution produces one `no_change` receipt and audit entry without touching the target's revision. A replay returns that same receipt. A receipt identifies the action, target, approving owner, proposal digest, before/after values and execution time; it never claims to send a message or collect a payment.

The synthetic engine uses SQLite transactions with independent connections so race and rollback tests exercise an actual database. Its whole-database write lock is a prototype limitation, not a production capacity design. Production needs the existing Postgres lock order and row locks, durable unique constraints and an approval/receipt transaction composed with the actual domain command.

## Verification and activation boundary

Test wrong actor/studio/action, anonymous or assistant approval attempts, forged/changed/expired/reused approvals, missing CSRF or wrong origin, grant and role revocation, session replacement, deleted/converted targets, stale state including undo/redo, no-ops, rollback after a domain effect, duplicate/concurrent retry and competing target edits. Run an actual SDK preview → refusal before approval → ordinary owner login/approval → execution → replay flow. Exercise the rendered owner decision page in a browser.

This prototype must remain outside the deployed application until the owner approves a separate alpha. That later release needs actual native action authorization, database revisions and the atomic domain wrapper, ACL/tenant/race/restore verification, capacity checks, owner-facing consent and audit retention/privacy decisions, current trigger-side-effect review, independent security review and the normal release gates. No production migration or deployment is included here.

The prototype uses Python sorting and leaves an already-present tag untouched. The production wrapper must compute and compare its actual after-state in Postgres, accounting for database collation and the existing command’s sort/deduplication behavior. Do not treat the prototype’s tag ordering or no-op shortcut as proof of production command equivalence.

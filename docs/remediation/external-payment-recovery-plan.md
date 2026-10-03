# External-payment request and audit ownership

After PR170, FSH1-05, FT1-04, BB1-05 and BT3-02 share one unresolved retry boundary. A payment can commit before balance/audit failure, while the browser keeps its request key only in a ref and clears that key on edits. A retry can therefore create another payment or permanently omit the original audit.

## Change

- Add one payer-only database RPC that commits a new external payment and its original-actor audit together. Preserve the existing studio/key uniqueness and exact request-hash binding. A matching replay returns the original payment without inventing historical audits. Balance recomputation remains repeatable after that transaction.
- Reject new non-USD external-payment writes while preserving exact confirmed historical non-USD replay. Keep PROGRAM-CURRENCY-01 pending for tuition and truthful aggregate handling. No FX conversion or historical backfill.
- The HTTP endpoint already rejects invoice targets. Repository and operator-entrypoint searches found the Python invoice-recording branch used only by tests. Remove that branch and its exclusive duplicate simulations; keep the endpoint's payer-only contract and all historical SQL invoice, tenant and overpayment guards.
- Keep ownership in the existing report hook/model. Save and read back one exact pending payload/key per signed-in staff member and studio before POST, including the normalized free-text note. Restore and pin the original form until a matching response confirms it. Unavailable, corrupt or failing storage blocks an unprotected submission. Edits and remounts cannot replace unresolved identity.
- Use the existing user/studio/role/session-generation identity for response ownership. Token renewal is not a new identity. Invalidation releases only the old owned action; stale completions cannot change another session's state or storage. Preview does not access live attempts.
- Verify the returned payment against the captured request before retirement. Preserve confirmation independently of list refresh. The existing refresh loader can resolve after recording an error, so its return is not proof of success or failure of the payment. Failed retirement retains the original attempt and prevents replacement.

Known-invalid form values must fail before durable capture. Keep the current amount/method/note normalization, enforce the actual positive integer-cent storage range and existing method length contract, and preserve generated HTTP contracts if validation changes.

## Boundaries and proof

No provider charge, invoice application, new payment feature, storage framework or generalized transaction layer. LocalStorage is not an atomic cross-tab lock. No claim is made that two independently initiated requests with different keys represent one payment.

Use the release-attestation generator for the next forward schema state. Preserve old backend compatibility through database-first cutover; atomic audit guarantees apply to callers using the new RPC, after old split-write operations drain. Do not backfill actor identity or missing historical audits.

Replace forwarding-only/key-format tests with a small mounted matrix covering lost response, blocked edits/remount, exact note/key retention, storage failure, malformed success, confirmed payment plus refresh failure, identity changes versus token renewal, and existing preview/role gates. Reuse the current billing test fixture. Real PostgreSQL tests must prove atomic audit failure rollback, same-key concurrency, original-actor preservation, key/hash and tenant rejection, legacy replay, and repeatable balance completion. Preserve invoice boundary checks in SQL and the HTTP rejection test. Delete obsolete internal invoice simulations and assess the touched test surface against the original branch baseline.

Require focused behavioral checks, real canonical/logical-restore continuation, full local database contracts, fresh independent review and exact-head CI before merge. No production operation is authorized.

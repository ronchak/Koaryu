# Independent program joining dates

DM2-02 remains partially fixed after V39: changing the overall joining date while resending a program list still rewrites retained program dates. The owner has settled the rule: those dates are independent.

## Bounded change

- V42 replaces only the private profile writer's retained-membership date propagation. Keep the overall student date update and the existing default for a newly created membership, including null.
- Match that rule in the frontend preview model. Explicit per-program editing stays authoritative. Import and lead-conversion writers are separate workflows and remain unchanged; this PR makes no claim about their merge semantics.
- Preserve wrappers, student-before-membership locks, tenant checks, rank restoration, paused status, membership endings, guardian/audit rollback and response contracts. No historical row update or backfill.
- Use the release generator for full V23, V22 compatibility, the affected V13 rank-return manifest and a real V41-to-V42 restore check. Keep historical migrations immutable. Derive and independently compare canonical and logically restored evidence before accepting new pins.

## Dependencies and verification

The private writer contributes to the V11 rank manifest; V13 checks its parent. Their changes flow through resource ownership V31, operational contract V31, its guarded expectation row and operational manifest V12. Other financial, rank-command and payer-balance contracts must remain unchanged. Advance application readiness and rollout classification together, retaining exact V41 as a predecessor and all existing compatibility consumers.

Replace the existing test that codifies date propagation. Consolidate repetitive preview assertions into the existing membership matrix. Preserve behavioral SQL checks for null dates, paused memberships, reorder/removal/addition, explicit program edits, tenant rejection and rollback. Do not add a test per audit observation.

Require focused preview/SQL checks, generator reproduction, actual logical restore and continuation, full local PostgreSQL contracts, affected backend readiness and rollout checks, fresh independent review and exact-head CI. Merge only when the whole candidate is healthy. Production migration and deployment remain outside this program's authority.

## Reassessment during implementation

OPS2-05 owns a separate reachable import-recovery case: a later row aborts the run after earlier rows committed; same-key recovery repeats those successful rows and can overwrite subsequent staff edits, including program dates. Its ledger acceptance criteria now require preserving those edits. Fixing only import date assignment would leave other fields vulnerable, so that correction stays with atomic import-row completion. New independent import runs use different student IDs. Lead conversion commits its deterministic student and converted marker together; no comparable ordinary replay path was found.
